<?php
/**
 * What the scheduler's CLI scripts share (run-scheduled-workflows.php, bin/run-schedule.php): config, the CONTEXTS
 * database, the schedule service and the callable that runs one schedule's workflow once.
 */
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\GraphWorkflowRunner;
use AgentTeam\Services\ScheduledWorkflowService;
use AgentTeam\Services\ScheduleTick;
use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\WorkflowRunner;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

$configPath = __DIR__ . '/../config/ai_config.php';
if (!file_exists($configPath)) {
    throw new \RuntimeException('Configuration file not found');
}
$config = require $configPath;

try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $pdo = new PDO("mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}",
        $dbConfig['username'], $dbConfig['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
} catch (PDOException $e) {
    throw new \RuntimeException('Database connection failed: ' . $e->getMessage());
}

$workflowRepository = new WorkflowRepository($pdo);
$graphRepository = $workflowRepository->getGraphRepository();
$agentRepository = new AgentRepository($pdo);
$assistant = new AIPortfolioAssistant($config);
$assistant->setDatabase($pdo);
$agentRunner = new AgentRunner($assistant->getLLMManager(), $assistant->getToolsManager(), new MCPToolsLoader($pdo), $pdo, $config);

return [
    'config' => $config,
    'pdo' => $pdo,
    'schedules' => new ScheduledWorkflowService($pdo),
    'runSchedule' => ScheduleTick::workflowRunner($workflowRepository, $graphRepository,
        new GraphWorkflowRunner($pdo, $agentRepository, $agentRunner, $graphRepository, $config),
        new WorkflowRunner($pdo, $agentRepository, $agentRunner, $config)),
];
