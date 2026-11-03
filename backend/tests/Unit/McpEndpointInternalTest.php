<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\McpEndpoint;

/** In the Docker app the registered gateway address is rewritten to the one the web container can reach. */
final class McpEndpointInternalTest extends TestCase
{
    private array $savedEnv = [];

    protected function setUp(): void
    {
        foreach (['MCPS_GATEWAY', 'MCPS_PUBLIC_GATEWAY'] as $k) {
            $this->savedEnv[$k] = $_ENV[$k] ?? null;
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->savedEnv as $k => $v) {
            if ($v === null) {
                unset($_ENV[$k]);
            } else {
                $_ENV[$k] = $v;
            }
        }
    }

    public function testRewritesOnlyTheGatewayWhenSet(): void
    {
        $_ENV['MCPS_GATEWAY'] = 'http://mcps:8790';
        $_ENV['MCPS_PUBLIC_GATEWAY'] = 'http://localhost:8790';
        self::assertSame('http://mcps:8790/outlook_mcp/mcp', McpEndpoint::internal('http://localhost:8790/outlook_mcp/mcp'));
        self::assertSame('http://mcps:8790/outlook_mcp/mcp', McpEndpoint::internal('http://127.0.0.1:8790/outlook_mcp/mcp'));
        self::assertSame('http://localhost:8770/mcp', McpEndpoint::internal('http://localhost:8770/mcp'));
        self::assertSame('http://localhost:87901/x', McpEndpoint::internal('http://localhost:87901/x'));
        self::assertSame(['http://mcps:8790/outlook_mcp/mcp'], McpEndpoint::candidates('http://localhost:8790/outlook_mcp/mcp'));
    }

    public function testUnchangedWhenUnset(): void
    {
        unset($_ENV['MCPS_GATEWAY'], $_ENV['MCPS_PUBLIC_GATEWAY']);
        self::assertSame('http://localhost:8790/a/mcp', McpEndpoint::internal('http://localhost:8790/a/mcp'));
    }
}
