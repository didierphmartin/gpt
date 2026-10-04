<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use AgentTeam\Controllers\CodeNodeController;
use PDO;
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

    /** A real loader whose HTTP POST answers $body (the MCP server's response). */
    private function httpLoader(string $body): MCPToolsLoader
    {
        $loader = new class(new PDO('sqlite::memory:'), $body) extends MCPToolsLoader {
            public function __construct(PDO $pdo, private string $body)
            {
                parent::__construct($pdo);
            }

            protected function postJsonRpc(string $url, string $payload, array $headers): array
            {
                return [$this->body, 200, ''];
            }
        };
        $tools = new \ReflectionProperty(MCPToolsLoader::class, 'tools');
        $tools->setValue($loader, ['mcp_poll_jobs' => ['server_url' => 'http://mcp.test/', 'server_name' => 'ServiceNow',
            'original_name' => 'poll_jobs', 'server_headers' => [], 'server_transport' => 'http', 'has_ui' => false]]);
        return $loader;
    }

    public function testEmptyObjectsStayObjectsThroughTheController(): void
    {
        // json_decode(..., true) turned {} into [] -- the code saw a list in the editor and a dict compiled.
        $result = '{"content":[{"type":"text","text":"{}"}],"structuredContent":{"job":{"number":"SCTASK1","variables":{}},"meta":{}}}';
        foreach (['{"jsonrpc":"2.0","id":1,"result":' . $result . '}',
                  "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" . $result . "}\n\n"] as $body) {
            $executor = new LoaderMcpExecutor($this->httpLoader($body));
            $controller = new CodeNodeController(new PDO('sqlite::memory:'), [],
                fn(int $uid) => fn(string $s, string $t, array $a): array => $executor->callRaw($s, $t, $a));
            $out = json_encode($controller->toolCall(['user_id' => 7, 'body' => ['server' => 'servicenow', 'tool' => 'poll_jobs']]));
            self::assertSame('{"ok":true,"result":' . $result . '}', $out);
        }
    }

    public function testFormattedResultIsUnchanged(): void
    {
        $loader = $this->httpLoader('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}],"structuredContent":{}}}');
        self::assertSame('hello', $loader->executeTool('mcp_poll_jobs', [])['result'] ?? null);
    }
}
