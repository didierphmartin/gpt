<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The event worker's logic (spec 2026-10-14 event-worker §3), without I/O of its own: every RECONCILE_S it reads
 * the active workflows; for each option-mode one it holds a wait on the option's waiting tool, starts a run on
 * `ready`, waits again when the run ends, and backs off on errors and failed runs; once a minute, while one of them
 * is in schedule mode, it starts the scheduler tick for the schedule-mode ones. One slot per user (one active workflow each). State goes to active_workflows.
 */
final class EventWorker
{
    public const RECONCILE_S = 5;
    public const BACKOFF_MIN_S = 30;
    public const BACKOFF_MAX_S = 300;
    public const HEARTBEAT_S = 30;
    public const SCHEDULE_TICK_S = 60;
    public const LOG_REPEAT_S = 60;

    /** @var array<int, array> user id => slot */
    private array $slots = [];
    private float $lastReconcile = -INF;
    private float $lastTick = -INF;
    private int $requestId = 0;
    /** @var array<int, array> user id => [workflow_id, schedule_id] of a run that failed while its slot was flagged for rebuild */
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
        foreach ($this->transport->done() as $user => [$body, $http, $err]) {
            try {
                $this->onAnswer((int) $user, WatchCall::answer($body, (int) $http, (string) $err), $now);
            } catch (\Throwable $e) {
                // one user's failure must not lose the others' answers
                $this->logError('answer', $e, (int) $user);
            }
        }
        foreach ($this->runs->done() as $user => $exit) {
            try {
                $this->onRunEnd((int) $user, (int) $exit, $now);
            } catch (\Throwable $e) {
                $this->logError('run end', $e, (int) $user);
            }
        }
        foreach (array_keys($this->slots) as $user) {
            try {
                $s = $this->slots[$user];
                if ($s['state'] === 'open' || ($s['state'] === 'backoff' && $now >= $s['until'])) {
                    $this->openWait($user, $now);
                }
                if (isset($this->slots[$user]) && $now - $this->slots[$user]['written_at'] >= self::HEARTBEAT_S) {
                    $this->write($user, true);
                }
            } catch (\Throwable $e) {
                $this->logError('wait', $e, $user);
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

    /** @return array<int, array> */
    public function slots(): array
    {
        return array_map(fn(array $s) => ['workflow_id' => $s['workflow_id'], 'schedule_id' => $s['schedule_id'],
            'state' => $s['state'], 'until' => $s['until'], 'backoff' => $s['backoff']], $this->slots);
    }

    public function stop(): void
    {
        foreach (array_keys($this->slots) as $user) {
            $this->transport->cancel($user);
        }
    }

    private function reconcile(): void
    {
        $this->active->sweep();
        $seen = [];
        foreach ($this->active->all() as $row) {
            $seen[(int) $row['user_id']] = true;
            try {
                $this->reconcileRow($row);
            } catch (\Throwable $e) {
                // one row's failure must not stop the later rows
                $this->logError('reconcile', $e, (int) $row['user_id']);
            }
        }
        foreach (array_keys($this->slots) as $user) {
            if (!isset($seen[$user])) {
                if ($this->slots[$user]['state'] === 'running') {
                    $this->slots[$user]['gone'] = true;   // let the run finish, then forget it
                } else {
                    $this->drop($user);
                }
            }
        }
    }

    private function reconcileRow(array $row): void
    {
        $user = (int) $row['user_id'];
        $check = $this->active->check($row);
        $schedule = $check['mode']['schedule'];
        $key = [(int) $row['workflow_id'], $schedule ? (int) $schedule['id'] : 0];
        $watch = self::watchOf($schedule);
        $slot = $this->slots[$user] ?? null;
        if ($slot !== null && $slot['state'] === 'running') {
            // a run is in flight: nothing for this user changes until it ends; if the row changed, the slot is then rebuilt
            if (!$check['ok'] || [$slot['workflow_id'], $slot['schedule_id']] !== $key || $slot['mode'] !== $row['mode']
                || $slot['watch'] !== $watch) {
                $this->slots[$user]['gone'] = true;
            }
            return;
        }
        $carried = null;
        if ($slot === null && isset($this->carry[$user])) {
            // a failed run that ended while the row changed
            $carried = $this->carry[$user] === $key ? ['message' => 'run_failed', 'run_failed' => true] : null;
            unset($this->carry[$user]);
        }
        if ($slot !== null && [$slot['workflow_id'], $slot['schedule_id']] !== $key) {
            $this->drop($user);   // another workflow (or row) is active now
            $slot = null;
        }
        if (!$check['ok']) {
            if ($slot !== null && $slot['state'] !== 'running') {
                $this->transport->cancel($user);
            }
            $this->slots[$user] = $this->slot($key, $row, $schedule, 'idle', $slot ?? $carried);
            $this->slots[$user]['message'] = $check['reason'];
            $this->write($user);
            return;
        }
        if ($row['mode'] === 'schedule') {
            $this->slots[$user] = $this->slot($key, $row, $schedule, 'scheduled', $slot ?? $carried);
            $this->slots[$user]['message'] = $schedule['next_run'] ?? null;
            $this->write($user);
            return;
        }
        if ($slot !== null && !in_array($slot['state'], ['idle', 'scheduled'], true) && $slot['watch'] !== $watch) {
            // the option's watch was edited in place (same row): close the old wait, wait again with the new one
            $this->transport->cancel($user);
            $this->slots[$user] = $this->slot($key, $row, $schedule, 'open', $slot);
            return;
        }
        if ($slot === null || in_array($slot['state'], ['idle', 'scheduled'], true)) {
            $this->slots[$user] = $this->slot($key, $row, $schedule, 'open', $slot ?? $carried);
        }
    }

    /** The schedule row's event_trigger, decoded: what the wait calls. */
    private static function watchOf(?array $schedule): mixed
    {
        return $schedule && is_string($schedule['event_trigger'] ?? null) ? json_decode($schedule['event_trigger'], true) : null;
    }

    private function slot(array $key, array $row, ?array $schedule, string $state, ?array $old): array
    {
        return ['workflow_id' => $key[0], 'schedule_id' => $key[1], 'owner' => (int) $row['owner_id'], 'watch' => self::watchOf($schedule),
            'mode' => $row['mode'], 'state' => $state, 'until' => 0.0, 'backoff' => $old['backoff'] ?? 0, 'message' => $old['message'] ?? null,
            'run_failed' => $old['run_failed'] ?? false,
            'written_at' => $old['written_at'] ?? -INF, 'written' => $old['written'] ?? null, 'gone' => false];
    }

    private function openWait(int $user, float $now): void
    {
        $s = $this->slots[$user];
        try {
            $server = is_array($s['watch']) ? ($this->serverFor)($s['owner'], (string) ($s['watch']['server'] ?? '')) : null;
        } catch (\Throwable $e) {
            $this->logError('server lookup', $e, $user);
            $this->backoff($user, 'unreachable', $now);
            return;
        }
        if ($server === null) {
            $this->backoff($user, 'server_missing', $now);
            return;
        }
        [$url, $headers, $body] = WatchCall::request($server, $s['watch'], ++$this->requestId);
        $this->transport->start($user, $url, $headers, $body);
        $this->slots[$user]['state'] = 'waiting';
        if ($s['run_failed']) {
            $this->slots[$user]['message'] = 'run_failed';   // waiting again after a failed run: the failure still shows
        }
        $this->write($user);
    }

    private function onAnswer(int $user, array $answer, float $now): void
    {
        if (($this->slots[$user]['state'] ?? null) !== 'waiting') {
            return;   // deactivated or replaced meanwhile: the answer is not this slot's
        }
        if ($answer['status'] === 'error') {
            $this->backoff($user, $answer['message'], $now);
            return;
        }
        if ($this->slots[$user]['run_failed']) {
            // after a failed run, only a run that succeeds clears the failure and its backoff
            $this->slots[$user]['message'] = 'run_failed';
        } else {
            $this->slots[$user]['backoff'] = 0;
            $this->slots[$user]['message'] = ($answer['events'] ?? null) === 'off' ? 'fallback' : null;
        }
        if ($answer['status'] === 'timeout') {
            $this->slots[$user]['state'] = 'open';
            return;
        }
        try {
            $row = null;
            foreach ($this->active->all() as $r) {
                if ((int) $r['user_id'] === $user) {
                    $row = $r;
                }
            }
            $ok = $row !== null && $this->active->check($row)['ok'];
        } catch (\Throwable $e) {
            $this->logError('check', $e, $user);
            $this->backoff($user, 'unreachable', $now);
            return;
        }
        if (!$ok || (int) $row['workflow_id'] !== $this->slots[$user]['workflow_id'] || $row['mode'] !== 'option') {
            unset($this->slots[$user]);   // deactivated or disabled since the wait opened (the request has finished): no run
            return;
        }
        $this->slots[$user]['state'] = 'running';
        try {
            $this->runs->start($user, $this->slots[$user]['schedule_id']);
        } catch (\Throwable $e) {
            $this->logError('run start', $e, $user);
            $this->slots[$user]['run_failed'] = true;
            $this->backoff($user, 'run_failed', $now);
            return;
        }
        $this->write($user);
    }

    private function onRunEnd(int $user, int $exit, float $now): void
    {
        if (!isset($this->slots[$user])) {
            return;
        }
        if ($this->slots[$user]['gone']) {
            if ($exit !== 0) {
                $this->carry[$user] = [$this->slots[$user]['workflow_id'], $this->slots[$user]['schedule_id']];
            }
            unset($this->slots[$user]);
            $this->lastReconcile = -INF;   // re-evaluate before anything opens for this user
            return;
        }
        if ($exit !== 0) {
            // a run that fails before the poll delivers the mail would loop ready -> run -> fail: back off (30 s .. 300 s)
            $this->slots[$user]['run_failed'] = true;
            $this->backoff($user, 'run_failed', $now);
            return;
        }
        $this->slots[$user] = array_merge($this->slots[$user], ['state' => 'open', 'message' => null, 'backoff' => 0, 'run_failed' => false]);
    }

    private function backoff(int $user, string $message, float $now): void
    {
        $b = $this->slots[$user]['backoff'];
        $b = $b === 0 ? self::BACKOFF_MIN_S : min($b * 2, self::BACKOFF_MAX_S);
        $this->slots[$user] = array_merge($this->slots[$user], ['state' => 'backoff', 'until' => $now + $b, 'backoff' => $b, 'message' => $message]);
        $this->write($user);
    }

    private function drop(int $user): void
    {
        $this->transport->cancel($user);
        unset($this->slots[$user]);
    }

    /** The slot's state to active_workflows: on a change, or on the heartbeat ($force). */
    private function write(int $user, bool $force = false): void
    {
        $s = $this->slots[$user];
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
            $this->active->setState($user, $state, $s['message']);
        } catch (\Throwable $e) {
            $this->logError('state write', $e, $user);
            return;   // 'written' stays as it was: the heartbeat retries
        }
        $this->slots[$user]['written'] = $written;
        $this->slots[$user]['written_at'] = ($this->now)();
    }

    /** A swallowed error, to the log: each distinct line at most once a minute (a failing step repeats every second). */
    private function logError(string $where, \Throwable $e, ?int $user = null): void
    {
        if ($this->log === null) {
            return;
        }
        $line = 'event worker: ' . $where . ($user !== null ? " (user {$user})" : '') . ': '
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
