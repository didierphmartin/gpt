<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\McpTestController;
use Quantis\AIPortfolioAssistant\Services\McpTestRelay;

final class McpTestControllerTest extends TestCase
{
    private PDO $db;
    /** @var list<array> */
    private array $calls = [];

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, url TEXT, headers TEXT, transport TEXT, enabled INTEGER DEFAULT 1)');
        $this->db->exec('CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT)');
        $this->db->exec("INSERT INTO users VALUES ('u1','user'), ('adm','admin')");
        $this->db->exec("INSERT INTO mcp_servers (id,user_id,url,headers,transport,enabled) VALUES
            (1, NULL, 'https://stored.test/mcp', '{\"X-Key\":\"s3cret\"}', 'http', 0),
            (2, 'u2', 'https://other.test/mcp', '{\"X-Key\":\"s3cret\"}', 'http', 1)");
    }

    private function ctl(): McpTestController
    {
        $relay = new McpTestRelay(function (string $url, array $lines, string $body, int $t): array {
            $this->calls[] = ['url' => $url, 'lines' => $lines];
            return ['status' => 200, 'headers' => [], 'body' => '{}', 'error' => null];
        });
        return new McpTestController($this->db, [], $relay);
    }

    private function req(array $body, ?string $user = 'u1'): array
    {
        $body += ['message' => ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'], 'protocol_version' => '2025-11-25'];
        return ['user_id' => $user, 'body' => $body];
    }

    public function testByServerIdUsesStoredUrlAndHeaders(): void
    {
        $res = $this->ctl()->test($this->req(['server_id' => 1, 'server_url' => 'https://evil.test', 'headers' => ['X-Key' => 'evil']]));
        $this->assertTrue($res['success']);
        $this->assertSame('https://stored.test/mcp', $this->calls[0]['url']);
        $this->assertContains('X-Key: s3cret', $this->calls[0]['lines']);
        $this->assertNotContains('X-Key: evil', $this->calls[0]['lines']);
    }

    public function testOtherUsersServerIs404(): void
    {
        $res = $this->ctl()->test($this->req(['server_id' => 2]));
        $this->assertFalse($res['success']);
        $this->assertSame(404, $res['status_code']);
        $this->assertSame([], $this->calls);
    }

    public function testUnsavedServerByUrlAndHeaders(): void
    {
        $res = $this->ctl()->test($this->req(['server_url' => 'https://new.test/mcp', 'headers' => ['X-A' => 'b']]));
        $this->assertTrue($res['success']);
        $this->assertSame('https://new.test/mcp', $this->calls[0]['url']);
        $this->assertContains('X-A: b', $this->calls[0]['lines']);
    }

    public function testSiblingAndSse(): void
    {
        $this->assertSame('https://x.test/mcp', McpTestController::endpointFor('https://x.test', 'http', true));
        $this->assertNull(McpTestController::endpointFor('https://x.test/mcp', 'http', true));
        $this->assertSame('https://x.test/mcp', McpTestController::endpointFor('https://x.test/sse', 'sse', false));
        $res = $this->ctl()->test($this->req(['server_url' => 'https://x.test/mcp', 'sibling' => true]));
        $this->assertSame(400, $res['status_code']);
    }

    public function testAdminTestsAnyRowAndRequiresAdmin(): void
    {
        $denied = $this->ctl()->adminTest($this->req(['server_id' => 2], 'u1'));
        $this->assertSame(403, $denied['status_code']);
        $this->assertSame([], $this->calls);
        $res = $this->ctl()->adminTest($this->req(['server_id' => 2], 'adm'));
        $this->assertTrue($res['success']);
        $this->assertContains('X-Key: s3cret', $this->calls[0]['lines']);
    }

    public function testMissingMessageOrVersionIs400(): void
    {
        $r = $this->req(['server_url' => 'https://x.test/mcp']);
        unset($r['body']['message']);
        $this->assertSame(400, $this->ctl()->test($r)['status_code']);
        $r = $this->req(['server_url' => 'https://x.test/mcp']);
        $r['body']['protocol_version'] = '';
        $this->assertSame(400, $this->ctl()->test($r)['status_code']);
        $this->assertSame(401, $this->ctl()->test($this->req(['server_id' => 1], null))['status_code']);
    }

    public function testResponseNeverContainsStoredSecrets(): void
    {
        $res = $this->ctl()->test($this->req(['server_id' => 1]));
        $this->assertStringNotContainsString('s3cret', json_encode($res));
    }
}
