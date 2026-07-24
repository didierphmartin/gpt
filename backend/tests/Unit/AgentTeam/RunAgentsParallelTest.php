<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Functions\AgentDelegationFunctions;
use AgentTeam\Models\Agent;
use PHPUnit\Framework\TestCase;
use Mockery;

final class RunAgentsParallelTest extends TestCase
{
    protected function tearDown(): void { Mockery::close(); }

    public function testRunsBatchThroughExecutorAndMapsResults(): void
    {
        $worker1 = new Agent(['id' => 5, 'name' => 'Researcher', 'agent_type' => 'worker', 'provider' => 'claude']);
        $worker2 = new Agent(['id' => 6, 'name' => 'Writer', 'agent_type' => 'worker', 'provider' => 'claude']);

        $repo = Mockery::mock(\AgentTeam\Services\AgentRepository::class);
        $repo->shouldReceive('findByName')->with('Researcher', Mockery::any())->andReturn($worker1);
        $repo->shouldReceive('findByName')->with('Writer', Mockery::any())->andReturn($worker2);
        $repo->shouldReceive('findById')->andReturnNull();

        // Fake executor: returns canned per-key results without any network.
        $executor = Mockery::mock(\AgentTeam\Services\ParallelAgentExecutor::class);
        $executor->shouldReceive('buildToolsFor')->andReturn([]);
        $executor->shouldReceive('run')->once()->andReturn([
            0 => ['agent_id' => 5, 'agent_name' => 'Researcher', 'output' => 'R', 'success' => true, 'usage' => null, 'execution_id' => 101],
            1 => ['agent_id' => 6, 'agent_name' => 'Writer', 'output' => 'W', 'success' => true, 'usage' => null, 'execution_id' => 102],
        ]);

        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getFreshRepository')->andReturn($repo);
        $runner->shouldReceive('createParallelExecutor')->andReturn($executor);

        $fns = new AgentDelegationFunctions($repo, $runner);
        $out = $fns->runAgentsParallel([
            'delegations' => [
                ['agent_name' => 'Researcher', 'task' => 'find X'],
                ['agent_name' => 'Writer', 'task' => 'write Y'],
            ],
        ], ['user_id' => 1, 'current_agent_id' => 1]);

        $this->assertTrue($out['success']);
        $this->assertSame(2, $out['successful']);
        $this->assertSame(0, $out['failed']);
        $this->assertSame('R', $out['results'][0]['result']);
        $this->assertSame('Writer', $out['results'][1]['agent']);
        $this->assertSame(102, $out['results'][1]['execution_id']);
    }

    public function testEmptyDelegationsIsAnError(): void
    {
        $repo = Mockery::mock(\AgentTeam\Services\AgentRepository::class);
        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $fns = new AgentDelegationFunctions($repo, $runner);
        $out = $fns->runAgentsParallel(['delegations' => []], ['user_id' => 1]);
        $this->assertFalse($out['success']);
    }

    public function testPreflightErrorItemCarriesFullSevenKeyShape(): void
    {
        // A manager-typed target is rejected pre-flight (worker/standard only),
        // so this delegation never reaches the executor. The resulting
        // results[] item must still carry the full seven-key shape.
        $managerTarget = new Agent(['id' => 9, 'name' => 'BossAgent', 'agent_type' => 'manager', 'provider' => 'claude']);

        $repo = Mockery::mock(\AgentTeam\Services\AgentRepository::class);
        $repo->shouldReceive('findByName')->with('BossAgent', Mockery::any())->andReturn($managerTarget);
        $repo->shouldReceive('findById')->andReturnNull();

        // Executor is created but never runs (no valid states) — no run() expectation.
        $executor = Mockery::mock(\AgentTeam\Services\ParallelAgentExecutor::class);
        $executor->shouldReceive('buildToolsFor')->andReturn([]);

        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getFreshRepository')->andReturn($repo);
        $runner->shouldReceive('createParallelExecutor')->andReturn($executor);

        $fns = new AgentDelegationFunctions($repo, $runner);
        $out = $fns->runAgentsParallel([
            'delegations' => [
                ['agent_name' => 'BossAgent', 'task' => 'do boss things'],
            ],
        ], ['user_id' => 1, 'current_agent_id' => 1]);

        $this->assertFalse($out['success']);
        $this->assertSame(1, $out['failed']);

        $item = $out['results'][0];
        foreach (['index', 'agent', 'task', 'success', 'result', 'error', 'execution_id'] as $key) {
            $this->assertArrayHasKey($key, $item, "results[0] must carry '{$key}'");
        }
        $this->assertSame('do boss things', $item['task']);
        $this->assertNull($item['result']);
        $this->assertFalse($item['success']);
        $this->assertNotNull($item['error']);
    }

    public function testMissingAgentNameErrorItemCarriesFullSevenKeyShape(): void
    {
        $repo = Mockery::mock(\AgentTeam\Services\AgentRepository::class);
        $repo->shouldReceive('findById')->andReturnNull();

        $executor = Mockery::mock(\AgentTeam\Services\ParallelAgentExecutor::class);

        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getFreshRepository')->andReturn($repo);
        $runner->shouldReceive('createParallelExecutor')->andReturn($executor);

        $fns = new AgentDelegationFunctions($repo, $runner);
        $out = $fns->runAgentsParallel([
            'delegations' => [
                ['task' => 'orphan task'], // missing agent_name
            ],
        ], ['user_id' => 1, 'current_agent_id' => 1]);

        $item = $out['results'][0];
        foreach (['index', 'agent', 'task', 'success', 'result', 'error', 'execution_id'] as $key) {
            $this->assertArrayHasKey($key, $item, "results[0] must carry '{$key}'");
        }
        $this->assertSame('orphan task', $item['task']);
        $this->assertNull($item['result']);
    }
}
