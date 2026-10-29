<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** The event worker's long-polls (spec 2026-10-14 event-worker §3): one open request per key (an active row's "{user}:{workflow}"). */
interface WatchTransport
{
    /** @param string[] $headers header lines */
    public function start(string $key, string $url, array $headers, string $body): void;

    public function cancel(string $key): void;

    /** @return array<string, array{0: string|false, 1: int, 2: string}> the requests that finished since the last call */
    public function done(): array;
}
