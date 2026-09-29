<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PDO;
use PDOStatement;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\ChatController;

/**
 * Jev routing tokens are recorded (usage, costs) but never count toward a
 * free user's lifetime token quota.
 */
final class FreeTrialQuotaJevTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new class ('sqlite::memory:') extends PDO {
            public function query(string $query, ?int $fetchMode = null, mixed ...$args): PDOStatement|false
            {
                if (stripos($query, 'SHOW TABLES LIKE') === 0) {
                    // SQLite reports rowCount() 0 for every SELECT; the method under
                    // test reads it as "table missing", so answer with a fixed count.
                    $this->setAttribute(PDO::ATTR_STATEMENT_CLASS, [OneRowStatement::class]);
                    $stmt = parent::query('SELECT 1');
                    $this->setAttribute(PDO::ATTR_STATEMENT_CLASS, [PDOStatement::class]);
                    return $stmt;
                }
                return $fetchMode === null ? parent::query($query) : parent::query($query, $fetchMode, ...$args);
            }
        };
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, plan TEXT, role TEXT)');
        $this->db->exec("INSERT INTO users (id, plan, role) VALUES (7, 'free', 'user')");
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO packages (role, capabilities) VALUES ('user', '{\"quota_tokens\": 1000}')");
        $this->db->exec('CREATE TABLE llm_usage_balance (user_id INTEGER, provider TEXT, total_tokens INTEGER)');
    }

    private function usage(string $provider, int $tokens): void
    {
        $this->db->exec("INSERT INTO llm_usage_balance (user_id, provider, total_tokens) VALUES (7, '$provider', $tokens)");
    }

    private function checkQuota(int $userId): ?array
    {
        $ref = new \ReflectionClass(ChatController::class);
        $controller = $ref->newInstanceWithoutConstructor();
        $prop = $ref->getProperty('db');
        $prop->setAccessible(true);
        $prop->setValue($controller, $this->db);
        $m = $ref->getMethod('checkFreeTrialQuota');
        $m->setAccessible(true);
        return $m->invoke($controller, (string) $userId);
    }

    public function testJevTokensDoNotCountTowardTheQuota(): void
    {
        $this->usage('claude', 900);
        $this->usage('jev', 5000);
        $this->assertNull($this->checkQuota(7));
    }

    public function testLlmTokensStillCount(): void
    {
        $this->usage('claude', 1200);
        $this->usage('jev', 0);
        $this->assertSame('QUOTA_EXCEEDED', $this->checkQuota(7)['code']);
    }
}

/** A statement that claims one row, standing in for MySQL's SHOW TABLES hit. */
final class OneRowStatement extends PDOStatement
{
    public function rowCount(): int
    {
        return 1;
    }
}
