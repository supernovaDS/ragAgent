from google.genai import types

from app.tools import get_search_tool
from app.models import Message
from app.genai_client import client
from app.config import settings

SYSTEM_PROMPT = (
    "You are an AI assistant answering questions about uploaded documents. The system "
    "will provide retrieved document context before you answer. Base your document "
    "answer only on that context. Cite page numbers like [p. 3] for claims from the "
    "documents. If the provided context does not contain enough evidence, say that the "
    "information was not found in the uploaded documents before adding any general "
    "knowledge.\n\n"
    "IMPORTANT: Only answer the user's latest (most recent) query. Do not re-answer "
    "previous questions from the chat history. Use the chat history only for context.\n\n"
    "*** CRITICAL INSTRUCTION FOR IMAGES AND LINKS ***\n"
    "1. You should ONLY display images using the Markdown syntax `![Description](image_url)` "
    "if there is an explicit, Cloudinary-hosted `image_url` field provided in the retrieved image results context.\n"
    "2. NEVER wrap standard webpage URLs, hyperlinks, or Wikipedia/Wikimedia links found within the body text of "
    "documents in an image tag `![...](url)`. Doing so causes broken image rendering errors in the chat.\n"
    "3. If you want to refer the user to a webpage or external link mentioned in the document body, write it as a "
    "standard clickable hyperlink using `[Link Text](url)` instead of an image tag. Do NOT use `!` before the bracket.\n"
    "4. Do NOT forcefully display images if they do not match the user's query or are not required."
)

def _extract_text_from_response(response_chunk) -> str:
    """Extracts non-thought text from a chunk."""
    texts = []
    if response_chunk.candidates:
        content = response_chunk.candidates[0].content
        if content and getattr(content, "parts", None):
            for part in content.parts:
                # skip thinking parts (they leak garbage tokens)
                if getattr(part, 'thought', False):
                    continue
                if part.text:
                    texts.append(part.text)
    return "".join(texts)

def _format_retrieved_context(results: list[dict]) -> str:
    if not results:
        return "No document evidence was retrieved for this query."

    blocks = []
    for idx, result in enumerate(results, start=1):
        page = result.get("page")
        source = result.get("source") or result.get("type")
        score = result.get("relevance_score")
        filename = result.get("filename") or "uploaded document"
        header = (
            f"[Evidence {idx}] filename={filename}; page={page}; "
            f"source={source}; relevance={score}"
        )

        content = result.get("content") or ""
        if result.get("type") == "image":
            image_url = result.get("image_url")
            content = content or "Image result with no extracted text."
            if image_url:
                content = f"{content}\nimage_url={image_url}"

        blocks.append(f"{header}\n{content}".strip())

    return "\n\n".join(blocks)


def chat_with_pdf_agent(user_query: str, chat_id: str, history: list[Message] = None):
    """
    Main agent reasoning loop. Connects the model to tools and streams the answer.
    """
    print(f"\n[User] {user_query}")
    
    # get isolated tool for this chat
    search_knowledge_base = get_search_tool(chat_id, raw_query=user_query)
    # 1. Initialize conversation history
    contents = []
    
    # append history
    if history:
        for msg in history:
            contents.append(
                types.Content(
                    role=msg.role,
                    parts=[types.Part.from_text(text=msg.text)]
                )
            )
            
    # always search deterministically to avoid missing evidence
    tool_results = search_knowledge_base(query=user_query)
    retrieved_context = _format_retrieved_context(tool_results)

    contents.append(
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=(
                        f"Latest user question:\n{user_query}\n\n"
                        f"Retrieved document context:\n{retrieved_context}\n\n"
                        "Answer the latest user question using the retrieved context. "
                        "Cite pages for document-supported facts."
                    )
                )
            ],
        )
    )

    print("[Agent] Synthesizing final answer from retrieved context...")
    final_response = client.models.generate_content_stream(
        model=settings.GEMINI_GENERATION_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT),
    )
    for chunk in final_response:
        text = _extract_text_from_response(chunk)
        if text:
            yield text
