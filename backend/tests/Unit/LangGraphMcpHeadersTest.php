<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphRuntime;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-07 §7.1: MCP headers come from MCP_HEADERS_<SLUG>, never from the script. */
final class LangGraphMcpHeadersTest extends TestCase
{
    private const SECRET = 'sekret-conn-key-7731';

    private function runPy(string $tail, array $env = []): array
    {
        $py = "import json, os, sys, time\nclass httpx:\n    class Client:\n        pass\n"
            . "MCP_SERVER_SLUGS = {'http://o/mcp': 'outlook'}\n"
            . LangGraphRuntime::mcpClientBlock() . "\n" . $tail;
        $file = tempnam(sys_get_temp_dir(), 'hd') . '.py';
        file_put_contents($file, $py);
        $envStr = '';
        foreach ($env as $k => $v) {
            $envStr .= $k . '=' . escapeshellarg($v) . ' ';
        }
        exec($envStr . '/usr/local/bin/python3 ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        return [$rc, $out];
    }

    public function testHeadersFromEnvironmentAreMerged(): void
    {
        [$rc, $out] = $this->runPy("print(json.dumps(MCP._headers('http://o/mcp'), sort_keys=True))",
            ['MCP_HEADERS_OUTLOOK' => '{"X-Outlook-Account": "k-1"}']);
        self::assertSame(0, $rc, implode("\n", $out));
        $h = json_decode($out[0], true);
        self::assertSame('k-1', $h['X-Outlook-Account']);
        self::assertSame('application/json', $h['Content-Type']);
    }

    public function testNoVariableMeansBaseHeaders(): void
    {
        [, $out] = $this->runPy("print('X-Outlook-Account' in MCP._headers('http://o/mcp'), 'Accept' in MCP._headers('http://x/mcp'))");
        self::assertSame(['False True'], $out);
    }

    public function testBadHeaderJsonNamesTheVariable(): void
    {
        [$rc, $out] = $this->runPy("MCP._headers('http://o/mcp')", ['MCP_HEADERS_OUTLOOK' => 'not json']);
        self::assertNotSame(0, $rc);
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK', implode("\n", $out));
    }

    public function testNonObjectHeaderJsonNamesTheVariable(): void
    {
        [$rc, $out] = $this->runPy("MCP._headers('http://o/mcp')", ['MCP_HEADERS_OUTLOOK' => '["a"]']);
        self::assertNotSame(0, $rc);
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK', implode("\n", $out));
    }

    public function testEveryRequestUsesServerHeaders(): void
    {
        $src = LangGraphRuntime::mcpClientBlock();
        self::assertSame(0, substr_count($src, 'headers=self.HEADERS'), 'all requests go through _headers()');
        self::assertSame(2, substr_count($src, 'headers=h,'));
        self::assertSame(2, substr_count($src, 'headers=self._headers(server_url)'));
    }

    private function generate(array $options): array
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, '{\"X-Outlook-Account\": \"" . self::SECRET . "\"}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $graph = [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
                ['id' => '2', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1']],
        ];
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Mail', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', $options);
    }

    public function testSingleFileEmitsSlugsAndDocsButNoHeaderValue(): void
    {
        $code = $this->generate([])['code'];
        self::assertMatchesRegularExpression('~MCP_SERVER_SLUGS = \{\s*"http://localhost/outlook/mcp": "outlook"\s*\}~', $code);
        self::assertLessThan(strpos($code, 'class McpClient'), strpos($code, 'MCP_SERVER_SLUGS = '));
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK=', $code);
        self::assertStringNotContainsString(self::SECRET, $code);
    }

    public function testModularEmitsSlugsAndNoHeaderValue(): void
    {
        $res = $this->generate(['modular' => true]);
        $all = '';
        foreach ($res['files'] as $f) {
            $all .= $f['code'] . "\n";
        }
        self::assertStringContainsString('MCP_SERVER_SLUGS = ', $all);
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK=', $all);
        self::assertStringNotContainsString(self::SECRET, $all);
    }
}
