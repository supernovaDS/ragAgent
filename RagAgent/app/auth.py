from fastapi import Security, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt
from jwt import PyJWKClient
from app.config import settings

security = HTTPBearer()

# init JWKS client
_jwks_client = None
if settings.CLERK_JWKS_URL:
    _jwks_client = PyJWKClient(settings.CLERK_JWKS_URL)

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)) -> str:
    """Extract user_id from Clerk JWT and verify signature."""
    token = credentials.credentials
    try:
        if _jwks_client:
            # prod: verify signature
            signing_key = _jwks_client.get_signing_key_from_jwt(token)
            decoded = jwt.decode(token, signing_key.key, algorithms=["RS256"])
        else:
            # dev fallback
            decoded = jwt.decode(token, options={"verify_signature": False})
        
        user_id = decoded.get("sub")
        
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token structure")
            
        return user_id
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")
