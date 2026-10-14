<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\CronExpression;
use AgentTeam\Services\ScheduledWorkflowService;
use AgentTeam\Services\WorkflowRepository;
use PDO;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/**
 * Scheduled Workflow Controller
 *
 * Handles REST API endpoints for managing scheduled workflow executions.
 */
class ScheduledWorkflowController
{
    private PDO $db;
    private array $config;
    private ScheduledWorkflowService $scheduleService;
    private WorkflowRepository $workflowRepository;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->scheduleService = new ScheduledWorkflowService($db);
        $this->workflowRepository = new WorkflowRepository($db);
    }

    /**
     * GET /api/v1/schedules
     * List all scheduled workflows for the authenticated user
     */
    public function index(array $request): array
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
            $schedules = $this->scheduleService->findByUser($userId);

            return [
                'success' => true,
                'data' => $schedules,
                'count' => count($schedules),
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
     * POST /api/v1/schedules
     * Create a new scheduled workflow
     */
    public function create(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {   // a Start option names its component; the component supplies the event (spec §3)
            $body = (new CodeComponentStore($this->db))->scheduleBody((int) $userId, $body);
        } catch (CodeComponentError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }

        // Validate required fields
        if (empty($body['workflow_id'])) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        if (empty($body['scheduled_time'])) {
            return [
                'success' => false,
                'error' => 'Scheduled time is required',
                'status_code' => 400
            ];
        }

        // Verify the workflow exists and belongs to the user
        $workflow = $this->workflowRepository->findById((int) $body['workflow_id']);
        if (!$workflow || $workflow->getUserId() !== $userId) {
            return [
                'success' => false,
                'error' => 'Workflow not found',
                'status_code' => 404
            ];
        }

        // Validate repeat_type if provided
        if (!empty($body['repeat_type']) && !in_array($body['repeat_type'], ScheduledWorkflowService::REPEAT_TYPES, true)) {
            return [
                'success' => false,
                'error' => 'Invalid repeat type. Must be one of: ' . implode(', ', ScheduledWorkflowService::REPEAT_TYPES),
                'status_code' => 400
            ];
        }
        if (($body['repeat_type'] ?? '') === 'cron' && !CronExpression::isValid(trim((string) ($body['cron'] ?? '')))) {
            return ['success' => false, 'error' => 'Invalid cron expression', 'status_code' => 400];
        }
        if (($body['repeat_type'] ?? '') === 'event') {
            try {
                ScheduledWorkflowService::eventTrigger($body['event_trigger'] ?? null);
            } catch (\InvalidArgumentException $e) {
                return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
            }
        }

        try {
            $schedule = $this->scheduleService->create([
                'user_id' => $userId,
                'workflow_id' => (int) $body['workflow_id'],
                'input_prompt' => $body['input_prompt'] ?? null,
                'scheduled_time' => $body['scheduled_time'],
                'repeat_type' => $body['repeat_type'] ?? 'none',
                'repeat_interval' => (int) ($body['repeat_interval'] ?? 1),
                'cron' => $body['cron'] ?? null,
                'event_trigger' => $body['event_trigger'] ?? null,
                'trigger_component_id' => $body['trigger_component_id'] ?? null,
            ]);

            return [
                'success' => true,
                'data' => $schedule,
                'message' => 'Schedule created successfully',
                'status_code' => 201
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
     * GET /api/v1/schedules/{id}
     * Get a specific scheduled workflow
     */
    public function show(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $id = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $schedule = $this->scheduleService->findById($id);

            if (!$schedule || $schedule['user_id'] !== $userId) {
                return [
                    'success' => false,
                    'error' => 'Schedule not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'data' => $schedule,
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
     * PUT /api/v1/schedules/{id}
     * Update a scheduled workflow
     */
    public function update(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $id = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {   // a Start option names its component; the component supplies the event (spec §3)
            $body = (new CodeComponentStore($this->db))->scheduleBody((int) $userId, $body);
        } catch (CodeComponentError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }

        // Validate repeat_type if provided
        if (!empty($body['repeat_type'])) {
            if (!in_array($body['repeat_type'], ScheduledWorkflowService::REPEAT_TYPES, true)) {
                return [
                    'success' => false,
                    'error' => 'Invalid repeat type',
                    'status_code' => 400
                ];
            }
        }

        // Effective cron after this update: a cron schedule must carry a valid, ever-firing expression.
        if (($body['repeat_type'] ?? null) === 'cron' || array_key_exists('cron', $body)) {
            $existing = $this->scheduleService->findById($id);
            $effType = $body['repeat_type'] ?? ($existing['repeat_type'] ?? 'none');
            $effCron = trim((string) ($body['cron'] ?? $existing['cron'] ?? ''));
            if ($effType === 'cron' && !CronExpression::isValid($effCron)) {
                return ['success' => false, 'error' => 'Invalid cron expression', 'status_code' => 400];
            }
        }

        try {
            $schedule = $this->scheduleService->update($id, $userId, $body);

            if (!$schedule) {
                return [
                    'success' => false,
                    'error' => 'Schedule not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'data' => $schedule,
                'message' => 'Schedule updated successfully',
                'status_code' => 200
            ];
        } catch (\InvalidArgumentException $e) {   // e.g. an event schedule without a usable trigger
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * DELETE /api/v1/schedules/{id}
     * Delete a scheduled workflow
     */
    public function destroy(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $id = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $deleted = $this->scheduleService->delete($id, $userId);

            if (!$deleted) {
                return [
                    'success' => false,
                    'error' => 'Schedule not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'message' => 'Schedule deleted successfully',
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
     * POST /api/v1/schedules/{id}/pause
     * Pause a scheduled workflow
     */
    public function pause(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $id = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $paused = $this->scheduleService->pause($id, $userId);

            if (!$paused) {
                return [
                    'success' => false,
                    'error' => 'Schedule not found or cannot be paused',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'message' => 'Schedule paused successfully',
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
     * POST /api/v1/schedules/{id}/resume
     * Resume a paused scheduled workflow
     */
    public function resume(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $id = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $resumed = $this->scheduleService->resume($id, $userId);

            if (!$resumed) {
                return [
                    'success' => false,
                    'error' => 'Schedule not found or not paused',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'message' => 'Schedule resumed successfully',
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
     * GET /api/v1/schedules/stats
     * Get scheduling statistics for the user
     */
    public function stats(array $request): array
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
            $stats = $this->scheduleService->getStats($userId);

            return [
                'success' => true,
                'data' => $stats,
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
     * GET /api/v1/workflows/{id}/schedules
     * Get all schedules for a specific workflow
     */
    public function byWorkflow(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $schedules = $this->scheduleService->findByWorkflow($workflowId, $userId);

            return [
                'success' => true,
                'data' => $schedules,
                'count' => count($schedules),
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
}
