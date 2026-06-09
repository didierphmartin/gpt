<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * User Memory Repository
 *
 * Backs Hermes-style "frozen" memory: two per-user markdown blocks
 * (MEMORY: project/environment facts, USER: user preferences) that are
 * injected into the system prompt on every workflow agent run.
 *
 * No vector index. No semantic retrieval. Just always-on small blocks.
 */
class UserMemoryRepository
{
    public const SCOPE_MEMORY = 'memory';
    public const SCOPE_USER = 'user';

    public const BUDGET_MEMORY = 2200;
    public const BUDGET_USER = 1375;

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
            CREATE TABLE IF NOT EXISTS user_memories (
                user_id INT NOT NULL,
                scope ENUM('memory', 'user') NOT NULL,
                content TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, scope)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        $this->tablesChecked = true;
    }

    public function get(int $userId, string $scope): string
    {
        $this->ensureTablesExist();
        $stmt = $this->db->prepare("SELECT content FROM user_memories WHERE user_id = ? AND scope = ?");
        $stmt->execute([$userId, $scope]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? (string) $row['content'] : '';
    }

    /**
     * Return both scopes in a single call — used by the agent runner so we
     * don't do two round-trips per node execution.
     */
    public function getBoth(int $userId): array
    {
        $this->ensureTablesExist();
        $stmt = $this->db->prepare("SELECT scope, content FROM user_memories WHERE user_id = ?");
        $stmt->execute([$userId]);
        $out = [self::SCOPE_MEMORY => '', self::SCOPE_USER => ''];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[$row['scope']] = (string) $row['content'];
        }
        return $out;
    }

    public function set(int $userId, string $scope, string $content): void
    {
        if ($scope !== self::SCOPE_MEMORY && $scope !== self::SCOPE_USER) {
            throw new \InvalidArgumentException("Invalid scope: {$scope}");
        }
        $this->ensureTablesExist();

        $limit = $scope === self::SCOPE_MEMORY ? self::BUDGET_MEMORY : self::BUDGET_USER;
        if (mb_strlen($content) > $limit) {
            $content = mb_substr($content, 0, $limit);
        }

        $stmt = $this->db->prepare("
            INSERT INTO user_memories (user_id, scope, content)
            VALUES (:user_id, :scope, :content)
            ON DUPLICATE KEY UPDATE content = VALUES(content)
        ");
        $stmt->execute([
            'user_id' => $userId,
            'scope' => $scope,
            'content' => $content,
        ]);
    }

    public function budgetFor(string $scope): int
    {
        return $scope === self::SCOPE_MEMORY ? self::BUDGET_MEMORY : self::BUDGET_USER;
    }

    /**
     * Non-destructive append. Existing lines are preserved; new lines
     * (one per addition) are appended. Returns the candidate string
     * without writing — callers are responsible for compaction when
     * the result exceeds budget.
     *
     * Deduplicates case-insensitive exact-line matches against current
     * content so the extractor can safely propose the same fact twice.
     */
    public function buildMerged(string $current, array $additions): string
    {
        $current = rtrim($current);
        $existingLines = [];
        foreach (preg_split('/\r?\n/', $current) as $line) {
            $key = mb_strtolower(trim($line));
            if ($key !== '') {
                $existingLines[$key] = true;
            }
        }

        $newLines = [];
        foreach ($additions as $addition) {
            $addition = trim((string) $addition);
            if ($addition === '') {
                continue;
            }
            $key = mb_strtolower($addition);
            if (isset($existingLines[$key])) {
                continue;
            }
            $existingLines[$key] = true;
            $newLines[] = $addition;
        }

        if (empty($newLines)) {
            return $current;
        }

        if ($current === '') {
            return implode("\n", $newLines);
        }
        return $current . "\n" . implode("\n", $newLines);
    }

    /**
     * Build a system-prompt-ready string containing both memory scopes,
     * formatted with "## Memory" / "## User" section headers. Empty scopes
     * are skipped. Returns '' when the user has no memory at all.
     *
     * Callers can pass this as `options['memory_context']` which every
     * provider appends to its resolved system prompt (default or custom).
     */
    public static function buildMemoryBlock(\PDO $db, int $userId): string
    {
        if ($userId <= 0) {
            return '';
        }
        $repo = new self($db);
        try {
            $both = $repo->getBoth($userId);
        } catch (\Throwable $e) {
            error_log('[UserMemoryRepository] buildMemoryBlock failed: ' . $e->getMessage());
            return '';
        }

        $memory = trim($both[self::SCOPE_MEMORY] ?? '');
        $user = trim($both[self::SCOPE_USER] ?? '');

        $parts = [];
        if ($memory !== '') {
            $parts[] = "## Memory\n" . $memory;
        }
        if ($user !== '') {
            $parts[] = "## User\n" . $user;
        }
        return implode("\n\n", $parts);
    }
}
