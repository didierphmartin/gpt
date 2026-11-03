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
 * A node bound to a skill needs a browser to run it. A run with no client_skills entry
 * (scheduled, event-triggered, robot, API) fails before any LLM call instead of running
 * the node without its skill. Nodes without a bound skill are unaffected.
 * Graph: Start(1) -> Agent(2) -> Output(3); the fan-out variant adds Agent(4) beside Agent(2).
 */
final class GraphWorkflowRunnerSkillTest extends TestCase
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

    private function run_(array $agentConfig, array $clientSkills = [], bool $fanOut = false): array
    {
        $nodes = [
            ['id' => 1, 'node_type' => 'start', 'config' => []],
            ['id' => 2, 'node_type' => 'agent', 'agent_id' => 7, 'config' => ['name' => 'Skilled'] + $agentConfig],
            ['id' => 3, 'node_type' => 'output', 'config' => []],
        ];
        $edges = [
            ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
            ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_1'],
        ];
        if ($fanOut) {
            $nodes[] = ['id' => 4, 'node_type' => 'agent', 'agent_id' => 8, 'config' => ['name' => 'Plain']];
            $edges[] = ['from_node_id' => 1, 'to_node_id' => 4, 'from_port' => 'output_1'];
            $edges[] = ['from_node_id' => 4, 'to_node_id' => 3, 'from_port' => 'output_1'];
        }
        $graph = Mockery::mock(WorkflowGraphRepository::class);
        $graph->shouldReceive('findStartNode')->andReturn($nodes[0]);
        $graph->shouldReceive('getGraph')->andReturn(['nodes' => $nodes, 'edges' => $edges]);
        // No agent lookup and no LLM call may happen for the failing node.
        $agents = Mockery::mock(AgentRepository::class);
        $agents->shouldNotReceive('findById');
        $agentRunner = Mockery::mock(AgentRunner::class);
        $agentRunner->shouldNotReceive('run');
        $runner = new GraphWorkflowRunner($this->pdo, $agents, $agentRunner, $graph, ['workflow_runs_dir' => $this->runsDir]);
        $prev = ini_set('error_log', $this->runsDir . '/php.log');
        try {
            return $runner->run(new Workflow(['id' => 44, 'name' => 'Skill test']), 3, ['prompt' => 'go'], $clientSkills);
        } finally {
            ini_set('error_log', (string) $prev);
        }
    }

    private const MESSAGE = 'Skill "pdf-tools" can only run from the editor or in a compiled program: this run has no browser to run it.';

    public function testBoundSkillWithoutABrowserFailsTheRun(): void
    {
        $out = $this->run_(['bound_skill' => ['dir_name' => 'pdf-tools', 'source' => 'local']]);
        self::assertFalse($out['success']);
        self::assertSame(self::MESSAGE, $out['error']);
        $rows = $this->pdo->query('SELECT status, error_message FROM agent_workflow_executions')->fetchAll(\PDO::FETCH_ASSOC);
        self::assertCount(1, $rows);
        self::assertSame('failed', $rows[0]['status']);
        self::assertSame(self::MESSAGE, $rows[0]['error_message']);
    }

    public function testALegacyInlineSkillContentDoesNotRescueIt(): void
    {
        $out = $this->run_(['bound_skill' => ['dir_name' => 'pdf-tools'], 'skill_content' => 'old inline body']);
        self::assertFalse($out['success']);
        self::assertSame(self::MESSAGE, $out['error']);
    }

    public function testTheFanOutPathFailsTheSameWay(): void
    {
        $out = $this->run_(['bound_skill' => ['dir_name' => 'pdf-tools']], [], true);
        self::assertFalse($out['success']);
        self::assertSame(self::MESSAGE, $out['error']);
    }

    public function testTheGuardPassesWhenTheBrowserSentTheSkill(): void
    {
        $cfg = ['bound_skill' => ['dir_name' => 'pdf-tools']];
        GraphWorkflowRunner::assertBoundSkillRunnable($cfg, ['pdf-tools' => ['skill_content' => 'x']]);
        $this->addToAssertionCount(1);
    }

    public function testNodesWithoutABoundSkillAreUnaffected(): void
    {
        foreach ([[], ['skill_content' => 'inline only'], ['bound_skill' => ['dir_name' => '']], ['bound_skill' => null]] as $cfg) {
            GraphWorkflowRunner::assertBoundSkillRunnable($cfg, []);
        }
        $this->addToAssertionCount(1);
    }
}
