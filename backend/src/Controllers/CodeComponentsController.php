<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use AgentTeam\Controllers\WorkflowController;
use PDO;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/** /api/v1/code-components — the code components collection (CRUD + used-by), over CodeComponentStore. */
final class CodeComponentsController
{
    private CodeComponentStore $store;
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->store = new CodeComponentStore($db);
    }

    public function index(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true, 'data' => $this->store->list($u)]);
    }

    public function show(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true, 'data' => $this->found($u, $request)]);
    }

    public function create(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true, 'data' => $this->store->save($u, null, $this->body($request))]);
    }

    public function update(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true,
            'data' => $this->store->save($u, (int) ($request['params']['id'] ?? 0), $this->body($request))]);
    }

    public function destroy(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $this->store->delete($u, (int) ($request['params']['id'] ?? 0));
            return ['success' => true];
        });
    }

    public function usedBy(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true,
            'data' => $this->store->usedBy($u, $this->found($u, $request)['id'])]);
    }

    public function setStartOption(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            if ($locked = $this->lockedGuard($u, (int) ($request['params']['id'] ?? 0))) {
                return $locked;
            }
            return ['success' => true,
                'data' => $this->store->setStartTrigger($u, (int) ($request['params']['id'] ?? 0), $this->body($request))];
        });
    }

    /** The 423 body when a schedule on this Start option belongs to a running robot workflow, else null. */
    private function lockedGuard(int $userId, int $componentId): ?array
    {
        if ($this->store->get($userId, $componentId) === null) {
            return null;   // not the caller's component: the store answers 404, never a lock
        }
        $own = new RobotOwnership($this->db, $this->config);
        $rows = $this->db->prepare('SELECT DISTINCT workflow_id FROM scheduled_workflows WHERE trigger_component_id = ?');
        $rows->execute([$componentId]);
        foreach ($rows->fetchAll(PDO::FETCH_COLUMN) as $wf) {
            if ($own->isLocked((int) $wf)) {
                $name = $this->db->prepare('SELECT name FROM agent_workflows WHERE id = ?');
                $name->execute([$wf]);
                return WorkflowController::lockedResponse((string) $name->fetchColumn());
            }
        }
        return null;
    }

    public function startOptionImpact(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true,
            'data' => $this->store->startTriggerImpact($u, $this->found($u, $request)['id'])]);
    }

    public function clearStartOption(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            if ($locked = $this->lockedGuard($u, (int) ($request['params']['id'] ?? 0))) {
                return $locked;
            }
            $data = $this->store->clearStartTrigger($u, (int) ($request['params']['id'] ?? 0));
            $this->sweepActive();   // reverted Starts: their mode is gone
            return ['success' => true, 'data' => $data];
        });
    }

    private function sweepActive(): void
    {
        try {   // never fails the write it follows: the write already happened, and the event worker sweeps every 5 s
            (new \AgentTeam\Services\ActiveWorkflowService($this->db))->sweep();
        } catch (\Throwable $e) {
            error_log('[ActiveWorkflow] sweep failed: ' . $e->getMessage());
        }
    }

    private function found(int $u, array $request): array
    {
        $id = (int) ($request['params']['id'] ?? 0);
        return $this->store->get($u, $id) ?? throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
    }

    private function body(array $request): array
    {
        $b = $request['body'] ?? [];
        return is_array($b) ? $b : [];
    }

    /** Authentication, then the action; a CodeComponentError becomes {success:false, error, kind, status_code[, data]}. */
    private function guard(array $request, \Closure $action): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'kind' => 'auth', 'status_code' => 401];
        }
        try {
            return $action($userId);
        } catch (CodeComponentError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status]
                + ($e->data !== [] ? ['data' => $e->data] : []);
        }
    }
}
