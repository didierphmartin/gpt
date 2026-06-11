<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Agent;

/**
 * Unit tests for the Agent model
 */
class AgentTest extends TestCase
{
    private Agent $standardAgent;
    private Agent $managerAgent;
    private Agent $workerAgent;

    protected function setUp(): void
    {
        $this->standardAgent = new Agent([
            'id' => 1,
            'user_id' => 100,
            'name' => 'Test Agent',
            'description' => 'A test agent',
            'agent_type' => 'standard',
            'provider' => 'claude',
            'model' => 'claude-sonnet-4-20250514',
            'instructions' => 'You are a helpful assistant.',
            'tools' => ['calculate', 'search'],
            'visibility' => 'personal',
            'enabled' => true,
        ]);

        $this->managerAgent = new Agent([
            'id' => 2,
            'user_id' => 100,
            'name' => 'Manager Agent',
            'description' => 'A manager agent',
            'agent_type' => 'manager',
            'provider' => 'claude',
            'tools' => ['delegate_to_agent', 'list_available_agents'],
            'can_delegate_to' => [10, 11, 12],
        ]);

        $this->workerAgent = new Agent([
            'id' => 3,
            'user_id' => 100,
            'name' => 'Worker Agent',
            'description' => 'A worker agent',
            'agent_type' => 'worker',
            'provider' => 'claude',
            'tools' => ['pubmed_search'],
        ]);
    }

    // ============================================
    // Construction and Hydration Tests
    // ============================================

    public function testCanCreateAgentFromArray(): void
    {
        $agent = new Agent([
            'name' => 'New Agent',
            'user_id' => 1,
        ]);

        $this->assertEquals('New Agent', $agent->getName());
        $this->assertEquals(1, $agent->getUserId());
    }

    public function testDefaultValues(): void
    {
        $agent = new Agent(['name' => 'Minimal']);

        $this->assertEquals('standard', $agent->getAgentType());
        $this->assertEquals('claude', $agent->getProvider());
        $this->assertEquals('personal', $agent->getVisibility());
        $this->assertTrue($agent->isEnabled());
        $this->assertEquals([], $agent->getTools());
        $this->assertEquals([], $agent->getCanDelegateTo());
    }

    public function testCategoryDefaultsToNull(): void
    {
        $agent = new Agent(['name' => 'No Category']);
        $this->assertNull($agent->getCategory());
    }

    public function testHydratesCategory(): void
    {
        $agent = new Agent(['name' => 'Foo', 'category' => 'Research']);
        $this->assertSame('Research', $agent->getCategory());
    }

    public function testEmptyStringCategoryHydratesAsNull(): void
    {
        $agent = new Agent(['name' => 'Foo', 'category' => '']);
        $this->assertNull($agent->getCategory());
    }

    public function testSetCategoryAcceptsNullAndEmpty(): void
    {
        $agent = new Agent(['name' => 'Foo', 'category' => 'Old']);
        $agent->setCategory('New');
        $this->assertSame('New', $agent->getCategory());
        $agent->setCategory(null);
        $this->assertNull($agent->getCategory());
        $agent->setCategory('Other');
        $agent->setCategory('');
        $this->assertNull($agent->getCategory());
    }

    public function testCategoryAppearsInToArrayAndApiArray(): void
    {
        $agent = new Agent(['name' => 'Foo', 'category' => 'Reports']);
        $this->assertSame('Reports', $agent->toArray()['category']);
        $this->assertSame('Reports', $agent->toApiArray()['category']);
    }

    public function testHydratesJsonFields(): void
    {
        $agent = new Agent([
            'name' => 'JSON Test',
            'tools' => '["tool1", "tool2"]', // JSON string
            'can_delegate_to' => '[1, 2, 3]', // JSON string
            'settings' => '{"temperature": 0.7}', // JSON string
        ]);

        $this->assertEquals(['tool1', 'tool2'], $agent->getTools());
        $this->assertEquals([1, 2, 3], $agent->getCanDelegateTo());
        $this->assertEquals(['temperature' => 0.7], $agent->getSettings());
    }

    // ============================================
    // Getter Tests
    // ============================================

    public function testGetters(): void
    {
        $this->assertEquals(1, $this->standardAgent->getId());
        $this->assertEquals(100, $this->standardAgent->getUserId());
        $this->assertEquals('Test Agent', $this->standardAgent->getName());
        $this->assertEquals('A test agent', $this->standardAgent->getDescription());
        $this->assertEquals('standard', $this->standardAgent->getAgentType());
        $this->assertEquals('claude', $this->standardAgent->getProvider());
        $this->assertEquals('claude-sonnet-4-20250514', $this->standardAgent->getModel());
        $this->assertEquals('You are a helpful assistant.', $this->standardAgent->getInstructions());
        $this->assertEquals(['calculate', 'search'], $this->standardAgent->getTools());
        $this->assertEquals('personal', $this->standardAgent->getVisibility());
        $this->assertTrue($this->standardAgent->isEnabled());
    }

    // ============================================
    // Setter Tests
    // ============================================

    public function testSetters(): void
    {
        $agent = new Agent(['name' => 'Original']);

        $agent->setName('Updated Name');
        $this->assertEquals('Updated Name', $agent->getName());

        $agent->setDescription('New description');
        $this->assertEquals('New description', $agent->getDescription());

        $agent->setAgentType('manager');
        $this->assertEquals('manager', $agent->getAgentType());

        $agent->setProvider('openai');
        $this->assertEquals('openai', $agent->getProvider());

        $agent->setModel('gpt-4');
        $this->assertEquals('gpt-4', $agent->getModel());

        $agent->setTools(['new_tool']);
        $this->assertEquals(['new_tool'], $agent->getTools());

        $agent->setEnabled(false);
        $this->assertFalse($agent->isEnabled());
    }

