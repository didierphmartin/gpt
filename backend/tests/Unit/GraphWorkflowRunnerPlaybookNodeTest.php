<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\GraphWorkflowRunner;
use AgentTeam\Services\PlaybookNodeRunner;
use AgentTeam\Services\WorkflowGraphRepository;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\FakeMcpExecutor;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\FakeNodeRunnerBridge;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;

/**
 * The server runner runs playbook nodes unattended and routes on the outcome.
 * Graph: Start(1) -> Code(2, fake output) -> Playbook(3) ; done (output_1) -> Out(4), failed (output_2) -> Out(5).
 */
final class GraphWorkflowRunnerPlaybookNodeTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    private PDO $pdo;
    private string $runsDir;
    private int $factoryCalls = 0;
    /** @var array[] scripted LLM rounds */
    private array $rounds = [];

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->pdo->sqliteCreateFunction('NOW', fn() => date('Y-m-d H:i:s'), 0);
        $this->pdo->exec('CREATE TABLE agent_workflow_executions (id INTEGER PRIMARY KEY, workflow_id INTEGER, user_id INTEGER,
            input_variables TEXT, status TEXT, output TEXT, error_message TEXT, response_time_ms INTEGER, started_at TEXT, completed_at TEXT)');
        $this->pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)');
        $this->pdo->exec("CREATE TABLE playbook_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, playbook_title TEXT,
            document TEXT, status TEXT DEFAULT 'pending', requester TEXT, variables TEXT, pending_gate TEXT,
            current_leg INT DEFAULT 0, coverage TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            direction TEXT, audience TEXT, text TEXT, sensitive INT DEFAULT 0, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            author TEXT DEFAULT 'agent', text TEXT, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            seq INT, action_name TEXT, tool TEXT, args TEXT, outcome TEXT, result_summary TEXT, returned_ids TEXT,
            sensitive INT DEFAULT 0, duration_ms INT, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_gates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            kind TEXT, args TEXT, asked_of TEXT, opened_at TEXT, closed_at TEXT, decision TEXT, actor TEXT)");
        PlaybookStoreTest::schema($this->pdo);
        $this->pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)');
        $this->pdo->exec("INSERT INTO users (kind) VALUES ('service')");
        $this->runsDir = sys_get_temp_dir() . '/wfruns_' . bin2hex(random_bytes(4));
        mkdir($this->runsDir);
        $this->factoryCalls = 0;
    }

    protected function tearDown(): void
    {
        foreach (glob($this->runsDir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->runsDir);
        Mockery::close();
    }

    private static function python(): string
    {
        $env = getenv('CODE_NODE_PYTHON');
        return $env ?: (is_executable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3');
    }

    private function scriptedLlm(): \Closure
    {
        $queue = $this->rounds;
        $n = 0;
        return function (array $m, array $t) use (&$queue, &$n) {
            if (!$queue) {
                return ['text' => 'nothing left to do', 'tool_calls' => []];
            }
            $calls = [];
            foreach (array_shift($queue) as $c) {
                $calls[] = ['id' => 'call_' . ++$n, 'name' => $c['name'], 'arguments' => $c['arguments'] ?? []];
            }
            return ['text' => null, 'tool_calls' => $calls];
        };
    }

    private function playbookDoc(): array
    {
        return ['title' => 'Simple Resolve', 'trigger' => ['kind' => 'request', 'description' => 't'],
            'instructions' => '#Resolve Request.', 'actions_used' => ['#Resolve Request'], 'policy' => ['writes_enabled' => true]];
    }

    /** @return array{0:array,1:array} [run result, node outputs] */
    private function go(array $pbConfig, string $codeOutput, bool $withExits = true): array
    {
        $pbConfig += ['name' => 'PB'] + ($withExits ? ['exits' => ['done', 'failed']] : []);
        $nodes = [
            ['id' => 1, 'node_type' => 'start', 'config' => []],
            ['id' => 2, 'node_type' => 'code', 'config' => ['name' => 'Get', 'exits' => ['next'], 'mcp_servers' => [], 'timeout_s' => 10,
                'code' => "def run(input, call_tool):\n    return {'route': 'next', 'output': " . var_export($codeOutput, true) . "}\n"]],
            ['id' => 3, 'node_type' => 'playbook', 'config' => $pbConfig],
            ['id' => 4, 'node_type' => 'output', 'config' => []],
            ['id' => 5, 'node_type' => 'output', 'config' => []],
        ];
        $edges = [
            ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_1'],
            ['from_node_id' => 3, 'to_node_id' => 4, 'from_port' => 'output_1'],
            ['from_node_id' => 3, 'to_node_id' => 5, 'from_port' => $withExits ? 'output_2' : 'output_1'],
        ];
        $graph = Mockery::mock(WorkflowGraphRepository::class);
        $graph->shouldReceive('findStartNode')->andReturn($nodes[0]);
        $graph->shouldReceive('getGraph')->andReturn(['nodes' => $nodes, 'edges' => $edges]);
        $agentRunner = Mockery::mock(AgentRunner::class);
        $agentRunner->shouldNotReceive('run');
        $factory = function (): PlaybookNodeRunner {
            $this->factoryCalls++;
            return new PlaybookNodeRunner(
                config: ['workflow_runs_dir' => $this->runsDir],
                llmFactory: fn(array $nodeConfig) => $this->scriptedLlm(),
                mcpFactory: fn(PDO $pdo, int $userId) => new FakeMcpExecutor(),
                bridgeFactory: fn(\Closure $emit) => new FakeNodeRunnerBridge($emit),
                pdoFactory: fn() => $this->pdo,
            );
        };
        $runner = new GraphWorkflowRunner($this->pdo, Mockery::mock(AgentRepository::class), $agentRunner, $graph,
            ['workflow_runs_dir' => $this->runsDir, 'code_nodes' => ['python' => self::python()]], $factory);
        $prev = ini_set('error_log', $this->runsDir . '/php.log');
        try {
            $out = $runner->run(new Workflow(['id' => 55, 'name' => 'PB test']), 3, ['prompt' => 'go']);
        } finally {
            ini_set('error_log', (string) $prev);
        }
        return [$out, $out['node_outputs'] ?? []];
    }

    public function testDoneRoutesToDoneBranch(): void
    {
        $this->rounds = [[['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]]];
        [$out, $o] = $this->go(['playbook' => $this->playbookDoc()], 'hello');
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertSame('done', $o[3]['exit']);
        self::assertArrayHasKey(4, $o, 'Out-done ran');
        self::assertArrayNotHasKey(5, $o, 'Out-failed skipped');
        self::assertStringContainsString('[playbook run', $o[3]['output']);
        self::assertStringNotContainsString('Playbook failed', $o[3]['output']);
        self::assertArrayNotHasKey('code_route', $o[3]);
    }

    public function testFromInputNodeEndsWithTheJobLine(): void
    {
        $job = '{"playbook": "nope", "task": "INC0001", "u": "é/x"}';
        [$out, $o] = $this->go(['playbook_source' => 'input'], $job);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertSame('failed', $o[3]['exit']);
        self::assertArrayHasKey(5, $o);
        self::assertArrayNotHasKey(4, $o);
        // unknown key: failed with the resolution reason, and the Job line carries the parent's JSON compactly
        self::assertStringStartsWith('Playbook failed: playbook_not_found:nope', $o[5]['output']);
        $lines = explode("\n", rtrim($o[3]['output']));
        self::assertSame('Job: {"playbook":"nope","task":"INC0001","u":"é/x"}', end($lines));
    }

    public function testGateEndsTheRunAsFailedWithGateReason(): void
    {
        $this->rounds = [
            [['name' => 'request_approval', 'arguments' => ['approver' => 'boss', 'question' => 'OK?']]],
            [['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]],
        ];
        [$out, $o] = $this->go(['playbook' => $this->playbookDoc()], 'hello');
        self::assertSame('failed', $o[3]['exit']);
        self::assertStringStartsWith('Playbook failed: gate:approval', $o[5]['output']);
        self::assertStringNotContainsString('Job: ', $o[3]['output'], 'fixed source adds no Job line');
    }

    public function testFromInputUnknownKeyRoutesToFailedWithoutRunning(): void
    {
        [$out, $o] = $this->go(['playbook_source' => 'input'], '{"playbook":"nope"}');
        self::assertSame('failed', $o[3]['exit']);
        self::assertArrayHasKey(5, $o);
        self::assertArrayNotHasKey(4, $o);
        self::assertSame(0, $this->factoryCalls, 'the playbook runner was never built');
    }

    public function testFromInputBadInputOmitsTheJobLine(): void
    {
        [$out, $o] = $this->go(['playbook_source' => 'input'], 'not json at all');
        self::assertSame('failed', $o[3]['exit']);
        self::assertStringStartsWith('Playbook failed: bad_input', $o[3]['output']);
        self::assertStringNotContainsString('Job: ', $o[3]['output']);
        self::assertSame(0, $this->factoryCalls);
    }

    public function testLegacyPlaybookNodeWithoutExitsRunsAllChildren(): void
    {
        $this->rounds = [[['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]]];
        [$out, $o] = $this->go(['playbook' => $this->playbookDoc()], 'hello', false);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertArrayHasKey(4, $o);
        self::assertArrayHasKey(5, $o);
        self::assertArrayNotHasKey('exit', $o[3]);
    }

    public function testFromInputResolvedKeyRunsThePublishedCopyAndEndsWithTheJobLine(): void
    {
        $this->pdo->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (1, 'pubpb', 'Pub', "
            . $this->pdo->quote("Title: Published Copy\nTrigger: a job\nInstructions: #Resolve Request.\nActions used: #Resolve Request") . ')');
        $this->rounds = [[['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]]];
        [$out, $o] = $this->go(['playbook_source' => 'input', 'writes_enabled' => true], '{"playbook":"pubpb","task":"INC0002"}');
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertSame('done', $o[3]['exit']);
        self::assertArrayHasKey(4, $o);
        self::assertArrayNotHasKey(5, $o);
        self::assertSame(1, $this->factoryCalls);
        self::assertStringContainsString('# Playbook: Published Copy', $o[3]['output'], 'the published text ran');
        $lines = explode("\n", rtrim($o[3]['output']));
        self::assertSame('Job: {"playbook":"pubpb","task":"INC0002"}', end($lines));
    }

    public function testFromInputMissingFieldIsBadInputButKeepsTheJobLine(): void
    {
        [$out, $o] = $this->go(['playbook_source' => 'input'], '{"task":"INC0001"}');
        self::assertSame('failed', $o[3]['exit']);
        self::assertStringStartsWith('Playbook failed: bad_input', $o[3]['output']);
        $lines = explode("\n", rtrim($o[3]['output']));
        self::assertSame('Job: {"task":"INC0001"}', end($lines));
        self::assertSame(0, $this->factoryCalls);
    }

    public function testFromInputJsonListHasNoJobLine(): void
    {
        [$out, $o] = $this->go(['playbook_source' => 'input'], '[1,2]');
        self::assertStringStartsWith('Playbook failed: bad_input', $o[3]['output']);
        self::assertStringNotContainsString('Job: ', $o[3]['output']);
    }

    public function testAnErrorReasonStaysOnOneLine(): void
    {
        // An unparsable stored playbook makes the run throw a multi-line message (it names the missing section).
        $this->pdo->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (1, 'badpb', 'Bad', 'Title: only a title')");
        [$out, $o] = $this->go(['playbook_source' => 'input'], '{"playbook":"badpb"}');
        self::assertSame('failed', $o[3]['exit']);
        $first = explode("\n", $o[3]['output'])[0];
        self::assertStringStartsWith('Playbook failed: error:', $first);
        self::assertStringContainsString('Instructions', $first);
    }
}
