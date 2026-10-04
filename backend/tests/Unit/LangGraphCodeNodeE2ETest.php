<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/** Opt-in (CODE_NODE_E2E=1): compiled code-node workflows RUN with real Python + LangGraph against the mock ServiceNow MCP. */
class LangGraphCodeNodeE2ETest extends TestCase
{
    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)");
        return $pdo;
    }

    private function generate(array $graph, ?string $userId = '3'): string
    {
        return $this->generateWith($graph, [], $userId)['code'];
    }

    private function generateWith(array $graph, array $options, ?string $userId = '3'): array
    {
        $pdo = $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);
        return $gen->generate(44, $userId, $options);
    }

    private const PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
    private const MCP = 'http://localhost/servicenow/?profile=mock&toolset=jobs';

    protected function setUp(): void
    {
        if (getenv('CODE_NODE_E2E') !== '1') {
            self::markTestSkipped('Set CODE_NODE_E2E=1 to run.');
        }
        if (!is_file(self::PY)) {
            self::markTestSkipped('venv python missing');
        }
        $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n",
            'content' => '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', 'timeout' => 5, 'ignore_errors' => true]]);
        if (@file_get_contents(self::MCP, false, $ctx) === false) {
            self::markTestSkipped('mock connector not answering');
        }
    }

    private function graph(string $code, array $tools): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'poll']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Poll ServiceNow jobs',
                    'code' => $code, 'exits' => ['job', 'no_job'], 'mcp_tools' => $tools, 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '3', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '4', 'from_port' => 'output_2'],
            ],
        ];
    }

    private function pollGraph(): array
    {
        return $this->graph("def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n", ['servicenow.poll_jobs']);
    }

    private function noJobGraph(): array
    {
        return $this->graph("def run(input, call_tool):\n    return {'route': 'no_job', 'output': None}\n", []);
    }

    /** Writes the generated files to a temp dir, runs workflow.py poll; returns [rc, output]. */
    private function runScript(array $gen): array
    {
        $dir = sys_get_temp_dir() . '/lgcn_e2e_' . bin2hex(random_bytes(4));
        mkdir($dir);
        $files = isset($gen['files']) ? array_column($gen['files'], 'code', 'path') : ['workflow.py' => $gen['code']];
        foreach ($files as $path => $code) {
            @mkdir(dirname("$dir/$path"), 0777, true);
            file_put_contents("$dir/$path", $code);
        }
        $proc = proc_open([self::PY, 'workflow.py', 'poll'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME'), 'ANTHROPIC_API_KEY' => 'dummy', 'OPENAI_API_KEY' => 'dummy', 'DEEPSEEK_API_KEY' => 'dummy']);
        stream_set_blocking($pipes[1], false);
        $text = '';
        $deadline = microtime(true) + 90;
        while (true) {
            $text .= (string) stream_get_contents($pipes[1]);
            $st = proc_get_status($proc);
            if (!$st['running'] || microtime(true) > $deadline) {
                break;
            }
            usleep(50000);
        }
        $text .= (string) stream_get_contents($pipes[1]);
        if ($st['running']) {
            proc_terminate($proc, 9);
            $rc = -1;
            $text .= "\n[timed out]";
        } else {
            $rc = $st['exitcode'];
        }
        proc_close($proc);
        fwrite(STDERR, "\n--- E2E output ($dir) ---\n$text\n");
        return [$rc, $text];
    }

    private function assertJob(array $gen): void
    {
        [$rc, $text] = $this->runScript($gen);
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('SCTASK0000101', $text);
        self::assertStringContainsString('poll_jobs', $text);
        self::assertMatchesRegularExpression("~exit '?job'?~", $text);
    }

    public function testSingleFileTakesTheJobExit(): void
    {
        $this->assertJob($this->generateWith($this->pollGraph(), []));
    }

    public function testModularTakesTheJobExit(): void
    {
        $this->assertJob($this->generateWith($this->pollGraph(), ['modular' => true]));
    }

    public function testNoJobExitReachesOutputB(): void
    {
        foreach ([[], ['modular' => true]] as $opts) {
            [$rc, $text] = $this->runScript($this->generateWith($this->noJobGraph(), $opts));
            self::assertSame(0, $rc, $text);
            self::assertStringNotContainsString('SCTASK0000101', $text);
            self::assertMatchesRegularExpression("~exit '?no_job'?~", $text);
            self::assertStringContainsString('[4] output', $text);
            self::assertStringNotContainsString('[3] output', $text);
        }
    }

    public function testBadCodeStopsTheScriptBeforeAnyNodeRuns(): void
    {
        // spec §5.2: check_code at startup, single file and modular.
        $bad = $this->graph("import requests\n\ndef run(input, call_tool):\n    return {'route': 'job', 'output': 1}\n", []);
        foreach ([[], ['modular' => true]] as $opts) {
            [$rc, $text] = $this->runScript($this->generateWith($bad, $opts));
            self::assertNotSame(0, $rc, $text);
            self::assertStringContainsString("import of 'requests' is not allowed", $text);
            self::assertStringNotContainsString('[info] Running', $text);
        }
    }
}
