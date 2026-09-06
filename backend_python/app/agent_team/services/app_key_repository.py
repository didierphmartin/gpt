"""Port of backend/src/AgentTeam/Services/AppKeyRepository.php."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets

from app.support.logger import error_log
from app.support.phpcompat import php_now

KEY_BYTES = 16
PREFIX_LEN = 12


class AppKeyRepository:
    def __init__(self, db, server_secret: str):
        if server_secret == '':
            raise RuntimeError('AppKeyRepository: app_key_secret is not configured.')
        self.db = db
        self.server_secret = server_secret

    def create(self, user_id: int, application_id: str, name: str, scopes: list) -> dict:
        full_key = 'ak_' + secrets.token_bytes(KEY_BYTES).hex()
        prefix = full_key[:PREFIX_LEN]
        key_id = self.db.insert(
            "INSERT INTO app_keys (user_id, application_id, name, key_prefix, key_hash, scopes)"
            " VALUES (:user_id, :application_id, :name, :key_prefix, :key_hash, :scopes)",
            {':user_id': user_id, ':application_id': application_id, ':name': name,
             ':key_prefix': prefix, ':key_hash': self._hash(full_key),
             ':scopes': json.dumps(list(scopes), separators=(',', ':'))})
        return {'id': key_id, 'user_id': user_id, 'application_id': application_id, 'name': name,
                'key_prefix': prefix, 'scopes': list(scopes), 'full_key': full_key, 'created_at': php_now()}

    def findByKey(self, full_key: str) -> dict | None:
        full_key = full_key.strip()
        if not full_key.startswith('ak_') or len(full_key) < PREFIX_LEN:
            return None
        row = self.db.fetch_one(
            "SELECT id, user_id, application_id, name, key_prefix, key_hash, scopes,"
            " created_at, last_used_at, revoked_at FROM app_keys"
            " WHERE key_prefix = :prefix AND revoked_at IS NULL LIMIT 1",
            {':prefix': full_key[:PREFIX_LEN]})
        if not row:
            return None
        if not hmac.compare_digest(str(row['key_hash']), self._hash(full_key)):
            return None
        row = dict(row)
        del row['key_hash']
        row['scopes'] = self._decode_scopes(row['scopes'])
        row['id'] = int(row['id'])
        row['user_id'] = int(row['user_id'])
        return row

    def recordUse(self, key_id: int) -> None:
        try:
            self.db.execute("UPDATE app_keys SET last_used_at = NOW() WHERE id = ?", [key_id])
        except Exception as e:  # noqa: BLE001
            error_log(f'[AppKeyRepository] recordUse failed: {e}')

    def revoke(self, key_id: int) -> bool:
        return self.db.execute("UPDATE app_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL",
                               [key_id]) > 0

    def listAll(self, application_id: str | None = None, user_id: int | None = None) -> list:
        sql = ("SELECT id, user_id, application_id, name, key_prefix, scopes, created_at, last_used_at, revoked_at"
               " FROM app_keys WHERE 1=1")
        params: dict = {}
        if application_id is not None:
            sql += " AND application_id = :application_id"; params[':application_id'] = application_id
        if user_id is not None:
            sql += " AND user_id = :user_id"; params[':user_id'] = user_id
        sql += " ORDER BY created_at DESC"
        rows = self.db.fetch_all(sql, params)
        for r in rows:
            r['id'] = int(r['id']); r['user_id'] = int(r['user_id']); r['scopes'] = self._decode_scopes(r['scopes'])
        return rows

    def findById(self, key_id: int) -> dict | None:
        row = self.db.fetch_one(
            "SELECT id, user_id, application_id, name, key_prefix, scopes, created_at, last_used_at, revoked_at"
            " FROM app_keys WHERE id = ? LIMIT 1", [key_id])
        if not row:
            return None
        row['id'] = int(row['id']); row['user_id'] = int(row['user_id']); row['scopes'] = self._decode_scopes(row['scopes'])
        return row

    def _hash(self, full_key: str) -> str:
        return hmac.new(self.server_secret.encode(), full_key.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _decode_scopes(raw):
        """PHP: json_decode($raw, true); is_array($decoded) ? $decoded : []. With
        assoc=true, both JSON arrays and JSON objects decode to a PHP array, so a
        decoded dict is returned as-is (not coerced to a list)."""
        if isinstance(raw, (list, dict)):
            return raw
        try:
            decoded = json.loads(str(raw))
        except ValueError:
            return []
        return decoded if isinstance(decoded, (list, dict)) else []
