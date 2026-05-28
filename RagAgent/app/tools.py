import math
import re
import json
import logging
from collections import Counter
from typing import Any

import qdrant_client
from google.genai import types

from app.config import settings
from app.database import db
from app.genai_client import client
from app.utils import call_with_retry

logger = logging.getLogger(__name__)


TOKEN_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_\-./]*")
IMAGE_KEYWORDS = {
    "image", "images", "logo", "diagram", "chart", "figure", "illustration",
    "photo", "picture", "pictures", "map", "draw", "drawing", "visual",
    "schematic", "show", "see", "look"
}
TABLE_KEYWORDS = {
    "table", "tables", "tabular", "row", "rows", "column", "columns",
    "compare", "comparison", "matrix", "value", "values", "total",
    "amount", "percentage", "percent", "rate", "list", "breakdown"
}
MULTI_PAGE_KEYWORDS = {
    "all", "across", "throughout", "entire", "full", "complete", "every",
    "summarize", "summary", "section", "sections", "requirements", "criteria",
    "steps", "process", "timeline", "compare", "differences", "relationship"
}


def _tokenize(text: str) -> list[str]:
    return [token.lower() for token in TOKEN_RE.findall(text or "")]


def _query_words(query: str) -> set[str]:
    return set(_tokenize(query))


def _has_any(query: str, keywords: set[str]) -> bool:
    return bool(_query_words(query) & keywords)


def _is_complex_query(query: str) -> bool:
    words = _query_words(query)
    return (
        len(words) >= 9
        or bool(words & MULTI_PAGE_KEYWORDS)
        or bool(words & TABLE_KEYWORDS)
        or "?" in query and len(words) >= 6
    )


