<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** The event worker's child processes (spec 2026-10-14 event-worker §3): an event's runs, and the scheduler tick. */
interface RunSpawner
{
    /** Start `bin/run-schedule.php <scheduleId>` for key (a user id). */
    public function start(int $key, int $scheduleId): void;

    /** @return array<int, int> key => exit code, for the runs that ended since the last call */
    public function done(): array;

    /** Start the scheduler tick for the active schedule-mode workflows, unless the previous one still runs. */
    public function scheduleTick(): void;
}
