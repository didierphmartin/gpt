<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The event worker's logic (spec 2026-10-14 event-worker §3), without I/O of its own: every RECONCILE_S it reads
 * the active workflows; for each option-mode one it holds a wait on the option's waiting tool, starts a run on
 * `ready`, waits again when the run ends, and backs off on errors and failed runs; once a minute, while one of them
 * is in schedule mode, it starts the scheduler tick for the schedule-mode ones. One slot per active row, keyed
 * "{user}:{workflow}" (a person has one row, the robot one per workflow). State goes to active_workflows.
 */
final class EventWorker
{
    public const RECONCILE_S = 5;
    public const BACKOFF_MIN_S = 30;
    public const BACKOFF_MAX_S = 300;
    public const HEARTBEAT_S = 30;
    public const SCHEDULE_TICK_S = 60;
    public const LOG_REPEAT_S = 60;

    /** @var array<string, array> row key "{user}:{workflow}" => slot */
    private array $slots = [];
    private float $lastReconcile = -INF;
    private float $lastTick = -INF;
    private int $requestId = 0;
    /** @var array<string, array> row key => [workflow_id, schedule_id] of a run that failed while its slot was flagged for rebuild */
    private array $carry = [];
    /** @var array<string, float> logged line => when, for the once-a-minute limit */
    private array $logged = [];

    /** $log(string $line): where swallowed errors go (each distinct line at most once a minute); null drops them. */
    public function __construct(
        private ActiveWorkflowService $active,
        private \Closure $serverFor,
        private WatchTransport $transport,
        private RunSpawner $runs,
        private \Closure $now,
        private ?\Closure $log = null,
    ) {
    }

    public function step(): void
    {
        $now = ($this->now)();
        if ($now - $this->lastReconcile >= self::RECONCILE_S) {
            try {
                $this->reconcile();
                $this->lastReconcile = $now;
            } catch (\Throwable $e) {
                // retried on the next step; the slots already drained below must still be handled
                $this->logError('reconcile', $e);
            }
        }
        foreach ($this->transport->done() as $key => [$body, $http, $err]) {
            try {
                $this->onAnswer((string) $key, WatchCall::answer($body, (int) $http, (string) $err), $now);
            } catch (\Throwable $e) {
                // one row's failure must not lose the others' answers
                $this->logError('answer', $e, (string) $key);
            }
        }
        foreach ($this->runs->done() as $key => $exit) {
            try {
                $this->onRunEnd((string) $key, (int) $exit, $now);
            } catch (\Throwable $e) {
                $this->logError('run end', $e, (string) $key);
            }
        }
        foreach (array_keys($this->slots) as $key) {
            try {
                $s = $this->slots[$key];
                if ($s['state'] === 'open' || ($s['state'] === 'backoff' && $now >= $s['until'])) {
                    $this->openWait($key, $now);
                }
                if (isset($this->slots[$key]) && $now - $this->slots[$key]['written_at'] >= self::HEARTBEAT_S) {
                    $this->write($key, true);
                }
            } catch (\Throwable $e) {
                $this->logError('wait', $e, $key);
            }
        }
        // the scheduler tick runs only while some active workflow is in schedule mode and qualifies (not idle)
        $scheduled = array_filter($this->slots, fn(array $s) => $s['state'] === 'scheduled');
        if ($scheduled && $now - $this->lastTick >= self::SCHEDULE_TICK_S) {
            $this->lastTick = $now;
            try {
                $this->runs->scheduleTick();
            } catch (\Throwable $e) {
                $this->logError('schedule tick', $e);
            }
        }
    }

    /** @return array<string, array> row key => slot */
    public function slots(): array
    {
        return array_map(fn(array $s) => ['workflow_id' => $s['workflow_id'], 'schedule_id' => $s['schedule_id'],
            'state' => $s['state'], 'until' => $s['until'], 'backoff' => $s['backoff']], $this->slots);
    }

    public function stop(): void
    {
        foreach (array_keys($this->slots) as $key) {
            $this->transport->cancel($key);
        }
    }

    private function reconcile(): void
    {
        $this->active->sweep();
        $rows = $this->active->all();
        $seen = array_flip(array_map(self::keyOf(...), $rows));
        // the removed rows first: a person's replaced run is flagged before the new row is looked at
        foreach (array_keys($this->slots) as $key) {
            if (!isset($seen[$key])) {
                if ($this->slots[$key]['state'] === 'running') {
                    $this->slots[$key]['gone'] = true;   // let the run finish, then forget it
                } else {
                    $this->drop($key);
                }
            }
        }
        foreach ($rows as $row) {
            try {
                $this->reconcileRow($row);
            } catch (\Throwable $e) {
                // one row's failure must not stop the later rows
                $this->logError('reconcile', $e, self::keyOf($row));
            }
        }
    }