    public function testFluentSetters(): void
    {
        $agent = new Agent(['name' => 'Fluent Test']);

        $result = $agent
            ->setName('Chained')
            ->setDescription('Fluent description')
            ->setProvider('openai');

        $this->assertSame($agent, $result);
        $this->assertEquals('Chained', $agent->getName());
    }

    // ============================================
    // Agent Type Tests
    // ============================================

    public function testIsManager(): void
    {
        $this->assertTrue($this->managerAgent->isManager());
        $this->assertFalse($this->standardAgent->isManager());
        $this->assertFalse($this->workerAgent->isManager());
    }

    public function testIsWorker(): void
    {
        $this->assertTrue($this->workerAgent->isWorker());
        $this->assertFalse($this->standardAgent->isWorker());
        $this->assertFalse($this->managerAgent->isWorker());
    }

    // ============================================
    // Delegation Tests
    // ============================================

    public function testCanDelegateToAgentWithExplicitList(): void
    {
        // Manager can delegate to agents in its list
        $this->assertTrue($this->managerAgent->canDelegateToAgent(10));
        $this->assertTrue($this->managerAgent->canDelegateToAgent(11));
        $this->assertTrue($this->managerAgent->canDelegateToAgent(12));

        // Cannot delegate to agents not in list
        $this->assertFalse($this->managerAgent->canDelegateToAgent(99));
    }

    public function testCanDelegateToAgentWithEmptyList(): void
    {
        // Empty list means can delegate to any agent
        $openManager = new Agent([
            'name' => 'Open Manager',
            'agent_type' => 'manager',
            'can_delegate_to' => [],
        ]);

        $this->assertTrue($openManager->canDelegateToAgent(1));
        $this->assertTrue($openManager->canDelegateToAgent(999));
    }

    public function testNonManagerCannotDelegate(): void
    {
        // Standard and worker agents have empty delegation lists by default
        $this->assertEquals([], $this->standardAgent->getCanDelegateTo());
        $this->assertEquals([], $this->workerAgent->getCanDelegateTo());
    }

    // ============================================
    // Serialization Tests
    // ============================================

    public function testToArray(): void
    {
        $array = $this->standardAgent->toArray();

        $this->assertIsArray($array);
        $this->assertEquals(1, $array['id']);
        $this->assertEquals('Test Agent', $array['name']);
        $this->assertEquals(['calculate', 'search'], $array['tools']);
        $this->assertArrayHasKey('instructions', $array);
        $this->assertArrayHasKey('settings', $array);
    }

    public function testToApiArray(): void
    {
        $apiArray = $this->standardAgent->toApiArray();

        $this->assertIsArray($apiArray);
        $this->assertArrayHasKey('id', $apiArray);
        $this->assertArrayHasKey('name', $apiArray);
        $this->assertArrayHasKey('description', $apiArray);

        // Should NOT include sensitive fields
        $this->assertArrayNotHasKey('instructions', $apiArray);
        $this->assertArrayNotHasKey('settings', $apiArray);
    }

    public function testJsonSerialize(): void
    {
        $json = json_encode($this->standardAgent->toArray());
        $decoded = json_decode($json, true);

        $this->assertEquals('Test Agent', $decoded['name']);
        $this->assertEquals(['calculate', 'search'], $decoded['tools']);
    }

    // ============================================
    // System Prompt Tests
    // ============================================

    public function testBuildSystemPrompt(): void
    {
        $prompt = $this->standardAgent->buildSystemPrompt();

        $this->assertIsString($prompt);
        $this->assertStringContainsString('Test Agent', $prompt);
        $this->assertStringContainsString('You are a helpful assistant', $prompt);
    }

    public function testBuildSystemPromptIncludesDescription(): void
    {
        $prompt = $this->standardAgent->buildSystemPrompt();

        $this->assertStringContainsString('A test agent', $prompt);
    }

    public function testBuildSystemPromptWithoutInstructions(): void
    {
        $agent = new Agent([
            'name' => 'No Instructions Agent',
            'description' => 'Agent without custom instructions',
        ]);

        $prompt = $agent->buildSystemPrompt();

        $this->assertStringContainsString('No Instructions Agent', $prompt);
    }

    // ============================================
    // Edge Cases
    // ============================================

    public function testEmptyAgentName(): void
    {
        $agent = new Agent([]);

        $this->assertEquals('', $agent->getName());
    }

    public function testNullModel(): void
    {
        $agent = new Agent(['name' => 'Test', 'model' => null]);

        $this->assertNull($agent->getModel());
    }

    public function testBooleanEnabledFromInt(): void
    {
        $agent = new Agent(['name' => 'Test', 'enabled' => 0]);
        $this->assertFalse($agent->isEnabled());

        $agent = new Agent(['name' => 'Test', 'enabled' => 1]);
        $this->assertTrue($agent->isEnabled());
    }

    public function testSettingsMerge(): void
    {
        $agent = new Agent([
            'name' => 'Test',
            'settings' => ['temperature' => 0.7, 'max_tokens' => 1000],
        ]);

        $agent->setSettings(['temperature' => 0.9, 'top_p' => 0.95]);

        $settings = $agent->getSettings();
        $this->assertEquals(0.9, $settings['temperature']);
        $this->assertEquals(0.95, $settings['top_p']);
    }
}
