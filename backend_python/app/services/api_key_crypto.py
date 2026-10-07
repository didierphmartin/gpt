"""Port of Services/ApiKeyCrypto.php.

The one encryption used for per-user keys in user_api_keys.

base64(iv16 . AES-256-CBC(plaintext)) with key = sha256(secret), where the
secret is `auth.jwt_secret`. Extracted from SettingsController and
ChatController so the readers of user_api_keys cannot drift from them.

Only the readers are ported here (decrypt / reveal / looksEncrypted);
SettingsController keeps its own encryptApiKey.
"""
from __future__ import annotations

import base64
import binascii
import hashlib

from app.support.crypto import aes256cbc_decrypt
from app.support.phpcompat import php_trim


class ApiKeyCrypto:
    @staticmethod
    def decrypt(blob: str, secret: str) -> str | None:
        """The plaintext, or None when the blob is malformed or was encrypted under another secret."""
        try:
            try:
                data = base64.b64decode(blob, validate=False)
            except Exception:  # noqa: BLE001 — base64_decode() === false
                return None
            if len(data) < 17:
                return None

            key = hashlib.sha256(secret.encode()).digest()
            iv = data[:16]
            encrypted = data[16:]

            decrypted = aes256cbc_decrypt(encrypted, key, iv)
            if decrypted is None:
                return None
            try:
                return decrypted.decode('utf-8')
            except Exception:  # noqa: BLE001
                return None
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def reveal(stored: str, secret: str) -> str:
        """The usable key in a user_api_keys.api_key value, or '' when there is
        none. SettingsController stores keys encrypted; AdminController stores
        per-user keys in the clear. A value not even shaped like an encrypted
        blob is such a clear key; one that IS shaped like a blob but will not
        open (rotated secret) is unusable."""
        stored = php_trim(stored)
        if stored == '':
            return ''
        plain = ApiKeyCrypto.decrypt(stored, secret)
        if plain is not None and php_trim(plain) != '':
            return php_trim(plain)
        return '' if ApiKeyCrypto.looksEncrypted(stored) else stored

    @staticmethod
    def looksEncrypted(value: str) -> bool:
        """Whether value has the exact shape encrypt() produces: canonical base64
        of a 16-byte IV followed by whole AES blocks. Used to tell an encrypted
        key we cannot open (wrong secret) from a key that was stored in the clear."""
        try:
            data = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            return False
        if base64.b64encode(data).decode('ascii') != value:
            return False
        length = len(data)
        return length >= 32 and (length - 16) % 16 == 0