    /** A slot's key: its active row's "{user}:{workflow}". */
    private static function keyOf(array $row): string
    {
        return (int) $row['user_id'] . ':' . (int) $row['workflow_id'];
    }

    private function reconcileRow(array $row): void
    {
        $key = self::keyOf($row);
        $check = $this->active->check($row);
        $schedule = $check['mode']['schedule'];
        $ids = [(int) $row['workflow_id'], $schedule ? (int) $schedule['id'] : 0];
        $watch = self::watchOf($schedule);
        $slot = $this->slots[$key] ?? null;
        if ($slot !== null && $slot['state'] === 'running') {
            // a run is in flight: nothing for this row changes until it ends; if the row changed, the slot is then rebuilt
            if (!$check['ok'] || [$slot['workflow_id'], $slot['schedule_id']] !== $ids || $slot['mode'] !== $row['mode']
                || $slot['watch'] !== $watch) {
                $this->slots[$key]['gone'] = true;
            }
            return;
        }
        if ($slot === null && $this->replacedRunInFlight((int) $row['user_id'])) {
            return;   // a person's replaced workflow still runs: the new one opens once it ends
        }
        $carried = null;
        if ($slot === null && isset($this->carry[$key])) {
            // a failed run that ended while the row changed
            $carried = $this->carry[$key] === $ids ? ['message' => 'run_failed', 'run_failed' => true] : null;
            unset($this->carry[$key]);
        }
        if ($slot !== null && [$slot['workflow_id'], $slot['schedule_id']] !== $ids) {
            $this->drop($key);   // another schedule row of this workflow is active now
            $slot = null;
        }
        if (!$check['ok']) {
            if ($slot !== null && $slot['state'] !== 'running') {
                $this->transport->cancel($key);
            }
            $this->slots[$key] = $this->slot($ids, $row, $schedule, 'idle', $slot ?? $carried);
            $this->slots[$key]['message'] = $check['reason'];
            $this->write($key);
            return;
        }
        if ($row['mode'] === 'schedule') {
            $this->slots[$key] = $this->slot($ids, $row, $schedule, 'scheduled', $slot ?? $carried);
            $this->slots[$key]['message'] = $schedule['next_run'] ?? null;
            $this->write($key);
            return;
        }
        if ($slot !== null && !in_array($slot['state'], ['idle', 'scheduled'], true) && $slot['watch'] !== $watch) {
            // the option's watch was edited in place (same row): close the old wait, wait again with the new one
            $this->transport->cancel($key);
            $this->slots[$key] = $this->slot($ids, $row, $schedule, 'open', $slot);
            return;
        }
        if ($slot === null || in_array($slot['state'], ['idle', 'scheduled'], true)) {
            $this->slots[$key] = $this->slot($ids, $row, $schedule, 'open', $slot ?? $carried);
        }
    }

    /** The schedule row's event_trigger, decoded: what the wait calls. */
    private static function watchOf(?array $schedule): mixed
    {
        return $schedule && is_string($schedule['event_trigger'] ?? null) ? json_decode($schedule['event_trigger'], true) : null;
    }

    /** Whether a slot of this user whose row is gone still runs (a person who activated another workflow meanwhile). */
    private function replacedRunInFlight(int $userId): bool
    {
        foreach ($this->slots as $s) {
            if ($s['user'] === $userId && $s['gone'] && $s['state'] === 'running') {
                return true;
            }
        }
        return false;
    }

    private function slot(array $ids, array $row, ?array $schedule, string $state, ?array $old): array
    {
        return ['user' => (int) $row['user_id'], 'workflow_id' => $ids[0], 'schedule_id' => $ids[1], 'owner' => (int) $row['owner_id'], 'watch' => self::watchOf($schedule),
            'mode' => $row['mode'], 'state' => $state, 'until' => 0.0, 'backoff' => $old['backoff'] ?? 0, 'message' => $old['message'] ?? null,
            'run_failed' => $old['run_failed'] ?? false,
            'written_at' => $old['written_at'] ?? -INF, 'written' => $old['written'] ?? null, 'gone' => false];
    }

    private function openWait(string $key, float $now): void
    {
        $s = $this->slots[$key];
        try {
            $server = is_array($s['watch']) ? ($this->serverFor)($s['owner'], (string) ($s['watch']['server'] ?? '')) : null;
        } catch (\Throwable $e) {
            $this->logError('server lookup', $e, $key);
            $this->backoff($key, 'unreachable', $now);
            return;
        }
        if ($server === null) {
            $this->backoff($key, 'server_missing', $now);
            return;
        }
        [$url, $headers, $body] = WatchCall::request($server, $s['watch'], ++$this->requestId);
        $this->transport->start($key, $url, $headers, $body);
        $this->slots[$key]['state'] = 'waiting';
        if ($s['run_failed']) {
            $this->slots[$key]['message'] = 'run_failed';   // waiting again after a failed run: the failure still shows
        }
        $this->write($key);
    }

