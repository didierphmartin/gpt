<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * File-based rendezvous between a workflow run (PHP/SSE) and the
 * browser-side Pyodide dispatcher.
 *
 * When the runner detects a `run_skill_script` tool call, it emits an
 * SSE event with a generated tool_call_id and then blocks on
 * awaitResult(). The browser runs the script, POSTs the result to
 * /api/v1/workflows/tool-result, the controller calls writeResult(),
 * the runner picks it up and continues.
 *
 * Single-user, single-worker ergonomics — no DB, just /tmp files.
 * Polls every 100ms with a configurable timeout; default 5 minutes
 * matches the chat dispatcher's outer envelope.
 *
 * Tool-call ids are 32-char random hex (~128 bits) so a forged POST
 * to the result endpoint can't collide with a real pending call.
 */
final class SkillToolBridge
{
    private const POLL_INTERVAL_US = 100_000;     // 100 ms
    private const DEFAULT_TIMEOUT_MS = 300_000;   // 5 min

    public static function generateToolCallId(): string
    {
        return bin2hex(random_bytes(16));
    }

    /**
     * Block until the browser writes a result file for $toolCallId, or
     * the timeout expires. Returns the decoded result array on success,
     * null on timeout.
     */
    public function awaitResult(string $toolCallId, int $timeoutMs = self::DEFAULT_TIMEOUT_MS): ?array
    {
        $path = self::resultPath($toolCallId);
        $deadline = microtime(true) + ($timeoutMs / 1000);
        while (microtime(true) < $deadline) {
            if (is_file($path)) {
                $raw = @file_get_contents($path);
                @unlink($path);
                if ($raw === false) return null;
                $decoded = json_decode($raw, true);
                return is_array($decoded) ? $decoded : null;
            }
            usleep(self::POLL_INTERVAL_US);
        }
        return null;
    }

    /**
     * Write the browser's result for $toolCallId. Idempotent: if the
     * file already exists (browser POSTed twice for the same call),
     * the latest write wins.
     */
    public function writeResult(string $toolCallId, array $result): void
    {
        $dir = self::dir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        $path = self::resultPath($toolCallId);
        $tmp = $path . '.' . bin2hex(random_bytes(4));
        @file_put_contents($tmp, json_encode($result, JSON_UNESCAPED_SLASHES));
        @rename($tmp, $path);
    }

    private static function dir(): string
    {
        return sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'synergy-workflow-tool';
    }

    private static function resultPath(string $toolCallId): string
    {
        // Hex-only IDs by construction; reject anything else defensively
        // in case the controller ever forwards a forged value.
        $safe = preg_replace('/[^a-f0-9]/i', '', $toolCallId);
        return self::dir() . DIRECTORY_SEPARATOR . $safe . '.result';
    }
}
