<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * What the live overlay has not shown yet of a workflow's runs (spec 2026-10-15 live-overlay §3.2). The cursor is
 * "<runId>:<complete lines read>". On a first connect only a run in progress is replayed (finished runs are in
 * Conversations); a run the pointer names that is not the cursor's is read from its first line, once it has shown it
 * is a real run: a quiet poll (ScheduleTick::drain re-runs until a run finds nothing) writes Start and the trigger
 * node, then is unlinked without a workflow_complete, so a run is held back until a work node or its end appears.
 * When the pointer has moved on, what the cursor's run wrote after the cursor is sent first.
 */
final class LiveFeed
{
    /** @return array{events: list<array>, cursor: ?string} */
    public static function next(WorkflowRunLog $log, int $workflowId, ?string $cursor): array
    {
        [$curRun, $curLines] = self::parse($cursor);
        $runId = $log->current($workflowId);
        $tail = [];
        if ($curRun !== null && $curRun !== $runId && ($prev = self::read($log, $curRun)) !== null) {
            $tail = array_slice($prev, $curLines);
            $cursor = $curRun . ':' . max($curLines, count($prev));
        }
        $events = $runId === null ? null : self::read($log, $runId);
        if ($events === null) {
            return ['events' => $tail, 'cursor' => $cursor];
        }
        $next = $runId . ':' . count($events);
        if ($curRun === $runId) {
            return ['events' => array_slice($events, $curLines), 'cursor' => $next];
        }
        if (!self::real($events)) {
            return ['events' => $tail, 'cursor' => $cursor];
        }
        if ($curRun === null && self::finished($events)) {
            return ['events' => [], 'cursor' => $next];
        }
        return ['events' => array_merge($tail, $events), 'cursor' => $next];
    }

    /** @return ?list<array> the run's complete lines, or null when its file is gone */
    private static function read(WorkflowRunLog $log, string $runId): ?array
    {
        $raw = @file_get_contents($log->pathFor($runId));
        if ($raw === false) {
            return null;
        }
        $complete = substr($raw, 0, (int) strrpos("\n" . $raw, "\n"));   // whole lines only: the runner may be mid-append
        $events = [];
        foreach ($complete === '' ? [] : explode("\n", rtrim($complete, "\n")) as $line) {
            $e = json_decode($line, true);
            $events[] = is_array($e) ? $e : ['type' => 'unreadable'];
        }
        return $events;
    }

    /** A work node ran (not Start, not the Start option's trigger node) or the run ended. */
    private static function real(array $events): bool
    {
        foreach ($events as $e) {
            if (in_array($e['type'] ?? null, ['node_start', 'node_complete'], true)
                && ($e['node_type'] ?? null) !== 'start'
                && is_numeric($e['node_id'] ?? null) && (int) $e['node_id'] < StartOptionGraph::ID_OFFSET) {
                return true;
            }
        }
        return self::finished($events);
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
