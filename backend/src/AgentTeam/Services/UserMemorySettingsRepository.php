<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Per-user settings for memory auto-update.
 *
 * Stored in its own table to avoid touching the ENUM on user_memories.
 * Defaults: enabled=true, model=claude-haiku-4-5-20251001.
 */
class UserMemorySettingsRepository
{
    public const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
    public const DEFAULT_ENABLED = true;

    public const ALLOWED_MODELS = [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-5-20250929',
        'claude-3-5-sonnet-20241022',
        'claude-3-haiku-20240307',
    ];

    private PDO $db;
    private bool $tablesChecked = false;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function ensureTablesExist(): void
    {
        if ($this->tablesChecked) {
            return;
        }

        $this->db->exec("
            CREATE TABLE IF NOT EXISTS user_memory_settings (
                user_id INT NOT NULL,
                auto_update_enabled TINYINT(1) NOT NULL DEFAULT 1,
                auto_update_model VARCHAR(64) NOT NULL DEFAULT '" . self::DEFAULT_MODEL . "',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        $this->tablesChecked = true;
    }

    public function get(int $userId): array
    {
        $this->ensureTablesExist();
        $stmt = $this->db->prepare("SELECT auto_update_enabled, auto_update_model FROM user_memory_settings WHERE user_id = ?");
        $stmt->execute([$userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            return [
                'enabled' => self::DEFAULT_ENABLED,
                'model' => self::DEFAULT_MODEL,
            ];
        }

        return [
            'enabled' => (bool) $row['auto_update_enabled'],
            'model' => (string) $row['auto_update_model'],
        ];
    }

    public function set(int $userId, bool $enabled, string $model): void
    {
        if (!in_array($model, self::ALLOWED_MODELS, true)) {
            throw new \InvalidArgumentException("Unsupported model: {$model}");
        }
        $this->ensureTablesExist();

        $stmt = $this->db->prepare("
            INSERT INTO user_memory_settings (user_id, auto_update_enabled, auto_update_model)
            VALUES (:user_id, :enabled, :model)
            ON DUPLICATE KEY UPDATE
                auto_update_enabled = VALUES(auto_update_enabled),
                auto_update_model = VALUES(auto_update_model)
        ");
        $stmt->execute([
            'user_id' => $userId,
            'enabled' => $enabled ? 1 : 0,
            'model' => $model,
        ]);
    }
}
