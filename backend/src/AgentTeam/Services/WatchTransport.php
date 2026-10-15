<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** The event worker's long-polls (spec 2026-10-14 event-worker §3): one open request per key (a user id). */
interface WatchTransport
{
    /** @param string[] $headers header lines */
    public function start(int $key, string $url, array $headers, string $body): void;

    public function cancel(int $key): void;

    /** @return array<int, array{0: string|false, 1: int, 2: string}> the requests that finished since the last call */
    public function done(): array;
}
