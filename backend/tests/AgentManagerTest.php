<?php

/**
 * Test Manager Agent with Delegation
 *
 * Tests a Manager Agent (e.g., Research Director) that delegates
 * tasks to worker agents using the delegation functions.
 *
 * Run: php tests/AgentManagerTest.php
 */

require_once __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Functions\AgentDelegationFunctions;
use Quantis\AIPortfolioAssistant\Services\LLMManager;
use Quantis\AIPortfolioAssistant\Services\ToolsManager;
use Quantis\AIPortfolioAssistant\Config\Configuration;

echo "=== Testing Manager Agent with Delegation ===\n\n";

// ============================================
// Mock Classes for Testing
// ============================================

class MockPDO extends PDO
{
    private int $lastInsertId = 1;
    private array $agents = [];

    public function __construct()
    {
        // Don't call parent constructor
    }

    public function setAgents(array $agents): void
    {
        $this->agents = $agents;
    }

    public function getAgents(): array
    {
        return $this->agents;
    }

    public function prepare($statement, $options = []): PDOStatement|false
    {
        return new MockPDOStatement($this, $statement);
    }

    public function lastInsertId($name = null): string|false
    {
        return (string) $this->lastInsertId++;
    }
}

class MockPDOStatement extends PDOStatement
{
    private MockPDO $pdo;
    private string $sql;
    private array $params = [];

    public function __construct(MockPDO $pdo, string $sql)
    {
        $this->pdo = $pdo;
        $this->sql = $sql;
    }

    public function execute($params = null): bool
    {
        $this->params = $params ?? [];
        return true;
    }

    public function fetch($mode = PDO::FETCH_DEFAULT, $cursorOrientation = PDO::FETCH_ORI_NEXT, $cursorOffset = 0): mixed
    {
        // Return agent data for findById queries
        if (strpos($this->sql, 'SELECT * FROM agents WHERE id') !== false) {
            $agents = $this->pdo->getAgents();
            $id = $this->params[0] ?? null;
            return $agents[$id] ?? false;
        }

        // Return agent data for findByName queries
        if (strpos($this->sql, 'SELECT * FROM agents') !== false && strpos($this->sql, 'name =') !== false) {
            $agents = $this->pdo->getAgents();
            $name = $this->params[0] ?? null;
            foreach ($agents as $agent) {
                if ($agent['name'] === $name) {
                    return $agent;
                }
            }
        }

        return false;
    }

    public function fetchAll($mode = PDO::FETCH_DEFAULT, ...$args): array
    {
        if (strpos($this->sql, 'SELECT * FROM agents') !== false) {
            return array_values($this->pdo->getAgents());
        }
        return [];
    }

    public function fetchColumn($column = 0): mixed
    {
        return 0;
    }
}

