import uuid
import re
from concurrent.futures import ThreadPoolExecutor
import fitz  # PyMuPDF
import cloudinary.uploader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from google.genai import types
from qdrant_client.models import PointStruct

from app.config import settings
from app.database import db
from app.genai_client import client
from app.utils import call_with_retry


def get_multimodal_embedding(content: bytes | str, is_image: bool = False, mime_type: str = "image/png") -> list[float]:
    """Generate embedding for text/image"""
    if is_image:
        part = types.Part.from_bytes(data=content, mime_type=mime_type)
        config = None
    else:
        part = content
        config = types.EmbedContentConfig(
            task_type="RETRIEVAL_DOCUMENT"
        )

    response = call_with_retry(
        client.models.embed_content,
        model="gemini-embedding-2-preview",
        contents=part,
        config=config
    )
    return response.embeddings[0].values

def get_multimodal_embeddings_batch(contents_list: list[str]) -> list[list[float]]:
    """Generate embeddings batch"""
    if not contents_list:
        return []
    
    # Wrap each string in a separate types.Content object so Gemini generates an embedding for each document
    wrapped_contents = [
        types.Content(parts=[types.Part.from_text(text=text)])
        for text in contents_list
    ]
    
    response = call_with_retry(
        client.models.embed_content,
        model="gemini-embedding-2-preview",
        contents=wrapped_contents,
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
    """Extract text from page"""
    try:
        text = page.get_text("text", sort=True)
    except TypeError:
        text = page.get_text()
    return _clean_extracted_text(text)

def _render_page_png(page: fitz.Page, dpi: int = 180) -> bytes:
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
    return pix.tobytes("png")

def _extract_text_from_image_bytes(image_bytes: bytes, mime_type: str, prompt: str) -> str:
    """Fallback to Gemini for OCR/caption"""
    response = call_with_retry(
        client.models.generate_content,
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

def _ocr_page_from_bytes(page_png: bytes, page_number: int) -> tuple[int, str]:
    try:
        ocr_text = _extract_text_from_image_bytes(
            page_png,
            "image/png",
            (
                "Extract all readable text from this PDF page. Preserve important "
                "labels, numbers, table-like rows, headings, and bullet points. "
                "Return only the extracted text. If no text is visible, return an empty string."
            ),
        )
        return page_number, ocr_text
    except Exception as e:
        print(f"Gemini OCR failed for page {page_number}: {e}")
        return page_number, ""

def _process_single_image(
    image_bytes_data: bytes,
    mime_type: str,
    doc_id: str,
    page_number: int,
    img_index: int,
    filename: str,
    user_id: str,
    chat_id: str,
) -> dict | None:
    try:
        # Fix #4: scope uploads into a user folder for access isolation
        folder = f"ragagent/{user_id}"
        public_id = f"{doc_id}_page{page_number}_img{img_index}"
        upload_result = cloudinary.uploader.upload(
            image_bytes_data, 
            public_id=public_id,
            folder=folder,
            resource_type="image"
        )
        image_url = upload_result["secure_url"]
        image_search_text = _describe_image_for_search(image_bytes_data, mime_type)
        vector = get_multimodal_embedding(image_bytes_data, is_image=True, mime_type=mime_type)
        
        return {
            "vector": vector,
            "image_url": image_url,
            "text_content": image_search_text or None,
            "page_number": page_number,
            "chunk_index": img_index,
            "filename": filename,
            "user_id": user_id,
            "chat_id": chat_id,
        }
    except Exception as e:
        print(f"Failed to process image {img_index} on page {page_number}: {e}")
        return None

def ingest_pdf(file_bytes: bytes, filename: str, user_id: str, chat_id: str) -> str:
    """Ingest PDF: extract text/images, embed, upload to Cloudinary & Qdrant, return doc ID."""
    doc_id = str(uuid.uuid4())
    print(f"Starting ingestion for document {doc_id} (Chat: {chat_id})")
    
    # load PDF
    pdf_document = fitz.open(stream=file_bytes, filetype="pdf")
    
    try:
        points = []
        text_chunks_metadata = []
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        
        ocr_futures = []
        image_futures = []

        with ThreadPoolExecutor(max_workers=8) as executor:
            # 1. Page processing loop (Extract text & submit OCR)
            for page_num in range(len(pdf_document)):
                page = pdf_document.load_page(page_num)
                page_number = page_num + 1
                text_content = _extract_page_text(page)
                
                _add_text_chunks(
                    text_chunks_metadata,
                    text_splitter,
                    text_content,
                    page_number,
                    source="pdf_text",
                )

                # Check if OCR is needed
                if settings.ENABLE_GEMINI_OCR and len(text_content.strip()) < settings.OCR_TEXT_MIN_CHARS:
                    try:
                        page_png = _render_page_png(page)
                        future = executor.submit(_ocr_page_from_bytes, page_png, page_number)
                        ocr_futures.append(future)
                    except Exception as render_err:
                        print(f"Failed to render page {page_number} for OCR: {render_err}")
                
                # 2. Image extraction on main thread and submit to worker
                try:
                    image_list = page.get_images(full=True)
                except Exception as img_err:
                    print(f"Failed to list images on page {page_number}: {img_err}")
                    image_list = []

                for img_index, img_info in enumerate(image_list):
                    xref = img_info[0]
                    try:
                        base_image = pdf_document.extract_image(xref)
                        image_bytes_data = base_image["image"]
                        img_ext = base_image.get("ext", "png")
                        mime_type = f"image/{img_ext}"
                        
                        future = executor.submit(
                            _process_single_image,
                            image_bytes_data,
                            mime_type,
                            doc_id,
                            page_number,
                            img_index,
                            filename,
                            user_id,
                            chat_id
                        )
                        image_futures.append(future)
                    except Exception as e:
                        print(f"Failed to extract image {img_index} on page {page_number}: {e}")

            # Wait for OCR tasks to finish
            for future in ocr_futures:
                try:
                    res = future.result()
                    if res:
                        p_num, ocr_text = res
                        if ocr_text:
                            _add_text_chunks(
                                text_chunks_metadata,
                                text_splitter,
                                ocr_text,
                                p_num,
                                source="page_ocr",
                            )
                except Exception as exc:
                    print(f"OCR future generated an exception: {exc}")

            # Wait for image tasks to finish
            for future in image_futures:
                try:
                    img_res = future.result()
                    if img_res:
                        # Construct PointStruct
                        points.append(
                            PointStruct(
                                id=str(uuid.uuid4()),
                                vector=img_res["vector"],
                                payload={
                                    "document_id": doc_id,
                                    "page_number": img_res["page_number"],
                                    "chunk_index": img_res["chunk_index"],
                                    "entity_type": "image",
                                    "text_content": img_res["text_content"],
                                    "image_url": img_res["image_url"],
                                    "source": "embedded_image",
                                    "filename": img_res["filename"],
                                    "user_id": img_res["user_id"],
                                    "chat_id": img_res["chat_id"]
                                }
                            )
                        )
                        # Add image description chunks for text search
                        if img_res["text_content"]:
                            _add_text_chunks(
                                text_chunks_metadata,
                                text_splitter,
                                img_res["text_content"],
                                img_res["page_number"],
                                source="image_text",
                                image_url=img_res["image_url"],
                            )
                except Exception as exc:
                    print(f"Image processing future generated an exception: {exc}")

        # batch process text chunks
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

        # upsert to Qdrant
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
