<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Per-run append-only event log. One JSONL file per workflow run, written
 * as events are emitted, so a run is debuggable after it ends, dies, loops,
 * or its SSE stream drops. Read back by the node form via the events endpoint.
 */
class WorkflowRunLog
{
    private string $baseDir;

    public function __construct(string $baseDir)
    {
        $this->baseDir = rtrim($baseDir, '/');
    }

    public static function defaultDir(array $config = []): string
    {
        // __DIR__ = backend/src/AgentTeam/Services ; dirname(...,3) = backend
        return $config['workflow_runs_dir'] ?? (dirname(__DIR__, 3) . '/storage/workflow-runs');
    }

    public function pathFor(string $runId): string
    {
        return $this->baseDir . '/' . $runId . '.jsonl';
    }

    private function isValidRunId(string $runId): bool
    {
        return (bool) preg_match('/^[a-f0-9]{32}$/', $runId);
    }

    public function append(string $runId, array $event): void
    {
        if (!$this->isValidRunId($runId)) {
            error_log("[WorkflowRunLog] refusing append for invalid runId");
            return;
        }
        try {
            if (!is_dir($this->baseDir)) {
                @mkdir($this->baseDir, 0775, true);
            }
            $line = json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($line === false) {
                error_log("[WorkflowRunLog] json_encode failed for runId={$runId}");
                return;
            }
            $bytes = @file_put_contents($this->pathFor($runId), $line . "\n", FILE_APPEND | LOCK_EX);
            if ($bytes === false) {
                error_log("[WorkflowRunLog] write failed for runId={$runId}");
            }
        } catch (\Throwable $e) {
            error_log("[WorkflowRunLog] append failed for runId={$runId}: " . $e->getMessage());
        }
    }

    public function read(string $runId): ?array
    {
        if (!$this->isValidRunId($runId)) {
            return null;
        }
        $path = $this->pathFor($runId);
        if (!is_file($path)) {
            return null;
        }
        $events = [];
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $decoded = json_decode($line, true);
            if (is_array($decoded)) {
                $events[] = $decoded;
            }
        }
        return $events;
    }
}
