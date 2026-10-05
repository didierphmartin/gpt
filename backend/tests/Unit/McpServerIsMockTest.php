<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPServerController;

/** Settings → MCP Servers: a server can be registered or edited as a mock (is_mock). */
final class McpServerIsMockTest extends TestCase
{
    private PDO $db;
    private MCPServerController $ctl;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, url TEXT,
            description TEXT, headers TEXT, transport TEXT DEFAULT "http", enabled INTEGER DEFAULT 1, is_mock INTEGER NOT NULL DEFAULT 0)');
        $this->db->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER)');
        $this->ctl = (new ReflectionClass(MCPServerController::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(MCPServerController::class, 'db'))->setValue($this->ctl, $this->db);
    }

    private function isMock(int|string $id): int
    {
        return (int) $this->db->query("SELECT is_mock FROM mcp_servers WHERE id = " . (int) $id)->fetchColumn();
    }

    public function testCreateAsMock(): void
    {
        $r = $this->ctl->create(['body' => ['user_id' => '3', 'name' => 'ServiceNow', 'url' => 'http://localhost/servicenow/mock/jobs', 'is_mock' => true]]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame(1, $this->isMock($r['server_id']));
    }

    public function testCreateWithoutTheFlagIsNotAMock(): void
    {
        $r = $this->ctl->create(['body' => ['user_id' => '3', 'name' => 'Real', 'url' => 'https://x.test/mcp']]);
        $this->assertSame(0, $this->isMock($r['server_id']));
    }

    public function testUpdateSetsAndClearsTheFlag(): void
    {
        $id = $this->ctl->create(['body' => ['user_id' => '3', 'name' => 'S', 'url' => 'https://x.test/mcp']])['server_id'];
        $this->ctl->update(['body' => ['user_id' => '3', 'server_id' => $id, 'name' => 'S', 'url' => 'https://x.test/mcp', 'is_mock' => true]]);
        $this->assertSame(1, $this->isMock($id));
        $this->ctl->update(['body' => ['user_id' => '3', 'server_id' => $id, 'name' => 'S', 'url' => 'https://x.test/mcp', 'is_mock' => false]]);
        $this->assertSame(0, $this->isMock($id));
    }

    public function testUpdateWithoutTheKeyLeavesTheFlag(): void
    {
        // A screen that does not send is_mock must not reset it (same rule as transport and headers).
        $id = $this->ctl->create(['body' => ['user_id' => '3', 'name' => 'S', 'url' => 'https://x.test/mcp', 'is_mock' => 1]])['server_id'];
        $this->ctl->update(['body' => ['user_id' => '3', 'server_id' => $id, 'name' => 'S2', 'url' => 'https://x.test/mcp']]);
        $this->assertSame(1, $this->isMock($id));
    }
}