def _expanded_queries(query: str, raw_query: str | None = None) -> list[str]:
    """Cheap query planning without an extra LLM call."""
    candidates = [query]
    if raw_query and raw_query.strip() and raw_query.strip() != query.strip():
        candidates.append(raw_query.strip())

    base = raw_query.strip() if raw_query and raw_query.strip() else query.strip()
    words = _query_words(base)

    if settings.ENABLE_RULE_BASED_QUERY_EXPANSION:
        if words & TABLE_KEYWORDS:
            candidates.extend([
                f"{base} table rows columns values totals",
                f"{base} comparison numeric amounts percentages",
            ])

        if words & MULTI_PAGE_KEYWORDS:
            candidates.extend([
                f"{base} full section all pages complete details",
                f"{base} previous next page continuation context",
            ])

        if words & IMAGE_KEYWORDS:
            candidates.append(f"{base} figure diagram chart image caption labels")

    unique_queries = []
    seen = set()
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", candidate).strip()
        key = normalized.lower()
        if normalized and key not in seen:
            seen.add(key)
            unique_queries.append(normalized)

    return unique_queries[: settings.MAX_EXPANDED_SEARCH_QUERIES]


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
    response = call_with_retry(
        client.models.embed_content,
        model="gemini-embedding-2-preview",
        contents=query,
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    return response.embeddings[0].values


def _scroll_chat_points(chat_id: str, limit: int) -> list[Any]:
    """Fetch payloads for lexical search"""
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


def _merge_and_rerank(
    vector_points: list[Any],
    lexical_records: list[Any],
    lexical_scores: dict[str, float],
    query: str = "",
) -> list[dict]:
    has_image_intent = _has_any(query, IMAGE_KEYWORDS)
    has_table_intent = _has_any(query, TABLE_KEYWORDS)

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
        has_image = bool(payload.get("image_url") or entity_type == "image")
        is_table = entity_type == "table" or source == "table"

        text_source_boost = 0.08 if entity_type == "text" else 0.0
        ocr_boost = 0.04 if source in {"page_ocr", "image_text", "embedded_image"} else 0.0
        content_boost = 0.03 if content else 0.0
        
        # Give images a baseline boost to compete with text, plus a large boost if the query has image intent
        image_boost = 0.10 if has_image else 0.0
        image_intent_boost = 0.25 if (has_image and has_image_intent) else 0.0
        table_boost = 0.12 if is_table else 0.0
        table_intent_boost = 0.22 if (is_table and has_table_intent) else 0.0

        final_score = (
            0.62 * normalized_vector.get(point_id, 0.0)
            + 0.50 * normalized_lexical.get(point_id, 0.0)
            + text_source_boost
            + ocr_boost
            + content_boost
            + image_boost
            + image_intent_boost
            + table_boost
            + table_intent_boost
        )

        candidate["final_score"] = final_score
        candidate["normalized_vector_score"] = normalized_vector.get(point_id, 0.0)
        candidate["normalized_lexical_score"] = normalized_lexical.get(point_id, 0.0)
        reranked.append(candidate)

    return sorted(reranked, key=lambda item: item["final_score"], reverse=True)


def _candidate_from_record(record: Any, score: float, context_role: str) -> dict:
    return {
        "id": str(record.id),
        "payload": record.payload or {},
        "vector_score": 0.0,
        "lexical_score": 0.0,
        "normalized_vector_score": 0.0,
        "normalized_lexical_score": 0.0,
        "final_score": score,
        "context_role": context_role,
    }


def _expand_with_neighbor_context(reranked: list[dict], records: list[Any]) -> list[dict]:
    """Add nearby page chunks so multi-page answers have enough surrounding context."""
    if not reranked or settings.CONTEXT_NEIGHBOR_PAGES <= 0:
        return reranked

    by_doc_page: dict[tuple[str, int], list[Any]] = {}
    for record in records:
        payload = record.payload or {}
        document_id = payload.get("document_id")
        page_number = payload.get("page_number")
        if not document_id or not isinstance(page_number, int):
            continue
        if not (payload.get("text_content") or payload.get("image_url")):
            continue
        by_doc_page.setdefault((document_id, page_number), []).append(record)

    def source_priority(record: Any) -> tuple[int, int]:
        payload = record.payload or {}
        source = payload.get("source", "")
        entity_type = payload.get("entity_type", "")
        if entity_type == "table" or source == "table":
            priority = 0
        elif source == "pdf_text":
            priority = 1
        elif source == "page_ocr":
            priority = 2
        elif source == "image_text":
            priority = 3
        elif entity_type == "image":
            priority = 4
        else:
            priority = 5
        return priority, int(payload.get("chunk_index") or 0)

    selected = []
    selected_ids = set()

    for candidate in reranked[: settings.FINAL_CONTEXT_LIMIT]:
        selected.append(candidate)
        selected_ids.add(candidate["id"])

    for anchor in reranked[: settings.FINAL_CONTEXT_LIMIT]:
        payload = anchor["payload"]
        document_id = payload.get("document_id")
        page_number = payload.get("page_number")
        if not document_id or not isinstance(page_number, int):
            continue

        for page in range(page_number - settings.CONTEXT_NEIGHBOR_PAGES, page_number + settings.CONTEXT_NEIGHBOR_PAGES + 1):
            if page < 1:
                continue

            page_records = sorted(by_doc_page.get((document_id, page), []), key=source_priority)
            for record in page_records[: settings.CONTEXT_CHUNKS_PER_PAGE]:
                record_id = str(record.id)
                if record_id in selected_ids:
                    continue
                selected_ids.add(record_id)
                selected.append(_candidate_from_record(record, anchor["final_score"] * 0.72, "neighbor_page"))

                if len(selected) >= settings.EXPANDED_CONTEXT_LIMIT:
                    return selected

    return selected


def _evidence_needs_rerank(query: str, candidates: list[dict]) -> bool:
    if not settings.ENABLE_LLM_RERANKER or not candidates:
        return False

    if _is_complex_query(query):
        return True

    direct_pages = {
        candidate["payload"].get("page_number")
        for candidate in candidates[: settings.FINAL_CONTEXT_LIMIT]
        if candidate.get("context_role", "direct_match") == "direct_match"
    }
    direct_pages.discard(None)

    if _has_any(query, MULTI_PAGE_KEYWORDS) and len(direct_pages) < 2:
        return True

    top_score = candidates[0].get("final_score", 0.0)
    return top_score < 0.35 and len(candidates) >= 8


def _extract_json_object(text: str) -> dict:
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]
    return json.loads(text)


def _response_text(response) -> str:
    if getattr(response, "text", None):
        return response.text.strip()

    texts = []
    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", []) or []:
            if getattr(part, "text", None):
                texts.append(part.text)
    return "\n".join(texts).strip()


def _candidate_excerpt(candidate: dict, max_chars: int = 900) -> str:
    payload = candidate["payload"]
    content = payload.get("text_content") or ""
    content = re.sub(r"\s+", " ", content).strip()
    if len(content) > max_chars:
        content = content[:max_chars].rsplit(" ", 1)[0] + "..."
    return content


