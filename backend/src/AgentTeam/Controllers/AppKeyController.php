<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\AppKeyRepository;
use PDO;

/**
 * App Key Controller
 *
 * Manages app keys — scoped, revocable credentials for client code that
 * calls the backend without a user's login JWT.
 *
 * Endpoints:
 *   POST   /api/v1/app-keys           create  (admin only)
 *   GET    /api/v1/app-keys           index   (admin only)
 *   DELETE /api/v1/app-keys/{id}      destroy (admin only)
 *   GET    /api/v1/app-keys/whoami    whoami  (app-key auth — introspection)
 *
 * CRUD is admin-only: only a user with role='admin' may mint, list, or
 * revoke keys. `whoami` is the lone endpoint an app key itself may call —
 * it lets client code confirm what its key authorizes.
 */
class AppKeyController
{
    private PDO $db;
    private array $config;
    private AppKeyRepository $repo;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->repo = new AppKeyRepository(
            $db,
            (string) ($config['auth']['app_key_secret'] ?? '')
        );
    }

    /**
     * POST /api/v1/app-keys
     * Body: { user_id, application_id, name, scopes: string[] }
     */
    public function create(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }

        $body = $request['body'] ?? [];
        $userId        = isset($body['user_id']) ? (int) $body['user_id'] : 0;
        $applicationId = trim((string) ($body['application_id'] ?? ''));
        $name          = trim((string) ($body['name'] ?? ''));
        $scopes        = $body['scopes'] ?? null;

        if ($userId <= 0) {
            return $this->err('user_id is required', 400);
        }
        if ($applicationId === '') {
            return $this->err('application_id is required', 400);
        }
        if ($name === '') {
            return $this->err('name is required', 400);
        }
        if (!is_array($scopes) || count($scopes) === 0) {
            return $this->err('scopes must be a non-empty array of strings', 400);
        }
        foreach ($scopes as $s) {
            if (!is_string($s) || trim($s) === '') {
                return $this->err('every scope must be a non-empty string', 400);
            }
        }

        // The user the key acts for must exist.
        $stmt = $this->db->prepare("SELECT id FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$userId]);
        if (!$stmt->fetch(PDO::FETCH_ASSOC)) {
            return $this->err("user_id {$userId} does not exist", 400);
        }

        $created = $this->repo->create($userId, $applicationId, $name, array_map('trim', $scopes));

        return [
            'success' => true,
            'data' => $created,   // includes full_key — visible ONCE
            'status_code' => 201,
        ];
    }

    /**
     * GET /api/v1/app-keys[?application_id=&user_id=]
     */
    public function index(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }

        $query = $request['query'] ?? [];
        $applicationId = isset($query['application_id']) && $query['application_id'] !== ''
            ? (string) $query['application_id'] : null;
        $userId = isset($query['user_id']) && $query['user_id'] !== ''
            ? (int) $query['user_id'] : null;

        return [
            'success' => true,
            'data' => $this->repo->listAll($applicationId, $userId),
            'status_code' => 200,
        ];
    }

    /**
     * DELETE /api/v1/app-keys/{id}
     */
    public function destroy(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }

        $keyId = (int) ($request['params']['id'] ?? 0);
        if ($keyId <= 0) {
            return $this->err('Invalid key id', 400);
        }
        if (!$this->repo->findById($keyId)) {
            return $this->err('App key not found', 404);
        }

        $revoked = $this->repo->revoke($keyId);
        return [
            'success' => true,
            'data' => ['id' => $keyId, 'revoked' => $revoked],
            'status_code' => 200,
        ];
    }

    /**
     * GET /api/v1/app-keys/workflows?user_id=N
     * Admin-only. Lists a given user's workflows (id + name) so the admin
     * UI can offer a pick-by-name workflow selector when minting a key —
     * the admin never has to know or type a raw workflow id. Each picked
     * workflow becomes a `workflows:run:<id>` scope.
     */
    public function listUserWorkflows(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }
        $userId = (int) ($request['query']['user_id'] ?? 0);
        if ($userId <= 0) {
            return $this->err('user_id query parameter is required', 400);
        }
        $stmt = $this->db->prepare(
            "SELECT id, name FROM agent_workflows WHERE user_id = ? ORDER BY name ASC"
        );
        $stmt->execute([$userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        return [
            'success' => true,
            'data' => array_map(
                fn($r) => ['id' => (int) $r['id'], 'name' => (string) $r['name']],
                $rows
            ),
            'status_code' => 200,
        ];
    }

    /**
     * GET /api/v1/app-keys/agents?user_id=N
     * Admin-only. Lists a given user's agents (id + name) so the admin UI
     * can offer a pick-by-name agent selector when minting a key. Each
     * picked agent becomes an `agents:run:<id>` scope.
     */
    public function listUserAgents(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }
        $userId = (int) ($request['query']['user_id'] ?? 0);
        if ($userId <= 0) {
            return $this->err('user_id query parameter is required', 400);
        }
        $stmt = $this->db->prepare(
            "SELECT id, name FROM agents WHERE user_id = ? ORDER BY name ASC"
        );
        $stmt->execute([$userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        return [
            'success' => true,
            'data' => array_map(
                fn($r) => ['id' => (int) $r['id'], 'name' => (string) $r['name']],
                $rows
            ),
            'status_code' => 200,
        ];
    }

    /**
     * GET /api/v1/app-keys/whoami
     * App-key-authed. Lets client code introspect its own key. No user info.
     *
     * Besides the raw scopes, this resolves the human-readable names of the
     * workflows/agents the key is scoped to (`workflows`/`agents` arrays of
     * {id, name}). That lets a client address a workflow by name instead of
     * hard-coding a numeric id — it looks the name up here, then calls
     * /workflows/{id}/run with the resolved id. Revealing names the key is
     * already authorized for leaks nothing new.
     */
    public function whoami(array $request): array
    {
        if (($request['auth_type'] ?? null) !== 'app_key') {
            return $this->err('This endpoint requires app-key authentication', 401);
        }

        $scopes = $request['app_key_scopes'] ?? [];

        // Pull the resource ids out of `workflows:run:<id>` / `agents:run:<id>`.
        $workflowIds = [];
        $agentIds    = [];
        foreach ($scopes as $scope) {
            if (preg_match('/^workflows:run:(\d+)$/', (string) $scope, $m)) {
                $workflowIds[] = (int) $m[1];
            } elseif (preg_match('/^agents:run:(\d+)$/', (string) $scope, $m)) {
                $agentIds[] = (int) $m[1];
            }
        }

        return [
            'success' => true,
            'data' => [
                'application_id' => $request['application_id'] ?? null,
                'scopes' => $scopes,
                'workflows' => $this->resolveNames('agent_workflows', $workflowIds),
                'agents' => $this->resolveNames('agents', $agentIds),
            ],
            'status_code' => 200,
        ];
    }

    /**
     * Resolve a set of resource ids to [{id, name}], skipping any that no
     * longer exist. $table is a trusted internal literal, never user input.
     */
    private function resolveNames(string $table, array $ids): array
    {
        $ids = array_values(array_unique(array_filter($ids, fn($i) => $i > 0)));
        if (count($ids) === 0) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->db->prepare(
            "SELECT id, name FROM {$table} WHERE id IN ({$placeholders}) ORDER BY name ASC"
        );
        $stmt->execute($ids);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        return array_map(
            fn($r) => ['id' => (int) $r['id'], 'name' => (string) $r['name']],
            $rows
        );
    }

    /**
     * Gate: caller must be a logged-in user with role='admin'.
     * Mirrors SystemSettingsController::requireAdmin().
     */
    private function requireAdmin(array $request): ?array
    {
        // App keys can never reach the admin CRUD — only JWT users can.
        if (($request['auth_type'] ?? null) === 'app_key') {
            return $this->err('App keys cannot manage app keys', 403);
        }
        $userId = $request['user_id'] ?? null;
        if (!$userId) {
            return $this->err('Authentication required', 401);
        }
        $stmt = $this->db->prepare("SELECT role FROM users WHERE id = :user_id");
        $stmt->execute([':user_id' => $userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || $user['role'] !== 'admin') {
            return $this->err('Admin access required', 403);
        }
        return null;
    }

    private function err(string $message, int $code): array
    {
        return ['success' => false, 'error' => $message, 'status_code' => $code];
    }
}
