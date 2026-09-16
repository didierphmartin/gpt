<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * LangGraph compiler, swarm mode: `orchestration = "swarm"` is a property of
 * the workflow (spec §10), not a build option, so it travels through the
 * facts the same way $wfName or $startPrompt does and generate() reads it
 * to pick the emit path.
 *
 * A swarm supports only the modular layout in v1 (§7); asking for single-file
 * or A2A packaging on a swarm is refused rather than silently downgraded.
 *
 * Fixture harness mirrors LangGraphA2AGeneratorTest (mocked repositories +
 * reflection into analyzeForEmit()) but, unlike that shared workflow-44
 * fixture, builds a fresh minimal graph per test: a swarm's validity depends
 * on shape (how many agents hang off Start) in a way the dispatcher-demo
 * graph does not exercise. twoAgentSwarm()/oneAgentSwarm() and generator()/
 * facts()/generate()/generateSwarm() below are the reusable pieces; Tasks
 * 2-4 build on top of them rather than inventing a parallel harness.
 */
class LangGraphSwarmGeneratorTest extends TestCase
{
    private static function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** Start -> two agents, no dispatcher: the smallest graph SwarmRewriter accepts. */
    private static function twoAgentSwarm(): array
    {
        $agent = fn(string $name) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => 'standard',
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'Help me plan a trip.']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('Alice')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('Bob')],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'],
            ],
        ];
    }

    /**
     * Start -> one agent: below SwarmRewriter's two-member floor
     * (start_needs_two_agents). Not exercised by this task's three tests but
     * kept alongside twoAgentSwarm() for Task 2/3, which need an invalid
     * shape to assert the refusal surfaces as a generation error.
     */
    private static function oneAgentSwarm(): array
    {
        $g = self::twoAgentSwarm();
        unset($g['nodes'][2], $g['edges'][1]);
        $g['nodes'] = array_values($g['nodes']);
        $g['edges'] = array_values($g['edges']);
        return $g;
    }

    private static function generator(array $graph, string $orchestration = 'swarm'): LangGraphGenerator
    {
        $t = new self('x');
        $wfRepo = $t->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(
            (new Workflow(['id' => 90, 'name' => 'Trip planning swarm', 'user_id' => '3']))
                ->setOrchestration($orchestration)
        );
        $graphRepo = $t->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $t->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator(self::pdo(), $wfRepo, $graphRepo, $agentRepo);
    }

    /** Facts as analyzeForEmit() returns them (private): reached through reflection. */
    private static function facts(array $graph, string $orchestration = 'swarm'): array
    {
        $gen = self::generator($graph, $orchestration);
        $m = new \ReflectionMethod($gen, 'analyzeForEmit');
        $m->setAccessible(true);
        return $m->invoke($gen, 90, '3');
    }

    /**
     * Runs the generator's swarm emit path directly (skipping generate()'s
     * option dispatch, which the refusal tests exercise instead) and returns
     * path => code, the same shape LangGraphModularGeneratorTest::files() uses.
     */
    private function generateSwarm(array $graph): array
    {
        $gen = self::generator($graph);
        $m = new \ReflectionMethod($gen, 'generateSwarm');
        $m->setAccessible(true);
        $manifest = $m->invoke($gen, self::facts($graph));
        $out = [];
        foreach ($manifest['files'] as $f) {
            $out[$f['path']] = $f['code'];
        }
        return $out;
    }

    /** Runs generate() itself, exactly as a caller (the code-gen dialog) would. */
    private function generate(array $graph, array $options, string $orchestration = 'swarm'): array
    {
        return self::generator($graph, $orchestration)->generate(90, '3', $options);
    }

    /**
     * Task 3 wires generateSwarm() to actually emit a package; here it is
     * still the Task-1 stub (`throw new RuntimeException('not implemented')`),
     * so this is expected to fail until Task 3 lands.
     */
    public function testASwarmWorkflowCompilesThroughTheSwarmPath(): void
    {
        $this->markTestSkipped('generateSwarm() emission is Task 3; Task 1 only wires dispatch + refusals.');
        $files = $this->generateSwarm(self::twoAgentSwarm());
        $this->assertArrayHasKey('workflow.py', $files);
        $this->assertStringContainsString('create_swarm', $files['workflow.py']);
    }

    public function testSingleFileIsRefusedForASwarm(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/single file|modular/i');
        $this->generate(self::twoAgentSwarm(), []);          // no modular, no a2a
    }

    public function testA2AIsRefusedForASwarm(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/A2A/i');
        $this->generate(self::twoAgentSwarm(), ['a2a' => true]);
    }
}
