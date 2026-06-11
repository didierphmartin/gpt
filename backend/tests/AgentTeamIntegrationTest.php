<?php

/**
 * Agent Team Integration Test
 *
 * Tests the full agent team workflow:
 * 1. Create a team
 * 2. Add manager agent (orchestrates workers)
 * 3. Add worker agent (PubMed researcher)
 * 4. Add verifier agent (reviews research)
 * 5. Execute manager with a research task
 *
 * Usage:
 *   php tests/AgentTeamIntegrationTest.php
 *
 * Environment variables:
 *   CLAUDE_API_KEY or OPENAI_API_KEY - Required for LLM calls
 */

require_once __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Models\Team;
use AgentTeam\Models\Agent;
use AgentTeam\Services\TeamRepository;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

echo "=== Agent Team Integration Test ===\n";
echo "Testing: Manager → PubMed Researcher → Verifier → Final Response\n\n";

// ============================================
// Configuration
// ============================================

$config = require __DIR__ . '/../config/ai_config.php';

// Check for API key
$hasApiKey = !empty($config['claude']['api_key']) || !empty($config['openai']['api_key']);
$provider = !empty($config['openai']['api_key']) ? 'openai' : 'claude';

if (!$hasApiKey) {
    echo "Warning: No API key found. Set CLAUDE_API_KEY or OPENAI_API_KEY.\n";
    echo "Test will create data but skip execution.\n\n";
}

// Database connection
try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    echo "✓ Database connected\n\n";
} catch (PDOException $e) {
    die("✗ Database connection failed: " . $e->getMessage() . "\n");
}

// ============================================
// Step 1: Create Team
// ============================================

echo "Step 1: Creating team...\n";

$teamRepo = new TeamRepository($pdo);
$agentRepo = new AgentRepository($pdo);

$team = new Team();
$team->setUserId(1)
    ->setName('Medical Research Team')
    ->setDescription('A team that researches medical topics using PubMed and verifies the findings');

try {
    $team = $teamRepo->create($team);
    echo "  ✓ Team created: ID={$team->getId()}, Name='{$team->getName()}'\n\n";
} catch (Exception $e) {
    die("  ✗ Failed to create team: " . $e->getMessage() . "\n");
}

// ============================================
// Step 2: Create Manager Agent
// ============================================

echo "Step 2: Creating manager agent...\n";

$managerPrompt = <<<PROMPT
You are the Research Manager, orchestrating a medical research team.

IMPORTANT: You MUST delegate all research tasks. You do NOT have direct access to any research tools.

## Your Team
- **PubMed Researcher**: Searches PubMed for scientific articles. DELEGATE research tasks to this agent.
- **Research Verifier**: Reviews and verifies research findings. DELEGATE verification to this agent.

## Required Process (ALWAYS follow these steps)
1. FIRST: Call list_available_agents to confirm your team is available
2. THEN: Use delegate_to_agent to send the research task to "PubMed Researcher"
3. NEXT: Use delegate_to_agent to send the results to "Research Verifier" for verification
4. FINALLY: Compile the verified findings into your final response

## Rules
- You MUST use delegation tools - do NOT answer from your own knowledge
- Always delegate research to PubMed Researcher first
- Always pass research results to Research Verifier before finalizing
- Include both the research findings and verification notes in your final response
PROMPT;

$manager = new Agent();
$manager->setUserId(1)
    ->setTeamId($team->getId())
    ->setName('Research Manager')
    ->setDescription('Orchestrates medical research workflow')
    ->setAgentType('manager')
    ->setProvider($provider)
    ->setInstructions($managerPrompt)
    ->setSettings(['temperature' => 0.7, 'max_tokens' => 2000])
    ->setEnabled(true);

try {
    $manager = $agentRepo->create($manager);
    echo "  ✓ Manager created: ID={$manager->getId()}, Name='{$manager->getName()}'\n";
    echo "    Type: {$manager->getAgentType()}, Provider: {$manager->getProvider()}\n\n";
} catch (Exception $e) {
    die("  ✗ Failed to create manager: " . $e->getMessage() . "\n");
}

// ============================================
// Step 3: Create PubMed Researcher (Worker)
// ============================================

