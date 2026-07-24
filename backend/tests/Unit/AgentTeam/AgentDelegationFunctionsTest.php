<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Functions\AgentDelegationFunctions;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;

/**
 * Unit tests for the AgentDelegationFunctions
 */
class AgentDelegationFunctionsTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    private $mockRepository;
    private $mockRunner;
    private AgentDelegationFunctions $functions;

    protected function setUp(): void
    {
        $this->mockRepository = Mockery::mock(AgentRepository::class);
        $this->mockRunner = Mockery::mock(AgentRunner::class);
        $this->functions = new AgentDelegationFunctions($this->mockRepository, $this->mockRunner);
    }

    protected function tearDown(): void
    {
        Mockery::close();
    }

    // ============================================
    // getAllFunctions Tests
    // ============================================

    public function testGetAllFunctionsReturnsExpectedFunctions(): void
    {
        $functions = $this->functions->getAllFunctions();

        $this->assertArrayHasKey('delegate_to_agent', $functions);
        $this->assertArrayHasKey('list_available_agents', $functions);
        $this->assertArrayHasKey('run_agents_parallel', $functions);
    }

    public function testEachFunctionHasHandlerAndSchema(): void
    {
        $functions = $this->functions->getAllFunctions();

        foreach ($functions as $name => $func) {
            $this->assertArrayHasKey('handler', $func, "$name should have handler");
            $this->assertArrayHasKey('schema', $func, "$name should have schema");
            $this->assertArrayHasKey('description', $func['schema'], "$name should have description");
            $this->assertArrayHasKey('input_schema', $func['schema'], "$name should have input_schema");
        }
    }

    public function testDelegateToAgentSchema(): void
    {
        $functions = $this->functions->getAllFunctions();
        $schema = $functions['delegate_to_agent']['schema'];

        $this->assertStringContainsString('delegate', strtolower($schema['description']));

        $properties = $schema['input_schema']['properties'];
        $this->assertArrayHasKey('agent_id', $properties);
        $this->assertArrayHasKey('agent_name', $properties);
        $this->assertArrayHasKey('task', $properties);
        $this->assertArrayHasKey('context', $properties);

        $required = $schema['input_schema']['required'];
        $this->assertContains('task', $required);
    }

    public function testListAvailableAgentsSchema(): void
    {
        $functions = $this->functions->getAllFunctions();
        $schema = $functions['list_available_agents']['schema'];

        $this->assertStringContainsString('list', strtolower($schema['description']));

        $properties = $schema['input_schema']['properties'];
        $this->assertArrayHasKey('agent_type', $properties);
    }

    public function testRunAgentsParallelSchema(): void
    {
        $functions = $this->functions->getAllFunctions();
        $schema = $functions['run_agents_parallel']['schema'];

        $this->assertStringContainsString('parallel', strtolower($schema['description']));

        $properties = $schema['input_schema']['properties'];
        $this->assertArrayHasKey('delegations', $properties);

        $required = $schema['input_schema']['required'];
        $this->assertContains('delegations', $required);
    }

    // ============================================
    // delegateToAgent Tests
    // ============================================

    public function testDelegateToAgentRequiresTask(): void
    {
        $result = $this->functions->delegateToAgent(
            ['agent_name' => 'Test Agent'],
            ['user_id' => 1]
        );

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('required', $result['error']);
    }

    public function testDelegateToAgentRequiresAgentIdentifier(): void
    {
        $result = $this->functions->delegateToAgent(
            ['task' => 'Do something'],
            ['user_id' => 1]
        );

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('agent_id or agent_name', $result['error']);
    }

    public function testDelegateToAgentHandlesAgentNotFound(): void
    {
        $this->mockRepository
            ->shouldReceive('findByName')
            ->with('NonExistent', 1)
            ->andReturn(null);

        $result = $this->functions->delegateToAgent(
            ['agent_name' => 'NonExistent', 'task' => 'Do something'],
            ['user_id' => 1]
        );

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('not found', $result['error']);
    }

    // ============================================
    // listAvailableAgents Tests
    // ============================================

    public function testListAvailableAgentsWithoutManager(): void
    {
        $this->mockRepository
            ->shouldReceive('findAccessibleByUser')
            ->with(1, Mockery::any())
            ->andReturn([]);

        $result = $this->functions->listAvailableAgents(
            ['agent_type' => 'all'],
            ['user_id' => 1]
        );

        $this->assertTrue($result['success']);
        $this->assertArrayHasKey('agents', $result);
        $this->assertArrayHasKey('count', $result);
        $this->assertEquals(0, $result['count']);
    }

    public function testListAvailableAgentsReturnsSuccessMessage(): void
    {
        $this->mockRepository
            ->shouldReceive('findAccessibleByUser')
            ->andReturn([]);

        $result = $this->functions->listAvailableAgents(
            [],
            ['user_id' => 1]
        );

        $this->assertArrayHasKey('message', $result);
    }

    // ============================================
    // runAgentsParallel Tests
    // ============================================

    public function testRunAgentsParallelRequiresDelegations(): void
    {
        $result = $this->functions->runAgentsParallel(
            [],
            ['user_id' => 1]
        );

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('No delegations', $result['error']);
    }

    public function testRunAgentsParallelRequiresArray(): void
    {
        $result = $this->functions->runAgentsParallel(
            ['delegations' => 'not an array'],
            ['user_id' => 1]
        );

        $this->assertFalse($result['success']);
        // Non-array `delegations` is folded into the same early-return as
        // "no delegations" by the executor-backed implementation.
        $this->assertStringContainsString('No delegations', $result['error']);
    }

    public function testRunAgentsParallelHandlesMissingFields(): void
    {
        $this->mockRunner
            ->shouldReceive('getFreshRepository')
            ->andReturn($this->mockRepository);
        $this->mockRunner
            ->shouldReceive('createParallelExecutor')
            ->andReturn(Mockery::mock(\AgentTeam\Services\ParallelAgentExecutor::class));

        $result = $this->functions->runAgentsParallel(
            ['delegations' => [
                ['agent_name' => 'Test'], // Missing task
            ]],
            ['user_id' => 1]
        );

        $this->assertEquals(1, $result['failed']);
        $this->assertEquals(0, $result['successful']);
    }

    public function testRunAgentsParallelReturnsCorrectStructure(): void
    {
        // Mock findByName to return null (agent not found)
        $this->mockRepository
            ->shouldReceive('findByName')
            ->with('Test', 1)
            ->andReturn(null);
        $this->mockRunner
            ->shouldReceive('getFreshRepository')
            ->andReturn($this->mockRepository);
        $this->mockRunner
            ->shouldReceive('createParallelExecutor')
            ->andReturn(Mockery::mock(\AgentTeam\Services\ParallelAgentExecutor::class));

        $result = $this->functions->runAgentsParallel(
            ['delegations' => [
                ['agent_name' => 'Test', 'task' => 'Do X'], // Will fail - agent not found
            ]],
            ['user_id' => 1]
        );

        $this->assertArrayHasKey('total_agents', $result);
        $this->assertArrayHasKey('successful', $result);
        $this->assertArrayHasKey('failed', $result);
        $this->assertArrayHasKey('results', $result);
        $this->assertArrayHasKey('message', $result);
    }

    // ============================================
    // Context Extraction Tests
    // ============================================

    public function testExtractsUserIdFromArrayContext(): void
    {
        $this->mockRepository
            ->shouldReceive('findAccessibleByUser')
            ->with(42, Mockery::any())
            ->andReturn([]);

        $this->functions->listAvailableAgents(
            [],
            ['user_id' => 42]
        );

        // If we got here without exception, context extraction worked
        $this->assertTrue(true);
    }

    public function testExtractsUserIdFromIntContext(): void
    {
        $this->mockRepository
            ->shouldReceive('findAccessibleByUser')
            ->with(99, Mockery::any())
            ->andReturn([]);

        $this->functions->listAvailableAgents(
            [],
            99 // Integer context
        );

        $this->assertTrue(true);
    }

    public function testHandlesNullContext(): void
    {
        $this->mockRepository
            ->shouldReceive('findAccessibleByUser')
            ->with(0, Mockery::any())
            ->andReturn([]);

        $result = $this->functions->listAvailableAgents([], null);

        $this->assertTrue($result['success']);
    }
}
