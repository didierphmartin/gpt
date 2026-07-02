<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use AgentTeam\Services\WorkflowGraphAnalyzer;
use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Models\Workflow;

/**
 * Exercises the DB-backed analyze() path with the repositories returning the
 * SAME object types they return in production — specifically WorkflowRepository::findById()
 * returning a Workflow MODEL OBJECT (not an array).
 *
 * Regression guard for the bug where analyze() accessed $wf['name'] on a Workflow
 * object ("Cannot use object of type Workflow as array"), which crashed every real
 * generate-adk / generate-python call while the pure analyzeGraph() unit tests passed.
 */
class WorkflowGraphAnalyzerAnalyzeTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    public function testAnalyzeUsesWorkflowObjectApiAndReturnsName(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];

        // findById returns a Workflow MODEL OBJECT — the production shape.
        $workflow = new Workflow(['id' => 31, 'name' => 'GEO Parallel Audit']);

        $wfRepo = Mockery::mock(WorkflowRepository::class);
        $wfRepo->shouldReceive('findById')->with(31)->andReturn($workflow);

        $graphRepo = Mockery::mock(WorkflowGraphRepository::class);
        $graphRepo->shouldReceive('getGraph')->with(31)->andReturn($graph);

        $agentRepo = Mockery::mock(AgentRepository::class);

        // buildToolCatalog() always queries MCP tools; return an empty result set.
        $stmt = Mockery::mock(\PDOStatement::class);
        $stmt->shouldReceive('fetchAll')->andReturn([]);
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('query')->andReturn($stmt);

        $analyzer = new WorkflowGraphAnalyzer($pdo, $wfRepo, $graphRepo, $agentRepo);

        // Before the fix this line threw: Error "Cannot use object of type Workflow as array".
        $result = $analyzer->analyze(31, '3');

        $this->assertSame('GEO Parallel Audit', $result['workflow']['name']);
        $this->assertSame(31, $result['workflow']['id']);
        $this->assertArrayHasKey('agents', $result);
        $this->assertArrayHasKey('2', $result['agents']);
        $this->assertSame([], $result['usedCatalog']);
    }

    public function testAnalyzeFallsBackToGeneratedNameWhenBlank(): void
    {
        $graph = ['nodes' => [['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']]], 'edges' => []];
        $workflow = new Workflow(['id' => 99, 'name' => '']);

        $wfRepo = Mockery::mock(WorkflowRepository::class);
        $wfRepo->shouldReceive('findById')->with(99)->andReturn($workflow);
        $graphRepo = Mockery::mock(WorkflowGraphRepository::class);
        $graphRepo->shouldReceive('getGraph')->with(99)->andReturn($graph);
        $stmt = Mockery::mock(\PDOStatement::class);
        $stmt->shouldReceive('fetchAll')->andReturn([]);
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('query')->andReturn($stmt);

        $analyzer = new WorkflowGraphAnalyzer($pdo, $wfRepo, $graphRepo, Mockery::mock(AgentRepository::class));
        $result = $analyzer->analyze(99, '1');

        $this->assertSame('workflow_99', $result['workflow']['name']);
    }
}
