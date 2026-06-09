<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\UserMemoryEventsRepository;
use AgentTeam\Services\UserMemoryRepository;
use AgentTeam\Services\UserMemorySettingsRepository;
use PDO;

/**
 * User Memory Controller
 *
 * Endpoints:
 * - GET    /api/v1/user-memories                           → both scopes + budgets + auto-update settings
 * - PUT    /api/v1/user-memories                           → update one or both scopes + optional settings
 * - GET    /api/v1/user-memories/events                    → recent audit events
 * - DELETE /api/v1/user-memories/events/{id}               → remove an audit entry (undoing its change first if not already undone)
 */
class UserMemoryController
{
    private PDO $db;
    private array $config;
    private UserMemoryRepository $repository;
    private UserMemoryEventsRepository $events;
    private UserMemorySettingsRepository $settings;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->repository = new UserMemoryRepository($db);
        $this->events = new UserMemoryEventsRepository($db);
        $this->settings = new UserMemorySettingsRepository($db);
    }

    public function show(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        $both = $this->repository->getBoth($userId);
        $settings = $this->settings->get($userId);

        return [
            'success' => true,
            'data' => [
                'memory' => [
                    'content' => $both[UserMemoryRepository::SCOPE_MEMORY],
                    'budget' => UserMemoryRepository::BUDGET_MEMORY,
                    'last_source' => $this->events->lastSource($userId, UserMemoryRepository::SCOPE_MEMORY),
                ],
                'user' => [
                    'content' => $both[UserMemoryRepository::SCOPE_USER],
                    'budget' => UserMemoryRepository::BUDGET_USER,
                    'last_source' => $this->events->lastSource($userId, UserMemoryRepository::SCOPE_USER),
                ],
                'auto_update' => [
                    'enabled' => $settings['enabled'],
                    'model' => $settings['model'],
                    'allowed_models' => UserMemorySettingsRepository::ALLOWED_MODELS,
                ],
            ],
        ];
    }

    public function update(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        $body = $request['body'] ?? [];
        $written = [];

        foreach ([UserMemoryRepository::SCOPE_MEMORY, UserMemoryRepository::SCOPE_USER] as $scope) {
            if (array_key_exists($scope, $body)) {
                $before = $this->repository->get($userId, $scope);
                $after = (string) $body[$scope];
                $this->repository->set($userId, $scope, $after);
                $this->events->log(
                    $userId,
                    $scope,
                    UserMemoryEventsRepository::SOURCE_MANUAL,
                    $before,
                    $after,
                    null,
                    null
                );
                $written[] = $scope;
            }
        }

        if (array_key_exists('auto_update', $body) && is_array($body['auto_update'])) {
            $current = $this->settings->get($userId);
            $enabled = array_key_exists('enabled', $body['auto_update'])
                ? (bool) $body['auto_update']['enabled']
                : $current['enabled'];
            $model = array_key_exists('model', $body['auto_update'])
                ? (string) $body['auto_update']['model']
                : $current['model'];

            try {
                $this->settings->set($userId, $enabled, $model);
                $written[] = 'auto_update';
            } catch (\InvalidArgumentException $e) {
                return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
            }
        }

        if (empty($written)) {
            return ['success' => false, 'error' => 'Nothing to update — provide "memory", "user", or "auto_update"', 'status_code' => 400];
        }

        return ['success' => true, 'data' => ['updated' => $written]];
    }

    public function listEvents(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        $limit = (int) ($request['query']['limit'] ?? 50);
        $rows = $this->events->list($userId, $limit);

        return [
            'success' => true,
            'data' => array_map(fn($e) => [
                'id' => (int) $e['id'],
                'scope' => $e['scope'],
                'source' => $e['source'],
                'before' => $e['before_content'],
                'after' => $e['after_content'],
                'rationale' => $e['rationale'],
                'session_id' => $e['session_id'],
                'created_at' => $e['created_at'],
            ], $rows),
        ];
    }

    /**
     * Universal "remove this audit entry" action.
     *
     * For a normal entry (source = manual / auto_extract / compact) the
     * change it records is first undone — memory is restored to the
     * event's before_content — then the audit row is removed. This
     * keeps the audit log and the live memory in sync: you can't have
     * a "we changed X" row without the change still being applied.
     *
     * For a SOURCE_REVERT row (legacy data from before the revert
     * path was changed to delete-in-place), the change was already
     * undone at the time the revert was triggered, so there's no
     * state to restore — we just remove the row.
     */
    public function deleteEvent(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        $eventId = (int) ($request['params']['id'] ?? 0);
        if (!$eventId) {
            return ['success' => false, 'error' => 'Invalid event id', 'status_code' => 400];
        }

        $event = $this->events->get($userId, $eventId);
        if (!$event) {
            return ['success' => false, 'error' => 'Event not found', 'status_code' => 404];
        }

        $scope = $event['scope'];
        $reverted = false;
        if ($event['source'] !== UserMemoryEventsRepository::SOURCE_REVERT) {
            $this->repository->set($userId, $scope, (string) $event['before_content']);
            $reverted = true;
        }

        $deleted = $this->events->delete($userId, $eventId);

        return [
            'success' => true,
            'data' => [
                'deleted_event' => $eventId,
                'scope' => $scope,
                'reverted' => $reverted,
                'deleted' => $deleted,
            ],
        ];
    }
}
