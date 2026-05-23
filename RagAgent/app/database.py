import logging
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import qdrant_client
from qdrant_client.models import VectorParams, Distance
from app.config import settings
from app.models import Base

# --- Supabase PostgreSQL Setup ---
# Use the URI provided by the user in the .env file
engine = create_engine(settings.SUPABASE_DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Automatically create all SQL tables in Supabase if they don't exist
Base.metadata.create_all(bind=engine)

# Dependency to get DB session
def get_db():
    db_session = SessionLocal()
    try:
        yield db_session
    finally:
        db_session.close()

# --- Qdrant Vector DB Setup ---
logger = logging.getLogger(__name__)

class VectorDatabase:
    def __init__(self):
        logger.info("Connecting to Qdrant Cloud...")
        self.client = qdrant_client.QdrantClient(
            url=settings.QDRANT_URL,
            api_key=settings.QDRANT_API_KEY,
        )
        self.collection_name = settings.QDRANT_COLLECTION_NAME
        self._ensure_collection_exists()

    def _ensure_collection_exists(self):
        """Creates the 3072-dimensional collection if it doesn't exist."""
        if not self.client.collection_exists(self.collection_name):
            logger.info(f"Creating new Qdrant collection: {self.collection_name}")
            self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config=VectorParams(
                    size=settings.VECTOR_DIMENSION, 
                    distance=Distance.COSINE
                )
            )
            self.client.create_payload_index(
                collection_name=self.collection_name,
                field_name="chat_id",
                field_schema=qdrant_client.models.PayloadSchemaType.KEYWORD
            )
            self.client.create_payload_index(
                collection_name=self.collection_name,
                field_name="document_id",
                field_schema=qdrant_client.models.PayloadSchemaType.KEYWORD
            )
            self.client.create_payload_index(
                collection_name=self.collection_name,
                field_name="entity_type",
                field_schema=qdrant_client.models.PayloadSchemaType.KEYWORD
            )
        else:
            logger.info(f"Connected to existing collection: {self.collection_name}")
            for field_name in ("chat_id", "document_id", "entity_type"):
                try:
                    self.client.create_payload_index(
                        collection_name=self.collection_name,
                        field_name=field_name,
                        field_schema=qdrant_client.models.PayloadSchemaType.KEYWORD
                    )
                except Exception:
                    pass

# Singleton instance to import into your FastAPI routes
db = VectorDatabase()
