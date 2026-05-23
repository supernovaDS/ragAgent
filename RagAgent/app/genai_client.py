from google import genai
from app.config import settings

# Shared GenAI client — single instance reused across the entire app
client = genai.Client(api_key=settings.GEMINI_API_KEY)
