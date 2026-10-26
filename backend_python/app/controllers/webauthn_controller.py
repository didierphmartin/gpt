"""Port of Controllers/WebAuthnController.php: passkey sign-in is off (PASSKEY_SIGNIN_OFF), as in PHP."""
from __future__ import annotations

import re
import secrets

from app.services import edition
from app.support.logger import error_log
from app.support.phpcompat import b64url_encode, php_empty

CHALLENGE_EXPIRY = 120


class WebAuthnController:
    """Registering and deleting passkeys; sign-in with one is off until
    authenticate() verifies the assertion (see _passkey_sign_in_off)."""

    def __init__(self, db, config: dict):
        self.db = db
        self.config = config

    def challenge(self, request) -> dict:
        action = request['body'].get('action', '') or ''
        # Passkey sign-in is off until assertions are verified (see authenticate()).
        if action != 'register':
            return self._passkey_sign_in_off()
        # Registration requires a signed-in user
        if request.get('user_id') is None:
            return {'success': False, 'message': 'Authentication required', 'status_code': 401}
        user_id = request['user_id']
        challenge = b64url_encode(secrets.token_bytes(32))
        self.db.execute(
            "INSERT INTO webauthn_challenges (challenge, user_id, action, created_at) VALUES (?, ?, ?, NOW())"
            " ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()",
            [challenge, user_id, action])
        wa = self.config.get('webauthn') or {}
        rp_id = wa.get('rp_id') or request['headers'].get('host') or 'localhost'
        rp_name = wa.get('rp_name') or 'Voice Assistant'
        rp_id = re.sub(r':\d+$', '', rp_id)
        return {'success': True, 'challenge': challenge, 'rp_id': rp_id, 'rp_name': rp_name,
                'allow_credentials': [], 'status_code': 200}

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
        return self._passkey_sign_in_off()

    @staticmethod
    def _passkey_sign_in_off() -> dict:
        """Sign-in with a passkey stays off until authenticate() verifies the
        assertion: the stored single-use challenge, origin, rpId hash, the
        signature against the stored public key, and the sign counter. Without
        that, a credential id alone (handed out by challenge() for any email)
        signed anyone in. Registering and deleting passkeys still work."""
        return {'success': False,
                'message': 'Passkey sign-in is turned off for now. Sign in with your email and password.',
                'code': 'PASSKEY_SIGNIN_OFF', 'status_code': 503}

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
