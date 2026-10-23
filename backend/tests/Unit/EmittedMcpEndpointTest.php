<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PythonEmitHelpers;

/**
 * The emitted MCP client (LangGraph, ADK, MAF, playbook) follows the backend's
 * endpoint rule (McpEndpoint): the registered URL as given first, then with
 * "/mcp" inserted into its path before any query string.
 */
class EmittedMcpEndpointTest extends TestCase
{
    private function runPython(string $python, string $body): string
    {
        $file = tempnam(sys_get_temp_dir(), 'mcpblock') . '.py';
        file_put_contents($file, "import json, sys, time, types\n"
            . "try:\n    import httpx\nexcept ImportError:\n    httpx = types.ModuleType('httpx')\n"
            . PythonEmitHelpers::mcpClientBlock() . "\n" . $body);
        exec(escapeshellarg($python) . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        $this->assertSame(0, $rc, implode("\n", $out));
        return implode("\n", $out);
    }

    public function testCandidatesAsGivenFirstThenMcpBeforeTheQuery(): void
    {
        $out = $this->runPython('python3', <<<'PY'
print(json.dumps([
    _mcp_candidates("https://x.test"),
    _mcp_candidates("http://h/srv/"),
    _mcp_candidates("http://localhost/servicenow/?profile=mock&toolset=jobs"),
    _mcp_candidates("http://h/x?a=1#f"),
    _mcp_candidates("https://x.test/mcp/"),
    _mcp_candidates("http://h/s.php?k=1"),
]))
PY);
        $this->assertSame([
            ['https://x.test', 'https://x.test/mcp'],
            ['http://h/srv/', 'http://h/srv/mcp'],
            ['http://localhost/servicenow/?profile=mock&toolset=jobs', 'http://localhost/servicenow/mcp?profile=mock&toolset=jobs'],
            ['http://h/x?a=1#f', 'http://h/x/mcp?a=1#f'],
            ['https://x.test/mcp/'],
            ['http://h/s.php?k=1'],
        ], json_decode($out, true));
    }

    public function testQueryAddressedServerIsCalledLive(): void
    {
        $python = getenv('HOME') . '/Documents/synergyAI/python/.venv/bin/python';
        $ch = curl_init('http://localhost/servicenow/');
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2]);
        curl_exec($ch);
        $up = curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 0;
        curl_close($ch);
        if (!$up || !is_executable($python)) {
            $this->markTestSkipped('needs the connector at localhost/servicenow and the runner venv');
        }
        $out = $this->runPython($python, <<<'PY'
print(_call_mcp_tool("http://localhost/servicenow/?profile=mock&toolset=jobs", "poll_jobs", {}))
print("ENDPOINT", _MCP_ENDPOINTS)
PY);
        $this->assertStringNotContainsString('"error"', $out);
        $this->assertStringContainsString("'http://localhost/servicenow/?profile=mock&toolset=jobs': 'http://localhost/servicenow/?profile=mock&toolset=jobs'", $out);
    }

    public function testNooaProbePicksTheAnsweringEndpointLive(): void
    {
        $python = getenv('HOME') . '/Documents/synergyAI/python/.venv/bin/python';
        $ch = curl_init('http://localhost/servicenow/');
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2]);
        curl_exec($ch);
        $up = curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 0;
        curl_close($ch);
        if (!$up || !is_executable($python)) {
            $this->markTestSkipped('needs the connector at localhost/servicenow and the runner venv');
        }
        $fn = (new \ReflectionMethod(\AgentTeam\Services\NOOAGenerator::class, 'mcpEndpointFn'))->invoke(null);
        // _mcp_candidates as the shared compiled runtime emits it; the live URL and headers stubbed.
        preg_match('/^def _mcp_candidates\(.*?(?=^\S)/ms', \AgentTeam\Services\CompiledRuntimeEmit::mcpClientBlock([]), $m);
        $prelude = "import httpx\n" . $m[0] . "\n_mcp_live_url = lambda u: u\n"
            . "_mcp_headers = lambda u: {'Accept': 'application/json, text/event-stream'}\n";
        $file = tempnam(sys_get_temp_dir(), 'nooaprobe') . '.py';
        file_put_contents($file, $prelude . $fn . "\nprint(_mcp_endpoint('http://localhost/servicenow/?profile=mock&toolset=jobs'))"
            . "\nprint(_mcp_endpoint('http://localhost/servicenow?profile=mock&toolset=jobs'))\n");
        exec(escapeshellarg($python) . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        $this->assertSame(0, $rc, implode("\n", $out));
        $this->assertSame([
            'http://localhost/servicenow/?profile=mock&toolset=jobs',      // answers as given
            'http://localhost/servicenow/mcp?profile=mock&toolset=jobs',   // 301 as given -> the /mcp form
        ], $out);
    }
}
