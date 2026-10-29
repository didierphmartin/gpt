<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\ActiveWorkflowError;
use AgentTeam\Services\ActiveWorkflowService;
use AgentTeam\Services\WorkflowRepository;
use PDO;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;

/**
 * ▶ on Start activates the workflow the event worker runs (spec 2026-10-14 event-worker §2). One per person; a robot
 * workflow's row is the robot's, and every user who may use the robot activates and deactivates (= Unlock) it.
 */
class ActiveWorkflowController
{
    private ActiveWorkflowService $active;
    private RobotOwnership $ownership;
    private WorkflowRepository $workflows;

    public function __construct(PDO $db, array $config)
    {
        $this->active = new ActiveWorkflowService($db);
        $this->ownership = new RobotOwnership($db, $config);
        $this->workflows = new WorkflowRepository($db);
    }

    /** GET /api/v1/workflows/active: the caller's own row. */
    public function show(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        return ['success' => true, 'data' => $this->active->get($userId), 'status_code' => 200];
    }

    /** GET /api/v1/workflows/{id}/active: the workflow's row, the robot's for a robot workflow. */
    public function forWorkflow(array $request): array
    {
        return $this->guarded($request, fn(int $userId, int $workflowId) =>
            ['success' => true, 'data' => $this->active->forWorkflow($workflowId), 'status_code' => 200]);
    }

    /** POST /api/v1/workflows/{id}/activate */
    public function activate(array $request): array
    {
        return $this->guarded($request, function (int $userId, int $workflowId) {
            try {
                $data = $this->active->activate($this->ownership->runAs($userId, $workflowId), $workflowId);
                return ['success' => true, 'data' => $data, 'status_code' => 200];
            } catch (ActiveWorkflowError $e) {
                return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
            }
        });
    }

    /** DELETE /api/v1/workflows/{id}/activate */
    public function deactivate(array $request): array
    {
        return $this->guarded($request, function (int $userId, int $workflowId) {
            $this->active->deactivate($this->ownership->runAs($userId, $workflowId), $workflowId);
            return ['success' => true, 'status_code' => 200];
        });
    }

    /** Authenticated, and the workflow is the caller's or a robot workflow the caller may use; else 404, nothing more. */
    private function guarded(array $request, callable $fn): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $workflowId = (int) ($request['params']['id'] ?? 0);
        if (!$this->workflows->canUserAccess($userId, $workflowId, $this->ownership->robotFor($userId))) {
            return ['success' => false, 'error' => 'Workflow not found', 'kind' => 'not_found', 'status_code' => 404];
        }
        return $fn($userId, $workflowId);
    }
}
