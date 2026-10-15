<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * What the live overlay has not shown yet of a workflow's runs (spec 2026-10-15 live-overlay §3.2). The cursor is
 * "<runId>:<complete lines read>". On a first connect only a run in progress is replayed (finished runs are in
 * Conversations); a run the pointer names that is not the cursor's is read from its first line.
 */
final class LiveFeed
{
    /** @return array{events: list<array>, cursor: ?string} */
    public static function next(WorkflowRunLog $log, int $workflowId, ?string $cursor): array
    {
        [$curRun, $curLines] = self::parse($cursor);
        $runId = $log->current($workflowId);
        $raw = $runId === null ? false : @file_get_contents($log->pathFor($runId));
        if ($raw === false) {
            return ['events' => [], 'cursor' => $cursor];
        }
        $complete = substr($raw, 0, (int) strrpos("\n" . $raw, "\n"));   // whole lines only: the runner may be mid-append
        $events = [];
        foreach ($complete === '' ? [] : explode("\n", rtrim($complete, "\n")) as $line) {
            $e = json_decode($line, true);
            $events[] = is_array($e) ? $e : ['type' => 'unreadable'];
        }
        $count = count($events);
        $next = $runId . ':' . $count;
        if ($curRun === $runId) {
            return ['events' => array_slice($events, $curLines), 'cursor' => $next];
        }
        if ($curRun === null && self::finished($events)) {
            return ['events' => [], 'cursor' => $next];
        }
        return ['events' => $events, 'cursor' => $next];
    }

    private static function finished(array $events): bool
    {
        foreach ($events as $e) {
            if (in_array($e['type'] ?? null, ['workflow_complete', 'workflow_error'], true)) {
                return true;
            }
        }
        return false;
    }

    /** @return array{0: ?string, 1: int} */
    private static function parse(?string $cursor): array
    {
        if ($cursor !== null && preg_match('/^([a-f0-9]{32}):(\d+)$/', $cursor, $m)) {
            return [$m[1], (int) $m[2]];
        }
        return [null, 0];
    }
}
