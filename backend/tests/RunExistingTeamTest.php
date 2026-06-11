<?php

/**
 * Run Existing Team Test
 *
 * Tests running an existing team from the database without creating test data.
 * Uses the actual "pubmed" team (or any team specified).
 *
 * Usage:
 *   php tests/RunExistingTeamTest.php [team_name]
 *
 * Examples:
 *   php tests/RunExistingTeamTest.php              # Uses default team name
 *   php tests/RunExistingTeamTest.php "pubmed"     # Uses specified team
 *   php tests/RunExistingTeamTest.php --list       # Lists all available teams
 */

require_once __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Services\TeamRepository;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

// ============================================
// Configuration
// ============================================

$teamName = $argv[1] ?? 'Medical Research Team';  // Default team name
$userId = (int)($argv[2] ?? 3);  // Default user ID (use: php test.php "team name" 3)

echo "=== Run Existing Team Test ===\n";
echo "Date: " . date('Y-m-d H:i:s') . "\n\n";

// Load config
$config = require __DIR__ . '/../config/ai_config.php';

// Database connection
try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    echo "✓ Database connected: {$dbConfig['database']}\n\n";
} catch (PDOException $e) {
    die("✗ Database connection failed: " . $e->getMessage() . "\n");
}

$teamRepo = new TeamRepository($pdo);
$agentRepo = new AgentRepository($pdo);

// ============================================
// List teams mode
// ============================================

if ($teamName === '--list') {
    echo "Available teams for user $userId:\n\n";

    $teams = $teamRepo->findByUserWithAgents($userId);

    if (empty($teams)) {
        echo "  No teams found.\n";
        exit(0);
    }

    foreach ($teams as $team) {
        $agents = $team->getAgents();
        $managerCount = 0;
        $workerCount = 0;

        foreach ($agents as $agent) {
            if ($agent->getAgentType() === 'manager') $managerCount++;
            if ($agent->getAgentType() === 'worker') $workerCount++;
        }

        echo "  [{$team->getId()}] {$team->getName()}\n";
        echo "      Agents: " . count($agents) . " ({$managerCount} manager, {$workerCount} workers)\n";
        echo "      Description: " . ($team->getDescription() ?: 'N/A') . "\n\n";
    }

    exit(0);
}

// ============================================
// Step 1: Find the team
// ============================================

echo "Step 1: Finding team '{$teamName}'...\n";

$teams = $teamRepo->findByUserWithAgents($userId);
$team = null;

foreach ($teams as $t) {
    if (stripos($t->getName(), $teamName) !== false) {
        $team = $t;
        break;
    }
}

if (!$team) {
    echo "  ✗ Team not found. Available teams:\n";
    foreach ($teams as $t) {
        echo "    - {$t->getName()} (ID: {$t->getId()})\n";
    }
    exit(1);
}

echo "  ✓ Found team: ID={$team->getId()}, Name='{$team->getName()}'\n";
echo "  Description: " . ($team->getDescription() ?: 'N/A') . "\n\n";

// ============================================
// Step 2: List agents in team
// ============================================

echo "Step 2: Loading agents...\n";

$agents = $team->getAgents();

if (empty($agents)) {
    die("  ✗ No agents in this team\n");
}

$manager = null;
$workers = [];

foreach ($agents as $agent) {
    $type = $agent->getAgentType();
    $status = $agent->isEnabled() ? '✓' : '✗';
    echo "  [{$status}] {$agent->getName()} ({$type})\n";
    echo "      Provider: {$agent->getProvider()}\n";
    echo "      Tools: " . (empty($agent->getTools()) ? 'none' : implode(', ', $agent->getTools())) . "\n";

    if ($type === 'manager' && $agent->isEnabled()) {
        $manager = $agent;
    } elseif ($type === 'worker') {
        $workers[] = $agent;
    }
}

echo "\n";

if (!$manager) {
    die("  ✗ No enabled manager agent found in this team\n");
}

echo "  ✓ Manager: {$manager->getName()} (ID: {$manager->getId()})\n";
echo "  ✓ Workers: " . count($workers) . "\n\n";

// ============================================
// Step 3: Provider info (keys are in backend config)
// ============================================