    private function onAnswer(string $key, array $answer, float $now): void
    {
        if (($this->slots[$key]['state'] ?? null) !== 'waiting') {
            return;   // deactivated or replaced meanwhile: the answer is not this slot's
        }
        if ($answer['status'] === 'error') {
            $this->backoff($key, $answer['message'], $now);
            return;
        }
        if ($this->slots[$key]['run_failed']) {
            // after a failed run, only a run that succeeds clears the failure and its backoff
            $this->slots[$key]['message'] = 'run_failed';
        } else {
            $this->slots[$key]['backoff'] = 0;
            $this->slots[$key]['message'] = ($answer['events'] ?? null) === 'off' ? 'fallback' : null;
        }
        if ($answer['status'] === 'timeout') {
            $this->slots[$key]['state'] = 'open';
            return;
        }
        try {
            $row = null;
            foreach ($this->active->all() as $r) {
                if (self::keyOf($r) === $key) {
                    $row = $r;
                }
            }
            $ok = $row !== null && $this->active->check($row)['ok'];
        } catch (\Throwable $e) {
            $this->logError('check', $e, $key);
            $this->backoff($key, 'unreachable', $now);
            return;
        }
        if (!$ok || (int) $row['workflow_id'] !== $this->slots[$key]['workflow_id'] || $row['mode'] !== 'option') {
            unset($this->slots[$key]);   // deactivated or disabled since the wait opened (the request has finished): no run
            return;
        }
        $this->slots[$key]['state'] = 'running';
        try {
            $this->runs->start($key, $this->slots[$key]['schedule_id']);
        } catch (\Throwable $e) {
            $this->logError('run start', $e, $key);
            $this->slots[$key]['run_failed'] = true;
            $this->backoff($key, 'run_failed', $now);
            return;
        }
        $this->write($key);
    }

    private function onRunEnd(string $key, int $exit, float $now): void
    {
        if (!isset($this->slots[$key])) {
            return;
        }
        if ($this->slots[$key]['gone']) {
            if ($exit !== 0) {
                $this->carry[$key] = [$this->slots[$key]['workflow_id'], $this->slots[$key]['schedule_id']];
            }
            unset($this->slots[$key]);
            $this->lastReconcile = -INF;   // re-evaluate before anything opens for this row (or its user's new row)
            return;
        }
        if ($exit !== 0) {
            // a run that fails before the poll delivers the mail would loop ready -> run -> fail: back off (30 s .. 300 s)
            $this->slots[$key]['run_failed'] = true;
            $this->backoff($key, 'run_failed', $now);
            return;
        }
        $this->slots[$key] = array_merge($this->slots[$key], ['state' => 'open', 'message' => null, 'backoff' => 0, 'run_failed' => false]);
    }

    private function backoff(string $key, string $message, float $now): void
    {
        $b = $this->slots[$key]['backoff'];
        $b = $b === 0 ? self::BACKOFF_MIN_S : min($b * 2, self::BACKOFF_MAX_S);
        $this->slots[$key] = array_merge($this->slots[$key], ['state' => 'backoff', 'until' => $now + $b, 'backoff' => $b, 'message' => $message]);
        $this->write($key);
    }

    private function drop(string $key): void
    {
        $this->transport->cancel($key);
        unset($this->slots[$key]);
    }

    /** The slot's state to active_workflows: on a change, or on the heartbeat ($force). */
    private function write(string $key, bool $force = false): void
    {
        $s = $this->slots[$key];
        $state = match ($s['state']) {
            'backoff' => 'error',
            'open' => 'waiting',
            default => $s['state'],
        };
        $written = [$state, $s['message']];
        if (!$force && $s['written'] === $written) {
            return;
        }
        try {
            $this->active->setState($s['user'], $s['workflow_id'], $state, $s['message']);
        } catch (\Throwable $e) {
            $this->logError('state write', $e, $key);
            return;   // 'written' stays as it was: the heartbeat retries
        }
        $this->slots[$key]['written'] = $written;
        $this->slots[$key]['written_at'] = ($this->now)();
    }

    /** A swallowed error, to the log: each distinct line at most once a minute (a failing step repeats every second). */
    private function logError(string $where, \Throwable $e, ?string $key = null): void
    {
        if ($this->log === null) {
            return;
        }
        $line = 'event worker: ' . $where . ($key !== null ? " ({$key})" : '') . ': '
            . get_class($e) . ': ' . $e->getMessage();
        $now = ($this->now)();
        if ($now - ($this->logged[$line] ?? -INF) < self::LOG_REPEAT_S) {
            return;
        }
        $this->logged = array_filter($this->logged, fn(float $t) => $now - $t < self::LOG_REPEAT_S);
        $this->logged[$line] = $now;
        try {
            ($this->log)($line);
        } catch (\Throwable) {
            // a broken log must not stop the worker
        }
    }
}
