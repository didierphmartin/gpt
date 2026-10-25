<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\ChatController;
use Quantis\AIPortfolioAssistant\Controllers\HumeToolController;
use Quantis\AIPortfolioAssistant\Controllers\MCPProxyController;
use Quantis\AIPortfolioAssistant\Controllers\MCPServerController;
use Quantis\AIPortfolioAssistant\Services\ToolsManager;

/**
 * A signed-in user who puts another user's id in the body or query string is
 * still treated as themselves: the authenticated `$request['user_id']` wins.
 */
final class CallerIdentityTest extends TestCase
{
    private const ME = '3';
    private const VICTIM = '9';

    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, url TEXT,
            description TEXT, headers TEXT, transport TEXT DEFAULT "http", enabled INTEGER DEFAULT 1, is_mock INTEGER NOT NULL DEFAULT 0)');
        $this->db->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, input_schema TEXT, has_ui INTEGER DEFAULT 0)');
        $this->db->exec("INSERT INTO mcp_servers (id, user_id, name, url) VALUES (1, '" . self::VICTIM . "', 'victim-private', 'https://victim.test/mcp')");
        $this->db->exec("INSERT INTO mcp_server_tools (id, server_id, tool_name, input_schema) VALUES (1, 1, 'secret_tool', '{}')");
    }

    private function inject(string $class, array $props = []): object
    {
        $obj = (new ReflectionClass($class))->newInstanceWithoutConstructor();
        foreach (['db' => $this->db] + $props as $name => $value) {
            (new ReflectionProperty($class, $name))->setValue($obj, $value);
        }
        return $obj;
    }

    private function servers(): MCPServerController
    {
        return $this->inject(MCPServerController::class);
    }

    private function row(int $id): array|false
    {
        return $this->db->query("SELECT * FROM mcp_servers WHERE id = $id")->fetch();
    }

    // ---- MCPServerController ----

    public function testCreateOwnsTheServerAsTheCaller(): void
    {
        $r = $this->servers()->create(['user_id' => self::ME,
            'body' => ['user_id' => self::VICTIM, 'name' => 'Mine', 'url' => 'https://me.test/mcp']]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame(self::ME, (string) $this->row((int) $r['server_id'])['user_id']);
    }

    public function testUpdateCannotReachAnotherUsersServer(): void
    {
        $r = $this->servers()->update(['user_id' => self::ME,
            'body' => ['user_id' => self::VICTIM, 'server_id' => 1, 'name' => 'hijacked', 'url' => 'https://evil.test/mcp']]);
        $this->assertFalse($r['success'], json_encode($r));
        $this->assertSame('victim-private', $this->row(1)['name']);
    }

    public function testToggleCannotReachAnotherUsersServer(): void
    {
        $this->servers()->toggle(['user_id' => self::ME,
            'body' => ['user_id' => self::VICTIM, 'server_id' => 1, 'enabled' => false]]);
        $this->assertSame(1, (int) $this->row(1)['enabled']);
    }

    public function testDeleteCannotReachAnotherUsersServer(): void
    {
        $r = $this->servers()->delete(['user_id' => self::ME,
            'query' => ['user_id' => self::VICTIM, 'server_id' => 1]]);
        $this->assertSame(404, $r['status_code']);
        $this->assertNotFalse($this->row(1));
    }

    public function testListIgnoresAQueryUserId(): void
    {
        $r = $this->servers()->list(['user_id' => self::ME, 'query' => ['user_id' => self::VICTIM]]);
        $this->assertSame([], array_column($r['servers'], 'name'));
    }

    public function testGetToolsIgnoresAQueryUserId(): void
    {
        $r = $this->servers()->getTools(['user_id' => self::ME, 'query' => ['user_id' => self::VICTIM, 'server_id' => 1]]);
        $this->assertSame(404, $r['status_code']);
    }

    public function testGetAllToolsIgnoresAQueryUserId(): void
    {
        $r = $this->servers()->getAllTools(['user_id' => self::ME, 'query' => ['user_id' => self::VICTIM]]);
        $this->assertSame([], $r['tools']);
    }

    // ---- MCPProxyController ----

    public function testProxyCannotResolveAnotherUsersServer(): void
    {
        $proxy = $this->inject(MCPProxyController::class);
        // No jsonrpc: a resolved server answers "JSON-RPC request required";
        // an unresolved one answers "Server URL required" — no network either way.
        $r = $proxy->forward(['user_id' => self::ME,
            'body' => ['action' => 'proxy', 'server_id' => 1, 'user_id' => self::VICTIM]]);
        $this->assertSame('Server URL required', $r['error']['message']);
    }

    // ---- HumeToolController ----

    public function testHumeToolRunsAsTheCaller(): void
    {
        $tools = $this->createMock(ToolsManager::class);
        $tools->method('hasFunction')->willReturn(true);
        $tools->expects($this->once())->method('execute')
            ->with('get_watchlist', [], self::ME)
            ->willReturn(['success' => true]);
        $hume = $this->inject(HumeToolController::class, ['toolsManager' => $tools]);
        $hume->execute(['user_id' => self::ME,
            'body' => ['toolCallId' => 't1', 'toolName' => 'get_watchlist', 'userId' => self::VICTIM]]);
    }

    // ---- ChatController ----

    /** The caller (3) is a free user over quota; the victim (9) is on a paid plan. */
    private function chat(): ChatController
    {
        $db = new class ('sqlite::memory:') extends PDO {
            public function query(string $query, ?int $fetchMode = null, mixed ...$args): PDOStatement|false
            {
                if (stripos($query, 'SHOW TABLES LIKE') === 0) {
                    $this->setAttribute(PDO::ATTR_STATEMENT_CLASS, [CallerIdentityOneRow::class]);
                    $stmt = parent::query('SELECT 1');
                    $this->setAttribute(PDO::ATTR_STATEMENT_CLASS, [PDOStatement::class]);
                    return $stmt;
                }
                return $fetchMode === null ? parent::query($query) : parent::query($query, $fetchMode, ...$args);
            }
        };
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, plan TEXT, role TEXT)');
        $db->exec("INSERT INTO users (id, plan, role) VALUES (3, 'free', 'user'), (9, 'pro', 'user')");
        $db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $db->exec("INSERT INTO packages (role, capabilities) VALUES ('user', '{\"quota_tokens\": 1000}')");
        $db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, api_format TEXT, enabled INTEGER, sort_order INTEGER DEFAULT 0)');
        $db->exec('CREATE TABLE llm_usage_balance (user_id INTEGER, provider TEXT, total_tokens INTEGER)');
        $db->exec("INSERT INTO llm_usage_balance (user_id, provider, total_tokens) VALUES (3, 'claude', 5000)");
        $ctl = (new ReflectionClass(ChatController::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(ChatController::class, 'db'))->setValue($ctl, $db);
        return $ctl;
    }

    public static function chatEndpoints(): array
    {
        return [
            'chat'    => ['chat', ['message' => 'hi', 'provider' => 'claude']],
            'agent'   => ['agent', ['prompt' => 'hi', 'provider' => 'claude']],
            'verify'  => ['verify', ['original_message' => 'q', 'response_text' => 'a', 'verifier_provider' => 'claude']],
            'compare' => ['compareOnly', ['message' => 'hi', 'compare_provider' => 'claude']],
        ];
    }

    /** @dataProvider chatEndpoints */
    public function testChatEndpointsChargeTheCallerNotTheBodyUser(string $method, array $body): void
    {
        $r = $this->chat()->{$method}(['user_id' => self::ME, 'body' => $body + ['user_id' => self::VICTIM]]);
        $this->assertSame('QUOTA_EXCEEDED', $r['code'] ?? null, json_encode($r));
    }
}

/** A statement that claims one row, standing in for MySQL's SHOW TABLES hit. */
final class CallerIdentityOneRow extends PDOStatement
{
    public function rowCount(): int
    {
        return 1;
    }
}
