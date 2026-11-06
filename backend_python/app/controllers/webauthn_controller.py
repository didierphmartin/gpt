"""Port of Controllers/WebAuthnController.php: passkey sign-in verifies the assertion before issuing a token."""
from __future__ import annotations

import binascii
import hashlib
import hmac
import json
import re
import secrets
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from app.controllers.auth_controller import generate_tokens
from app.services import edition
from app.support.logger import error_log
from app.support.phpcompat import b64url_encode, php_empty, php_now

CHALLENGE_EXPIRY = 120

# authenticatorData flags: user present, user verified
FLAG_UP = 0x01
FLAG_UV = 0x04


class WebAuthnController:
    """Registering, deleting and signing in with passkeys. authenticate() checks the
    single-use challenge, origin, rpId hash, user verification and the signature
    against the stored public key (ES256 or RS256)."""

    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        auth = config.get('auth') or {}
        self.jwt_secret = str(auth.get('jwt_secret', '') or '')
        if self.jwt_secret == '':
            raise RuntimeError('JWT secret is not configured (set JWT_SECRET).')
        self.jwt_expiry = int(auth.get('jwt_expiry', 28800))
        self.refresh_expiry = int(auth.get('refresh_expiry', 604800))

    def challenge(self, request) -> dict:
        b = request['body']
        action = b.get('action', '') or ''
        credential_id = b.get('credential_id')
        email = b.get('email')
        allow_credentials: list = []
        if action == 'register':
            # Registration requires a signed-in user
            if request.get('user_id') is None:
                return {'success': False, 'message': 'Authentication required', 'status_code': 401}
            user_id = request['user_id']
        elif action == 'authenticate':
            # Identify the user by credential_id (webapp flow) or email (Chrome-extension flow).
            # Credential ids are not secrets: authenticate() verifies the signature.
            if not php_empty(credential_id):
                cred = self.db.fetch_one("SELECT user_id FROM webauthn_credentials WHERE credential_id = ?", [credential_id])
                if not cred:
                    return {'success': False, 'message': 'Credential not found', 'code': 'CREDENTIAL_NOT_FOUND', 'status_code': 404}
                user_id = int(cred['user_id'])
            elif not php_empty(email):
                user = self.db.fetch_one("SELECT id FROM users WHERE email = ?", [email])
                if not user:
                    return {'success': False, 'message': 'No account found for this email', 'code': 'USER_NOT_FOUND', 'status_code': 404}
                user_id = int(user['id'])
                rows = self.db.fetch_all("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?", [user_id])
                if not rows:
                    return {'success': False,
                            'message': 'No passkey registered for this account. Sign in with email/password and enable biometric login first.',
                            'code': 'NO_CREDENTIALS', 'status_code': 404}
                allow_credentials = [{'id': r['credential_id'], 'type': 'public-key', 'transports': ['internal']} for r in rows]
            else:
                # Discoverable (no id, no email) sign-in would need a challenge bound to no user,
                # which webauthn_challenges cannot hold.
                return {'success': False, 'message': 'Enter your email to sign in with a passkey.',
                        'code': 'EMAIL_REQUIRED', 'status_code': 400}
        else:
            return {'success': False, 'message': 'Unknown action', 'status_code': 400}
        challenge = b64url_encode(secrets.token_bytes(32))
        # Stored temporarily; authenticate() consumes it once.
        self.db.execute(
            "INSERT INTO webauthn_challenges (challenge, user_id, action, created_at) VALUES (?, ?, ?, NOW())",
            [challenge, user_id, action])
        wa = self.config.get('webauthn') or {}
        rp_name = wa.get('rp_name') or 'Voice Assistant'
        return {'success': True, 'challenge': challenge, 'rp_id': self._rp_id(request), 'rp_name': rp_name,
                'allow_credentials': allow_credentials, 'status_code': 200}

    def register(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id:
            return {'success': False, 'message': 'Authentication required', 'status_code': 401}
        b = request['body']
        credential_id = b.get('credential_id', '') or ''
        public_key = b.get('public_key', '') or ''
        if php_empty(credential_id) or php_empty(public_key):
            return {'success': False, 'message': 'Credential ID and public key are required', 'status_code': 400}
        if self.db.fetch_one("SELECT id FROM webauthn_credentials WHERE credential_id = ?", [credential_id]):
            return {'success': False, 'message': 'Credential already registered', 'status_code': 409}
        self.db.insert("INSERT INTO webauthn_credentials (user_id, credential_id, public_key, created_at) VALUES (?, ?, ?, NOW())",
                       [user_id, credential_id, public_key])
        error_log(f'[WebAuthnController] Credential registered: user_id={user_id}, credential_id={credential_id[:20]}...')
        self._cleanup_challenges()
        return {'success': True, 'message': 'Credential registered successfully', 'status_code': 200}

    def authenticate(self, request) -> dict:
        refused = edition.refuse_local_sign_in(self.config)
        if refused:
            return refused
        b = request['body']
        credential_id = b.get('credential_id', '')
        client_data_json = b.get('client_data_json', '')
        authenticator_data = b.get('authenticator_data', '')
        signature = b.get('signature', '')
        if any(not isinstance(f, str) or f == '' for f in (credential_id, client_data_json, authenticator_data, signature)):
            return {'success': False, 'message': 'Credential ID, client data, authenticator data and signature are required',
                    'status_code': 400}
        cred = self.db.fetch_one(
            "SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.kind, u.role, u.plan, u.ledger_user_id, u.provider,"
            " u.last_login, u.created_at FROM webauthn_credentials wc JOIN users u ON wc.user_id = u.id"
            " WHERE wc.credential_id = ?", [credential_id])
        # The robot is a service row: answer as for an unknown credential.
        if cred and (cred.get('kind') or 'person') == 'service':
            cred = None
        if not cred:
            return {'success': False, 'message': 'Credential not found', 'code': 'CREDENTIAL_NOT_FOUND', 'status_code': 404}
        user_id = int(cred['uid'])
        failure = self._verify_assertion(request, user_id, str(cred.get('public_key') or ''),
                                         client_data_json, authenticator_data, signature)
        if failure is not None:
            error_log(f'[WebAuthnController] Passkey sign-in refused: user_id={user_id}, reason={failure}')
            return {'success': False, 'message': 'Passkey sign-in failed', 'status_code': 401}
        tokens = generate_tokens(user_id, self.jwt_secret, self.jwt_expiry, self.refresh_expiry)
        self.db.execute("UPDATE users SET last_login = NOW() WHERE id = ?", [user_id])
        error_log(f'[WebAuthnController] Biometric auth successful: user_id={user_id}')
        self._cleanup_challenges()
        return {
            'success': True, 'message': 'Authentication successful', 'token': tokens['access_token'],
            'user': {'id': str(user_id), 'email': cred['email'], 'first_name': cred['first_name'],
                     'last_name': cred['last_name'], 'role': cred.get('role') or 'prospect',
                     'plan': cred.get('plan') or 'free', 'provider': cred.get('provider') or 'webauthn',
                     'last_login': php_now(), 'created_at': cred.get('created_at')},
            'status_code': 200,
        }

    def _verify_assertion(self, request, user_id: int, public_key: str, client_data_b64: str,
                          auth_data_b64: str, signature_b64: str) -> str | None:
        """None when the assertion holds, else the reason (for the log only)."""
        client_data = _b64url_decode(client_data_b64)
        auth_data = _b64url_decode(auth_data_b64)
        signature = _b64url_decode(signature_b64)
        if client_data is None or auth_data is None or signature is None:
            return 'undecodable base64url'
        try:
            client = json.loads(client_data)
        except ValueError:
            return 'bad clientDataJSON'
        if not isinstance(client, dict) or not isinstance(client.get('challenge'), str):
            return 'bad clientDataJSON'
        # The challenge is single use: consume it before any other check.
        if not self._consume_challenge(client['challenge'], user_id):
            return 'unknown, expired or reused challenge'
        if client.get('type') != 'webauthn.get':
            return 'clientDataJSON type is not webauthn.get'
        rp_id = self._rp_id(request)
        if not self._origin_allowed(str(client.get('origin') or ''), rp_id):
            return 'origin not allowed'
        # authenticatorData = rpIdHash (32) | flags (1) | signCount (4) | ...
        if len(auth_data) < 37:
            return 'authenticatorData too short'
        if not hmac.compare_digest(hashlib.sha256(rp_id.encode()).digest(), auth_data[:32]):
            return 'rpIdHash mismatch'
        flags = auth_data[32]
        if not flags & FLAG_UP or not flags & FLAG_UV:
            return 'user presence or verification flag missing'
        der = _b64url_decode(public_key)
        try:
            key = serialization.load_der_public_key(der) if der is not None else None
        except ValueError:
            key = None
        if not isinstance(key, (ec.EllipticCurvePublicKey, rsa.RSAPublicKey)):
            return 'stored public key unreadable'
        signed = auth_data + hashlib.sha256(client_data).digest()
        try:
            if isinstance(key, ec.EllipticCurvePublicKey):
                key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
            else:
                key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
        except (InvalidSignature, ValueError):
            return 'bad signature'
        return None

    def _consume_challenge(self, challenge: str, user_id: int) -> bool:
        """Delete the challenge and tell whether it was a live sign-in challenge issued
        for this user. Deleted whatever the answer, so it is single use."""
        row = self.db.fetch_one(
            "SELECT user_id, action, UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(created_at) AS age"
            " FROM webauthn_challenges WHERE challenge = ?", [challenge])
        if not row:
            return False
        if self.db.execute("DELETE FROM webauthn_challenges WHERE challenge = ?", [challenge]) != 1:
            return False  # a concurrent request consumed it first
        age = int(row['age'])
        return int(row['user_id']) == user_id and row['action'] == 'authenticate' and 0 <= age <= CHALLENGE_EXPIRY

    def _rp_id(self, request) -> str:
        """Relying party id: config webauthn.rp_id, else the request host without port."""
        wa = self.config.get('webauthn') or {}
        rp_id = wa.get('rp_id') or (request.get('headers') or {}).get('host') or 'localhost'
        # Remove port from rpId if present (WebAuthn requires domain only)
        return re.sub(r':\d+$', '', str(rp_id))

    def _origin_allowed(self, origin: str, rp_id: str) -> bool:
        """The assertion origin must be one of config webauthn.origins when set; otherwise
        its host must be the rp id, over https (http only on localhost, as browsers allow). Any port."""
        origins = (self.config.get('webauthn') or {}).get('origins')
        if isinstance(origins, str):
            origins = [o.strip() for o in origins.split(',')] if origins.strip() else []
        if origins:
            return origin.rstrip('/') in [str(o).rstrip('/') for o in origins]
        # An origin is exactly scheme://host[:port]
        try:
            parts = urlsplit(origin)
            port = parts.port
        except ValueError:
            return False
        if not parts.scheme or not parts.hostname:
            return False
        if origin != f'{parts.scheme}://{parts.hostname}' + (f':{port}' if port is not None else ''):
            return False
        if parts.hostname.lower() != rp_id.lower():
            return False
        return parts.scheme == 'https' or (parts.scheme == 'http' and rp_id in ('localhost', '127.0.0.1'))

    def delete(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id:
            return {'success': False, 'message': 'Authentication required', 'status_code': 401}
        credential_id = request['body'].get('credential_id', '') or ''
        if php_empty(credential_id):
            return {'success': False, 'message': 'Credential ID is required', 'status_code': 400}
        deleted = self.db.execute("DELETE FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?",
                                  [credential_id, user_id]) > 0
        error_log(f"[WebAuthnController] Credential deleted: user_id={user_id}, credential_id={credential_id[:20]}..., success={'true' if deleted else 'false'}")
        return {'success': True, 'message': 'Credential deleted' if deleted else 'Credential not found or not owned by user',
                'status_code': 200}

    def _cleanup_challenges(self) -> None:
        try:
            self.db.execute("DELETE FROM webauthn_challenges WHERE created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)",
                            [CHALLENGE_EXPIRY])
        except Exception as e:  # noqa: BLE001
            error_log(f'[WebAuthnController] Challenge cleanup failed: {e}')


def _b64url_decode(data: str) -> bytes | None:
    """Base64URL decode; None when not valid base64url (PHP base64_decode(..., true))."""
    if not re.fullmatch(r'[A-Za-z0-9_-]*={0,2}', data):
        return None
    try:
        return binascii.a2b_base64((data.rstrip('=') + '=' * (-len(data.rstrip('=')) % 4)).translate(str.maketrans('-_', '+/')))
    except binascii.Error:
        return None