echo "Step 3: Provider configuration...\n";
$provider = $manager->getProvider();
echo "  Manager provider: {$provider}\n";
echo "  (API keys are loaded from backend config)\n\n";

// ============================================
// Step 4: Initialize components
// ============================================

echo "Step 4: Initializing components...\n";

try {
    // Initialize AIPortfolioAssistant for LLM access
    $assistant = new AIPortfolioAssistant($config);
    echo "  ✓ AIPortfolioAssistant initialized\n";

    // Initialize MCP tools loader
    $mcpLoader = null;
    try {
        $mcpLoader = new MCPToolsLoader($pdo);
        $mcpLoader->loadToolsForUser($userId);
        $mcpToolCount = count($mcpLoader->getToolDefinitions());
        echo "  ✓ MCP tools loaded: {$mcpToolCount} tools\n";
    } catch (Exception $e) {
        echo "  ⚠ MCP tools unavailable: " . $e->getMessage() . "\n";
    }

    // Create AgentRunner
    $runner = new AgentRunner(
        $assistant->getLLMManager(),
        $assistant->getToolsManager(),
        $mcpLoader,
        $pdo,
        $config
    );
    echo "  ✓ AgentRunner initialized\n\n";

} catch (Exception $e) {
    die("  ✗ Initialization failed: " . $e->getMessage() . "\n");
}

// ============================================
// Step 5: Execute the manager agent
// ============================================

echo "Step 5: Executing manager agent...\n";

$task = "Make a report about the current research status of methylene blue";

echo "  Task: {$task}\n";
echo "  Agent: {$manager->getName()}\n";
echo "  Provider: {$provider}\n";
echo "\n  Executing... (this may take a moment)\n\n";

$startTime = microtime(true);

try {
    $result = $runner->run(
        $manager,
        $task,
        [],      // conversation history
        $userId, // user_id
        []       // context
    );

    $duration = round((microtime(true) - $startTime) * 1000);

    if ($result['success']) {
        echo "═══════════════════════════════════════════════════════════════\n";
        echo "                         SUCCESS\n";
        echo "═══════════════════════════════════════════════════════════════\n\n";

        echo "Response:\n";
        echo "─────────────────────────────────────────────────────────────────\n";
        echo $result['text'] . "\n";
        echo "─────────────────────────────────────────────────────────────────\n\n";

        echo "Execution Details:\n";
        echo "  - Duration: {$duration}ms\n";
        echo "  - Execution ID: " . ($result['execution_id'] ?? 'N/A') . "\n";
        echo "  - Provider: " . ($result['provider'] ?? 'N/A') . "\n";
        echo "  - Model: " . ($result['model'] ?? 'N/A') . "\n";

        if (!empty($result['tools_used'])) {
            echo "  - Tools used: " . count($result['tools_used']) . "\n";
            foreach ($result['tools_used'] as $tool) {
                $toolName = is_array($tool) ? ($tool['name'] ?? json_encode($tool)) : $tool;
                echo "    · {$toolName}\n";
            }
        }

        if (!empty($result['usage'])) {
            $usage = $result['usage'];
            $inputTokens = $usage['prompt_tokens'] ?? $usage['input_tokens'] ?? 0;
            $outputTokens = $usage['completion_tokens'] ?? $usage['output_tokens'] ?? 0;
            echo "  - Tokens: {$inputTokens} input, {$outputTokens} output\n";
        }

    } else {
        echo "═══════════════════════════════════════════════════════════════\n";
        echo "                         FAILED\n";
        echo "═══════════════════════════════════════════════════════════════\n\n";

        echo "Error: " . ($result['error'] ?? 'Unknown error') . "\n";

        if (!empty($result['details'])) {
            echo "Details: " . print_r($result['details'], true) . "\n";
        }
    }

} catch (Exception $e) {
    $duration = round((microtime(true) - $startTime) * 1000);

    echo "═══════════════════════════════════════════════════════════════\n";
    echo "                       EXCEPTION\n";
    echo "═══════════════════════════════════════════════════════════════\n\n";

    echo "Exception: " . $e->getMessage() . "\n\n";
    echo "Duration before error: {$duration}ms\n\n";
    echo "Stack trace:\n";
    echo $e->getTraceAsString() . "\n";
}

echo "\n=== Test Complete ===\n";
