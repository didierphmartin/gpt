"""Port of backend/src/AgentTeam/Services/UserMemorySettingsRepository.php.

Per-user settings for memory auto-update.

Stored in its own table to avoid touching the ENUM on user_memories.
Defaults: enabled=true, model=claude-haiku-4-5-20251001.
"""
from __future__ import annotations

from app.support.phpcompat import php_bool


class UserMemorySettingsRepository:
    DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
    DEFAULT_ENABLED = True

    ALLOWED_MODELS = [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-5-20250929',
        'claude-3-5-sonnet-20241022',
        'claude-3-haiku-20240307',
    ]

    def __init__(self, db):
        self.db = db
        self.tablesChecked = False

    def ensureTablesExist(self) -> None:
        # Tables exist in the schema; no runtime DDL is ported.
        self.tablesChecked = True

    def get(self, userId: int) -> dict:
        self.ensureTablesExist()
        row = self.db.fetch_one(
            "SELECT auto_update_enabled, auto_update_model FROM user_memory_settings WHERE user_id = ?",
            [userId],
        )

        if not row:
            return {
                'enabled': self.DEFAULT_ENABLED,
                'model': self.DEFAULT_MODEL,
            }

        return {
            'enabled': php_bool(row['auto_update_enabled']),
            'model': str(row['auto_update_model']),
        }

    def set(self, userId: int, enabled: bool, model: str) -> None:
        if model not in self.ALLOWED_MODELS:
            raise ValueError(f'Unsupported model: {model}')
        self.ensureTablesExist()

        self.db.execute(
            "INSERT INTO user_memory_settings (user_id, auto_update_enabled, auto_update_model) "
            "VALUES (:user_id, :enabled, :model) "
            "ON DUPLICATE KEY UPDATE "
            "auto_update_enabled = VALUES(auto_update_enabled), "
            "auto_update_model = VALUES(auto_update_model)",
            {
                'user_id': userId,
                'enabled': 1 if enabled else 0,
                'model': model,
            },
        )
