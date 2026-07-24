<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use AgentTeam\Models\Agent;

/** Sink for parallel-run lifecycle events. Both callers implement this. */
interface ParallelRunObserver
{
    public function onAgentStart(string $key, Agent $agent, string $input): void;
    public function onAgentComplete(string $key, Agent $agent, bool $success, ?string $output, ?array $usage): void;
    public function log(string $key, string $level, string $phase, string $message): void;
}
