<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError;

/** /api/v1/playbooks — the playbook collection (CRUD + used-by), over PlaybookStore. */
final class PlaybooksController
{
    private PlaybookStore $store;

    public function __construct(PDO $db, array $config)
    {
        $this->store = new PlaybookStore($db);
    }

    public function index(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true, 'data' => $this->store->list($u)]);
    }

    public function show(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $id = (int) ($request['params']['id'] ?? 0);
            $row = $this->store->get($u, $id);
            if ($row === null) throw new PlaybookStoreError('not_found', "Playbook #{$id} not found", 404);
            return ['success' => true, 'data' => $row];
        });
    }

    public function create(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true,
            'data' => $this->store->save($u, null, $this->text($request), $this->key($request))]);
    }

    public function update(array $request): array
    {
        return $this->guard($request, fn(int $u) => ['success' => true,
            'data' => $this->store->save($u, (int) ($request['params']['id'] ?? 0), $this->text($request), $this->key($request))]);
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
        return $this->guard($request, function (int $u) use ($request) {
            $id = (int) ($request['params']['id'] ?? 0);
            if ($this->store->get($u, $id) === null) throw new PlaybookStoreError('not_found', "Playbook #{$id} not found", 404);
            return ['success' => true, 'data' => $this->store->usedBy($u, $id)];
        });
    }

    private function text(array $request): string
    {
        $text = $request['body']['text'] ?? null;
        if (!is_string($text) || trim($text) === '') {
            throw new PlaybookStoreError('invalid_text', 'text is required (the playbook, as written).', 400);
        }
        return $text;
    }

    private function key(array $request): ?string
    {
        $k = $request['body']['pkey'] ?? null;
        return is_string($k) && trim($k) !== '' ? trim($k) : null;
    }

    /** Authentication, then the action; a PlaybookStoreError becomes {success:false, error, kind, status_code}. */
    private function guard(array $request, \Closure $action): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'kind' => 'auth', 'status_code' => 401];
        }
        try {
            return $action($userId);
        } catch (PlaybookStoreError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'kind' => $e->kind, 'status_code' => $e->status];
        }
    }
}
