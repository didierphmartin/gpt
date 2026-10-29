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
    /** @var array<string, array{proc: resource|null, started: float}> */
    private array $runs = [];
    /** @var resource|null */
    private $tick = null;
    private float $tickStarted = 0.0;
    private \Closure $log;

    public function __construct(private string $php, private string $backendDir, private int $runLimitS = 1800, ?\Closure $log = null)
    {
        $this->log = $log ?? static fn(string $line) => null;
    }

    public function start(string $key, int $scheduleId): void
    {
        if (isset($this->runs[$key])) {
            ($this->log)("run {$key} is still in flight: schedule {$scheduleId} not started");
            throw new \RuntimeException("a run {$key} is still in flight");
        }
        $proc = proc_open([$this->php, $this->backendDir . '/bin/run-schedule.php', (string) $scheduleId],
            [0 => ['file', '/dev/null', 'r'], 1 => STDOUT, 2 => STDERR], $pipes, $this->backendDir);
        if (!is_resource($proc)) {
            ($this->log)("run {$key} (schedule {$scheduleId}) could not start");
            $this->runs[$key] = ['proc' => null, 'started' => microtime(true)];
            return;
        }
        $this->runs[$key] = ['proc' => $proc, 'started' => microtime(true)];
    }

    public function done(): array
    {
        $this->reapTick();
        $out = [];
        foreach ($this->runs as $key => $r) {
            if ($r['proc'] === null) {
                $out[$key] = 127;
                unset($this->runs[$key]);
                continue;
            }
            $st = proc_get_status($r['proc']);
            if ($st['running'] && microtime(true) - $r['started'] > $this->runLimitS) {
                ($this->log)("run {$key} passed {$this->runLimitS} s: killed");
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

    /** Close a finished tick; kill one past $runLimitS so a hung tick never blocks the schedule-mode workflows. */
    private function reapTick(): void
    {
        if ($this->tick === null) {
            return;
        }
        if (proc_get_status($this->tick)['running']) {
            if (microtime(true) - $this->tickStarted <= $this->runLimitS) {
                return;
            }
            ($this->log)("scheduler tick passed {$this->runLimitS} s: killed");
            proc_terminate($this->tick, 9);
        }
        proc_close($this->tick);
        $this->tick = null;
    }

    public function scheduleTick(): void
    {
        $this->reapTick();
        if ($this->tick !== null) {
            return;   // the previous minute's tick still runs
        }
        $proc = proc_open([$this->php, $this->backendDir . '/scheduler/run-scheduled-workflows.php'],
            [0 => ['file', '/dev/null', 'r'], 1 => STDOUT, 2 => STDERR], $pipes, $this->backendDir);
        $this->tick = is_resource($proc) ? $proc : null;
        $this->tickStarted = microtime(true);
    }

    /** SIGTERM: let the children finish up to $graceS, then kill them. */
    public function stopAll(int $graceS): void
    {
        $end = microtime(true) + $graceS;
        while (($this->runs || $this->tick !== null) && microtime(true) < $end) {
            $this->done();
            usleep(200000);
        }
        if ($this->tick !== null) {
            proc_terminate($this->tick, 9);
            proc_close($this->tick);
            $this->tick = null;
        }
        foreach ($this->runs as $r) {
            if ($r['proc'] !== null) {
                proc_terminate($r['proc'], 9);
            }
        }
    }
}
