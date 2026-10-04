<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/** Code nodes need the raw MCP result: structuredContent and isError survive (review focus 3). */
final class LoaderMcpExecutorRawTest extends TestCase
{
    private function loader(array $raw): MCPToolsLoader
    {
        $loader = $this->getMockBuilder(MCPToolsLoader::class)->disableOriginalConstructor()
            ->onlyMethods(['getTools', 'executeToolRaw'])->getMock();
        $loader->method('getTools')->willReturn([
            'mcp_poll_jobs' => ['server_name' => 'ServiceNow', 'original_name' => 'poll_jobs'],
        ]);
        $loader->method('executeToolRaw')->willReturnCallback(
            fn(string $name, array $args) => $name === 'mcp_poll_jobs' ? $raw : ['error' => true, 'message' => 'wrong name']);
        return $loader;
    }

    public function testRawResultKeepsStructuredContentAndIsError(): void
    {
        $raw = ['content' => [['type' => 'text', 'text' => 'not_claimable: closed']], 'isError' => true,
                'structuredContent' => ['error' => ['code' => 'not_claimable']]];
        $r = (new LoaderMcpExecutor($this->loader(['error' => false, 'raw' => $raw])))->callRaw('servicenow', 'poll_jobs', []);
        self::assertSame(['ok' => true, 'result' => $raw], $r);
    }

    public function testUnknownToolAndTransportFailure(): void
    {
        $ex = new LoaderMcpExecutor($this->loader(['error' => true, 'message' => 'MCP connection failed: refused']));
        self::assertSame(['ok' => false, 'error' => "MCP tool 'okta.reset' not found"], $ex->callRaw('okta', 'reset', []));
        self::assertSame(['ok' => false, 'error' => 'MCP connection failed: refused'], $ex->callRaw('servicenow', 'poll_jobs', []));
    }
}
