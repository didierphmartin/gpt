<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

class LoaderMcpExecutorTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    private function makeLoader(): MCPToolsLoader
    {
        $loader = Mockery::mock(MCPToolsLoader::class);
        $loader->shouldReceive('getTools')->andReturn([
            'mcp_search_users' => [
                'original_name' => 'search_users',
                'server_id' => 1,
                'server_url' => 'http://localhost/mockokta/',
                'server_name' => 'Okta',
                'server_headers' => [],
                'description' => 'Find an Okta user by email address.',
                'input_schema_json' => json_encode([
                    'type' => 'object',
                    'properties' => ['email' => ['type' => 'string']],
                    'required' => ['email'],
                ]),
                'has_ui' => false,
                'ui_resource_uri' => null,
            ],
        ]);
        return $loader;
    }

    public function testAvailableToolsMapsSlugKey(): void
    {
        $adapter = new LoaderMcpExecutor($this->makeLoader());
        $tools = $adapter->availableTools();

        $this->assertArrayHasKey('okta.search_users', $tools);
        $this->assertSame('Find an Okta user by email address.', $tools['okta.search_users']['description']);
        $this->assertSame('object', $tools['okta.search_users']['input_schema']['type']);
        $this->assertSame(['email'], $tools['okta.search_users']['input_schema']['required']);
    }

    public function testCallProxiesToLoaderExecuteTool(): void
    {
        $loader = $this->makeLoader();
        $loader->shouldReceive('executeTool')
            ->once()
            ->with('mcp_search_users', ['email' => 'x'])
            ->andReturn(['content' => [['type' => 'text', 'text' => 'ok']]]);

        $adapter = new LoaderMcpExecutor($loader);
        $result = $adapter->call('okta', 'search_users', ['email' => 'x']);

        $this->assertTrue($result['ok']);
        $this->assertSame(['content' => [['type' => 'text', 'text' => 'ok']]], $result['result']);
    }

    public function testCallMapsLoaderErrorToOkFalse(): void
    {
        $loader = $this->makeLoader();
        $loader->shouldReceive('executeTool')
            ->once()
            ->with('mcp_search_users', ['email' => 'x'])
            ->andReturn(['error' => true, 'message' => "MCP tool 'search_users' not found"]);

        $adapter = new LoaderMcpExecutor($loader);
        $result = $adapter->call('okta', 'search_users', ['email' => 'x']);

        $this->assertFalse($result['ok']);
        $this->assertSame("MCP tool 'search_users' not found", $result['error']);
    }
}
