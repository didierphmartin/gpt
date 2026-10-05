<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPProxyController;

/**
 * Settings → register an MCP server runs the proxy's test_connection. A server
 * whose endpoint is not ".../mcp" (the ServiceNow connector addressed by query)
 * must register as given. Needs the connector served at localhost/servicenow.
 */
final class McpProxyRegistrationTest extends TestCase
{
    private const QUERY_URL = 'http://localhost/servicenow/?profile=mock&toolset=jobs';

    private function testConnection(string $url): array
    {
        $ch = curl_init(self::QUERY_URL);
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2]);
        curl_exec($ch);
        $up = curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 0;
        curl_close($ch);
        if (!$up) {
            $this->markTestSkipped('ServiceNow connector not served at localhost/servicenow');
        }
        $proxy = (new ReflectionClass(MCPProxyController::class))->newInstanceWithoutConstructor();
        $m = new ReflectionMethod(MCPProxyController::class, 'testConnection');
        return $m->invoke($proxy, $url, [], 'http');
    }

    public function testQueryAddressedServerRegistersAsGiven(): void
    {
        $r = $this->testConnection(self::QUERY_URL);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame('servicenow', $r['serverInfo']['name'] ?? null, json_encode($r));
    }

    public function testFallbackToMcpStillWorks(): void
    {
        // /servicenow/mock/jobs answers itself; /servicenow/mock/jobs/mcp does too.
        $this->assertTrue($this->testConnection('http://localhost/servicenow/mock/jobs')['success']);
    }

    public function testUnreachableEndpointReportsEveryUrlTried(): void
    {
        $r = $this->testConnection('http://localhost/servicenow/a/b/c');
        $this->assertFalse($r['success']);
        $this->assertStringContainsString('http://localhost/servicenow/a/b/c/mcp', $r['url_tried']);
    }
}