echo "Step 3: Creating PubMed Researcher agent...\n";

$researcherPrompt = <<<PROMPT
You are a medical research specialist with expertise in searching scientific literature.

## Your Role
Search PubMed for relevant articles based on the research topic provided.

## Guidelines
- Use the pubmed_search tool to find articles
- Focus on recent, peer-reviewed research
- Look for clinical studies and systematic reviews when relevant
- Summarize key findings from the most relevant articles

## Output Format
For each relevant article found:
- Title
- Authors (first author et al.)
- Publication year
- Key findings or conclusions
- PMID (PubMed ID)

Provide a summary of the overall research landscape on the topic.
PROMPT;

$researcher = new Agent();
$researcher->setUserId(1)
    ->setTeamId($team->getId())
    ->setName('PubMed Researcher')
    ->setDescription('Searches PubMed for scientific articles')
    ->setAgentType('worker')
    ->setProvider($provider)
    ->setInstructions($researcherPrompt)
    ->setTools(['pubmed_search', 'pubmed_build_query'])  // MCP tools
    ->setSettings(['temperature' => 0.3, 'max_tokens' => 3000])
    ->setEnabled(true);

try {
    $researcher = $agentRepo->create($researcher);
    echo "  ✓ Researcher created: ID={$researcher->getId()}, Name='{$researcher->getName()}'\n";
    echo "    Type: {$researcher->getAgentType()}, Tools: " . implode(', ', $researcher->getTools()) . "\n\n";
} catch (Exception $e) {
    die("  ✗ Failed to create researcher: " . $e->getMessage() . "\n");
}

// ============================================
// Step 4: Create Research Verifier (Worker)
// ============================================

echo "Step 4: Creating Research Verifier agent...\n";

$verifierPrompt = <<<PROMPT
You are a research verification specialist with expertise in evaluating scientific literature.

## Your Role
Review research findings provided by the PubMed Researcher and verify their quality.

## Verification Checklist
1. **Source Quality**: Are the cited articles from peer-reviewed journals?
2. **Relevance**: Do the articles directly address the research question?
3. **Recency**: Are the findings up-to-date?
4. **Completeness**: Are there any gaps in the research coverage?
5. **Accuracy**: Do the summaries accurately reflect the article content?

## Output Format
Provide a verification report:

### Verification Summary
- Overall Quality Score: X/10
- Sources Verified: X articles

### Strengths
- [What was done well]

### Concerns (if any)
- [Any issues found]

### Recommendations
- [Suggestions for improvement]

### Final Assessment
[Your conclusion on the reliability of the research]
PROMPT;

$verifier = new Agent();
$verifier->setUserId(1)
    ->setTeamId($team->getId())
    ->setName('Research Verifier')
    ->setDescription('Verifies and reviews research findings')
    ->setAgentType('worker')
    ->setProvider($provider)
    ->setInstructions($verifierPrompt)
    ->setTools([])  // No external tools needed
    ->setSettings(['temperature' => 0.2, 'max_tokens' => 2000])
    ->setEnabled(true);

try {
    $verifier = $agentRepo->create($verifier);
    echo "  ✓ Verifier created: ID={$verifier->getId()}, Name='{$verifier->getName()}'\n";
    echo "    Type: {$verifier->getAgentType()}\n\n";
} catch (Exception $e) {
    die("  ✗ Failed to create verifier: " . $e->getMessage() . "\n");
}

// ============================================
// Step 5: Verify Team Structure
// ============================================

echo "Step 5: Verifying team structure...\n";

$loadedTeam = $teamRepo->findByIdWithAgents($team->getId());

if (!$loadedTeam) {
    die("  ✗ Failed to load team\n");
}

$agents = $loadedTeam->getAgents();
echo "  Team: {$loadedTeam->getName()}\n";
echo "  Agents: " . count($agents) . "\n";

$managerCount = 0;
$workerCount = 0;

foreach ($agents as $agent) {
    $type = $agent->getAgentType();
    echo "    - {$agent->getName()} ({$type})\n";
    if ($type === 'manager') $managerCount++;
    if ($type === 'worker') $workerCount++;
}