def _llm_rerank_candidates(query: str, candidates: list[dict]) -> list[dict]:
    if not _evidence_needs_rerank(query, candidates):
        return candidates

    limited_candidates = candidates[: settings.RERANK_CANDIDATE_LIMIT]
    evidence_lines = []
    for idx, candidate in enumerate(limited_candidates, start=1):
        payload = candidate["payload"]
        evidence_lines.append(
            "\n".join([
                f"id: {candidate['id']}",
                f"rank: {idx}",
                f"page: {payload.get('page_number')}",
                f"type: {payload.get('entity_type')}",
                f"source: {payload.get('source')}",
                f"score: {round(candidate.get('final_score', 0.0), 4)}",
                f"content: {_candidate_excerpt(candidate)}",
            ])
        )

    prompt = (
        "You are reranking retrieved PDF evidence for a RAG answer. Select only "
        "evidence blocks that help answer the user question. Prefer exact values, "
        "tables, and pages that complete a multi-page answer. Return strict JSON "
        "with this shape: {\"selected_ids\": [\"id1\"], \"needs_more_context\": false}. "
        "Do not invent ids.\n\n"
        f"Question:\n{query}\n\n"
        "Evidence candidates:\n"
        + "\n\n---\n\n".join(evidence_lines)
    )

    try:
        response = call_with_retry(
            client.models.generate_content,
            model=settings.GEMINI_GENERATION_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0,
            ),
        )
        data = _extract_json_object(_response_text(response))
        selected_ids = data.get("selected_ids") or []
        if not isinstance(selected_ids, list):
            return candidates

        candidate_by_id = {candidate["id"]: candidate for candidate in candidates}
        selected = []
        selected_id_set = set()
        for point_id in selected_ids:
            point_id = str(point_id)
            if point_id in candidate_by_id and point_id not in selected_id_set:
                selected_id_set.add(point_id)
                selected.append(candidate_by_id[point_id])

        if not selected:
            return candidates

        remaining = [candidate for candidate in candidates if candidate["id"] not in selected_id_set]
        return selected[: settings.RERANK_OUTPUT_LIMIT] + remaining
    except Exception:
        logger.exception("LLM reranker failed; using deterministic ranking")
        return candidates


def _format_result(candidate: dict) -> dict:
    payload = candidate["payload"]
    entity_type = payload.get("entity_type", "text")
    result_type = "image" if entity_type == "image" else "table" if entity_type == "table" else "text"
    result = {
        "type": result_type,
        "document_id": payload.get("document_id"),
        "filename": payload.get("filename"),
        "page": payload.get("page_number"),
        "chunk": payload.get("chunk_index", 0),
        "source": payload.get("source", entity_type),
        "context_role": candidate.get("context_role", "direct_match"),
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
    queries_to_search = _expanded_queries(query=query, raw_query=raw_query)

    all_vector_points: dict[str, Any] = {}
    lexical_records = _scroll_chat_points(chat_id, settings.LEXICAL_SCAN_LIMIT)
    merged_lexical_scores: dict[str, float] = {}

    for q in queries_to_search:
        logger.info(f"[Tool Execution] Hybrid search for: '{q}' in chat '{chat_id}'")

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
        except Exception:
            logger.exception("Vector search failed; falling back to lexical results only")

        lexical_scores = _bm25_scores(q, lexical_records)
        for point_id, score in lexical_scores.items():
            merged_lexical_scores[point_id] = max(merged_lexical_scores.get(point_id, 0.0), score)

    reranked = _merge_and_rerank(
        list(all_vector_points.values()),
        lexical_records,
        merged_lexical_scores,
        query=raw_query or query,
    )

    expanded_candidates = _expand_with_neighbor_context(reranked, lexical_records)
    intelligence_mode = "complex_rerank" if _evidence_needs_rerank(raw_query or query, expanded_candidates) else "deterministic"
    final_candidates = _llm_rerank_candidates(raw_query or query, expanded_candidates)
    final_candidates = final_candidates[: settings.EXPANDED_CONTEXT_LIMIT]
    formatted_results = [_format_result(candidate) for candidate in final_candidates]
    for result in formatted_results:
        result["search_queries_used"] = queries_to_search
        result["intelligence_mode"] = intelligence_mode
    return formatted_results


def get_search_tool(chat_id: str, raw_query: str | None = None):
    def search_knowledge_base(query: str) -> list[dict]:
        """Search chat documents via hybrid retrieval (embeddings + lexical)."""
        return search_knowledge_base_direct(chat_id=chat_id, query=query, raw_query=raw_query)

    return search_knowledge_base
