<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPAppController;

/**
 * The MCP app proxy follows the same endpoint rule as registration. Needs the
 * connector at localhost/servicenow (it has no resources, so a reached server
 * answers resources/read with an error rather than failing to initialize).
 */
final class McpAppEndpointTest extends TestCase
{
    public function testQueryAddressedServerIsReachedAsGiven(): void
    {
        $ch = curl_init('http://localhost/servicenow/');
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2]);
        curl_exec($ch);
        $up = curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 0;
        curl_close($ch);
        if (!$up) {
            $this->markTestSkipped('ServiceNow connector not served at localhost/servicenow');
        }
        // The route only reaches registered servers
        $server = 'http://localhost/servicenow/?profile=mock&toolset=jobs';
        $db = new PDO('sqlite::memory:');
        $db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, url TEXT, enabled INTEGER)');
        $db->prepare('INSERT INTO mcp_servers (url, enabled) VALUES (?, 1)')->execute([$server]);
        $app = new MCPAppController($db, []);
        $r = $app->getResource(['query' => [
            'server' => $server,
            'resource' => 'ui://none',
        ]]);
        $this->assertStringStartsWith('Failed to fetch MCP resource', $r['error'] ?? '', json_encode($r));
    }
}
