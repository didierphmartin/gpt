<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * Chat tool calls follow the same endpoint rule as registration: the stored URL
 * as given, then with "/mcp" in its path. Needs the connector at localhost/servicenow.
 */
final class McpToolsLoaderEndpointTest extends TestCase
{
    private function call(string $url): array
    {
        $ch = curl_init('http://localhost/servicenow/');
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2]);
        curl_exec($ch);
        $up = curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 0;
        curl_close($ch);
        if (!$up) {
            $this->markTestSkipped('ServiceNow connector not served at localhost/servicenow');
        }
        $loader = (new ReflectionClass(MCPToolsLoader::class))->newInstanceWithoutConstructor();
        $m = new ReflectionMethod(MCPToolsLoader::class, 'callMCPServer');
        return $m->invoke($loader, $url, 'poll_jobs', [], [], 'http');
    }

    public function testStoredUrlIsUsedAsGiven(): void
    {
        $r = $this->call('http://localhost/servicenow/?profile=mock&toolset=jobs');
        $this->assertIsArray($r['raw'], json_encode($r['formatted']));
    }

    public function testFallsBackToMcpWhenTheStoredUrlFails(): void
    {
        // Without its slash the folder URL 301s (not followed); /servicenow/mcp?… answers.
        $r = $this->call('http://localhost/servicenow?profile=mock&toolset=jobs');
        $this->assertIsArray($r['raw'], json_encode($r['formatted']));
    }
}
