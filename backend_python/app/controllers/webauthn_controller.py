"""Port of Controllers/WebAuthnController.php (no assertion crypto in PHP either)."""
from __future__ import annotations

import re
import secrets

from app.controllers.auth_controller import generate_tokens
from app.support.logger import error_log
from app.support.phpcompat import b64url_encode, php_empty, php_now

CHALLENGE_EXPIRY = 120


class WebAuthnController:
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
        user_id = b.get('user_id')
        credential_id = b.get('credential_id')
        email = b.get('email')
        allow_credentials: list = []
        if action == 'register':
            if request.get('user_id') is None:
                return {'success': False, 'message': 'Authentication required', 'status_code': 401}
            user_id = request['user_id']
        if action == 'authenticate':
            if not php_empty(credential_id):
                cred = self.db.fetch_one("SELECT user_id FROM webauthn_credentials WHERE credential_id = ?", [credential_id])
                if not cred:
                    return {'success': False, 'message': 'Credential not found', 'code': 'CREDENTIAL_NOT_FOUND', 'status_code': 404}
                user_id = cred['user_id']
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
                user_id = 0
        challenge = b64url_encode(secrets.token_bytes(32))
        if user_id != 0:
            self.db.execute(
                "INSERT INTO webauthn_challenges (challenge, user_id, action, created_at) VALUES (?, ?, ?, NOW())"
                " ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()",
                [challenge, user_id, action])
        wa = self.config.get('webauthn') or {}
        rp_id = wa.get('rp_id') or request['headers'].get('host') or 'localhost'
        rp_name = wa.get('rp_name') or 'Voice Assistant'
        rp_id = re.sub(r':\d+$', '', rp_id)
        return {'success': True, 'challenge': challenge, 'rp_id': rp_id, 'rp_name': rp_name,
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
        b = request['body']
        credential_id = b.get('credential_id', '') or ''
        authenticator_data = b.get('authenticator_data', '') or ''
        signature = b.get('signature', '') or ''
        if php_empty(credential_id) or php_empty(signature):
            return {'success': False, 'message': 'Credential ID and signature are required', 'status_code': 400}
        cred = self.db.fetch_one(
            "SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.role, u.plan, u.ledger_user_id, u.provider,"
            " u.last_login, u.created_at FROM webauthn_credentials wc JOIN users u ON wc.user_id = u.id"
            " WHERE wc.credential_id = ?", [credential_id])
        if not cred:
            return {'success': False, 'message': 'Credential not found', 'code': 'CREDENTIAL_NOT_FOUND', 'status_code': 404}
        if php_empty(authenticator_data) or php_empty(signature):
            return {'success': False, 'message': 'Invalid authentication data', 'status_code': 400}
        user_id = int(cred['uid'])
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
