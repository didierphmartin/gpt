"""Port of AuthController::googleSecureTokenKeys() + verifyFirebaseIdToken()."""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import httpx
import jwt
from cryptography import x509

CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
CACHE_FILE = Path(tempfile.gettempdir()) / 'gpt_firebase_securetoken_certs.json'
CACHE_TTL = 3600


def _default_fetch() -> dict:
    r = httpx.get(CERTS_URL, timeout=10)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict) or not data:
        raise RuntimeError('Unable to fetch Google secure token certificates')
    return data


def google_secure_token_certs(fetch_certs=None) -> dict:
    certs = None
    try:
        if CACHE_FILE.is_file() and (time.time() - CACHE_FILE.stat().st_mtime) < CACHE_TTL:
            decoded = json.loads(CACHE_FILE.read_text())
            if isinstance(decoded, dict) and decoded:
                certs = decoded
    except (OSError, ValueError):
        certs = None
    if certs is None:
        certs = (fetch_certs or _default_fetch)()
        try:
            CACHE_FILE.write_text(json.dumps(certs))
        except OSError:
            pass
    return certs


def verify_firebase_id_token(id_token: str, project_id: str, *, fetch_certs=None) -> dict | None:
    from app.support.logger import error_log
    try:
        certs = google_secure_token_certs(fetch_certs)
        kid = jwt.get_unverified_header(id_token).get('kid')
        pem = certs.get(kid)
        if not pem:
            raise jwt.InvalidTokenError('unknown kid')
        public_key = x509.load_pem_x509_certificate(pem.encode()).public_key()
        claims = jwt.decode(id_token, public_key, algorithms=['RS256'], options={'verify_aud': False})
        if claims.get('aud', '') != project_id:
            return None
        if claims.get('iss', '') != 'https://securetoken.google.com/' + project_id:
            return None
        if str(claims.get('sub', '') or '') == '':
            return None
        return claims
    except Exception as e:  # noqa: BLE001
        error_log(f'[AuthController] Firebase ID token verification failed: {e}')
        return None