if ($managerCount !== 1 || $workerCount !== 2) {
    echo "  ⚠ Warning: Expected 1 manager and 2 workers\n";
}

echo "  ✓ Team structure verified\n\n";

// ============================================
// Step 6: Execute Manager Agent (if API key available)
// ============================================

if ($hasApiKey) {
    echo "Step 6: Executing manager agent...\n";
    echo "  Task: Research methylene blue usage in medicine\n";
    echo "  (This will make real API calls)\n\n";

    try {
        // Initialize AIPortfolioAssistant for LLM access
        $assistant = new AIPortfolioAssistant($config);

        // Initialize MCP tools loader
        $mcpLoader = null;
        try {
            $mcpLoader = new MCPToolsLoader($pdo);
            $mcpLoader->loadToolsForUser(1);
            echo "  MCP tools loaded: " . ($mcpLoader->hasTools() ? 'yes' : 'no') . "\n";
        } catch (Exception $e) {
            echo "  MCP tools unavailable: " . $e->getMessage() . "\n";
        }

        // Create AgentRunner
        $runner = new AgentRunner(
            $assistant->getLLMManager(),
            $assistant->getToolsManager(),
            $mcpLoader,
            $pdo,
            $config
        );

        // Execute the manager with the research task
        $task = "I need you to research the medical uses of methylene blue. " .
                "Use your team: first delegate to the PubMed Researcher to find relevant articles, " .
                "then have the Research Verifier check the findings. " .
                "Provide me with the verified summary.";

        echo "\n  Executing...\n";
        $startTime = microtime(true);

        $result = $runner->run(
            $manager,
            $task,
            [],  // conversation history
            1,   // user_id
            []   // context
        );

        $duration = round((microtime(true) - $startTime) * 1000);

        if ($result['success']) {
            echo "\n  ✓ Execution completed in {$duration}ms\n\n";
            echo "  === RESULT ===\n";
            echo "  " . str_replace("\n", "\n  ", $result['text']) . "\n";
            echo "  ==============\n\n";

            echo "  Execution Details:\n";
            echo "    - Execution ID: {$result['execution_id']}\n";
            echo "    - Provider: {$result['provider']}\n";
            echo "    - Model: {$result['model']}\n";

            if (!empty($result['tools_used'])) {
                echo "    - Tools used: " . count($result['tools_used']) . "\n";
                foreach ($result['tools_used'] as $tool) {
                    $toolName = is_array($tool) ? ($tool['name'] ?? 'unknown') : $tool;
                    echo "      · {$toolName}\n";
                }
            }

            if (!empty($result['usage'])) {
                $usage = $result['usage'];
                $tokens = ($usage['prompt_tokens'] ?? $usage['input_tokens'] ?? 0) +
                          ($usage['completion_tokens'] ?? $usage['output_tokens'] ?? 0);
                echo "    - Total tokens: {$tokens}\n";
            }
        } else {
            echo "\n  ✗ Execution failed: {$result['error']}\n";
        }

    } catch (Exception $e) {
        echo "\n  ✗ Error during execution: " . $e->getMessage() . "\n";
        echo "  Stack trace:\n" . $e->getTraceAsString() . "\n";
    }
} else {
    echo "Step 6: Skipping execution (no API key)\n";
    echo "  Set CLAUDE_API_KEY or OPENAI_API_KEY to test execution\n";
}

// ============================================
// Step 7: Cleanup (Optional)
// ============================================

echo "\nStep 7: Cleanup...\n";

// Ask if user wants to keep or delete test data
if (php_sapi_name() === 'cli') {
    echo "  Test data created:\n";
    echo "    - Team ID: {$team->getId()}\n";
    echo "    - Manager ID: {$manager->getId()}\n";
    echo "    - Researcher ID: {$researcher->getId()}\n";
    echo "    - Verifier ID: {$verifier->getId()}\n";
    echo "\n  To delete test data, run:\n";
    echo "    DELETE FROM agents WHERE team_id = {$team->getId()};\n";
    echo "    DELETE FROM agent_teams WHERE id = {$team->getId()};\n";
}

echo "\n=== Test Complete ===\n";
