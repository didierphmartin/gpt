<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\RoleStore;
use Quantis\AIPortfolioAssistant\Services\RoleStoreError;

/**
 * Admin API for roles (capabilities are still edited through /admin/packages/{role}).
 *
 *   GET    /api/v1/admin/roles
 *   POST   /api/v1/admin/roles            {role, name, copy_from?}
 *   PUT    /api/v1/admin/roles/{role}     {name}
 *   DELETE /api/v1/admin/roles/{role}
 */
final class RolesController
{
    use RequiresAdmin;

    private PDO $db;
    private RoleStore $store;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->store = new RoleStore($db);
    }

    public function index(array $request): array
    {
        return $this->guard($request, fn() => ['success' => true, 'data' => $this->store->list()]);
    }

    public function create(array $request): array
    {
        return $this->guard($request, function () use ($request) {
            $b = $request['body'] ?? [];
            $copy = $b['copy_from'] ?? null;
            return ['success' => true, 'data' => $this->store->create(
                (string) ($b['role'] ?? ''),
                (string) ($b['name'] ?? ''),
                is_string($copy) ? $copy : null
            )];
        });
    }

    public function rename(array $request): array
    {
        return $this->guard($request, fn() => ['success' => true, 'data' => $this->store->rename(
            $this->key($request),
            (string) (($request['body'] ?? [])['name'] ?? '')
        )]);
    }

    public function destroy(array $request): array
    {
        return $this->guard($request, function () use ($request) {
            $this->store->delete($this->key($request));
            return ['success' => true];
        });
    }

    private function key(array $request): string
    {
        return (string) ($request['params']['role'] ?? '');
    }

    private function guard(array $request, \Closure $action): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }
        try {
            return $action();
        } catch (RoleStoreError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }
    }
}
