from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.database import db
from app.api import router as api_router

app = FastAPI(
    title="Agentic Multimodal RAG API",
    description="Powered by Gemini 3.1 Flash-Lite and Gemini Embedding 2",
    version="1.0.0"
)

# prevent caching on dynamic endpoints
@app.middleware("http")
async def add_cache_control_headers(request: Request, call_next):
    response: Response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/chats") or path.startswith("/api/documents"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# setup CORS
cors_origins = [origin.strip() for origin in settings.CORS_ORIGINS.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins, 
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# mount router
app.include_router(api_router)

@app.get("/health")
async def health_check():
    """Health check for API and Vector DB."""
    try:
        collection_info = db.client.get_collection(settings.QDRANT_COLLECTION_NAME)
        return {
            "status": "healthy",
            "qdrant_status": collection_info.status,
            "vector_count": collection_info.points_count
        }
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}