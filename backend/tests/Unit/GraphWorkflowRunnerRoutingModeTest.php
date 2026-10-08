<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\DecisionRouter;
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
use Quantis\AIPortfolioAssistant\Services\DecisionUsage;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;

/**
 * The interpreter's dispatcher honours settings.routing_mode:
 *   a provider key (e.g. 'jev') = that decision provider only (the model is
 *     never called; no decision, or an unknown provider = "did not route"),
 *   'llm' = model only (no decision provider is consulted),
 *   unset = the first decision provider the user's plan allows, else the model.
 *   There is no hybrid: a decline never falls back to the model or another provider.
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

    /**
     * A PDO that answers ensureDbConnection, DecisionKeyResolver's package and key
     * lookups, and PricingResolver's jev price row.
     *
     * @param bool $jevEnabled the role's package switches Jev on (false = not in the plan)
     * @param array{0: ?float, 1: ?float} $jevPrices price_input_per_1m / price_output_per_1m of the jev row
     */
    private function pdo(string $userKey, string $globalKey, bool $jevEnabled = true, array $jevPrices = [0.042, 0.0]): \PDO
    {
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('query')->andReturn(Mockery::mock(\PDOStatement::class));
        $pdo->shouldReceive('prepare')->andReturnUsing(function (string $sql) use ($userKey, $globalKey, $jevEnabled, $jevPrices) {
            $row = false;
            $rows = [];
            if (str_contains($sql, 'FROM users')) {
                $row = ['role' => 'user'];
            } elseif (str_contains($sql, 'FROM packages')) {
                $row = ['capabilities' => json_encode(['providers' => [
                    'jev' => ['enabled' => $jevEnabled], 'acme' => ['enabled' => $jevEnabled],
                ]]), 'updated_at' => null];
            } elseif (str_contains($sql, 'api_format = :f')) {
                $rows = [
                    ['provider_key' => 'acme', 'display_name' => 'Acme', 'api_key' => 'acme-global', 'model' => 'acme-1',
                     'base_url' => null, 'protocol' => 'typesafe', 'enabled' => 1, 'sort_order' => 200],
                    ['provider_key' => 'jev', 'display_name' => 'Jev', 'api_key' => $globalKey, 'model' => 'jev-latest',
                     'base_url' => null, 'protocol' => 'typesafe', 'enabled' => 1, 'sort_order' => 100],
                ];
                usort($rows, fn($a, $b) => $a['sort_order'] <=> $b['sort_order']);
            } elseif (str_contains($sql, 'user_api_keys')) {
                $row = $userKey !== '' ? ['api_key' => ApiKeyCrypto::encrypt($userKey, self::SECRET), 'base_url' => null] : false;
            } elseif (str_contains($sql, 'price_input_per_1m')) {
                $row = ['price_input_per_1m' => $jevPrices[0], 'price_output_per_1m' => $jevPrices[1]];
            }
            $stmt = Mockery::mock(\PDOStatement::class);
            $stmt->shouldReceive('execute')->andReturn(true);
            $stmt->shouldReceive('fetch')->andReturn($row);
            $stmt->shouldReceive('fetchAll')->andReturn($rows);
            $stmt->shouldReceive('fetchColumn')->andReturn(false);
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
    private function makeRunner(string $userKey, string $globalKey, AgentRunner $agentRunner, array $jevQueue,
                                bool $jevEnabled = true, array $jevPrices = [0.042, 0.0]): RoutingModeTestRunner
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
        $set('db', $this->pdo($userKey, $globalKey, $jevEnabled, $jevPrices));
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

        $this->assertTrue($out['success'], 'no branch fits: a normal ending, not an error');
        $this->assertSame('jev', $out['provider']);
        $this->assertArrayNotHasKey('route', $out);
        $this->assertSame(
            'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).',
            $out['output']
        );
        $this->assertSame(['input_tokens' => 342, 'output_tokens' => 39], $out['usage']);
    }

    public function testJevModeLowConfidenceStopsWithDidNotRoute(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Sales', 0.46)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertTrue($out['success'], 'no branch fits: a normal ending, not an error');
        $this->assertSame(
            'Not classified: dispatcher "Router" did not route the request (jev: low_confidence: confidence 0.46 below floor 0.60).',
            $out['output']
        );
    }

    public function testJevModeUnclearGoesToTheUnclearBranch(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer(JevRouter::UNCLEAR, 0.7)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev', 'unclear_branch' => 'Sales']);

        $this->assertTrue($out['success']);
        $this->assertSame('Sales', $out['route']['name']);
        $this->assertArrayNotHasKey('halt_branches', $out);
    }

    public function testJevModeLowConfidenceGoesToTheUnclearBranch(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Billing', 0.46)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev', 'unclear_branch' => 'Sales']);

        $this->assertSame('Sales', $out['route']['name']);
    }

    public function testAnUnclearBranchNoLongerOnTheMenuStops(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer(JevRouter::UNCLEAR, 1.0)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev', 'unclear_branch' => 'Deleted branch']);

        $this->assertArrayNotHasKey('route', $out);
        $this->assertTrue($out['halt_branches']);
    }

    public function testAMissingKeyIgnoresTheUnclearBranch(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(false), []);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev', 'unclear_branch' => 'Sales']);

        $this->assertFalse($out['success']);
        $this->assertArrayNotHasKey('route', $out);
        $this->assertStringStartsWith('Error: ', $out['output']);
    }

    public function testJevModeWithoutAKeyStopsWithDidNotRouteAndZeroUsage(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(false), []);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertFalse($out['success']);
        $this->assertSame('jev', $out['provider']);
        $this->assertSame(
            'Error: dispatcher "Router" did not route the request (jev: unavailable: no Jev key).',
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

    // ── No mode saved: Jev when the plan allows it, else the model ─────────

    public function testUnsetModeAllowedRoutesWithJev(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Billing', 0.99)]);
        $out = $this->dispatch($runner, null);

        $this->assertTrue($out['success']);
        $this->assertSame('jev', $out['provider']);
        $this->assertSame('Billing', $out['route']['name']);
    }

    public function testUnsetModeAllowedUnclearStopsWithDidNotRouteAndNeverCallsTheModel(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer(JevRouter::UNCLEAR, 1.0)]);
        $out = $this->dispatch($runner, []);

        $this->assertTrue($out['success'], 'no branch fits: a normal ending, not an error');
        $this->assertSame('jev', $out['provider']);
        $this->assertArrayNotHasKey('route', $out);
        $this->assertTrue($out['halt_branches']);
        $this->assertSame(
            'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).',
            $out['output']
        );
    }

    public function testUnsetModeAllowedWithoutAKeyStopsWithDidNotRoute(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(false), []);
        $out = $this->dispatch($runner, null);

        $this->assertFalse($out['success']);
        $this->assertSame('jev', $out['provider']);
        $this->assertTrue($out['halt_branches']);
        $this->assertSame(
            'Error: dispatcher "Router" did not route the request (jev: unavailable: no Jev key).',
            $out['output']
        );
    }

    public function testANodeNamingADeletedProviderHalts(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), []);
        $out = $this->dispatch($runner, ['routing_mode' => 'banana']);

        $this->assertFalse($out['success']);
        $this->assertTrue($out['halt_branches']);
        $this->assertSame('banana', $out['provider']);
        $this->assertSame(0, $runner->made, 'nothing to build for an unknown provider');
        $this->assertSame(
            'Error: dispatcher "Router" did not route the request (banana: unavailable: \'banana\' is not an available decision provider).',
            $out['output']
        );
    }

    public function testEachNodeUsesItsOwnProvider(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Sales', 0.99)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'acme']);

        $this->assertTrue($out['success']);
        $this->assertSame('acme', $out['provider']);
        $this->assertSame('acme', $runner->madeFor);
        $this->assertSame('acme-global', $runner->madeWithKey);
        $this->assertSame('acme', $runner->recorded[0]['provider']);
    }

    public function testMinConfidenceWinsOverTheLegacySetting(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Sales', 0.99)]);
        $this->dispatch($runner, ['routing_mode' => 'jev', 'min_confidence' => 0.8, 'jev_min_confidence' => 0.3]);
        $this->assertSame(0.8, $runner->madeWithFloor);
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
            // The package lookup (userId 0 resolves to the guest package) enables Jev.
            $stmt->shouldReceive('fetch')->andReturn(str_contains($sql, 'FROM packages')
                ? ['capabilities' => json_encode(['providers' => ['jev' => ['enabled' => true]]]), 'updated_at' => null]
                : false);
            // The decision rows (DecisionProviders::rows): the jev row holds the global key.
            $stmt->shouldReceive('fetchAll')->andReturn(str_contains($sql, 'api_format = :f')
                ? [['provider_key' => 'jev', 'display_name' => 'Jev', 'api_key' => $globalKey, 'model' => 'jev-latest',
                    'base_url' => null, 'protocol' => 'typesafe', 'enabled' => 1, 'sort_order' => 100]]
                : []);
            $stmt->shouldReceive('fetchColumn')->andReturn(false);
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
        // A request no branch fits ends normally; a missing key is an error.
        $notClassified = str_starts_with($why, 'unclear');
        $message = ($notClassified ? 'Not classified' : 'Error') . ": dispatcher \"Router\" did not route the request (jev: {$why}).";

        $this->assertArrayNotHasKey(2, $out['node_outputs'], 'Billing must not run');
        $this->assertArrayNotHasKey(3, $out['node_outputs'], 'Sales must not run');
        $this->assertArrayNotHasKey(4, $out['node_outputs'], 'nothing downstream of the branches runs');
        $this->assertSame($notClassified, $out['node_outputs'][1]['success']);
        $this->assertSame($message, $out['node_outputs'][1]['output']);
        $this->assertSame($message, $out['output'], 'the run ends with the did-not-route result');
    }

    /** An unset dispatcher on a plan with Jev is Jev only: a decline stops its branches too. */
    public function testAnUnsetDispatcherThatJevDoesNotRouteStopsItsBranches(): void
    {
        try {
            $out = $this->runWorkflow(null, 'global-jev-key', [self::jevAnswer(JevRouter::UNCLEAR, 1.0)], $this->agentRunner(false));
        } finally {
            $this->cleanRunsDir();
        }
        $message = 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).';

        $this->assertArrayNotHasKey(2, $out['node_outputs'], 'Billing must not run');
        $this->assertArrayNotHasKey(3, $out['node_outputs'], 'Sales must not run');
        $this->assertSame($message, $out['output']);
    }

    /**
     * Scope pin: an LLM-mode dispatcher whose model does not call route_to
     * keeps today's behaviour, which fans out to every branch.
     */
    public function testAnLlmDispatcherThatDoesNotRouteKeepsTodaysFanOut(): void
    {
        $model = Mockery::mock(AgentRunner::class);
        $model->shouldReceive('run')->once()->andReturn(['success' => true, 'text' => 'Some prose, no route_to.',
            'usage' => ['input_tokens' => 10, 'output_tokens' => 5]]);
        try {
            $out = $this->runWorkflow(['routing_mode' => 'llm'], '', [], $model);
        } finally {
            $this->cleanRunsDir();
        }

        $this->assertFalse($out['node_outputs'][1]['success']);
        $this->assertStringContainsString('did not route the request. Expected a route_to call', $out['node_outputs'][1]['output']);
        $this->assertSame('disabled node', $out['node_outputs'][2]['output'], 'Billing still runs (unchanged)');
        $this->assertSame('disabled node', $out['node_outputs'][3]['output'], 'Sales still runs (unchanged)');
    }

    // ── Usage recording ────────────────────────────────────────────────────

    private function nodeCost(GraphWorkflowRunner $runner, int $in, int $out): ?float
    {
        $m = new \ReflectionMethod(GraphWorkflowRunner::class, 'computeNodeCost');
        $m->setAccessible(true);
        return $m->invoke($runner, 'jev', $in, $out);
    }

    /** Jev is priced from its system_llm_settings row, like any provider. */
    public function testAJevRoutedStepIsRecordedOnceAndPricedFromTheRow(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer('Billing', 0.99)]);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertSame('Billing', $out['route']['name']);
        $this->assertCount(1, $runner->recorded);
        $this->assertSame(self::USER_ID, $runner->recorded[0]['user_id']);
        $this->assertSame('routed', $runner->recorded[0]['outcome']);
        $this->assertSame(['input_tokens' => 342, 'output_tokens' => 39], $runner->recorded[0]['usage']);
        $this->assertEqualsWithDelta(0.042, $this->nodeCost($runner, 1_000_000, 10), 1e-9);
    }

    /** An unset dispatcher's decline is an answered call: recorded once, and the model never runs. */
    public function testAnUnsetDeclineIsRecordedOnceAndTheModelNeverRuns(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [self::jevAnswer(JevRouter::UNCLEAR, 1.0)]);
        $out = $this->dispatch($runner, null);

        $this->assertSame('jev', $out['provider']);
        $this->assertCount(1, $runner->recorded);
        $this->assertSame('unclear', $runner->recorded[0]['outcome']);
    }

    public function testJevModeNotAllowedStopsWithThePlanReasonAndRecordsNothing(): void
    {
        // The user's own key does not bypass the plan.
        $runner = $this->makeRunner('personal-jev-key', 'global-jev-key', $this->agentRunner(false),
            [self::jevAnswer('Billing', 0.99)], false);
        $out = $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertFalse($out['success']);
        $this->assertStringContainsString('(jev: unavailable: Jev is not enabled for your plan).', $out['output']);
        $this->assertTrue($out['halt_branches']);
        $this->assertSame([], $runner->recorded, 'a call that was never sent records nothing');
    }

    public function testJevModeWithoutAKeyRecordsNothing(): void
    {
        $runner = $this->makeRunner('', '', $this->agentRunner(false), []);
        $this->dispatch($runner, ['routing_mode' => 'jev']);

        $this->assertSame([], $runner->recorded);
    }

    public function testUnsetModeNotAllowedGoesToTheModel(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(true), [self::jevAnswer('Billing', 0.99)], false);
        $out = $this->dispatch($runner, null);

        $this->assertTrue($out['success']);
        $this->assertSame('openai', $out['provider']);
        $this->assertSame('Sales', $out['route']['name']);
        $this->assertSame([], $runner->recorded);
        $this->assertSame(0, $runner->made, 'not allowed: the Jev router is never built');
    }

    /** A jev row installed before prices existed: unknown cost, never a fake $0. */
    public function testNullJevPricesGiveAnUnknownCostNotZero(): void
    {
        $runner = $this->makeRunner('', 'global-jev-key', $this->agentRunner(false), [], true, [null, null]);
        $this->assertNull($this->nodeCost($runner, 100, 0));
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
    public string $madeFor = '';
    /** @var array<int, array<string, mixed>> the Jev results production would write as usage, with their user */
    public array $recorded = [];

    /** Production's filter (DecisionUsage::record), with the database write replaced by a list. */
    protected function recordDecisionUsage(int $userId, string $providerKey, string $model, array $out): void
    {
        $recorded = &$this->recorded;
        $logger = new class ($recorded, $out) extends UsageLogger {
            public function __construct(private array &$into, private array $out)
            {
            }

            public function logTransaction(array $data): ?int
            {
                $this->into[] = ['user_id' => $data['user_id'], 'provider' => $data['provider']] + $this->out;
                return 1;
            }
        };
        DecisionUsage::record($logger, $userId, $providerKey, $model, $out);
    }

    protected function makeDecisionRouter(array $resolved, float $floor): ?DecisionRouter
    {
        $this->made++;
        $this->madeWithKey = $resolved['key'];
        $this->madeWithFloor = $floor;
        $this->madeFor = (string) ($resolved['row']['provider_key'] ?? '');
        return new JevRouter($resolved['key'] !== '' ? $resolved['key'] : null,
            new Client(['handler' => HandlerStack::create(new MockHandler($this->jevQueue))]), $floor);
    }
}
