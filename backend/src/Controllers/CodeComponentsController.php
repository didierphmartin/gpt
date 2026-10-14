<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/** /api/v1/code-components — the code components collection (CRUD + used-by), over CodeComponentStore. */
final class CodeComponentsController
{
    private CodeComponentStore $store;

    public function __construct(PDO $db, array $config)
    {
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

    /** Authentication, then the action; a CodeComponentError becomes {success:false, error, kind, status_code}. */
    private function guard(array $request, \Closure $action): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'kind' => 'auth', 'status_code' => 401];
        }
        try {
            return $action($userId);
        } catch (CodeComponentError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }
    }
}
