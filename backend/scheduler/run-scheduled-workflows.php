<?php

/**
 * Scheduled Workflow Runner
 *
 * This script is called by cron to execute due scheduled workflows.
 * It can be invoked via:
 *   1. CLI: php /path/to/run-scheduled-workflows.php
 *   2. HTTP: curl https://yoursite.com/scheduler/run-scheduled-workflows.php?token=YOUR_SECRET
 *
 * Cron entry example (runs every minute):
 *   * * * * * /usr/bin/php /path/to/backend/scheduler/run-scheduled-workflows.php >> /var/log/workflow-scheduler.log 2>&1
 *
 * Or via HTTP:
 *   * * * * * curl -s "https://yoursite.com/scheduler/run-scheduled-workflows.php?token=YOUR_SECRET" > /dev/null 2>&1
 */

declare(strict_types=1);

// Determine if running via CLI or HTTP
$isCli = php_sapi_name() === 'cli';

// Security check for HTTP access
if (!$isCli) {
    // Require a secret token for HTTP access
    $configPath = __DIR__ . '/../config/ai_config.php';
    if (file_exists($configPath)) {
        $config = require $configPath;
    } else {
        http_response_code(500);
        echo json_encode(['error' => 'Configuration not found']);
        exit(1);
    }

    $expectedToken = $config['scheduler']['token'] ?? 'change-this-secret-token-in-production';
    $providedToken = $_GET['token'] ?? $_SERVER['HTTP_X_SCHEDULER_TOKEN'] ?? '';

    if ($providedToken !== $expectedToken) {
        http_response_code(403);
        echo json_encode(['error' => 'Invalid scheduler token']);
        exit(1);
    }

    header('Content-Type: application/json');
}

// Set up error handling
set_error_handler(function ($errno, $errstr, $errfile, $errline) use ($isCli) {
    $message = "Error [$errno]: $errstr in $errfile:$errline";
    if ($isCli) {
        fwrite(STDERR, $message . "\n");
    }
    error_log($message);
    return true;
});

// Load configuration and dependencies
require_once __DIR__ . '/../vendor/autoload.php';

$configPath = __DIR__ . '/../config/ai_config.php';
if (!file_exists($configPath)) {
    $error = 'Configuration file not found';
    if ($isCli) {
        fwrite(STDERR, $error . "\n");
        exit(1);
    }
    echo json_encode(['error' => $error]);
    exit(1);
}

$config = require $configPath;

// Connect to database
try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false
    ]);
} catch (PDOException $e) {
    $error = 'Database connection failed: ' . $e->getMessage();
    if ($isCli) {
        fwrite(STDERR, $error . "\n");
        exit(1);
    }
    echo json_encode(['error' => $error]);
    exit(1);
}

// Initialize services
use AgentTeam\Services\ScheduledWorkflowService;
use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\GraphWorkflowRunner;
use AgentTeam\Services\WorkflowRunner;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

$scheduleService = new ScheduledWorkflowService($pdo);
$workflowRepository = new WorkflowRepository($pdo);
$graphRepository = $workflowRepository->getGraphRepository();
$agentRepository = new AgentRepository($pdo);

// Create AI assistant for LLM and tools
$assistant = new AIPortfolioAssistant($config);
$assistant->setDatabase($pdo);
$mcpToolsLoader = new MCPToolsLoader($pdo);

$agentRunner = new AgentRunner(
    $assistant->getLLMManager(),
    $assistant->getToolsManager(),
    $mcpToolsLoader,
    $pdo,
    $config
);

$graphWorkflowRunner = new GraphWorkflowRunner(
    $pdo,
    $agentRepository,
    $agentRunner,
    $graphRepository,
    $config
);

$workflowRunner = new WorkflowRunner(
    $pdo,
    $agentRepository,
    $agentRunner,
    $config
);

// Get due schedules
$dueSchedules = $scheduleService->getDueSchedules();

$results = [
    'timestamp' => date('Y-m-d H:i:s'),
    'due_count' => count($dueSchedules),
    'executed' => [],
    'failed' => []
];

if ($isCli) {
    echo "[" . date('Y-m-d H:i:s') . "] Found " . count($dueSchedules) . " due schedule(s)\n";
}

foreach ($dueSchedules as $schedule) {
    $scheduleId = (int) $schedule['id'];
    $workflowId = (int) $schedule['workflow_id'];
    $userId = (int) $schedule['user_id'];
    $inputPrompt = $schedule['input_prompt'];

    if ($isCli) {
        echo "[" . date('Y-m-d H:i:s') . "] Executing schedule #{$scheduleId} (workflow #{$workflowId})\n";
    }

    try {
        // Mark as running
        $scheduleService->markRunning($scheduleId);

        // Load workflow
        $workflow = $workflowRepository->findById($workflowId);

        if (!$workflow) {
            throw new Exception("Workflow #{$workflowId} not found");
        }

        if (!$workflow->isEnabled()) {
            throw new Exception("Workflow #{$workflowId} is disabled");
        }

        // Prepare input variables
        $inputVariables = [];
        if ($inputPrompt) {
            $inputVariables['user_prompt'] = $inputPrompt;
            $inputVariables['prompt'] = $inputPrompt;
        }

        // Check if graph-based workflow
        $hasGraphNodes = $graphRepository->getNodes($workflowId);
        $isGraphWorkflow = !empty($hasGraphNodes);

        // Execute workflow
        if ($isGraphWorkflow) {
            $result = $graphWorkflowRunner->run($workflow, $userId, $inputVariables);
        } else {
            $result = $workflowRunner->run($workflow, $userId, $inputVariables);
        }

        if ($result['success']) {
            $scheduleService->markCompleted($scheduleId);
            $results['executed'][] = [
                'schedule_id' => $scheduleId,
                'workflow_id' => $workflowId,
                'workflow_name' => $schedule['workflow_name'],
                'execution_id' => $result['execution_id'] ?? null
            ];

            if ($isCli) {
                echo "[" . date('Y-m-d H:i:s') . "] ✓ Schedule #{$scheduleId} completed successfully\n";
            }
        } else {
            throw new Exception($result['error'] ?? 'Workflow execution failed');
        }

    } catch (Exception $e) {
        $errorMessage = $e->getMessage();
        $scheduleService->markFailed($scheduleId, $errorMessage);

        $results['failed'][] = [
            'schedule_id' => $scheduleId,
            'workflow_id' => $workflowId,
            'workflow_name' => $schedule['workflow_name'] ?? 'Unknown',
            'error' => $errorMessage
        ];

        if ($isCli) {
            echo "[" . date('Y-m-d H:i:s') . "] ✗ Schedule #{$scheduleId} failed: {$errorMessage}\n";
        }

        error_log("Scheduled workflow failed: Schedule #{$scheduleId}, Workflow #{$workflowId}: {$errorMessage}");
    }
}

$results['executed_count'] = count($results['executed']);
$results['failed_count'] = count($results['failed']);

if ($isCli) {
    echo "[" . date('Y-m-d H:i:s') . "] Completed: " . $results['executed_count'] . " succeeded, " . $results['failed_count'] . " failed\n";
} else {
    echo json_encode($results, JSON_PRETTY_PRINT);
}

exit(0);
