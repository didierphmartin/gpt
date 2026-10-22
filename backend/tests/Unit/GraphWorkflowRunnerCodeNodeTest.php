<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\GraphWorkflowRunner;
use AgentTeam\Services\WorkflowGraphRepository;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use PHPUnit\Framework\TestCase;

/**
 * The server runner executes code nodes (real python3 harness, SQLite DB, temp run-log dir):
 * it follows the exit taken, records exit/success per code node, and a poll that found
 * nothing (quiet) leaves no execution row and no run log. Errors are never quiet.
 * Graph: Start(1) -> Code(2) ; exit 'work' (output_1) -> Output(3).
 */
final class GraphWorkflowRunnerCodeNodeTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    private \PDO $pdo;
    private string $runsDir;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $this->pdo->sqliteCreateFunction('NOW', fn() => date('Y-m-d H:i:s'), 0);
        $this->pdo->exec('CREATE TABLE agent_workflow_executions (id INTEGER PRIMARY KEY, workflow_id INTEGER, user_id INTEGER,
            input_variables TEXT, status TEXT, output TEXT, error_message TEXT, response_time_ms INTEGER, started_at TEXT, completed_at TEXT)');
        $this->pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)');
        $this->runsDir = sys_get_temp_dir() . '/wfruns_' . bin2hex(random_bytes(4));
        mkdir($this->runsDir);
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

    private function run_(string $code, array $exits, array $config = [], array $nodeConfig = [], ?array $edges = null,
        array $extraNodes = []): array
    {
        $nodes = [
            ['id' => 1, 'node_type' => 'start', 'config' => []],
            ['id' => 2, 'node_type' => 'code', 'config' => ['name' => 'Poll', 'code' => $code, 'exits' => $exits,
                'mcp_servers' => [], 'timeout_s' => 10] + $nodeConfig],
            ['id' => 3, 'node_type' => 'output', 'config' => []],
            ...$extraNodes,
        ];
        $edges ??= [
            ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_1'],
        ];
        $graph = Mockery::mock(WorkflowGraphRepository::class);
        $graph->shouldReceive('findStartNode')->andReturn($nodes[0]);
        $graph->shouldReceive('getGraph')->andReturn(['nodes' => $nodes, 'edges' => $edges]);
        $agentRunner = Mockery::mock(AgentRunner::class);
        $agentRunner->shouldNotReceive('run');
        $runner = new GraphWorkflowRunner($this->pdo, Mockery::mock(AgentRepository::class), $agentRunner, $graph,
            array_replace_recursive(['workflow_runs_dir' => $this->runsDir, 'code_nodes' => ['python' => self::python()]], $config));
        $prev = ini_set('error_log', $this->runsDir . '/php.log');
        try {
            return $runner->run(new Workflow(['id' => 44, 'name' => 'Poll test']), 3, ['prompt' => 'go']);
        } finally {
            ini_set('error_log', (string) $prev);
        }
    }

    private function rows(): array
    {
        return $this->pdo->query('SELECT * FROM agent_workflow_executions')->fetchAll(\PDO::FETCH_ASSOC);
    }

    private function runLogs(): array
    {
        return glob($this->runsDir . '/*.jsonl') ?: [];
    }

    public function testAPollThatFoundNothingLeavesNoTrace(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'none'}\n", ['work', 'idle']);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertTrue($out['quiet']);
        self::assertFalse($out['drain']);
        self::assertNull($out['execution_id']);
        self::assertSame([], $this->rows(), 'quiet run deletes its execution row');
        self::assertSame([], $this->runLogs(), 'quiet run deletes its run log');
        self::assertArrayNotHasKey(3, $out['node_outputs'], 'the work branch was skipped');
    }

    public function testAPollThatFoundWorkRunsTheExitAndAsksToDrain(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'work', 'output': 'job 1'}\n", ['work', 'idle']);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertFalse($out['quiet']);
        self::assertTrue($out['drain']);
        self::assertSame('job 1', $out['output']);
        $code = $out['node_outputs'][2];
        self::assertSame(['type' => 'code', 'output' => 'job 1', 'exit' => 'work', 'success' => true], $code);
        $rows = $this->rows();
        self::assertCount(1, $rows);
        self::assertSame('completed', $rows[0]['status']);
        self::assertCount(1, $this->runLogs());
        $runId = (new \AgentTeam\Services\WorkflowRunLog($this->runsDir))->current(44);
        self::assertMatchesRegularExpression('/^[a-f0-9]{32}$/', (string) $runId, 'the workflow points at its run');
        self::assertFileExists($this->runsDir . '/' . $runId . '.jsonl');
    }

    public function testWorkBesideThePollDoesNotDrain(): void
    {
        // Start -> Code(2) and Start -> Output(3) in parallel: the Output runs every tick, the poll found nothing.
        $edges = [
            ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
            ['from_node_id' => 1, 'to_node_id' => 3, 'from_port' => 'output_1'],
        ];
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'none'}\n", ['work', 'idle'], [], [], $edges);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertArrayHasKey(3, $out['node_outputs'], 'the Output beside the poll ran');
        self::assertFalse($out['quiet']);
        self::assertFalse($out['drain'], 'work beside the poll must not make the scheduler re-run the workflow');
    }

    public function testOutputTakesANodeOnceAndOnlyThroughTheExitItTook(): void
    {
        // Both exits of Code(2) link to Output(3): the Output shows the result once, not once per link.
        $edges = [
            ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_2'],
        ];
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'ok', 'output': 'stored'}\n", ['ok', 'no'], [], [], $edges);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertSame('stored', $out['output']);
    }

    public function testOutputIgnoresAnEarlierNodesUntakenErrorExit(): void
    {
        // Convert(2): done -> Store(4), error -> Output(3); Store(4): ok -> Output(3). Convert took done, so the
        // Output is Store's message alone -- not Convert's package next to it.
        $store = ['id' => 4, 'node_type' => 'code', 'config' => ['name' => 'Store', 'exits' => ['ok', 'no'],
            'code' => "def run(input, call_tool):\n    return {'route': 'ok', 'output': 'stored'}\n",
            'mcp_servers' => [], 'timeout_s' => 10]];
        $edges = [
            ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 4, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_2'],
            ['from_node_id' => 4, 'to_node_id' => 3, 'from_port' => 'output_1'],
            ['from_node_id' => 4, 'to_node_id' => 3, 'from_port' => 'output_2'],
        ];
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'done', 'output': 'package'}\n", ['done', 'error'],
            [], [], $edges, [$store]);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertSame('stored', $out['output']);
        self::assertSame('ok', $out['node_outputs'][4]['exit']);
    }

    public function testAnUnwiredErrorExitIsKeptAndNeverQuiet(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    raise ValueError('mailbox down')\n", ['work', 'idle', 'error']);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertFalse($out['quiet']);
        self::assertFalse($out['drain']);
        self::assertSame('error', $out['node_outputs'][2]['exit']);
        self::assertStringContainsString('mailbox down', $out['node_outputs'][2]['output']);
        $rows = $this->rows();
        self::assertCount(1, $rows);
        self::assertStringContainsString('mailbox down', (string) $rows[0]['output']);
        $log = (string) file_get_contents($this->runLogs()[0]);
        self::assertStringContainsString('took its error exit', $log);
    }

    private function phpLog(): string
    {
        return (string) @file_get_contents($this->runsDir . '/php.log');
    }

    public function testAnErrorExitRunIsRecordedButNeitherSavedNorArchived(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'error', 'output': 'mailbox down'}\n", ['work', 'idle', 'error']);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertNull($out['storage'], 'no output storage for an error exit');
        self::assertStringNotContainsString('Archive to conversation_contexts', $this->phpLog(), 'no archive attempt');
        $rows = $this->rows();
        self::assertCount(1, $rows);
        self::assertSame("code node 'Poll' took its error exit: mailbox down", $rows[0]['error_message']);
    }

    public function testANormalRunIsSavedAndArchived(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'work', 'output': 'job 1'}\n", ['work', 'idle', 'error']);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertIsArray($out['storage'], 'output storage was attempted');
        // No contexts_database in the test config: the attempt fails (best effort) and says so.
        self::assertStringContainsString('Archive to conversation_contexts failed', $this->phpLog());
        self::assertNull($this->rows()[0]['error_message']);
    }

    public function testTheErrorExitReasonIsLoggedAsOneBoundedLine(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'error', 'output': 'tool page\\n\\n  says ' + 'x' * 300}\n",
            ['work', 'idle', 'error']);
        self::assertTrue($out['success'], $out['error'] ?? '');
        $log = (string) file_get_contents($this->runLogs()[0]);
        self::assertMatchesRegularExpression('/took its error exit: tool page says x{185}…"/u', $log);
    }

    public function testAFailedCodeNodeFailsTheRunAndKeepsTheRow(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    raise ValueError('mailbox down')\n", ['work', 'idle']);
        self::assertFalse($out['success']);
        self::assertArrayNotHasKey('quiet', $out, 'a failed run is never reported quiet');
        self::assertArrayNotHasKey('drain', $out, 'a failed run never drains');
        self::assertStringContainsString('mailbox down', $out['error']);
        self::assertFalse($out['partial_outputs'][2]['success']);
        $rows = $this->rows();
        self::assertCount(1, $rows);
        self::assertSame('failed', $rows[0]['status']);
        self::assertStringContainsString('mailbox down', (string) $rows[0]['error_message']);
    }

    public function testADisabledCodeNodeNeitherDrainsNorGoesQuiet(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'x'}\n", ['work', 'idle'],
            [], ['disabled' => true]);
        self::assertTrue($out['success'], $out['error'] ?? '');
        self::assertFalse($out['quiet']);
        self::assertFalse($out['drain'], 'a disabled code node must not make the scheduler re-run the workflow');
        self::assertArrayHasKey(3, $out['node_outputs'], 'the downstream Output ran');
        $rows = $this->rows();
        self::assertCount(1, $rows);
        self::assertSame('completed', $rows[0]['status']);
        self::assertCount(1, $this->runLogs());
    }

    public function testSwitchedOffCodeNodesFailTheRun(): void
    {
        $out = $this->run_("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'x'}\n", ['work', 'idle'],
            ['code_nodes' => ['server_side' => false]]);
        self::assertFalse($out['success']);
        self::assertStringContainsString('CODE_NODES_SERVER_SIDE', $out['error']);
        self::assertCount(1, $this->rows());
    }
}
