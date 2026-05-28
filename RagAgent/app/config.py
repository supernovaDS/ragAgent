import cloudinary
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    GEMINI_API_KEY: str
    GEMINI_GENERATION_MODEL: str = "gemini-3.1-flash-lite"
    QDRANT_URL: str
    QDRANT_API_KEY: str
    QDRANT_COLLECTION_NAME: str = "pdf_knowledge_base"
    CLOUDINARY_CLOUD_NAME: str
    CLOUDINARY_API_KEY: str
    CLOUDINARY_API_SECRET: str
    SUPABASE_DATABASE_URL: str
    CLERK_SECRET_KEY: str
    CLERK_JWKS_URL: str = ""
    # Override this with your production domain(s) when deploying — never use "*"
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:5174,http://localhost:3000"
    # Set to False in production to enforce JWT verification and hide debug endpoints
    DEBUG: bool = True
    
    # Hardcoded 3072 dims for Gemini Embedding 2
    VECTOR_DIMENSION: int = 3072 
    
    # retrieval knobs (favor recall)
    VECTOR_SEARCH_LIMIT: int = 50
    FINAL_CONTEXT_LIMIT: int = 15
    EXPANDED_CONTEXT_LIMIT: int = 24
    LEXICAL_SCAN_LIMIT: int = 2500
    CONTEXT_NEIGHBOR_PAGES: int = 1
    CONTEXT_CHUNKS_PER_PAGE: int = 3
    TABLE_CHUNK_MAX_CHARS: int = 6000
    ENABLE_RULE_BASED_QUERY_EXPANSION: bool = True
    MAX_EXPANDED_SEARCH_QUERIES: int = 4
    ENABLE_LLM_RERANKER: bool = True
    RERANK_CANDIDATE_LIMIT: int = 30
    RERANK_OUTPUT_LIMIT: int = 18
    ENABLE_GEMINI_OCR: bool = True
    ENABLE_IMAGE_TEXT_EXTRACTION: bool = True
    OCR_TEXT_MIN_CHARS: int = 80

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()

cloudinary.config(
    cloud_name=settings.CLOUDINARY_CLOUD_NAME,
    api_key=settings.CLOUDINARY_API_KEY,
    api_secret=settings.CLOUDINARY_API_SECRET,
    secure=True
)
