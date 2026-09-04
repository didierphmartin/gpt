<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPServerController;

final class McpServerTransportTest extends TestCase
{
    public function testNormalizeTransportDefaultsToHttp(): void
    {
        $this->assertSame('http', MCPServerController::normalizeTransport(null));
        $this->assertSame('http', MCPServerController::normalizeTransport(''));
        $this->assertSame('http', MCPServerController::normalizeTransport('  '));
    }

    public function testNormalizeTransportAcceptsKnownValues(): void
    {
        $this->assertSame('http', MCPServerController::normalizeTransport('http'));
        $this->assertSame('sse', MCPServerController::normalizeTransport('sse'));
        $this->assertSame('sse', MCPServerController::normalizeTransport(' SSE '));
    }

    public function testNormalizeTransportRejectsUnknown(): void
    {
        $this->assertNull(MCPServerController::normalizeTransport('stdio'));
        $this->assertNull(MCPServerController::normalizeTransport(42));
        $this->assertNull(MCPServerController::normalizeTransport(['sse']));
    }

    public function testDeriveServerType(): void
    {
        $this->assertSame('mcp', MCPServerController::deriveServerType(0));
        $this->assertSame('mcp_app', MCPServerController::deriveServerType(1));
        $this->assertSame('mcp_app', MCPServerController::deriveServerType(7));
    }
}
