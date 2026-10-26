<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPAppController;

/** The public /mcp/app route only reaches MCP servers someone registered (refusals only: no request is sent). */
class MCPAppRegisteredServerTest extends TestCase
{
    public function test_unregistered_or_disabled_server_is_refused(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec("CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, url TEXT, enabled INTEGER)");
        $db->exec("INSERT INTO mcp_servers (url, enabled) VALUES ('http://127.0.0.1:1/off', 0)");
        $c = new MCPAppController($db, []);

        foreach (['http://169.254.169.254/latest', 'http://127.0.0.1:1/off'] as $server) {
            $r = $c->getResource(['query' => ['server' => $server, 'resource' => 'ui://x']]);
            $this->assertSame(404, $r['status_code'], $server);
            $this->assertSame('Unknown MCP server', $r['error']);
        }
    }
}
