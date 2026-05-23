import uuid
import re
import fitz  # PyMuPDF
import cloudinary.uploader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from google.genai import types
from qdrant_client.models import PointStruct

from app.config import settings
from app.database import db
from app.genai_client import client


def get_multimodal_embedding(content: bytes | str, is_image: bool = False, mime_type: str = "image/png") -> list[float]:
    """Generates a 3072-dimensional vector for either text or image bytes."""
    if is_image:
        part = types.Part.from_bytes(data=content, mime_type=mime_type)
        config = None
    else:
        part = content
        config = types.EmbedContentConfig(
            task_type="RETRIEVAL_DOCUMENT"
        )

    response = client.models.embed_content(
        model="gemini-embedding-2-preview",
        contents=part,
        config=config
    )
    return response.embeddings[0].values

def get_multimodal_embeddings_batch(contents_list: list[str]) -> list[list[float]]:
    """Generates embeddings for a batch of strings."""
    if not contents_list:
        return []
    
    response = client.models.embed_content(
        model="gemini-embedding-2-preview",
        contents=contents_list,
        config=types.EmbedContentConfig(
            task_type="RETRIEVAL_DOCUMENT"
        )
    )
    return [emb.values for emb in response.embeddings]

def _extract_response_text(response) -> str:
    if getattr(response, "text", None):
        return response.text.strip()

    texts = []
    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", []) or []:
            if getattr(part, "text", None):
                texts.append(part.text)
    return "\n".join(texts).strip()

def _clean_extracted_text(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def _extract_page_text(page: fitz.Page) -> str:
    """Extract text in reading order as well as PyMuPDF can provide it."""
    try:
        text = page.get_text("text", sort=True)
    except TypeError:
        text = page.get_text()
    return _clean_extracted_text(text)

def _render_page_png(page: fitz.Page, dpi: int = 180) -> bytes:
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
    return pix.tobytes("png")

def _extract_text_from_image_bytes(image_bytes: bytes, mime_type: str, prompt: str) -> str:
    """Use the configured Gemini generation model as OCR/caption fallback."""
    response = client.models.generate_content(
        model=settings.GEMINI_GENERATION_MODEL,
        contents=[
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text=prompt),
                    types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                ],
            )
        ],
    )
    return _clean_extracted_text(_extract_response_text(response))

def _ocr_page_if_needed(page: fitz.Page, extracted_text: str) -> str:
    if not settings.ENABLE_GEMINI_OCR:
        return ""
    if len(extracted_text.strip()) >= settings.OCR_TEXT_MIN_CHARS:
        return ""

    try:
        page_png = _render_page_png(page)
        return _extract_text_from_image_bytes(
            page_png,
            "image/png",
            (
                "Extract all readable text from this PDF page. Preserve important "
                "labels, numbers, table-like rows, headings, and bullet points. "
                "Return only the extracted text. If no text is visible, return an empty string."
            ),
        )
    except Exception as e:
        print(f"Gemini OCR failed for page {page.number + 1}: {e}")
        return ""

def _describe_image_for_search(image_bytes: bytes, mime_type: str) -> str:
    if not settings.ENABLE_IMAGE_TEXT_EXTRACTION:
        return ""

    try:
        return _extract_text_from_image_bytes(
            image_bytes,
            mime_type,
            (
                "Extract any readable text from this image and add a concise factual "
                "description of the image. Preserve labels, legend text, axis names, "
                "numbers, and table values. Return only searchable content."
            ),
        )
    except Exception as e:
        print(f"Image text extraction failed: {e}")
        return ""

def _add_text_chunks(
    text_chunks_metadata: list[dict],
    splitter: RecursiveCharacterTextSplitter,
    text: str,
    page_number: int,
    source: str,
    image_url: str | None = None,
):
    cleaned = _clean_extracted_text(text)
    if not cleaned:
        return

    chunks = splitter.split_text(cleaned)
    for chunk_idx, chunk_text in enumerate(chunks):
        text_chunks_metadata.append({
            "text": chunk_text,
            "page_number": page_number,
            "chunk_index": chunk_idx,
            "source": source,
            "image_url": image_url,
        })

