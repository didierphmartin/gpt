<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Pure formatters for per-node processing-log lines (the node_log event's
 * `message`). Kept separate so both executors emit identical wording and the
 * strings are unit-testable without constructing the runner.
 */
final class NodeLogFormat
{
    public static function callingProvider(string $provider, ?string $model): string
    {
        return ($model !== null && $model !== '')
            ? "calling {$provider} ({$model})"
            : "calling {$provider}";
    }

    public static function modelRequestedTool(string $tool): string
    {
        return "model requested {$tool}";
    }

    public static function modelRespondedText(): string
    {
        return 'model responded with text';
    }

    public static function runningSkill(string $dir): string
    {
        return "running skill {$dir}";
    }

    public static function skillFinished(?int $exitCode, ?int $bytes): string
    {
        $exit = $exitCode === null ? 'unknown' : (string) $exitCode;
        return "skill finished (exit {$exit}, " . (int) $bytes . ' bytes)';
    }

    public static function skillTimedOut(int $seconds): string
    {
        return "skill timed out after {$seconds}s";
    }

    public static function completed(int $tokens, ?float $costUsd): string
    {
        return $costUsd !== null
            ? sprintf('completed (%d tok, $%.4f)', $tokens, $costUsd)
            : sprintf('completed (%d tok)', $tokens);
    }

    public static function httpError(int $httpCode, string $message): string
    {
        return "HTTP {$httpCode} — {$message}";
    }
}
