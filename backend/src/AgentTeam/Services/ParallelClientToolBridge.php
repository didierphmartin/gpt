<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/** Round-trips a browser-side (Pyodide) tool call. Graph supplies this; delegation passes null. */
interface ParallelClientToolBridge
{
    public function isClientSideTool(string $name): bool;
    /** Dispatch the tool call to the browser (non-blocking). */
    public function emit(array $toolCall, string $key, string $assistantText): void;
    /** Block until the browser posts the result back. */
    public function await(array $toolCall, string $key): string;
}
