"""Firebase ID token verification (RS256 vs Google secure-token certs). Real body: Task 8."""
from app.support.logger import error_log


def verify_firebase_id_token(id_token: str, project_id: str) -> dict | None:
    error_log('[AuthController] Firebase ID token verification failed: not implemented yet')
    return None
