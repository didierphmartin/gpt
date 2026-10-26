<?php

/**
 * Scheduled Workflow Runner
 *
 * This script is called by cron to execute due scheduled workflows.
 * It can be invoked via:
 *   1. CLI: php /path/to/run-scheduled-workflows.php
 *   2. HTTP: curl https://yoursite.com/scheduler/run-scheduled-workflows.php?token=YOUR_SECRET
 *
 * Cron entry example (runs every minute; every minute is required for cron schedules):
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

    // A blank SCHEDULER_TOKEN turns HTTP access off: it never matches ''
    $expectedToken = (string) ($config['scheduler']['token'] ?? '');
    $providedToken = $_GET['token'] ?? $_SERVER['HTTP_X_SCHEDULER_TOKEN'] ?? '';

    if ($expectedToken === '' || !is_string($providedToken) || !hash_equals($expectedToken, $providedToken)) {
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

try {
    $boot = require __DIR__ . '/bootstrap.php';
} catch (\RuntimeException $e) {
    if ($isCli) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
    echo json_encode(['error' => $e->getMessage()]);
    exit(1);
}

$tick = new AgentTeam\Services\ScheduleTick(
    $boot['schedules'],
    $boot['runSchedule'],
    $isCli ? static fn(string $line) => print('[' . date('Y-m-d H:i:s') . "] {$line}\n") : null
);
// Only the active schedule-mode workflows run (spec 2026-10-14 event-worker §3). A missing active_workflows table
// (not migrated yet) must not break the tick: then nothing is due, never every schedule.
try {
    $activeWorkflowIds = (new AgentTeam\Services\ActiveWorkflowService($boot['pdo']))->scheduleWorkflowIds();
} catch (\Throwable $e) {
    error_log('Scheduler: active workflows unavailable, running none: ' . $e->getMessage());
    if ($isCli) {
        fwrite(STDERR, 'Scheduler: active workflows unavailable, running none: ' . $e->getMessage() . "\n");
    }
    $activeWorkflowIds = [];
}
$results = $tick->run($activeWorkflowIds);

if ($isCli) {
    echo "[" . date('Y-m-d H:i:s') . "] Completed: " . $results['executed_count'] . " succeeded, " . $results['failed_count'] . " failed\n";
} else {
    echo json_encode($results, JSON_PRETTY_PRINT);
}

exit(0);
