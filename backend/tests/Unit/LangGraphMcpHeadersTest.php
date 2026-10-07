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

    private function python(): string
    {
        $py = is_executable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
        exec($py . ' -c ' . escapeshellarg('import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)') . ' 2>&1', $o, $rc);
        if ($rc !== 0) {
            self::markTestSkipped('Python 3.10+ not available');
        }
        return $py;
    }

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
        exec($envStr . $this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
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

    public function testNonStringOrMultilineHeaderValueNamesTheVariableNotTheValue(): void
    {
        foreach (['{"X-A": 5}', '{"X-A": "a\\nb"}'] as $bad) {
            [$rc, $out] = $this->runPy("MCP._headers('http://o/mcp')", ['MCP_HEADERS_OUTLOOK' => $bad]);
            self::assertNotSame(0, $rc);
            $text = implode("\n", $out);
            self::assertStringContainsString('MCP_HEADERS_OUTLOOK', $text);
            self::assertStringNotContainsString('a\\nb', $text);
        }
    }

    public function testEveryRequestUsesServerHeaders(): void
    {
        $src = LangGraphRuntime::mcpClientBlock();
        self::assertSame(0, substr_count($src, 'headers=self.HEADERS'), 'all requests go through _headers()');
        self::assertSame(2, substr_count($src, 'headers=h,'));
        self::assertSame(2, substr_count($src, 'headers=self._headers(server_url)'));
    }

    /** @param list<array{string,string}> $extraServers  seeded for the user; $useExtra says whether the agent calls them */
    private function generate(array $options, array $extraServers = [], bool $useExtra = false): array
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, '{\"X-Outlook-Account\": \"" . self::SECRET . "\"}')");
        foreach ($extraServers as $i => [$name, $url]) {
            $pdo->exec("INSERT INTO mcp_servers VALUES (" . (10 + $i) . ", '3', '$name', '$url', 1, NULL)");
            $pdo->exec("INSERT INTO mcp_server_tools VALUES (" . (10 + $i) . ", " . (10 + $i) . ", 'tool_$i', 'T', '{}')");
        }
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $tools = ['mcp_list_messages'];
        if ($useExtra) {
            foreach (array_keys($extraServers) as $i) {
                $tools[] = 'mcp_tool_' . $i;
            }
        }
        $graph = [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
                ['id' => '2', 'node_type' => '', 'config' => ['type' => 'agent-template', 'agent_name' => 'Mailer', 'agent_type' => 'standard',
                    'instructions' => 'Read mail.', 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-6',
                    'tools' => $tools, 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096]]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']],
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

    public function testOnlyServersTheWorkflowUsesAreListedAndDocumented(): void
    {
        $code = $this->generate([], [['Calendar', 'http://localhost/cal/mcp']])['code'];
        self::assertStringContainsString('"http://localhost/outlook/mcp": "outlook"', $code);
        self::assertStringNotContainsString('calendar', strtolower($code));
        self::assertStringNotContainsString('MCP_HEADERS_CALENDAR', $code);
    }

    public function testTwoUsedServersWithTheSameSlugAreRefused(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('MCP_HEADERS_OUTLOOK');
        $this->generate([], [['outlook', 'http://localhost/other/mcp']], true);
    }

    public function testSameSlugOnAnUnusedServerIsFine(): void
    {
        $code = $this->generate([], [['outlook', 'http://localhost/other/mcp']])['code'];
        self::assertStringNotContainsString('http://localhost/other/mcp', $code);
    }

    /** Two mailboxes on one Outlook MCP URL (different X-Outlook-Account): a code node checks $servers. */
    private function generateCode(array $servers): array
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, NULL)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (6, '3', 'Outlook Work', 'http://localhost/outlook/mcp', 1, NULL)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 6, 'list_messages', 'List', '{}')");
        $graph = [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Poll',
                    'code' => "def run(input, call_tool):\n    return {'route': 'next', 'output': 'x'}\n",
                    'exits' => ['next'], 'mcp_servers' => $servers, 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']],
        ];
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Mail', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', []);
    }

    public function testTwoUsedServersOnOneUrlAreRefused(): void
    {
        try {
            $this->generateCode(['Outlook', 'Outlook Work']);
            self::fail('two used servers on one URL compiled');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('"Outlook"', $e->getMessage());
            self::assertStringContainsString('"Outlook Work"', $e->getMessage());
            self::assertStringContainsString('one connection per MCP URL', $e->getMessage());
        }
    }

    public function testTheOneUsedServerOnASharedUrlKeepsItsOwnHeaderVariable(): void
    {
        $code = $this->generateCode(['Outlook Work'])['code'];
        self::assertStringContainsString('"http://localhost/outlook/mcp": "outlook_work"', $code);
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK_WORK=', $code);
        self::assertStringNotContainsString('MCP_HEADERS_OUTLOOK=', $code);
    }

    public function testTheDocsSayOneConnectionPerUrl(): void
    {
        self::assertStringContainsString('one connection per MCP URL', $this->generate([])['code']);
    }
}
