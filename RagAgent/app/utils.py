import time
import random
import logging
from google.genai.errors import ClientError

logger = logging.getLogger(__name__)

def call_with_retry(api_func, *args, **kwargs):
    """
    Executes a Gemini API function with exponential backoff and jitter 
    if a 429 RESOURCE_EXHAUSTED rate limit exception occurs.
    """
    max_retries = 6
    base_delay = 2.0
    
    for attempt in range(max_retries):
        try:
            return api_func(*args, **kwargs)
        except ClientError as e:
            # Detect 429 Rate Limit error
            is_rate_limit = (
                getattr(e, "code", None) == 429 or
                "RESOURCE_EXHAUSTED" in str(e) or
                "quota" in str(e).lower() or
                "limit" in str(e).lower()
            )
            
            if is_rate_limit and attempt < max_retries - 1:
                # Exponential backoff with random jitter (+/- 0.5s to 1.5s)
                delay = (base_delay * (2 ** attempt)) + random.uniform(0.5, 1.5)
                logger.warning(
                    f"[Gemini Rate Limit] Hit 429 (Resource Exhausted). "
                    f"Retrying in {delay:.2f}s... (Attempt {attempt + 1}/{max_retries})"
                )
                time.sleep(delay)
                continue
            
            # Re-raise actual client exception if we are out of retries or not a rate limit
            raise e
