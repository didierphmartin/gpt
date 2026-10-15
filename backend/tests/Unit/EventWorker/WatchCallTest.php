<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Services\WatchCall;
use PDO;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-14 event-worker §3: the waiting tool's call and answer. */
final class WatchCallTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        EventWorkerSchema::create($this->db, fn() => '2026-10-14 09:00:00');
    }

    private function server(?int $user, string $name, string $url, ?string $headers, int $enabled = 1): void
    {
        $this->db->prepare('INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (?, ?, ?, ?, ?)')
            ->execute([$user, $name, $url, $headers, $enabled]);
    }

    public function testTheUsersOwnServerWins(): void
    {
        $this->server(null, 'Outlook', 'http://global/mcp', '{}');
        $this->server(3, 'Outlook', 'http://mine/mcp', '{"X-Outlook-Key":"k"}');
        $this->server(4, 'Outlook', 'http://theirs/mcp', '{}');
        $this->assertSame(['url' => 'http://mine/mcp', 'headers' => ['X-Outlook-Key' => 'k']], WatchCall::server($this->db, 3, 'Outlook'));
        $this->assertSame('http://global/mcp', WatchCall::server($this->db, 5, 'outlook')['url']);   // matched by slug
    }

    public function testADisabledOrMissingServerIsNull(): void
    {
        $this->server(3, 'Outlook', 'http://mine/mcp', '{}', 0);
        $this->assertNull(WatchCall::server($this->db, 3, 'Outlook'));
        $this->assertNull(WatchCall::server($this->db, 3, 'Google'));
    }

    public function testInvalidHeadersJsonMeansNoHeaders(): void
    {
        $this->server(3, 'Outlook', 'http://mine/mcp', 'not json');
        $this->assertSame([], WatchCall::server($this->db, 3, 'Outlook')['headers']);
        $this->db->exec("UPDATE mcp_servers SET headers = NULL");
        $this->assertSame([], WatchCall::server($this->db, 3, 'Outlook')['headers']);
    }

    public function testTheRequest(): void
    {
        [$url, $lines, $body] = WatchCall::request(['url' => 'http://h/mcp', 'headers' => ['X-Outlook-Key' => 'k']],
            EventWorkerSchema::WATCH, 7);
        $this->assertSame('http://h/mcp', $url);
        $this->assertContains('X-Outlook-Key: k', $lines);
        $this->assertContains('Content-Type: application/json', $lines);
        $this->assertSame(['jsonrpc' => '2.0', 'id' => 7, 'method' => 'tools/call',
            'params' => ['name' => 'wait_for_new', 'arguments' => ['args' => ['folder' => 'Inbox']]]], json_decode($body, true));
        [, , $empty] = WatchCall::request(['url' => 'u', 'headers' => []], ['server' => 's', 'tool' => 't', 'args' => []], 1);
        $this->assertStringContainsString('"arguments":{}', $empty);
    }

    private static function rpc(array $payload, bool $structured = true): string
    {
        $result = $structured ? ['structuredContent' => $payload, 'content' => [['type' => 'text', 'text' => json_encode($payload)]]]
            : ['content' => [['type' => 'text', 'text' => json_encode($payload)]]];
        return json_encode(['jsonrpc' => '2.0', 'id' => 1, 'result' => $result]);
    }

    public function testAnswers(): void
    {
        $this->assertSame(['status' => 'ready', 'via' => 'event', 'events' => 'on'],
            WatchCall::answer(self::rpc(['status' => 'ready', 'via' => 'event', 'events' => 'on']), 200, ''));
        $this->assertSame(['status' => 'timeout', 'via' => null, 'events' => 'off'],
            WatchCall::answer(self::rpc(['status' => 'timeout', 'events' => 'off'], false), 200, ''));
        $this->assertSame('ready', WatchCall::answer("event: message\ndata: " . self::rpc(['status' => 'ready']) . "\n\n", 200, '')['status']);
    }

    public function testErrors(): void
    {
        $this->assertSame(['status' => 'error', 'message' => 'reconnect_needed'],
            WatchCall::answer(self::rpc(['error' => 'reconnect_needed', 'message' => 'x']), 200, ''));
        $this->assertSame(['status' => 'error', 'message' => 'unreachable'], WatchCall::answer(false, 0, 'Connection refused'));
        $this->assertSame(['status' => 'error', 'message' => 'http_502'], WatchCall::answer('<html>', 502, ''));
        $this->assertSame(['status' => 'error', 'message' => 'rpc_error'],
            WatchCall::answer('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}', 200, ''));
        $this->assertSame(['status' => 'error', 'message' => 'bad_answer'], WatchCall::answer(self::rpc(['status' => 'maybe']), 200, ''));
        $this->assertSame(['status' => 'error', 'message' => 'bad_answer'], WatchCall::answer('not json', 200, ''));
    }
}
