"""Port of backend/src/AgentTeam/Services/EventWorker.php.

The event worker's logic (spec 2026-10-14 event-worker §3), without I/O of its own: every RECONCILE_S it reads
the active workflows; for each option-mode one it holds a wait on the option's waiting tool, starts a run on
`ready`, waits again when the run ends, and backs off on errors and failed runs; once a minute, while one of them
is in schedule mode, it starts the scheduler tick for the schedule-mode ones. One slot per user (one active workflow
each). State goes to active_workflows.
"""
from __future__ import annotations

import json
from collections.abc import Callable

from app.agent_team.services.watch_call import WatchCall
from app.support.phpcompat import php_intval, php_strval

_INF = float('inf')


class EventWorker:
    RECONCILE_S = 5
    BACKOFF_MIN_S = 30
    BACKOFF_MAX_S = 300
    HEARTBEAT_S = 30
    SCHEDULE_TICK_S = 60
    LOG_REPEAT_S = 60

    def __init__(self, active, serverFor: Callable[[int, str], dict | None], transport, runs,
                 now: Callable[[], float], log: Callable[[str], None] | None = None):
        """`log(line)`: where swallowed errors go (each distinct line at most once a minute); None drops them."""
        self.active = active
        self.serverFor = serverFor
        self.transport = transport
        self.runs = runs
        self.now = now
        self.log = log
        self._slots: dict[int, dict] = {}
        self.lastReconcile = -_INF
        self.lastTick = -_INF
        self.requestId = 0
        # user id => [workflow_id, schedule_id] of a run that failed while its slot was flagged for rebuild
        self.carry: dict[int, list] = {}
        # logged line => when, for the once-a-minute limit
        self.logged: dict[str, float] = {}

    def step(self) -> None:
        now = self.now()
        if now - self.lastReconcile >= self.RECONCILE_S:
            try:
                self._reconcile()
                self.lastReconcile = now
            except Exception as e:  # noqa: BLE001
                # retried on the next step; the slots already drained below must still be handled
                self._logError('reconcile', e)
        for user, (body, http, err) in self.transport.done().items():
            try:
                self._onAnswer(int(user), WatchCall.answer(body, php_intval(http), php_strval(err)), now)
            except Exception as e:  # noqa: BLE001
                # one user's failure must not lose the others' answers
                self._logError('answer', e, int(user))
        for user, exit in self.runs.done().items():
            try:
                self._onRunEnd(int(user), int(exit), now)
            except Exception as e:  # noqa: BLE001
                self._logError('run end', e, int(user))
        for user in list(self._slots.keys()):
            try:
                if user not in self._slots:
                    continue
                s = self._slots[user]
                if s['state'] == 'open' or (s['state'] == 'backoff' and now >= s['until']):
                    self._openWait(user, now)
                if user in self._slots and now - self._slots[user]['written_at'] >= self.HEARTBEAT_S:
                    self._write(user, True)
            except Exception as e:  # noqa: BLE001
                self._logError('wait', e, user)
        # the scheduler tick runs only while some active workflow is in schedule mode and qualifies (not idle)
        scheduled = [s for s in self._slots.values() if s['state'] == 'scheduled']
        if scheduled and now - self.lastTick >= self.SCHEDULE_TICK_S:
            self.lastTick = now
            try:
                self.runs.scheduleTick()
            except Exception as e:  # noqa: BLE001
                self._logError('schedule tick', e)

    def slots(self) -> dict:
        return {u: {'workflow_id': s['workflow_id'], 'schedule_id': s['schedule_id'], 'state': s['state'],
                    'until': s['until'], 'backoff': s['backoff']} for u, s in self._slots.items()}

    def stop(self) -> None:
        for user in list(self._slots.keys()):
            self.transport.cancel(user)

    def _reconcile(self) -> None:
        self.active.sweep()
        seen = set()
        for row in self.active.all():
            seen.add(php_intval(row['user_id']))
            try:
                self._reconcileRow(row)
            except Exception as e:  # noqa: BLE001
                # one row's failure must not stop the later rows
                self._logError('reconcile', e, php_intval(row['user_id']))
        for user in list(self._slots.keys()):
            if user not in seen:
                if self._slots[user]['state'] == 'running':
                    self._slots[user]['gone'] = True   # let the run finish, then forget it
                else:
                    self._drop(user)

    def _reconcileRow(self, row: dict) -> None:
        user = php_intval(row['user_id'])
        check = self.active.check(row)
        schedule = check['mode']['schedule']
        key = [php_intval(row['workflow_id']), php_intval(schedule['id']) if schedule else 0]
        watch = self._watchOf(schedule)
        slot = self._slots.get(user)
        if slot is not None and slot['state'] == 'running':
            # a run is in flight: nothing for this user changes until it ends; if the row changed, the slot is then rebuilt
            if (not check['ok'] or [slot['workflow_id'], slot['schedule_id']] != key or slot['mode'] != row['mode']
                    or slot['watch'] != watch):
                self._slots[user]['gone'] = True
            return
        carried = None
        if slot is None and user in self.carry:
            # a failed run that ended while the row changed
            carried = {'message': 'run_failed', 'run_failed': True} if self.carry[user] == key else None
            del self.carry[user]
        if slot is not None and [slot['workflow_id'], slot['schedule_id']] != key:
            self._drop(user)   # another workflow (or row) is active now
            slot = None
        if not check['ok']:
            if slot is not None and slot['state'] != 'running':
                self.transport.cancel(user)
            self._slots[user] = self._slot(key, row, schedule, 'idle', slot if slot is not None else carried)
            self._slots[user]['message'] = check['reason']
            self._write(user)
            return
        if row['mode'] == 'schedule':
            self._slots[user] = self._slot(key, row, schedule, 'scheduled', slot if slot is not None else carried)
            self._slots[user]['message'] = schedule.get('next_run') if schedule else None
            self._write(user)
            return
        if slot is not None and slot['state'] not in ('idle', 'scheduled') and slot['watch'] != watch:
            # the option's watch was edited in place (same row): close the old wait, wait again with the new one
            self.transport.cancel(user)
            self._slots[user] = self._slot(key, row, schedule, 'open', slot)
            return
        if slot is None or slot['state'] in ('idle', 'scheduled'):
            self._slots[user] = self._slot(key, row, schedule, 'open', slot if slot is not None else carried)

    @staticmethod
    def _watchOf(schedule: dict | None):
        """The schedule row's event_trigger, decoded: what the wait calls."""
        if schedule and isinstance(schedule.get('event_trigger'), str):
            try:
                return json.loads(schedule['event_trigger'])
            except ValueError:
                return None
        return None

    def _slot(self, key: list, row: dict, schedule: dict | None, state: str, old: dict | None) -> dict:
        old = old or {}
        return {'workflow_id': key[0], 'schedule_id': key[1], 'owner': php_intval(row['owner_id']),
                'watch': self._watchOf(schedule), 'mode': row['mode'], 'state': state, 'until': 0.0,
                'backoff': old.get('backoff', 0), 'message': old.get('message'),
                'run_failed': old.get('run_failed', False),
                'written_at': old.get('written_at', -_INF), 'written': old.get('written'), 'gone': False}

    def _openWait(self, user: int, now: float) -> None:
        s = self._slots[user]
        try:
            server = (self.serverFor(s['owner'], php_strval(s['watch'].get('server') if s['watch'].get('server') is not None else ''))
                      if isinstance(s['watch'], dict) else None)
        except Exception as e:  # noqa: BLE001
            self._logError('server lookup', e, user)
            self._backoff(user, 'unreachable', now)
            return
        if server is None:
            self._backoff(user, 'server_missing', now)
            return
        self.requestId += 1
        url, headers, body = WatchCall.request(server, s['watch'], self.requestId)
        self.transport.start(user, url, headers, body)
        self._slots[user]['state'] = 'waiting'
        if s['run_failed']:
            self._slots[user]['message'] = 'run_failed'   # waiting again after a failed run: the failure still shows
        self._write(user)

    def _onAnswer(self, user: int, answer: dict, now: float) -> None:
        if (self._slots.get(user) or {}).get('state') != 'waiting':
            return   # deactivated or replaced meanwhile: the answer is not this slot's
        if answer['status'] == 'error':
            self._backoff(user, answer['message'], now)
            return
        if self._slots[user]['run_failed']:
            # after a failed run, only a run that succeeds clears the failure and its backoff
            self._slots[user]['message'] = 'run_failed'
        else:
            self._slots[user]['backoff'] = 0
            self._slots[user]['message'] = 'fallback' if answer.get('events') == 'off' else None
        if answer['status'] == 'timeout':
            self._slots[user]['state'] = 'open'
            return
        try:
            row = None
            for r in self.active.all():
                if php_intval(r['user_id']) == user:
                    row = r
            ok = row is not None and self.active.check(row)['ok']
        except Exception as e:  # noqa: BLE001
            self._logError('check', e, user)
            self._backoff(user, 'unreachable', now)
            return
        if not ok or php_intval(row['workflow_id']) != self._slots[user]['workflow_id'] or row['mode'] != 'option':
            del self._slots[user]   # deactivated or disabled since the wait opened (the request has finished): no run
            return
        self._slots[user]['state'] = 'running'
        try:
            self.runs.start(user, self._slots[user]['schedule_id'])
        except Exception as e:  # noqa: BLE001
            self._logError('run start', e, user)
            self._slots[user]['run_failed'] = True
            self._backoff(user, 'run_failed', now)
            return
        self._write(user)

    def _onRunEnd(self, user: int, exit: int, now: float) -> None:
        if user not in self._slots:
            return
        if self._slots[user]['gone']:
            if exit != 0:
                self.carry[user] = [self._slots[user]['workflow_id'], self._slots[user]['schedule_id']]
            del self._slots[user]
            self.lastReconcile = -_INF   # re-evaluate before anything opens for this user
            return
        if exit != 0:
            # a run that fails before the poll delivers the mail would loop ready -> run -> fail: back off (30 s .. 300 s)
            self._slots[user]['run_failed'] = True
            self._backoff(user, 'run_failed', now)
            return
        self._slots[user].update({'state': 'open', 'message': None, 'backoff': 0, 'run_failed': False})

    def _backoff(self, user: int, message: str, now: float) -> None:
        b = self._slots[user]['backoff']
        b = self.BACKOFF_MIN_S if b == 0 else min(b * 2, self.BACKOFF_MAX_S)
        self._slots[user].update({'state': 'backoff', 'until': now + b, 'backoff': b, 'message': message})
        self._write(user)

    def _drop(self, user: int) -> None:
        self.transport.cancel(user)
        self._slots.pop(user, None)

    def _write(self, user: int, force: bool = False) -> None:
        """The slot's state to active_workflows: on a change, or on the heartbeat (`force`)."""
        s = self._slots[user]
        state = {'backoff': 'error', 'open': 'waiting'}.get(s['state'], s['state'])
        written = [state, s['message']]
        if not force and s['written'] == written:
            return
        try:
            self.active.setState(user, state, s['message'])
        except Exception as e:  # noqa: BLE001
            self._logError('state write', e, user)
            return   # 'written' stays as it was: the heartbeat retries
        self._slots[user]['written'] = written
        self._slots[user]['written_at'] = self.now()

    def _logError(self, where: str, e: BaseException, user: int | None = None) -> None:
        """A swallowed error, to the log: each distinct line at most once a minute (a failing step repeats every second)."""
        if self.log is None:
            return
        line = ('event worker: ' + where + (f' (user {user})' if user is not None else '') + ': '
                + type(e).__name__ + ': ' + str(e))
        now = self.now()
        if now - self.logged.get(line, -_INF) < self.LOG_REPEAT_S:
            return
        self.logged = {k: t for k, t in self.logged.items() if now - t < self.LOG_REPEAT_S}
        self.logged[line] = now
        try:
            self.log(line)
        except Exception:  # noqa: BLE001 -- a broken log must not stop the worker
            pass
