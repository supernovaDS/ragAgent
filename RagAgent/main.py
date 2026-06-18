from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import logging
from app.config import settings
from app.database import db
from app.api import router as api_router

logger = logging.getLogger(__name__)

# rate limiting — keyed by IP
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])

app = FastAPI(
    title="Agentic Multimodal RAG API",
    description="Powered by Gemini 3.1 Flash-Lite and Gemini Embedding 2",
    version="1.0.0",
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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
@limiter.exempt
async def health_check():
    """Health check — returns only status. Internal details are logged server-side."""
    try:
        collection_info = db.client.get_collection(settings.QDRANT_COLLECTION_NAME)
        logger.info(f"Health OK — qdrant={collection_info.status}, vectors={collection_info.points_count}")
        return {"status": "healthy"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {"status": "unhealthy"}