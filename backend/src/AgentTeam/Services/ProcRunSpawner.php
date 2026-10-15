<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The event worker's children (spec 2026-10-14 event-worker §3): `bin/run-schedule.php <id>` per event run, killed
 * past $runLimitS, and the scheduler tick (`scheduler/run-scheduled-workflows.php`), one at a time. Children's
 * output goes to the worker's own stdout/stderr (the launchd log).
 */
final class ProcRunSpawner implements RunSpawner
{
    /** @var array<int, array{proc: resource|null, started: float}> */
    private array $runs = [];
    /** @var resource|null */
    private $tick = null;
    private \Closure $log;

    public function __construct(private string $php, private string $backendDir, private int $runLimitS = 1800, ?\Closure $log = null)
    {
        $this->log = $log ?? static fn(string $line) => null;
    }

    public function start(int $key, int $scheduleId): void
    {
        if (isset($this->runs[$key])) {
            ($this->log)("run for user {$key} is still in flight: schedule {$scheduleId} not started");
            return;
        }
        $proc = proc_open([$this->php, $this->backendDir . '/bin/run-schedule.php', (string) $scheduleId],
            [0 => ['file', '/dev/null', 'r'], 1 => STDOUT, 2 => STDERR], $pipes, $this->backendDir);
        if (!is_resource($proc)) {
            ($this->log)("run for user {$key} (schedule {$scheduleId}) could not start");
            $this->runs[$key] = ['proc' => null, 'started' => microtime(true)];
            return;
        }
        $this->runs[$key] = ['proc' => $proc, 'started' => microtime(true)];
    }

    public function done(): array
    {
        $out = [];
        foreach ($this->runs as $key => $r) {
            if ($r['proc'] === null) {
                $out[$key] = 127;
                unset($this->runs[$key]);
                continue;
            }
            $st = proc_get_status($r['proc']);
            if ($st['running'] && microtime(true) - $r['started'] > $this->runLimitS) {
                ($this->log)("run for user {$key} passed {$this->runLimitS} s: killed");
                proc_terminate($r['proc'], 9);
                $st = ['running' => false, 'exitcode' => 137];
            }
            if (!$st['running']) {
                $out[$key] = (int) $st['exitcode'];
                proc_close($r['proc']);
                unset($this->runs[$key]);
            }
        }
        return $out;
    }

    public function scheduleTick(): void
    {
        if ($this->tick !== null && proc_get_status($this->tick)['running']) {
            return;   // the previous minute's tick still runs
        }
        if ($this->tick !== null) {
            proc_close($this->tick);
        }
        $proc = proc_open([$this->php, $this->backendDir . '/scheduler/run-scheduled-workflows.php'],
            [0 => ['file', '/dev/null', 'r'], 1 => STDOUT, 2 => STDERR], $pipes, $this->backendDir);
        $this->tick = is_resource($proc) ? $proc : null;
    }

    /** SIGTERM: let the children finish up to $graceS, then kill them. */
    public function stopAll(int $graceS): void
    {
        $end = microtime(true) + $graceS;
        while ($this->runs && microtime(true) < $end) {
            $this->done();
            usleep(200000);
        }
        foreach ($this->runs as $r) {
            if ($r['proc'] !== null) {
                proc_terminate($r['proc'], 9);
            }
        }
    }
}
