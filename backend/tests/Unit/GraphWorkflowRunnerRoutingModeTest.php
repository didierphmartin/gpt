<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\GraphWorkflowRunner;
use AgentTeam\Services\JevRouter;
use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\ApiKeyCrypto;

/**
 * The interpreter's dispatcher honours settings.routing_mode:
 *   'jev' = Jev only (the model is never called; no decision = "did not route"),
 *   'llm' = model only (Jev is never consulted),
 *   anything else (absent) = today's hybrid: Jev first when a key exists, the
 *   model when Jev declines or no key.
 * The key is the stored one (user row wins over the global row), never .env.
 */
final class GraphWorkflowRunnerRoutingModeTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    private const SECRET = 'routing-mode-test-secret';
    private const USER_ID = 7;

    protected function tearDown(): void
    {
        Mockery::close();
    }

    private static function jevAnswer(string $choice, float $confidence): Response
    {
        return new Response(200, [], json_encode(['model' => 'jev-1.13.0', 'answers' => ['route' => [
            'type' => 'choice', 'choice' => $choice, 'confidence' => $confidence,
            'probabilities' => [$choice => $confidence],
        ]], 'usage' => ['input_tokens' => 342, 'output_tokens' => 39]]));
    }

    /** A PDO that answers ensureDbConnection and JevKeyResolver's two lookups. */
    private function pdo(string $userKey, string $globalKey): \PDO
    {
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('query')->andReturn(Mockery::mock(\PDOStatement::class));
        $pdo->shouldReceive('prepare')->andReturnUsing(function (string $sql) use ($userKey, $globalKey) {
            $value = str_contains($sql, 'user_api_keys')
                ? ($userKey !== '' ? ApiKeyCrypto::encrypt($userKey, self::SECRET) : false)
                : ($globalKey !== '' ? $globalKey : false);
            $stmt = Mockery::mock(\PDOStatement::class);
            $stmt->shouldReceive('execute')->andReturn(true);
            $stmt->shouldReceive('fetchColumn')->andReturn($value);
            return $stmt;
        });
        return $pdo;
    }

    /** An AgentRunner whose model answers route_to(Sales) — or must never be called. */
    private function agentRunner(bool $expectCall): AgentRunner
    {
        $runner = Mockery::mock(AgentRunner::class);
        if ($expectCall) {
            $runner->shouldReceive('run')->once()->andReturn([
                'success' => true,
                'pending_client_tool_call' => true,
                'pending_tool_calls' => [['name' => 'route_to', 'input' => ['target' => 'Sales', 'notes' => 'model chose']]],
                'usage' => ['input_tokens' => 1000, 'output_tokens' => 20],
            ]);
        } else {
            $runner->shouldNotReceive('run');
        }
        return $runner;
    }

    /**
     * @param array<string, mixed>|null $settings dispatcher settings (routing_mode, jev_min_confidence)
     * @param Response[] $jevQueue canned Jev API responses
     */
    private function makeRunner(string $userKey, string $globalKey, AgentRunner $agentRunner, array $jevQueue): RoutingModeTestRunner
    {
        $ref = new \ReflectionClass(GraphWorkflowRunner::class);
        /** @var RoutingModeTestRunner $runner */
        $runner = (new \ReflectionClass(RoutingModeTestRunner::class))->newInstanceWithoutConstructor();
        $runner->jevQueue = $jevQueue;
        $set = function (string $prop, $value) use ($ref, $runner): void {
            $p = $ref->getProperty($prop);
            $p->setAccessible(true);
            $p->setValue($runner, $value);
        };
        $set('db', $this->pdo($userKey, $globalKey));
        $set('config', ['auth' => ['jwt_secret' => self::SECRET]]);
        $set('agentRunner', $agentRunner);
        $set('workflowName', 'Support desk');
        $set('graphNodes', [
            1 => ['id' => 1, 'node_type' => 'agent', 'config' => []],
            2 => ['id' => 2, 'node_type' => 'agent', 'config' => ['agent_name' => 'Billing']],
            3 => ['id' => 3, 'node_type' => 'agent', 'config' => ['agent_name' => 'Sales']],
        ]);
        return $runner;
    }

    private function dispatch(GraphWorkflowRunner $runner, ?array $settings): array
    {
        $node = ['id' => 1, 'node_type' => 'agent', 'agent_id' => null, 'config' => [
            'agent_name' => 'Router',
            'agent_type' => 'dispatcher',
            'provider' => 'openai',
            'model' => 'gpt-test',
            'instructions' => 'Send the request to the right team.',
            'tools' => [],
            'settings' => $settings ?? [],
        ]];
        $edges = [
            ['from_node_id' => 1, 'to_node_id' => 2],
            ['from_node_id' => 1, 'to_node_id' => 3],
        ];
        $m = new \ReflectionMethod(GraphWorkflowRunner::class, 'executeAgentNode');
        $m->setAccessible(true);
        return $m->invoke($runner, $node, self::USER_ID, 'I was charged twice.', $edges, []);
    }

    // ── Jev mode: Jev only ─────────────────────────────────────────────────

    public function testJevModeRoutedNeverCallsTheModel(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Billing', 0.99)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertTrue($out['success']);
        $this->assertSame('jev', $out['provider']);
        $this->assertSame('Billing', $out['route']['name']);
        $this->assertSame(['input_tokens' => 342, 'output_tokens' => 39], $out['usage']);
        $this->assertSame('global-jev-key', $runner->madeWithKey);
    }

    public function testJevModeUnclearStopsWithDidNotRoute(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer(JevRouter::UNCLEAR, 1.0)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertFalse($out['success']);
        $this->assertSame('jev', $out['provider']);
        $this->assertArrayNotHasKey('route', $out);
        $this->assertSame(
            'Error: dispatcher "Router" did not route the request (Jev: unclear: the request names no branch).',
            $out['output']
        );
        $this->assertSame(['input_tokens' => 342, 'output_tokens' => 39], $out['usage']);
    }

    public function testJevModeLowConfidenceStopsWithDidNotRoute(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Sales', 0.46)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertFalse($out['success']);
        $this->assertSame(
            'Error: dispatcher "Router" did not route the request (Jev: low_confidence: confidence 0.46 below floor 0.60).',
            $out['output']
        );
    }

    public function testJevModeWithoutAKeyStopsWithDidNotRouteAndZeroUsage(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(false), []);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertFalse($out['success']);
        $this->assertSame('jev', $out['provider']);
        $this->assertSame(
            'Error: dispatcher "Router" did not route the request (Jev: unavailable: no Jev key).',
            $out['output']
        );
        $this->assertSame(['input_tokens' => 0, 'output_tokens' => 0], $out['usage']);
    }

    /** A user with only a personal key (no global key) still gets Jev routing. */
    public function testJevModeUsesTheUsersOwnKey(): void
    {
        $runner = $this->makeRunner('personal-jev-key', '', $this->agentRunner(false), [self::jevAnswer('Billing', 0.99)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertTrue($out['success']);
        $this->assertSame('Billing', $out['route']['name']);
        $this->assertSame('personal-jev-key', $runner->madeWithKey);
    }

    // ── LLM mode: model only ───────────────────────────────────────────────

    public function testLlmModeNeverConsultsJevEvenWithAKey(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(true), [self::jevAnswer('Billing', 0.99)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'llm']);

        $this->assertTrue($out['success']);
        $this->assertSame('openai', $out['provider']);
        $this->assertSame('Sales', $out['route']['name']);
        $this->assertSame(0, $runner->made, 'LLM mode must not build a Jev router');
    }

    public function testLlmModeWithoutAKeyUsesTheModel(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(true), []);
        $out = $this->dispatch($runner, ['routing_mode' => 'llm']);

        $this->assertSame('Sales', $out['route']['name']);
        $this->assertSame(0, $runner->made);
    }

    // ── No mode saved: today's hybrid ──────────────────────────────────────

    public function testHybridRoutedByJevSkipsTheModel(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Billing', 0.99)]);
        $out = $this->dispatch($runner, null);

        $this->assertSame('jev', $out['provider']);
        $this->assertSame('Billing', $out['route']['name']);
    }

    public function testHybridUnclearFallsBackToTheModel(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(true), [self::jevAnswer(JevRouter::UNCLEAR, 1.0)]);
        $out = $this->dispatch($runner, []);

        $this->assertTrue($out['success']);
        $this->assertSame('openai', $out['provider']);
        $this->assertSame('Sales', $out['route']['name']);
    }

    public function testHybridWithoutAKeyIsThePureModel(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(true), []);
        $out = $this->dispatch($runner, null);

        $this->assertSame('openai', $out['provider']);
        $this->assertSame('Sales', $out['route']['name']);
    }

    public function testAnUnknownModeIsTheHybrid(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(true), [self::jevAnswer(JevRouter::UNCLEAR, 1.0)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'banana']);

        $this->assertSame('openai', $out['provider'], 'an unknown mode must fall back to the model like the hybrid');
        $this->assertSame('Sales', $out['route']['name']);
    }

    // ── Minimum confidence ─────────────────────────────────────────────────

    /** @return array<string, array{0: mixed, 1: float}> */
    public static function floors(): array
    {
        return [
            'absent'      => [null, JevRouter::DEFAULT_CONFIDENCE_FLOOR],
            'numeric'     => [0.3, 0.3],
            'string'      => ['0.75', 0.75],
            'above one'   => [1.7, 1.0],
            'below zero'  => [-2, 0.0],
            'not numeric' => ['abc', JevRouter::DEFAULT_CONFIDENCE_FLOOR],
        ];
    }

    /** @dataProvider floors */
    public function testMinimumConfidenceIsTheClampedFloor(mixed $setting, float $expected): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Billing', 0.99)]);
        $settings = ['routing_mode' => 'jev'];
        if ($setting !== null) {
            $settings['jev_min_confidence'] = $setting;
        }
        $this->dispatch($runner, $settings);

        $this->assertSame($expected, $runner->madeWithFloor);
    }

    public function testALowerFloorLetsADividedAnswerRoute(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Sales', 0.46)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev', 'jev_min_confidence' => 0.4]);

        $this->assertTrue($out['success']);
        $this->assertSame('Sales', $out['route']['name']);
    }

    // ── Run level: what happens to the branches ────────────────────────────

    private string $runsDir = '';

    /**
     * A whole run() over Start -> Router (dispatcher) -> Billing | Sales -> Output.
     * The children are disabled nodes: if the traversal reaches them they record
     * the 'disabled node' sentinel (and never call a model), so their presence
     * in node_outputs is proof they ran.
     */
    private function runWorkflow(?array $settings, string $globalKey, array $jevQueue, AgentRunner $agentRunner): array
    {
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('prepare')->andReturnUsing(function (string $sql) use ($globalKey) {
            $stmt = Mockery::mock(\PDOStatement::class);
            $stmt->shouldReceive('execute')->andReturn(true);
            $stmt->shouldReceive('fetch')->andReturn(false);
            $stmt->shouldReceive('fetchAll')->andReturn([]);
            $stmt->shouldReceive('fetchColumn')->andReturn(
                str_contains($sql, 'system_llm_settings') && $globalKey !== '' ? $globalKey : false
            );
            $stmt->shouldReceive('rowCount')->andReturn(0);
            return $stmt;
        });
        $pdo->shouldReceive('query')->andReturnUsing(fn () => Mockery::mock(\PDOStatement::class)->shouldIgnoreMissing());
        $pdo->shouldReceive('exec')->andReturn(0);
        $pdo->shouldReceive('lastInsertId')->andReturn('1');

        $child = fn (int $id, string $name) => ['id' => $id, 'node_type' => 'agent', 'agent_id' => null,
            'config' => ['agent_name' => $name, 'instructions' => "You are {$name}.", 'provider' => 'openai',
                         'tools' => [], 'disabled' => true]];
        $nodes = [
            ['id' => 10, 'node_type' => 'start', 'agent_id' => null, 'config' => []],
            ['id' => 1, 'node_type' => 'agent', 'agent_id' => null, 'config' => [
                'agent_name' => 'Router', 'agent_type' => 'dispatcher', 'provider' => 'openai', 'model' => 'gpt-test',
                'instructions' => 'Send the request to the right team.', 'tools' => [], 'settings' => $settings ?? [],
            ]],
            $child(2, 'Billing'),
            $child(3, 'Sales'),
            ['id' => 4, 'node_type' => 'output', 'agent_id' => null, 'config' => []],
        ];
        $edges = [
            ['from_node_id' => 10, 'to_node_id' => 1],
            ['from_node_id' => 1, 'to_node_id' => 2],
            ['from_node_id' => 1, 'to_node_id' => 3],
            ['from_node_id' => 2, 'to_node_id' => 4],
            ['from_node_id' => 3, 'to_node_id' => 4],
        ];
        $graph = Mockery::mock(\AgentTeam\Services\WorkflowGraphRepository::class);
        $graph->shouldReceive('findStartNode')->andReturn($nodes[0]);
        $graph->shouldReceive('getGraph')->andReturn(['nodes' => $nodes, 'edges' => $edges]);

        $this->runsDir = sys_get_temp_dir() . '/routing-mode-test-' . bin2hex(random_bytes(4));
        $runner = new RoutingModeTestRunner(
            $pdo,
            Mockery::mock(\AgentTeam\Services\AgentRepository::class),
            $agentRunner,
            $graph,
            ['auth' => ['jwt_secret' => self::SECRET], 'workflow_runs_dir' => $this->runsDir]
        );
        $runner->jevQueue = $jevQueue;

        // userId 0: no per-user key lookup and no conversation archive.
        return $runner->run(new \AgentTeam\Models\Workflow(['id' => 5, 'name' => 'Support desk']), 0,
            ['prompt' => 'I was charged twice.']);
    }

    private function cleanRunsDir(): void
    {
        if ($this->runsDir !== '' && is_dir($this->runsDir)) {
            array_map('unlink', glob($this->runsDir . '/*') ?: []);
            rmdir($this->runsDir);
        }
    }

    /** @return array<string, array{0: string, 1: Response[], 2: string}> */
    public static function jevDeclines(): array
    {
        return [
            'unclear' => ['global-jev-key', [self::jevAnswer(JevRouter::UNCLEAR, 1.0)], 'unclear: the request names no branch'],
            'no key'  => ['', [], 'unavailable: no Jev key'],
        ];
    }

    /** @dataProvider jevDeclines */
    public function testAJevOnlyDispatcherThatDoesNotRouteStopsItsBranches(string $key, array $queue, string $why): void
    {
        try {
            $out = $this->runWorkflow(['routing_mode' => 'jev'], $key, $queue, $this->agentRunner(false));
        } finally {
            $this->cleanRunsDir();
        }
        $message = "Error: dispatcher \"Router\" did not route the request (Jev: {$why}).";

        $this->assertArrayNotHasKey(2, $out['node_outputs'], 'Billing must not run');
        $this->assertArrayNotHasKey(3, $out['node_outputs'], 'Sales must not run');
        $this->assertArrayNotHasKey(4, $out['node_outputs'], 'nothing downstream of the branches runs');
        $this->assertFalse($out['node_outputs'][1]['success']);
        $this->assertSame($message, $out['node_outputs'][1]['output']);
        $this->assertSame($message, $out['output'], 'the run ends with the did-not-route result');
    }

    /**
     * Scope pin: a hybrid (no mode) dispatcher whose model does not call
     * route_to keeps today's behaviour, which fans out to every branch.
     */
    public function testAHybridDispatcherThatDoesNotRouteKeepsTodaysFanOut(): void
    {
        $model = Mockery::mock(AgentRunner::class);
        $model->shouldReceive('run')->once()->andReturn(['success' => true, 'text' => 'Some prose, no route_to.',
            'usage' => ['input_tokens' => 10, 'output_tokens' => 5]]);
        try {
            $out = $this->runWorkflow(null, '', [], $model);
        } finally {
            $this->cleanRunsDir();
        }

        $this->assertFalse($out['node_outputs'][1]['success']);
        $this->assertStringContainsString('did not route the request. Expected a route_to call', $out['node_outputs'][1]['output']);
        $this->assertSame('disabled node', $out['node_outputs'][2]['output'], 'Billing still runs (unchanged)');
        $this->assertSame('disabled node', $out['node_outputs'][3]['output'], 'Sales still runs (unchanged)');
    }

    // ── Usage recording ────────────────────────────────────────────────────

    /**
     * Jev is not priced in system_llm_settings (it is not an LLM), so a Jev
     * step must be costed without asking PricingResolver at all.
     */
    public function testAJevStepIsNotPriced(): void
    {
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldNotReceive('prepare');
        $ref = new \ReflectionClass(GraphWorkflowRunner::class);
        $runner = $ref->newInstanceWithoutConstructor();
        $p = $ref->getProperty('db');
        $p->setAccessible(true);
        $p->setValue($runner, $pdo);

        $m = $ref->getMethod('computeNodeCost');
        $m->setAccessible(true);
        $this->assertSame(0.0, $m->invoke($runner, 'jev', 342, 39));
    }
}

/** Replaces the Jev HTTP transport with canned answers and records how the router was built. */
class RoutingModeTestRunner extends GraphWorkflowRunner
{
    /** @var Response[] */
    public array $jevQueue = [];
    public int $made = 0;
    public ?string $madeWithKey = null;
    public ?float $madeWithFloor = null;

    protected function makeJevRouter(string $key, float $floor): JevRouter
    {
        $this->made++;
        $this->madeWithKey = $key;
        $this->madeWithFloor = $floor;
        // Mirrors production: an empty key means "not configured" (null).
        return new JevRouter($key !== '' ? $key : null, new Client(['handler' => HandlerStack::create(new MockHandler($this->jevQueue))]), $floor);
    }
}
