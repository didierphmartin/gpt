<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Orchestrates the post-turn memory auto-update:
 *   skip cheap cases → extract → merge per scope → compact if over budget → write + event row.
 *
 * Designed to be called after fastcgi_finish_request() so the user never
 * waits on the extractor call. Any failure is swallowed and logged — the
 * assistant's response has already been delivered.
 */
class MemoryAutoUpdater
{
    public const MIN_USER_MSG_CHARS = 20;

    private PDO $db;
    private string $apiKey;
    private UserMemoryRepository $memoryRepo;
    private UserMemoryEventsRepository $eventsRepo;
    private UserMemorySettingsRepository $settingsRepo;

    public function __construct(PDO $db, string $apiKey)
    {
        $this->db = $db;
        $this->apiKey = $apiKey;
        $this->memoryRepo = new UserMemoryRepository($db);
        $this->eventsRepo = new UserMemoryEventsRepository($db);
        $this->settingsRepo = new UserMemorySettingsRepository($db);
    }

    /**
     * Run the auto-update flow for one chat turn. Returns an array describing
     * what happened (for tests/debug) or null if short-circuited.
     */
    public function run(int $userId, string $sessionId, string $lastUserMsg, string $lastAssistantMsg): ?array
    {
        if ($userId <= 0 || $this->apiKey === '') {
            return null;
        }
        if (mb_strlen(trim($lastUserMsg)) < self::MIN_USER_MSG_CHARS) {
            return null;
        }

        $settings = $this->settingsRepo->get($userId);
        if (!$settings['enabled']) {
            return null;
        }

        $current = $this->memoryRepo->getBoth($userId);
        $currentMemory = $current[UserMemoryRepository::SCOPE_MEMORY];
        $currentUser = $current[UserMemoryRepository::SCOPE_USER];

        $extractor = new MemoryExtractor($this->apiKey);
        $result = $extractor->extract(
            $settings['model'],
            $currentMemory,
            $currentUser,
            $lastUserMsg,
            $lastAssistantMsg
        );

        if ($result === null) {
            return null;
        }

        $written = [];

        // Second-stage guard: filter paraphrased/implied duplicates against current content.
        // Only runs when there are candidates, so no overhead on the common empty case.
        $memoryAdditions = !empty($result['memory_additions'])
            ? $extractor->filterDuplicates($settings['model'], $currentMemory, $result['memory_additions'])
            : [];
        $userAdditions = !empty($result['user_additions'])
            ? $extractor->filterDuplicates($settings['model'], $currentUser, $result['user_additions'])
            : [];

        if (!empty($memoryAdditions)) {
            $this->applyScope(
                $userId,
                UserMemoryRepository::SCOPE_MEMORY,
                $currentMemory,
                $memoryAdditions,
                $result['reason'],
                $sessionId,
                $settings['model'],
                $extractor,
                $written
            );
        }

        if (!empty($userAdditions)) {
            $this->applyScope(
                $userId,
                UserMemoryRepository::SCOPE_USER,
                $currentUser,
                $userAdditions,
                $result['reason'],
                $sessionId,
                $settings['model'],
                $extractor,
                $written
            );
        }

        return [
            'reason' => $result['reason'],
            'written' => $written,
        ];
    }

    private function applyScope(
        int $userId,
        string $scope,
        string $current,
        array $additions,
        string $reason,
        string $sessionId,
        string $model,
        MemoryExtractor $extractor,
        array &$written
    ): void {
        $budget = $this->memoryRepo->budgetFor($scope);
        $candidate = $this->memoryRepo->buildMerged($current, $additions);

        if ($candidate === $current) {
            return; // all additions dedup'd away
        }

        if (mb_strlen($candidate) <= $budget) {
            $this->memoryRepo->set($userId, $scope, $candidate);
            $this->eventsRepo->log(
                $userId,
                $scope,
                UserMemoryEventsRepository::SOURCE_AUTO_EXTRACT,
                $current,
                $candidate,
                $reason,
                $sessionId
            );
            $written[] = $scope;
            return;
        }

        // Over budget — ask the model to compact, preserving the new additions verbatim.
        $compacted = $extractor->compact($model, $candidate, $budget, $additions);
        if ($compacted === null || $compacted === '') {
            error_log("[MemoryAutoUpdater] compact returned empty for user={$userId} scope={$scope}; skipping write");
            return;
        }

        $this->memoryRepo->set($userId, $scope, $compacted);
        $this->eventsRepo->log(
            $userId,
            $scope,
            UserMemoryEventsRepository::SOURCE_COMPACT,
            $current,
            $compacted,
            $reason,
            $sessionId
        );
        $written[] = $scope;
    }
}