try {
    // ============================================
    // 1. Create Worker Agents
    // ============================================
    echo "1. Creating Worker Agents...\n\n";

    // Medical Research Worker
    $medicalWorker = new Agent([
        'id' => 1,
        'user_id' => 1,
        'name' => 'Medical Research Specialist',
        'description' => 'Searches and analyzes biomedical literature using PubMed',
        'agent_type' => 'worker',
        'provider' => 'claude',
        'model' => 'claude-sonnet-4-20250514',
        'instructions' => 'You are a medical research specialist. Search PubMed for relevant articles and summarize findings.',
        'tools' => ['pubmed_search', 'pubmed_build_query', 'pubmed_mesh_suggestions'],
        'visibility' => 'workspace',
        'enabled' => true,
    ]);
    echo "  ✓ Created: {$medicalWorker->getName()} (ID: {$medicalWorker->getId()})\n";
    echo "    Type: {$medicalWorker->getAgentType()}, Tools: " . implode(', ', $medicalWorker->getTools()) . "\n";

    // Data Analysis Worker
    $dataWorker = new Agent([
        'id' => 2,
        'user_id' => 1,
        'name' => 'Data Analysis Specialist',
        'description' => 'Analyzes data and creates visualizations',
        'agent_type' => 'worker',
        'provider' => 'claude',
        'model' => 'claude-sonnet-4-20250514',
        'instructions' => 'You are a data analysis specialist. Analyze data, identify patterns, and provide statistical insights.',
        'tools' => ['calculate', 'analyze_data'],
        'visibility' => 'workspace',
        'enabled' => true,
    ]);
    echo "  ✓ Created: {$dataWorker->getName()} (ID: {$dataWorker->getId()})\n";
    echo "    Type: {$dataWorker->getAgentType()}, Tools: " . implode(', ', $dataWorker->getTools()) . "\n";

    // Writing Worker
    $writingWorker = new Agent([
        'id' => 3,
        'user_id' => 1,
        'name' => 'Technical Writer',
        'description' => 'Creates well-structured reports and documentation',
        'agent_type' => 'worker',
        'provider' => 'claude',
        'model' => 'claude-sonnet-4-20250514',
        'instructions' => 'You are a technical writer. Create clear, well-structured documents from research findings.',
        'tools' => [],
        'visibility' => 'workspace',
        'enabled' => true,
    ]);
    echo "  ✓ Created: {$writingWorker->getName()} (ID: {$writingWorker->getId()})\n";
    echo "    Type: {$writingWorker->getAgentType()}, Tools: (none - uses natural language)\n";

    echo "\n";

    // ============================================
    // 2. Create Manager Agent
    // ============================================
    echo "2. Creating Manager Agent...\n\n";

    $researchDirector = new Agent([
        'id' => 10,
        'user_id' => 1,
        'name' => 'Research Director',
        'description' => 'Orchestrates research projects by delegating to specialized worker agents',
        'agent_type' => 'manager',
        'provider' => 'claude',
        'model' => 'claude-sonnet-4-20250514',
        'instructions' => <<<INSTRUCTIONS
You are the Research Director, a manager agent that orchestrates complex research projects.

Your team includes:
1. Medical Research Specialist - for PubMed literature searches
2. Data Analysis Specialist - for statistical analysis
3. Technical Writer - for report creation

Your workflow:
1. Analyze the research request
2. Break it down into subtasks
3. Delegate to appropriate specialists using delegate_to_agent
4. For parallel work, use run_agents_parallel
5. Synthesize results into a comprehensive response

Available tools:
- list_available_agents: See your team members
- delegate_to_agent: Assign a task to a specific agent
- run_agents_parallel: Run multiple agents simultaneously

Always coordinate efficiently and provide a unified, coherent response.
INSTRUCTIONS,
        'tools' => ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel'],
        'can_delegate_to' => [1, 2, 3], // Can delegate to workers 1, 2, 3
        'visibility' => 'workspace',
        'enabled' => true,
    ]);

    echo "  ✓ Created: {$researchDirector->getName()} (ID: {$researchDirector->getId()})\n";
    echo "    Type: {$researchDirector->getAgentType()}\n";
    echo "    Tools: " . implode(', ', $researchDirector->getTools()) . "\n";
    echo "    Can delegate to: " . implode(', ', $researchDirector->getCanDelegateTo()) . "\n";

    echo "\n";

    // ============================================
    // 3. Test Manager/Worker Methods
    // ============================================
    echo "3. Testing Manager/Worker methods...\n";

    // Test isManager/isWorker
    assert($researchDirector->isManager() === true, 'Research Director should be a manager');
    assert($researchDirector->isWorker() === false, 'Research Director should not be a worker');
    echo "  ✓ isManager() returns true for manager agent\n";

    assert($medicalWorker->isManager() === false, 'Medical Worker should not be a manager');
    assert($medicalWorker->isWorker() === true, 'Medical Worker should be a worker');
    echo "  ✓ isWorker() returns true for worker agent\n";

    // Test canDelegateToAgent
    assert($researchDirector->canDelegateToAgent(1) === true, 'Should be able to delegate to agent 1');
    assert($researchDirector->canDelegateToAgent(2) === true, 'Should be able to delegate to agent 2');
    assert($researchDirector->canDelegateToAgent(3) === true, 'Should be able to delegate to agent 3');
    assert($researchDirector->canDelegateToAgent(99) === false, 'Should not be able to delegate to agent 99');
    echo "  ✓ canDelegateToAgent() correctly validates delegation permissions\n";

    // Test empty can_delegate_to (means can delegate to all)
    $openManager = new Agent([
        'id' => 11,
        'name' => 'Open Manager',
        'agent_type' => 'manager',
        'can_delegate_to' => [], // Empty = can delegate to any
    ]);
    assert($openManager->canDelegateToAgent(1) === true, 'Empty can_delegate_to should allow any');
    assert($openManager->canDelegateToAgent(999) === true, 'Empty can_delegate_to should allow any');
    echo "  ✓ Empty can_delegate_to allows delegation to any agent\n";

    echo "\n";

    // ============================================
    // 4. Test Delegation Functions
    // ============================================
    echo "4. Testing Delegation Functions...\n";

    // Setup mock database with agents
    $mockDb = new MockPDO();
    $mockDb->setAgents([
        1 => [
            'id' => 1,
            'user_id' => 1,
            'name' => 'Medical Research Specialist',
            'description' => 'Searches biomedical literature',
            'agent_type' => 'worker',
            'provider' => 'claude',
            'model' => 'claude-sonnet-4-20250514',
            'instructions' => 'You are a medical research specialist.',
            'tools' => json_encode(['pubmed_search']),
            'can_delegate_to' => json_encode([]),
            'knowledge_sources' => json_encode([]),
            'visibility' => 'workspace',
            'enabled' => 1,
            'settings' => json_encode([]),
        ],
        2 => [
            'id' => 2,
            'user_id' => 1,
            'name' => 'Data Analysis Specialist',
            'description' => 'Analyzes data',
            'agent_type' => 'worker',
            'provider' => 'claude',
            'model' => 'claude-sonnet-4-20250514',
            'instructions' => 'You are a data analysis specialist.',
            'tools' => json_encode(['calculate']),
            'can_delegate_to' => json_encode([]),
            'knowledge_sources' => json_encode([]),
            'visibility' => 'workspace',
            'enabled' => 1,
            'settings' => json_encode([]),
        ],
    ]);

    $repository = new AgentRepository($mockDb);
    $config = new Configuration([]);
    $llmManager = new LLMManager($config);
    $toolsManager = new ToolsManager();

    // Note: We can't fully test AgentRunner without a real LLM,
    // but we can create it and test the delegation functions structure
    $runner = new AgentRunner($llmManager, $toolsManager, null, $mockDb, []);

    $delegationFunctions = new AgentDelegationFunctions($repository, $runner);

    // Get all delegation functions
    $functions = $delegationFunctions->getAllFunctions();

    assert(isset($functions['delegate_to_agent']), 'Should have delegate_to_agent function');
    assert(isset($functions['list_available_agents']), 'Should have list_available_agents function');
    assert(isset($functions['run_agents_parallel']), 'Should have run_agents_parallel function');
    echo "  ✓ All delegation functions are defined\n";

    // Check function schemas
    foreach ($functions as $name => $func) {
        assert(isset($func['handler']), "$name should have a handler");
        assert(isset($func['schema']), "$name should have a schema");
        assert(isset($func['schema']['description']), "$name should have a description");
        assert(isset($func['schema']['input_schema']), "$name should have input_schema");
        echo "  ✓ {$name} has valid schema\n";
    }

    echo "\n";

    // ============================================
    // 5. Test list_available_agents Function
    // ============================================
    echo "5. Testing list_available_agents function...\n";

    // Test listing agents without a current manager context
    $listResult = $delegationFunctions->listAvailableAgents(
        ['agent_type' => 'all'],
        ['user_id' => 1]
    );

    assert($listResult['success'] === true, 'list_available_agents should succeed');
    assert(isset($listResult['agents']), 'Should return agents array');
    assert(isset($listResult['count']), 'Should return count');
    echo "  ✓ list_available_agents returns agent list\n";
    echo "    Found {$listResult['count']} agents\n";

    echo "\n";

    // ============================================
    // 6. Test delegate_to_agent Validation
    // ============================================
    echo "6. Testing delegate_to_agent validation...\n";

    // Test missing task
    $result = $delegationFunctions->delegateToAgent(
        ['agent_name' => 'Medical Research Specialist'],
        ['user_id' => 1]
    );
    assert($result['success'] === false, 'Should fail without task');
    assert(strpos($result['error'], 'required') !== false, 'Error should mention required');
    echo "  ✓ Rejects empty task\n";

    // Test missing agent identifier
    $result = $delegationFunctions->delegateToAgent(
        ['task' => 'Search for articles'],
        ['user_id' => 1]
    );
    assert($result['success'] === false, 'Should fail without agent identifier');
    echo "  ✓ Rejects missing agent identifier\n";

    // Test non-existent agent
    $result = $delegationFunctions->delegateToAgent(
        ['agent_name' => 'NonExistent Agent', 'task' => 'Do something'],
        ['user_id' => 1]
    );
    assert($result['success'] === false, 'Should fail for non-existent agent');
    assert(strpos($result['error'], 'not found') !== false, 'Error should mention not found');
    echo "  ✓ Rejects non-existent agent\n";

    echo "\n";

    // ============================================
    // 7. Test run_agents_parallel Validation
    // ============================================
    echo "7. Testing run_agents_parallel validation...\n";

    // Test empty delegations
    $result = $delegationFunctions->runAgentsParallel(
        ['delegations' => []],
        ['user_id' => 1]
    );
    assert($result['success'] === false, 'Should fail with empty delegations');
    echo "  ✓ Rejects empty delegations array\n";

    // Test invalid delegations format
    $result = $delegationFunctions->runAgentsParallel(
        ['delegations' => 'not an array'],
        ['user_id' => 1]
    );
    assert($result['success'] === false, 'Should fail with non-array delegations');
    echo "  ✓ Rejects non-array delegations\n";

    // Test delegations with missing fields
    $result = $delegationFunctions->runAgentsParallel(
        ['delegations' => [
            ['agent_name' => 'Test'], // Missing task
            ['task' => 'Do something'], // Missing agent_name
        ]],
        ['user_id' => 1]
    );
    assert($result['failed'] === 2, 'Both should fail');
    echo "  ✓ Reports failures for incomplete delegations\n";

    echo "\n";

    // ============================================
    // 8. Test Manager System Prompt
    // ============================================
    echo "8. Testing Manager system prompt...\n";

    $systemPrompt = $researchDirector->buildSystemPrompt();

    assert(strpos($systemPrompt, 'Research Director') !== false, 'Should include agent name');
    assert(strpos($systemPrompt, 'orchestrates') !== false || strpos($systemPrompt, 'manager') !== false,
        'Should reference orchestration or management');
    assert(strpos($systemPrompt, 'delegate') !== false, 'Should mention delegation');

    echo "  ✓ System prompt includes agent identity\n";
    echo "  ✓ System prompt references delegation capabilities\n";

    echo "\n  System Prompt Preview (first 500 chars):\n";
    echo "  " . str_replace("\n", "\n  ", substr($systemPrompt, 0, 500)) . "...\n";

    echo "\n";

    // ============================================
    // Summary
    // ============================================
    echo "=== Manager Agent Test Summary ===\n\n";

    echo "Manager Agent: {$researchDirector->getName()}\n";
    echo "  Type: {$researchDirector->getAgentType()}\n";
    echo "  Delegation Tools: " . implode(', ', $researchDirector->getTools()) . "\n";
    echo "  Worker IDs: " . implode(', ', $researchDirector->getCanDelegateTo()) . "\n";

    echo "\nWorker Agents:\n";
    foreach ([$medicalWorker, $dataWorker, $writingWorker] as $worker) {
        echo "  - {$worker->getName()} (ID: {$worker->getId()})\n";
        echo "    Tools: " . (empty($worker->getTools()) ? '(none)' : implode(', ', $worker->getTools())) . "\n";
    }

    echo "\nDelegation Flow:\n";
    echo "  1. User requests complex research task\n";
    echo "  2. Research Director analyzes and plans\n";
    echo "  3. Delegates literature search to Medical Research Specialist\n";
    echo "  4. Delegates data analysis to Data Analysis Specialist\n";
    echo "  5. Delegates report writing to Technical Writer\n";
    echo "  6. Research Director synthesizes final response\n";

    echo "\n✓ All tests passed!\n\n";

    // ============================================
    // Example Delegation Structure
    // ============================================
    echo "=== Example Delegation Request ===\n\n";

    $exampleDelegation = [
        'delegations' => [
            [
                'agent_name' => 'Medical Research Specialist',
                'task' => 'Search PubMed for recent articles on mRNA vaccine efficacy',
                'context' => 'Focus on COVID-19 vaccines from 2023-2024',
            ],
            [
                'agent_name' => 'Data Analysis Specialist',
                'task' => 'Analyze efficacy rates from the research findings',
                'context' => 'Compare different vaccine types',
            ],
        ],
    ];

    echo "Parallel delegation example:\n";
    echo json_encode($exampleDelegation, JSON_PRETTY_PRINT) . "\n\n";

    echo "This would run both agents simultaneously and collect results.\n";

} catch (Exception $e) {
    echo "\n✗ Error: " . $e->getMessage() . "\n";
    echo "Stack trace:\n" . $e->getTraceAsString() . "\n";
    exit(1);
}
