<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\ScheduledWorkflowService;
use AgentTeam\Services\ScheduleTick;
use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\GraphWorkflowRunner;
use AgentTeam\Services\WorkflowRunner;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use PDO;

/**
 * Scheduler Controller
 *
 * Provides API access to the workflow scheduler.
 * This is an alternative to the direct cron script, allowing
 * authenticated admin access to trigger scheduled workflow execution.
 */
class SchedulerController
{
    private PDO $db;
    private array $config;
    private ScheduledWorkflowService $scheduleService;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->scheduleService = new ScheduledWorkflowService($db);
    }

    /**
     * POST /api/v1/scheduler/run
     * Manually trigger the scheduler to run due workflows
     * Requires admin authentication or scheduler token
     */
    public function run(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $body = $request['body'] ?? [];

        // Check for scheduler token in body (allows cron/external trigger)
        $schedulerToken = $body['token'] ?? $request['headers']['X-Scheduler-Token'] ?? null;
        $expectedToken = $this->config['scheduler']['token'] ?? '';

        // Either need valid user auth or valid scheduler token
        if (!$userId && $schedulerToken !== $expectedToken) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $results = $this->executeScheduler();

            return [
                'success' => true,
                'data' => $results,
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/scheduler/status
     * Get scheduler status and upcoming schedules
     */
    public function status(array $request): array
    {
        $userId = $request['user_id'] ?? 0;

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $dueSchedules = $this->scheduleService->getDueSchedules();
            $userStats = $this->scheduleService->getStats($userId);

            return [
                'success' => true,
                'data' => [
                    'due_count' => count($dueSchedules),
                    'user_stats' => $userStats,
                    'server_time' => date('Y-m-d H:i:s'),
                    'timezone' => date_default_timezone_get()
                ],
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Execute the scheduler logic
     */
    private function executeScheduler(): array
    {
        $workflowRepository = new WorkflowRepository($this->db);
        $graphRepository = $workflowRepository->getGraphRepository();
        $agentRepository = new AgentRepository($this->db);

        // Create AI assistant for LLM and tools. DB-overlay so providers from
        // system_llm_settings register correctly (post-cutover the file no
        // longer carries provider blocks).
        $config = LLMProviderResolver::applyDbSettings($this->db, $this->config);
        $assistant = new AIPortfolioAssistant($config);
        $assistant->setDatabase($this->db);
        $mcpToolsLoader = new MCPToolsLoader($this->db);

        $agentRunner = new AgentRunner(
            $assistant->getLLMManager(),
            $assistant->getToolsManager(),
            $mcpToolsLoader,
            $this->db,
            $this->config
        );

        $graphWorkflowRunner = new GraphWorkflowRunner(
            $this->db,
            $agentRepository,
            $agentRunner,
            $graphRepository,
            $this->config
        );

        $workflowRunner = new WorkflowRunner(
            $this->db,
            $agentRepository,
            $agentRunner,
            $this->config
        );

        $tick = new ScheduleTick(
            $this->scheduleService,
            ScheduleTick::workflowRunner($workflowRepository, $graphRepository, $graphWorkflowRunner, $workflowRunner)
        );
        // A missing active_workflows table (not migrated yet) must not break the tick: then nothing is due, never every schedule.
        try {
            $activeWorkflowIds = (new \AgentTeam\Services\ActiveWorkflowService($this->db))->scheduleWorkflowIds();
        } catch (\Throwable $e) {
            error_log('Scheduler: active workflows unavailable, running none: ' . $e->getMessage());
            $activeWorkflowIds = [];
        }
        return $tick->run($activeWorkflowIds);
    }
}
