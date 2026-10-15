<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * One connection of the live overlay (spec 2026-10-15 live-overlay §3.3): every 0.5 s the run events after the
 * cursor, the active row every 5 s, a ping every 15 s, then "bye" with the cursor the client reconnects from.
 * Clock, sleep and output are injected so the loop is testable.
 */
final class LiveStream
{
    public static function run(callable $next, callable $state, callable $emit, callable $sleep, callable $now,
        callable $aborted, ?string $cursor, float $maxSeconds = 50.0): ?string
    {
        $start = $now();
        $stateAt = null;
        $pingAt = $start;
        while ($now() - $start < $maxSeconds) {
            if ($aborted()) {
                return $cursor;
            }
            $r = $next($cursor);
            foreach ($r['events'] as $e) {
                $emit('run', ['cursor' => $r['cursor'], 'event' => $e]);
            }
            $cursor = $r['cursor'];
            if ($stateAt === null || $now() - $stateAt >= 5.0) {
                $emit('state', ['active' => $state()]);
                $stateAt = $now();
            }
            if ($now() - $pingAt >= 15.0) {
                $emit('ping', []);
                $pingAt = $now();
            }
            $sleep(0.5);
        }
        $emit('bye', ['cursor' => $cursor]);
        return $cursor;
    }
}