def ingest_pdf(file_bytes: bytes, filename: str, user_id: str, chat_id: str) -> str:
    """
    1. Extracts text and images from the PDF using PyMuPDF.
    2. Generates multimodal embeddings using Gemini 2.
    3. Uploads images to Cloudinary.
    4. Upserts the embeddings into Qdrant Cloud.
    Returns the unique document ID.
    """
    doc_id = str(uuid.uuid4())
    print(f"Starting ingestion for document {doc_id} (Chat: {chat_id})")
    
    # Open the PDF from raw bytes
    pdf_document = fitz.open(stream=file_bytes, filetype="pdf")
    
    try:
        points = []
        text_chunks_metadata = []
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        
        for page_num in range(len(pdf_document)):
            page = pdf_document.load_page(page_num)
            
            # --- 1. Extract and Collect Text Chunks ---
            page_number = page_num + 1
            text_content = _extract_page_text(page)
            _add_text_chunks(
                text_chunks_metadata,
                text_splitter,
                text_content,
                page_number,
                source="pdf_text",
            )

            page_ocr_text = _ocr_page_if_needed(page, text_content)
            if page_ocr_text:
                _add_text_chunks(
                    text_chunks_metadata,
                    text_splitter,
                    page_ocr_text,
                    page_number,
                    source="page_ocr",
                )
                
            # --- 2. Extract and Embed Images ---
            image_list = page.get_images(full=True)
            for img_index, img_info in enumerate(image_list):
                xref = img_info[0]
                try:
                    base_image = pdf_document.extract_image(xref)
                    image_bytes_data = base_image["image"]
                    img_ext = base_image.get("ext", "png")
                    mime_type = f"image/{img_ext}"
                    
                    # Upload the extracted image bytes directly to Cloudinary
                    public_id = f"{doc_id}_page{page_num+1}_img{img_index}"
                    upload_result = cloudinary.uploader.upload(
                        image_bytes_data, 
                        public_id=public_id,
                        resource_type="image"
                    )
                    image_url = upload_result["secure_url"]
                    image_search_text = _describe_image_for_search(image_bytes_data, mime_type)
                    
                    vector = get_multimodal_embedding(image_bytes_data, is_image=True, mime_type=mime_type)
                    
                    points.append(
                        PointStruct(
                            id=str(uuid.uuid4()),
                            vector=vector,
                            payload={
                                "document_id": doc_id,
                                "page_number": page_num + 1,
                                "chunk_index": img_index,
                                "entity_type": "image",
                                "text_content": image_search_text or None,
                                "image_url": image_url,
                                "source": "embedded_image",
                                "filename": filename,
                                "user_id": user_id,
                                "chat_id": chat_id
                            }
                        )
                    )

                    if image_search_text:
                        _add_text_chunks(
                            text_chunks_metadata,
                            text_splitter,
                            image_search_text,
                            page_number,
                            source="image_text",
                            image_url=image_url,
                        )
                except Exception as e:
                    print(f"Failed to process image {img_index} on page {page_num + 1}: {e}")
                
        # Now batch process all text chunks safely
        batch_size = 100
        if text_chunks_metadata:
            print(f"Batch embedding {len(text_chunks_metadata)} text chunks...")
            for i in range(0, len(text_chunks_metadata), batch_size):
                batch = text_chunks_metadata[i:i + batch_size]
                batch_texts = [item["text"] for item in batch]
                
                embeddings = get_multimodal_embeddings_batch(batch_texts)
                
                for item, vector in zip(batch, embeddings):
                    points.append(
                        PointStruct(
                            id=str(uuid.uuid4()),
                            vector=vector,
                            payload={
                                "document_id": doc_id,
                                "page_number": item["page_number"],
                                "chunk_index": item["chunk_index"],
                                "entity_type": "text",
                                "text_content": item["text"],
                                "image_url": item.get("image_url"),
                                "source": item.get("source", "pdf_text"),
                                "filename": filename,
                                "user_id": user_id,
                                "chat_id": chat_id
                            }
                        )
                    )

        # Upsert all collected points to Qdrant Cloud
        if points:
            print(f"Upserting {len(points)} vectors to Qdrant...")
            db.client.upsert(
                collection_name=settings.QDRANT_COLLECTION_NAME,
                points=points
            )
            print("Upsert complete.")
            
        return doc_id
    finally:
        pdf_document.close()
