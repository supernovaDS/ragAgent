import logging
from openai import AsyncOpenAI
from app.config import settings

logger = logging.getLogger(__name__)

deepseek_client = None
if settings.DEEPSEEK_API_KEY:
    deepseek_client = AsyncOpenAI(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url="https://api.deepseek.com"
    )
    logger.info("DeepSeek AsyncOpenAI client initialized.")
else:
    logger.info("DeepSeek API key is not configured. Falling back to Gemini.")
