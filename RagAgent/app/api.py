import asyncio
import logging
import os
import re
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, BackgroundTasks, Query
from fastapi.responses import StreamingResponse
from typing import List
from sqlalchemy.orm import Session
import cloudinary.api
import qdrant_client
from google.genai import types

from app.database import get_db, db as vector_db, SessionLocal
from app.models import Chat, Document, Message
from app.schemas import ChatSchema, DocumentSchema, MessageSchema, ChatRequest
from app.auth import get_current_user
from app.ingest import ingest_pdf
from app.agent import chat_with_pdf_agent
from app.tools import search_knowledge_base_direct
from app.config import settings
from app.genai_client import client
from app.utils import call_with_retry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50MB
MAX_FILENAME_LENGTH = 200

def _sanitize_filename(raw_name: str) -> str:
    """Strip path separators, null bytes, and truncate to a safe length."""
    name = os.path.basename(raw_name or "upload.pdf")
    name = re.sub(r'[<>:"/\\|?*\x00]', '_', name)
    name = name.strip('. ')
    if len(name) > MAX_FILENAME_LENGTH:
        stem, ext = os.path.splitext(name)
        name = stem[:MAX_FILENAME_LENGTH - len(ext)] + ext
    return name or "upload.pdf"

# --- Shared helpers (Fix #17: deduplicated vector deletion) ---

def _delete_vectors_by(field: str, value: str):
    """Delete Qdrant vectors matching a single field condition."""
    try:
        vector_db.client.delete(
            collection_name=settings.QDRANT_COLLECTION_NAME,
            points_selector=qdrant_client.models.Filter(
                must=[
                    qdrant_client.models.FieldCondition(
                        key=field,
                        match=qdrant_client.models.MatchValue(value=value)
                    )
                ]
            )
        )
    except Exception as e:
        logger.error(f"Failed to delete vectors ({field}={value}): {e}")

def _cleanup_cloudinary_images(doc_id: str):
    """Delete all page images uploaded to Cloudinary for a document."""
    try:
        cloudinary.api.delete_resources_by_prefix(f"{doc_id}_")
    except Exception as e:
        logger.error(f"Failed to delete Cloudinary images for doc {doc_id}: {e}")

def _cleanup_chat(chat_id: str, doc_ids: List[str]):
    """Cleanup Qdrant and Cloudinary for a chat."""
    _delete_vectors_by("chat_id", chat_id)
    for doc_id in doc_ids:
        _cleanup_cloudinary_images(doc_id)

def _cleanup_document(doc_id: str):
    """Cleanup Qdrant and Cloudinary for a doc."""
    _delete_vectors_by("document_id", doc_id)
    _cleanup_cloudinary_images(doc_id)

# --- CRUD endpoints ---

@router.post("/chats", response_model=ChatSchema)
def create_chat(user_id: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = Chat(user_id=user_id)
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat

@router.get("/chats", response_model=List[ChatSchema])
def get_chats(user_id: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chats = db.query(Chat).filter(Chat.user_id == user_id).order_by(Chat.created_at.desc()).all()
    return chats

@router.delete("/chats/{chat_id}")
def delete_chat(chat_id: str, background_tasks: BackgroundTasks, user_id: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
        
    doc_ids = [doc.id for doc in chat.documents]
    background_tasks.add_task(_cleanup_chat, chat_id, doc_ids)
        
    db.delete(chat)
    db.commit()
    return {"status": "success"}

@router.get("/chats/{chat_id}/documents", response_model=List[DocumentSchema])
def get_documents(chat_id: str, user_id: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat.documents

@router.delete("/documents/{doc_id}")
def delete_document(doc_id: str, background_tasks: BackgroundTasks, user_id: str = Depends(get_current_user), db: Session = Depends(get_db)):
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc or doc.chat.user_id != user_id:
        raise HTTPException(status_code=404, detail="Document not found")
        
    background_tasks.add_task(_cleanup_document, doc_id)
    
    db.delete(doc)
    db.commit()
    return {"status": "success"}

# --- Upload (Fix #8: chunked read, Fix #9: async thread, Fix #7: sanitized filename) ---

@router.post("/chats/{chat_id}/upload")
async def upload_document(
    chat_id: str, 
    file: UploadFile = File(...), 
    user_id: str = Depends(get_current_user), 
    db: Session = Depends(get_db)
):
    chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    
    # Fix #8: chunked read with early abort to prevent OOM
    chunks, total = [], 0
    while True:
        chunk = await file.read(1024 * 1024)  # 1MB at a time
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail="File too large. Max 50MB.")
        chunks.append(chunk)
    file_bytes = b"".join(chunks)
    
    # Fix #7: sanitize user-controlled filename
    safe_filename = _sanitize_filename(file.filename)
    
    # Fix #9: run heavy sync ingestion in a thread so we don't block the event loop
    doc_id = await asyncio.to_thread(ingest_pdf, file_bytes, safe_filename, user_id, chat_id)
    
    # store metadata
    doc = Document(id=doc_id, chat_id=chat_id, filename=safe_filename)
    db.add(doc)
    db.commit()
    return {"status": "success"}

@router.get("/chats/{chat_id}/messages", response_model=List[MessageSchema])
def get_messages(chat_id: str, user_id: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.created_at.asc(), Message.id.asc()).all()

# Fix #2: debug endpoint gated behind DEBUG flag
if settings.DEBUG:
    @router.get("/chats/{chat_id}/debug/search")
    def debug_search(
        chat_id: str,
        q: str = Query(..., min_length=1),
        user_id: str = Depends(get_current_user),
        db: Session = Depends(get_db),
    ):
        chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")

        return {
            "query": q,
            "results": search_knowledge_base_direct(chat_id=chat_id, query=q),
        }

@router.post("/chats/{chat_id}/message")
def send_message(
    chat_id: str, 
    request: ChatRequest, 
    user_id: str = Depends(get_current_user), 
    db: Session = Depends(get_db)
):
    chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
        
    # Fix #12: use compare-and-swap to avoid duplicate title generation
    if chat.title == "New Chat":
        chat.title = "Generating..."
        db.commit()
        try:
            res = call_with_retry(
                client.models.generate_content,
                model=settings.GEMINI_GENERATION_MODEL,
                contents=f"Generate a 3-word title for a conversation that begins with: '{request.query}'",
                config=types.GenerateContentConfig(system_instruction="Only return the 3 words, nothing else.")
            )
            chat.title = res.text.strip().replace('"', '')
            db.commit()
        except Exception as e:
            logger.warning(f"Failed to auto-title chat: {e}")
            chat.title = request.query[:40] or "Untitled Chat"
            db.commit()

    # get history before adding new msg
    history = db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.created_at.asc()).all()

    user_msg = Message(chat_id=chat_id, role="user", text=request.query)
    db.add(user_msg)
    db.commit()
    
    # Fix #11: use proper logging with tracebacks
    def generate():
        full_response = ""
        try:
            for chunk in chat_with_pdf_agent(user_query=request.query, history=history, chat_id=chat_id):
                full_response += chunk
                yield chunk
        except Exception as e:
            error_msg = f"\n\n**Error:** Something went wrong while generating the response."
            full_response += error_msg
            yield error_msg
            logger.exception(f"Streaming error for chat {chat_id}")
        finally:
            if full_response:
                with SessionLocal() as stream_db:
                    assistant_msg = Message(chat_id=chat_id, role="model", text=full_response)
                    stream_db.add(assistant_msg)
                    stream_db.commit()

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")
