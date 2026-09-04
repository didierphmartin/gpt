<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPProxyController;

final class McpProxyEndpointUrlTest extends TestCase
{
    public function testHttpAppendsMcpWhenMissing(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test', 'http'));
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/', 'http'));
    }

    public function testHttpLeavesMcpAndPhpEndpointsAlone(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/mcp', 'http'));
        $this->assertSame('http://localhost/AI_mcp/mcp-server.php',
            MCPProxyController::resolveEndpointUrl('http://localhost/AI_mcp/mcp-server.php', 'http'));
    }

    public function testSseRewritesSseSuffixToMcp(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/sse', 'sse'));
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/sse/', 'sse'));
    }

    public function testSseWithoutSseSuffixBehavesLikeHttp(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test', 'sse'));
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/mcp', 'sse'));
    }

    public function testHttpDoesNotRewriteSseSuffix(): void
    {
        // Existing behaviour for http transport is preserved verbatim.
        $this->assertSame('https://x.test/sse/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/sse', 'http'));
    }
}
