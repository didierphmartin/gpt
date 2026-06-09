<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Audit log for user memory changes.
 *
 * Every write to user_memories (manual, auto-extract, revert, compact) is
 * recorded here with full before/after snapshots so the UI can show history
 * and revert to any prior state.
 */
class UserMemoryEventsRepository
{
    public const SOURCE_MANUAL = 'manual';
    public const SOURCE_AUTO_EXTRACT = 'auto_extract';
    public const SOURCE_REVERT = 'revert';
    public const SOURCE_COMPACT = 'compact';

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
            CREATE TABLE IF NOT EXISTS user_memory_events (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id INT NOT NULL,
                scope ENUM('memory', 'user') NOT NULL,
                source ENUM('manual', 'auto_extract', 'revert', 'compact') NOT NULL,
                before_content TEXT NOT NULL,
                after_content TEXT NOT NULL,
                rationale VARCHAR(255) NULL,
                session_id VARCHAR(64) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_user_created (user_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        $this->tablesChecked = true;
    }

    public function log(
        int $userId,
        string $scope,
        string $source,
        string $before,
        string $after,
        ?string $rationale = null,
        ?string $sessionId = null
    ): int {
        $this->ensureTablesExist();

        if ($before === $after) {
            return 0;
        }

        $stmt = $this->db->prepare("
            INSERT INTO user_memory_events
                (user_id, scope, source, before_content, after_content, rationale, session_id)
            VALUES
                (:user_id, :scope, :source, :before, :after, :rationale, :session_id)
        ");
        $stmt->execute([
            'user_id' => $userId,
            'scope' => $scope,
            'source' => $source,
            'before' => $before,
            'after' => $after,
            'rationale' => $rationale,
            'session_id' => $sessionId,
        ]);

        return (int) $this->db->lastInsertId();
    }

    public function list(int $userId, int $limit = 50): array
    {
        $this->ensureTablesExist();
        $limit = max(1, min(200, $limit));

        $stmt = $this->db->prepare("
            SELECT id, scope, source, before_content, after_content, rationale, session_id, created_at
            FROM user_memory_events
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT {$limit}
        ");
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    public function get(int $userId, int $eventId): ?array
    {
        $this->ensureTablesExist();
        $stmt = $this->db->prepare("
            SELECT id, scope, source, before_content, after_content, rationale, session_id, created_at
            FROM user_memory_events
            WHERE id = ? AND user_id = ?
        ");
        $stmt->execute([$eventId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    /**
     * Remove an audit event. Used when a change is reverted — the entry
     * should disappear from the recent-changes list rather than stick
     * around with a "reverted" marker.
     */
    public function delete(int $userId, int $eventId): bool
    {
        $this->ensureTablesExist();
        $stmt = $this->db->prepare("
            DELETE FROM user_memory_events
            WHERE id = ? AND user_id = ?
        ");
        $stmt->execute([$eventId, $userId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Returns the scope of the most recent event for the user, or null
     * if there is none. Used by the UI to render the "auto" badge.
     */
    public function lastSource(int $userId, string $scope): ?string
    {
        $this->ensureTablesExist();
        $stmt = $this->db->prepare("
            SELECT source FROM user_memory_events
            WHERE user_id = ? AND scope = ?
            ORDER BY id DESC
            LIMIT 1
        ");
        $stmt->execute([$userId, $scope]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? (string) $row['source'] : null;
    }
}
