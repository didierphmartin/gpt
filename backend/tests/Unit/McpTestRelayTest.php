<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\McpTestRelay;

final class McpTestRelayTest extends TestCase
{
    /** @var array<string,mixed> */
    private array $seen = [];

    private function relay(array $reply = []): McpTestRelay
    {
        $reply += ['status' => 200, 'headers' => [], 'body' => '{}', 'error' => null];
        return new McpTestRelay(function (string $url, array $lines, string $body, int $t) use ($reply): array {
            $this->seen = ['url' => $url, 'lines' => $lines, 'body' => $body, 'timeout' => $t];
            return $reply;
        });
    }

    public function testSendsMessageUnchanged(): void
    {
        $msg = ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call',
            'params' => ['name' => 'x', 'arguments' => []]];
        $this->relay()->relay('http://h/mcp', [], $msg, null, '2025-11-25');
        $this->assertSame(json_encode($msg), $this->seen['body']);
        $this->assertStringContainsString('"arguments":[]', $this->seen['body']);
    }

    public function testProtocolAndSessionHeaders(): void
    {
        $r = $this->relay();
        $r->relay('http://h/mcp', ['X-A' => 'b'], ['a' => 1], 'abc', '2025-11-25');
        $this->assertContains('mcp-protocol-version: 2025-11-25', $this->seen['lines']);
        $this->assertContains('mcp-session-id: abc', $this->seen['lines']);
        $this->assertContains('X-A: b', $this->seen['lines']);
        foreach ([null, ''] as $sid) {
            $r->relay('http://h/mcp', [], ['a' => 1], $sid, '2025-11-25');
            $this->assertStringNotContainsString('mcp-session-id', implode("\n", $this->seen['lines']));
        }
    }

    public function testEmptyProtocolVersionOmitsHeader(): void
    {
        $this->relay()->relay('http://h/mcp', [], ['a' => 1], null, '');
        $this->assertStringNotContainsString('mcp-protocol-version', implode("\n", $this->seen['lines']));
    }

    public function testObjectMessageKeepsEmptyObjects(): void
    {
        $msg = json_decode('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}');
        $this->relay()->relay('http://h/mcp', [], $msg, null, '');
        $this->assertStringContainsString('"capabilities":{}', $this->seen['body']);
    }

    public function testSessionAndVersionCrLfStripped(): void
    {
        $this->relay()->relay('http://h/mcp', [], ['a' => 1], "abc\r\nX-Evil: 1", "2025-11-25\r\nX-Bad: 2");
        $this->assertContains('mcp-session-id: abcX-Evil: 1', $this->seen['lines']);
        $this->assertContains('mcp-protocol-version: 2025-11-25X-Bad: 2', $this->seen['lines']);
        foreach ($this->seen['lines'] as $line) {
            $this->assertDoesNotMatchRegularExpression('/[\r\n]/', $line);
        }
    }

    public function testParsesSseEvents(): void
    {
        $body = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        $m = McpTestRelay::parseMessages('text/event-stream; charset=utf-8', $body);
        $this->assertCount(2, $m);
        $this->assertSame(1, $m[1]->id);
    }

    /** The server's {} must reach the browser as {}: an assoc decode turns it into [] and the validator then blames the server. */
    public function testParsedMessagesKeepEmptyObjects(): void
    {
        $json = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},"serverInfo":{"name":"s"}}}';
        $this->assertSame('[' . $json . ']', json_encode(McpTestRelay::parseMessages('application/json', $json)));
        $sse = "event: message\ndata: $json\n\n";
        $this->assertSame('[' . $json . ']', json_encode(McpTestRelay::parseMessages('text/event-stream', $sse)));
        $batch = '[' . $json . ',{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}]';
        $this->assertSame($batch, json_encode(McpTestRelay::parseMessages('application/json', $batch)));
    }

    public function testParsesJsonAndBatch(): void
    {
        $this->assertCount(1, McpTestRelay::parseMessages('application/json', '{"id":1}'));
        $this->assertCount(2, McpTestRelay::parseMessages('application/json', '[{"id":1},{"id":2}]'));
        $this->assertSame([], McpTestRelay::parseMessages('text/html', '<html>no</html>'));
    }

    public function testExposesOnlyThreeHeaders(): void
    {
        $out = McpTestRelay::exposedHeaders([
            'content-type' => 'a', 'mcp-session-id' => 'b', 'mcp-protocol-version' => 'c',
            'set-cookie' => 'x', 'authorization' => 'y', 'x-api-key' => 'z',
        ]);
        $this->assertSame(['content-type', 'mcp-session-id', 'mcp-protocol-version'], array_keys($out));
    }

    public function testTransportErrorIsReturnedNotThrown(): void
    {
        $r = $this->relay(['status' => 0, 'body' => '', 'error' => 'Could not resolve host'])
            ->relay('http://h/mcp', [], ['a' => 1], null, '2025-11-25');
        $this->assertSame('Could not resolve host', $r['error']);
        $this->assertSame([], $r['messages']);
        $this->assertSame(0, $r['status']);
    }
}
