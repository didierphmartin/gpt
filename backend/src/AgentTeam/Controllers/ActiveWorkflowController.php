<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\ActiveWorkflowError;
use AgentTeam\Services\ActiveWorkflowService;
use PDO;

/** ▶ on Start activates the workflow the event worker runs (spec 2026-10-14 event-worker §2). One per user. */
class ActiveWorkflowController
{
    private ActiveWorkflowService $active;

    public function __construct(PDO $db, array $config)
    {
        $this->active = new ActiveWorkflowService($db);
    }

    /** GET /api/v1/workflows/active */
    public function show(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        return ['success' => true, 'data' => $this->active->get($userId), 'status_code' => 200];
    }

    /** POST /api/v1/workflows/{id}/activate */
    public function activate(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        try {
            return ['success' => true, 'data' => $this->active->activate($userId, (int) ($request['params']['id'] ?? 0)), 'status_code' => 200];
        } catch (ActiveWorkflowError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }
    }

    /** DELETE /api/v1/workflows/{id}/activate */
    public function deactivate(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $this->active->deactivate($userId, (int) ($request['params']['id'] ?? 0));
        return ['success' => true, 'status_code' => 200];
    }
}
