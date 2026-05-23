from fastapi import Security, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt
from jwt import PyJWKClient
from app.config import settings

security = HTTPBearer()

# Initialize JWKS client for Clerk signature verification
_jwks_client = None
if settings.CLERK_JWKS_URL:
    _jwks_client = PyJWKClient(settings.CLERK_JWKS_URL)

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)) -> str:
    """
    Extracts the user_id (sub) from the Clerk JWT.
    Verifies the JWT signature using Clerk's public JWKS keys.
    """
    token = credentials.credentials
    try:
        if _jwks_client:
            # Production: verify signature with Clerk's JWKS
            signing_key = _jwks_client.get_signing_key_from_jwt(token)
            decoded = jwt.decode(token, signing_key.key, algorithms=["RS256"])
        else:
            # Development fallback: no JWKS URL configured
            decoded = jwt.decode(token, options={"verify_signature": False})
        
        user_id = decoded.get("sub")
        
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token structure")
            
        return user_id
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")
