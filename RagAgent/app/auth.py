import logging
from fastapi import Security, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt
from jwt import PyJWKClient
from app.config import settings

logger = logging.getLogger(__name__)
security = HTTPBearer()

# init JWKS client
_jwks_client = None
if settings.CLERK_JWKS_URL:
    _jwks_client = PyJWKClient(settings.CLERK_JWKS_URL)
elif not settings.DEBUG:
    raise RuntimeError(
        "CLERK_JWKS_URL must be set when DEBUG=False. "
        "JWT signature verification cannot be skipped in production."
    )

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)) -> str:
    """Extract user_id from Clerk JWT and verify signature."""
    token = credentials.credentials
    try:
        if _jwks_client:
            signing_key = _jwks_client.get_signing_key_from_jwt(token)
            decoded = jwt.decode(token, signing_key.key, algorithms=["RS256"])
        elif settings.DEBUG:
            logger.warning("JWT signature verification is DISABLED (DEBUG mode)")
            decoded = jwt.decode(token, options={"verify_signature": False})
        else:
            raise HTTPException(status_code=401, detail="Server misconfiguration: no JWKS URL")
        
        user_id = decoded.get("sub")
        
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token structure")
            
        return user_id
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")
