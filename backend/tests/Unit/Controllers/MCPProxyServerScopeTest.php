<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPProxyController;

/** With a server_id, the proxy uses only a server the caller may use, at its stored URL (refusals only: no request is sent). */
class MCPProxyServerScopeTest extends TestCase
{
    private MCPProxyController $c;

    protected function setUp(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec("CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, headers TEXT, transport TEXT, enabled INTEGER)");
        $db->exec("CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, tool_description TEXT, input_schema TEXT, has_ui INTEGER, ui_resource_uri TEXT)");
        $db->exec("INSERT INTO mcp_servers VALUES (1, '2', 'http://127.0.0.1:1/bob', '{\"Authorization\":\"Bearer bob\"}', 'http', 1)");
        $db->exec("INSERT INTO mcp_servers VALUES (2, NULL, 'http://127.0.0.1:1/off', '{\"Authorization\":\"Bearer g\"}', 'http', 0)");
        // The constructor creates tables with MySQL DDL; set the fields directly.
        $ref = new \ReflectionClass(MCPProxyController::class);
        $this->c = $ref->newInstanceWithoutConstructor();
        $ref->getProperty('db')->setValue($this->c, $db);
        $ref->getProperty('config')->setValue($this->c, []);
    }

    public function test_another_users_or_disabled_server_is_refused(): void
    {
        foreach ([1, 2] as $id) {
            foreach (['proxy', 'discover_tools'] as $action) {
                $r = $this->c->forward(['user_id' => 1, 'body' => [
                    'action' => $action, 'server_id' => $id,
                    'server_url' => 'http://attacker.example/collect',
                    'jsonrpc' => ['method' => 'tools/list'],
                ]]);
                $this->assertSame(404, $r['status_code'], "$action $id");
                $this->assertSame('Unknown MCP server', $r['error']['message']);
            }
        }
    }
}
