<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\McpEndpoint;

/**
 * One rule for every MCP client: the registered URL is tried as given first;
 * only if that fails is "/mcp" tried, inserted into the path before any query.
 */
final class McpProxyEndpointUrlTest extends TestCase
{
    public function testRegisteredUrlFirstThenMcpAppended(): void
    {
        $this->assertSame(['https://x.test', 'https://x.test/mcp'], McpEndpoint::candidates('https://x.test', 'http'));
    }

    public function testTrailingSlashIsKeptOnTheAsGivenUrl(): void
    {
        // Apache 301-redirects a directory URL without its slash; never trim it.
        $this->assertSame(['http://h/srv/', 'http://h/srv/mcp'], McpEndpoint::candidates('http://h/srv/', 'http'));
    }

    public function testMcpGoesIntoThePathBeforeTheQuery(): void
    {
        $this->assertSame(
            ['http://localhost/servicenow/?profile=mock&toolset=jobs', 'http://localhost/servicenow/mcp?profile=mock&toolset=jobs'],
            McpEndpoint::candidates('http://localhost/servicenow/?profile=mock&toolset=jobs', 'http')
        );
        $this->assertSame(['http://h/x?a=1#f', 'http://h/x/mcp?a=1#f'], McpEndpoint::candidates('http://h/x?a=1#f', 'http'));
    }

    public function testMcpAndPhpEndpointsHaveNoFallback(): void
    {
        $this->assertSame(['https://x.test/mcp'], McpEndpoint::candidates('https://x.test/mcp', 'http'));
        $this->assertSame(['https://x.test/mcp/'], McpEndpoint::candidates('https://x.test/mcp/', 'http'));
        $this->assertSame(['http://localhost/AI_mcp/mcp-server.php'], McpEndpoint::candidates('http://localhost/AI_mcp/mcp-server.php', 'http'));
        $this->assertSame(['http://h/s.php?k=1'], McpEndpoint::candidates('http://h/s.php?k=1', 'http'));
    }

    public function testSseRewritesSseSuffixToMcp(): void
    {
        $this->assertSame(['https://x.test/mcp'], McpEndpoint::candidates('https://x.test/sse', 'sse'));
        $this->assertSame(['https://x.test/mcp'], McpEndpoint::candidates('https://x.test/sse/', 'sse'));
        $this->assertSame(['https://x.test/mcp?k=1'], McpEndpoint::candidates('https://x.test/sse?k=1', 'sse'));
    }

    public function testHttpDoesNotRewriteSseSuffix(): void
    {
        $this->assertSame(['https://x.test/sse', 'https://x.test/sse/mcp'], McpEndpoint::candidates('https://x.test/sse', 'http'));
    }

    public function testIsJsonRpcReply(): void
    {
        $this->assertTrue(McpEndpoint::isJsonRpcReply(['jsonrpc' => '2.0', 'id' => 1, 'result' => []]));
        $this->assertTrue(McpEndpoint::isJsonRpcReply(['jsonrpc' => '2.0', 'id' => 1, 'error' => ['code' => -1]]));
        $this->assertFalse(McpEndpoint::isJsonRpcReply(null));
        // Lenient servers that omit "jsonrpc" were always accepted by the loader.
        $this->assertTrue(McpEndpoint::isJsonRpcReply(['result' => ['tools' => []]]));
        $this->assertFalse(McpEndpoint::isJsonRpcReply(['status' => 'ok']));
    }
}
