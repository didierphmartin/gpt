<?php
/**
 * One event's runs (spec 2026-10-14 event-worker §3): the event worker starts this for a `ready`. Runs the workflow
 * of the event row <id> with the drain rule, records last_run, prints one JSON line. Exit 0 ok, 1 failed.
 *   php backend/bin/run-schedule.php <schedule id>
 */
declare(strict_types=1);

use AgentTeam\Services\ScheduleTick;

$out = static function (array $line, int $code): never {
    echo json_encode($line, JSON_UNESCAPED_SLASHES), "\n";
    exit($code);
};

try {
    $boot = require __DIR__ . '/../scheduler/bootstrap.php';
    $id = (int) ($argv[1] ?? 0);
    $schedule = $boot['schedules']->findById($id);
    if (!$schedule || ($schedule['repeat_type'] ?? '') !== 'event') {
        $out(['ok' => false, 'error' => "schedule #{$id} is not an event schedule"], 1);
    }
    $r = ScheduleTick::drain(fn() => ($boot['runSchedule'])($schedule));
    $boot['schedules']->markCompleted($id);   // last_run; an event row keeps no next_run
    $out(['ok' => true] + $r, 0);
} catch (\Throwable $e) {
    $out(['ok' => false, 'error' => $e->getMessage()], 1);
}
