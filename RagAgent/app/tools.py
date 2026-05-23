import math
import re
from collections import Counter
from typing import Any

import qdrant_client
from google.genai import types

from app.config import settings
from app.database import db
from app.genai_client import client


TOKEN_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_\-./]*")


def _tokenize(text: str) -> list[str]:
    return [token.lower() for token in TOKEN_RE.findall(text or "")]


def _chat_filter(chat_id: str) -> qdrant_client.models.Filter:
    return qdrant_client.models.Filter(
        must=[
            qdrant_client.models.FieldCondition(
                key="chat_id",
                match=qdrant_client.models.MatchValue(value=chat_id),
            )
        ]
    )


def _embed_query(query: str) -> list[float]:
    response = client.models.embed_content(
        model="gemini-embedding-2-preview",
        contents=query,
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    return response.embeddings[0].values


def _scroll_chat_points(chat_id: str, limit: int) -> list[Any]:
    """Fetch payloads for lexical search. Qdrant remains the only retrieval store."""
    records = []
    next_offset = None

    while len(records) < limit:
        batch_size = min(256, limit - len(records))
        batch, next_offset = db.client.scroll(
            collection_name=settings.QDRANT_COLLECTION_NAME,
            scroll_filter=_chat_filter(chat_id),
            limit=batch_size,
            offset=next_offset,
            with_payload=True,
            with_vectors=False,
        )
        records.extend(batch)
        if next_offset is None or not batch:
            break

    return records


def _bm25_scores(query: str, records: list[Any]) -> dict[str, float]:
    query_terms = [term for term in _tokenize(query) if len(term) > 1]
    if not query_terms:
        return {}

    text_records = []
    document_frequency = Counter()
    total_length = 0

    for record in records:
        payload = record.payload or {}
        text = payload.get("text_content") or ""
        if not text.strip():
            continue

        tokens = _tokenize(text)
        if not tokens:
            continue

        token_set = set(tokens)
        for term in set(query_terms):
            if term in token_set:
                document_frequency[term] += 1

        total_length += len(tokens)
        text_records.append((record, text, tokens))

    if not text_records:
        return {}

    avg_doc_len = max(total_length / len(text_records), 1)
    query_counter = Counter(query_terms)
    normalized_query = " ".join(query_terms)
    scores: dict[str, float] = {}

    for record, text, tokens in text_records:
        token_counts = Counter(tokens)
        doc_len = len(tokens)
        score = 0.0

        for term, query_frequency in query_counter.items():
            term_frequency = token_counts.get(term, 0)
            if not term_frequency:
                continue

            n = document_frequency.get(term, 0)
            idf = math.log(1 + (len(text_records) - n + 0.5) / (n + 0.5))
            k1 = 1.4
            b = 0.72
            denominator = term_frequency + k1 * (1 - b + b * doc_len / avg_doc_len)
            score += query_frequency * idf * ((term_frequency * (k1 + 1)) / denominator)

        text_lower = text.lower()
        if normalized_query and normalized_query in text_lower:
            score += 8.0

        if len(query_counter) > 1 and all(term in text_lower for term in query_counter):
            score += 2.0

        if score > 0:
            scores[str(record.id)] = score

    return scores


def _normalize_scores(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    max_score = max(scores.values())
    if max_score <= 0:
        return {key: 0.0 for key in scores}
    return {key: value / max_score for key, value in scores.items()}


def _merge_and_rerank(vector_points: list[Any], lexical_records: list[Any], lexical_scores: dict[str, float]) -> list[dict]:
    candidates: dict[str, dict] = {}
    vector_scores = {}

    for point in vector_points:
        point_id = str(point.id)
        vector_scores[point_id] = max(float(getattr(point, "score", 0.0) or 0.0), 0.0)
        candidates[point_id] = {
            "id": point_id,
            "payload": point.payload or {},
            "vector_score": vector_scores[point_id],
            "lexical_score": 0.0,
        }

    for record in lexical_records:
        point_id = str(record.id)
        if point_id not in lexical_scores:
            continue

        if point_id not in candidates:
            candidates[point_id] = {
                "id": point_id,
                "payload": record.payload or {},
                "vector_score": 0.0,
                "lexical_score": lexical_scores[point_id],
            }
        else:
            candidates[point_id]["lexical_score"] = lexical_scores[point_id]

    normalized_vector = _normalize_scores(vector_scores)
    normalized_lexical = _normalize_scores(lexical_scores)

    reranked = []
    for point_id, candidate in candidates.items():
        payload = candidate["payload"]
        content = payload.get("text_content") or ""
        entity_type = payload.get("entity_type")
        source = payload.get("source", "")

        text_source_boost = 0.08 if entity_type == "text" else 0.0
        ocr_boost = 0.04 if source in {"page_ocr", "image_text"} else 0.0
        content_boost = 0.03 if content else 0.0

        final_score = (
            0.62 * normalized_vector.get(point_id, 0.0)
            + 0.50 * normalized_lexical.get(point_id, 0.0)
            + text_source_boost
            + ocr_boost
            + content_boost
        )

        candidate["final_score"] = final_score
        candidate["normalized_vector_score"] = normalized_vector.get(point_id, 0.0)
        candidate["normalized_lexical_score"] = normalized_lexical.get(point_id, 0.0)
        reranked.append(candidate)

    return sorted(reranked, key=lambda item: item["final_score"], reverse=True)


def _format_result(candidate: dict) -> dict:
    payload = candidate["payload"]
    entity_type = payload.get("entity_type", "text")
    result = {
        "type": "image" if entity_type == "image" else "text",
        "document_id": payload.get("document_id"),
        "filename": payload.get("filename"),
        "page": payload.get("page_number"),
        "chunk": payload.get("chunk_index", 0),
        "source": payload.get("source", entity_type),
        "content": payload.get("text_content"),
        "image_url": payload.get("image_url"),
        "relevance_score": round(candidate["final_score"], 4),
        "vector_score": round(candidate["normalized_vector_score"], 4),
        "lexical_score": round(candidate["normalized_lexical_score"], 4),
    }

    if result["type"] == "image" and result["content"]:
        result["content"] = f"Image searchable text/description: {result['content']}"

    return result


def search_knowledge_base_direct(chat_id: str, query: str, raw_query: str | None = None) -> list[dict]:
    queries_to_search = [query]
    if raw_query and raw_query.strip() and raw_query != query:
        queries_to_search.append(raw_query)

    all_vector_points: dict[str, Any] = {}
    lexical_records = _scroll_chat_points(chat_id, settings.LEXICAL_SCAN_LIMIT)
    merged_lexical_scores: dict[str, float] = {}

    for q in queries_to_search:
        print(f"[Tool Execution] Hybrid search for: '{q}' in chat '{chat_id}'")

        try:
            query_vector = _embed_query(q)
            vector_results = db.client.query_points(
                collection_name=settings.QDRANT_COLLECTION_NAME,
                query=query_vector,
                limit=settings.VECTOR_SEARCH_LIMIT,
                query_filter=_chat_filter(chat_id),
            ).points

            for point in vector_results:
                point_id = str(point.id)
                if point_id not in all_vector_points or point.score > all_vector_points[point_id].score:
                    all_vector_points[point_id] = point
        except Exception as e:
            print(f"Vector search failed; falling back to lexical results only: {e}")

        lexical_scores = _bm25_scores(q, lexical_records)
        for point_id, score in lexical_scores.items():
            merged_lexical_scores[point_id] = max(merged_lexical_scores.get(point_id, 0.0), score)

    reranked = _merge_and_rerank(
        list(all_vector_points.values()),
        lexical_records,
        merged_lexical_scores,
    )

    final_candidates = reranked[: settings.FINAL_CONTEXT_LIMIT]
    return [_format_result(candidate) for candidate in final_candidates]


def get_search_tool(chat_id: str, raw_query: str | None = None):
    def search_knowledge_base(query: str) -> list[dict]:
        """
        Searches the active chat's uploaded documents using hybrid retrieval.

        The search combines Gemini embeddings with exact lexical matching over
        extracted PDF text, OCR text, and image text/captions. Results include
        page numbers and score breakdowns for grounded final answers.
        """
        return search_knowledge_base_direct(chat_id=chat_id, query=query, raw_query=raw_query)

    return search_knowledge_base
