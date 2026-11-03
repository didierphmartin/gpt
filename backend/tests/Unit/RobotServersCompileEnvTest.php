<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\RobotServersController;

/**
 * GET /robot/mcp-servers/compile-env: the robot's own enabled servers' headers as MCP_HEADERS_<SLUG>, for a compiled
 * robot workflow's .env -- the very values the interpreter sends when the robot runs (SQLite, no production DB).
 */
final class RobotServersCompileEnvTest extends TestCase
{
    private \PDO $db;

    protected function setUp(): void
    {
        $this->db = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, kind TEXT)");
        $this->db->exec("CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, description TEXT,
            enabled INTEGER, headers TEXT)");
        $this->db->exec("INSERT INTO users (id, kind) VALUES (3, 'user'), (120, 'service')");
        $add = $this->db->prepare('INSERT INTO mcp_servers (user_id, name, url, enabled, headers) VALUES (?, ?, ?, ?, ?)');
        $add->execute(['120', 'Outlook', 'http://localhost:8770/mcp', 1, '{"X-Outlook-Account":"robot-key"}']);
        $add->execute(['120', 'Share Point', 'http://localhost:8771/mcp', 1, '{"X-SharePoint-Account":"sp-key"}']);
        $add->execute(['120', 'Jira', 'http://localhost:9000/mcp', 0, '{"Authorization":"off"}']);      // disabled
        $add->execute(['120', 'Docs', 'http://localhost:9001/mcp', 1, null]);                           // no headers
        $add->execute(['3', 'Outlook', 'http://localhost:8770/mcp', 1, '{"X-Outlook-Account":"person-key"}']);
    }

    private function call(int $userId): array
    {
        return (new RobotServersController($this->db, ['edition' => 'individual']))->compileEnv(['user_id' => $userId]);
    }

    public function testTheRobotsEnabledHeadersBySlug(): void
    {
        $r = $this->call(3);
        self::assertTrue($r['success'], json_encode($r));
        self::assertSame([
            'MCP_HEADERS_OUTLOOK' => '{"X-Outlook-Account":"robot-key"}',
            'MCP_HEADERS_SHARE_POINT' => '{"X-SharePoint-Account":"sp-key"}',
        ], $r['data']['vars'], 'only the robot\'s enabled rows with headers; never the person\'s own');
    }

    public function testSignedOutIsRefused(): void
    {
        $r = $this->call(0);
        self::assertFalse($r['success']);
        self::assertSame(401, $r['status_code']);
    }
}
