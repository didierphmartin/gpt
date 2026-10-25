"""Port of backend/src/AgentTeam/Services/ScheduledWorkflowService.php (341 lines).

Handles CRUD operations and scheduling logic for workflow schedules. No
model class ports PHP's row shape here (PHP returns plain associative
arrays from every method — no `new Scheduled...`/`toArray()` in the source),
so this port returns dicts in PHP's key order too.
"""
from __future__ import annotations

import calendar
import json
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from app.agent_team.services.cron_expression import CronExpression
from app.exceptions.invalid_argument import InvalidArgumentException
from app.support.phpcompat import (php_bool, php_coalesce, php_empty, php_intval, php_strval, php_trim,
                                   php_tz)


def _parse_dt(s: str) -> datetime:
    """`new DateTimeImmutable($s)` for the DB's 'Y-m-d H:i:s' (fractions allowed), naive."""
    return datetime.fromisoformat(s.strip().replace('T', ' ')).replace(tzinfo=None)


def _add_months(dt: datetime, months: int) -> datetime:
    """PHP `DateInterval("P{n}M")` month-add semantics: advance the month
    field (with year carry), then OVERFLOW the day-of-month past the target
    month's length into the following month(s) by the excess day count —
    PHP never clamps (e.g. Jan 31 + P1M -> Mar 3 in a non-leap year, not
    Feb 28/29)."""
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    days_in_month = calendar.monthrange(year, month)[1]
    if dt.day <= days_in_month:
        return dt.replace(year=year, month=month, day=dt.day)
    overflow = dt.day - days_in_month
    return datetime(year, month, days_in_month, dt.hour, dt.minute, dt.second) + timedelta(days=overflow)


def _shift_out_of_dst_gap(dt: datetime, tz) -> datetime:
    """PHP's `DateTime::add()` re-localizes the field-arithmetic result
    through the DateTime's timezone; when that naive result lands on a
    wall-clock time that does not exist (a spring-forward gap), PHP's
    timelib pushes it forward by exactly the width of the gap instead of
    raising. Python's zoneinfo never raises for a nonexistent local time
    (PEP 495) — it silently applies whichever offset `fold` selects — so
    the gap is detected here by round-tripping both fold candidates through
    UTC and back: an unambiguous time (or an ambiguous fall-back time)
    round-trips to `dt` under at least one fold; a gap round-trips under
    neither, and is then shifted forward by the observed offset delta,
    matching PHP byte-for-byte (verified against `php -r` for the 3 gap
    cases in the calculateNextRun fixture table)."""
    aware0 = dt.replace(tzinfo=tz, fold=0)
    aware1 = dt.replace(tzinfo=tz, fold=1)
    back0 = aware0.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None)
    back1 = aware1.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None)
    if back0 == dt or back1 == dt:
        return dt
    gap = aware1.utcoffset() - aware0.utcoffset()
    return dt + gap


class ScheduledWorkflowService:
    REPEAT_TYPES = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'cron', 'event']
    # A run 'running' for longer than this is treated as crashed and may be claimed again.
    STALE_RUNNING_MINUTES = 60

    def __init__(self, db, now: Callable[[], datetime] | None = None):
        """`now` returns the current server time (a naive datetime). The default reads the DB
        connection's NOW(), so "server time" matches the NOW() used elsewhere in this service."""
        self.db = db
        self._nowFn = now if now is not None else (
            lambda: _parse_dt(str(self.db.fetch_column('SELECT NOW()')[0])))

    def _now(self) -> datetime:
        return self._nowFn()

    def _stamp(self) -> str:
        return self._now().strftime('%Y-%m-%d %H:%M:%S')

    def _nowAndStale(self) -> tuple[str, str]:
        """One clock read as [now, stale-threshold] strings, so a statement sees a single instant."""
        t = self._now()
        return (t.strftime('%Y-%m-%d %H:%M:%S'),
                (t - timedelta(minutes=self.STALE_RUNNING_MINUTES)).strftime('%Y-%m-%d %H:%M:%S'))

    @staticmethod
    def eventTrigger(raw) -> str:
        """An 'event' schedule's trigger -- {"server": <MCP server name>, "tool": ..., "args": {...}} -- as the
        canonical JSON stored in event_trigger (spec 2026-10-12 mail/drive events §8). An event schedule has
        no next_run, so no scheduler tick ever claims it. Raises InvalidArgumentException when the trigger
        is not that shape."""
        if isinstance(raw, str):
            try:
                t = json.loads(raw)
            except ValueError:
                t = None
        else:
            t = raw
        if not isinstance(t, (dict, list)):
            raise InvalidArgumentException('An event schedule needs event_trigger: {"server", "tool", "args"}')
        if isinstance(t, list):   # a JSON list is a PHP array too: it has no server/tool keys
            t = {}
        server = php_trim(php_strval(php_coalesce(t.get('server'), '')))
        tool = php_trim(php_strval(php_coalesce(t.get('tool'), '')))
        args = php_coalesce(t.get('args'), [])
        if server == '' or tool == '':
            raise InvalidArgumentException('event_trigger needs an MCP server and a tool')
        if not isinstance(args, (dict, list)) or (isinstance(args, list) and args != []):
            raise InvalidArgumentException('event_trigger.args must be a JSON object')
        return json.dumps({'server': server, 'tool': tool, 'args': args if isinstance(args, dict) else {}},
                          ensure_ascii=False, separators=(',', ':'))

    def _nextCronRun(self, cron: str) -> str:
        return CronExpression(cron).nextAfter(self._now()).strftime('%Y-%m-%d %H:%M:%S')

    def create(self, data: dict) -> dict | None:
        repeatType = php_coalesce(data.get('repeat_type'), 'none')
        cron = php_trim(php_strval(php_coalesce(data.get('cron'), ''))) if repeatType == 'cron' else None
        if repeatType == 'cron' and not CronExpression.isValid(cron):
            raise InvalidArgumentException('Invalid cron expression')
        event = self.eventTrigger(data.get('event_trigger')) if repeatType == 'event' else None
        scheduledTime = data['scheduled_time'] if data.get('scheduled_time') is not None else self._stamp()
        # A cron schedule first fires on its next cron minute; an event schedule never (no next_run:
        # its trigger tool decides, in a compiled --watch); others at the scheduled time.
        if cron is not None:
            nextRun = self._nextCronRun(cron)
        elif event is not None:
            nextRun = None
        else:
            nextRun = scheduledTime
        # event_trigger is written only for event schedules: the others keep working on a database
        # the event migration has not reached yet.
        eventCol = ', event_trigger' if event is not None else ''
        eventVal = ', :event_trigger' if event is not None else ''
        optionId = (php_intval(data['trigger_component_id'])
                    if event is not None and not php_empty(data.get('trigger_component_id')) else None)
        eventCol += ', trigger_component_id' if optionId is not None else ''
        eventVal += ', :trigger_component_id' if optionId is not None else ''

        params = {
            'user_id': data['user_id'],
            'workflow_id': data['workflow_id'],
            'input_prompt': data.get('input_prompt'),
            'scheduled_time': scheduledTime,
            'repeat_type': repeatType,
            'repeat_interval': php_coalesce(data.get('repeat_interval'), 1),
            'cron': cron,
            'next_run': nextRun,
        }
        if event is not None:
            params['event_trigger'] = event
        if optionId is not None:
            params['trigger_component_id'] = optionId
        new_id = self.db.insert(
            "INSERT INTO scheduled_workflows\n"
            "            (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type, repeat_interval, cron, next_run, created_at"
            + eventCol + ")\n"
            "            VALUES\n"
            "            (:user_id, :workflow_id, :input_prompt, :scheduled_time, 'pending', :repeat_type, :repeat_interval, :cron, :next_run, NOW()"
            + eventVal + ")",
            params,
        )

        return self.findById(int(new_id))

    def update(self, id: int, userId: int, data: dict) -> dict | None:
        """PHP 57-104."""
        # First verify ownership
        schedule = self.findById(id)
        if not schedule or schedule['user_id'] != userId:
            return None

        fields = []
        params: dict = {'id': id}

        if data.get('scheduled_time') is not None:
            fields.append('scheduled_time = :scheduled_time')
            fields.append('next_run = :next_run')
            params['scheduled_time'] = data['scheduled_time']
            params['next_run'] = data['scheduled_time']

        if data.get('input_prompt') is not None:
            fields.append('input_prompt = :input_prompt')
            params['input_prompt'] = data['input_prompt']

        if data.get('repeat_type') is not None:
            fields.append('repeat_type = :repeat_type')
            params['repeat_type'] = data['repeat_type']

        if data.get('repeat_interval') is not None:
            fields.append('repeat_interval = :repeat_interval')
            params['repeat_interval'] = data['repeat_interval']

        repeatType = php_coalesce(data.get('repeat_type'), schedule['repeat_type'])
        if 'cron' in data or repeatType == 'cron':
            cron = (php_trim(php_strval(php_coalesce(data.get('cron'), schedule.get('cron'), '')))
                    if repeatType == 'cron' else None)
            if repeatType == 'cron' and not CronExpression.isValid(cron):
                raise InvalidArgumentException('Invalid cron expression')
            fields.append('cron = :cron')
            params['cron'] = cron
            if cron is not None:
                # The cron decides the next run; replace any scheduled_time-derived next_run.
                fields = [f for f in fields if f != 'next_run = :next_run']
                fields.append('next_run = :next_run')
                params['next_run'] = self._nextCronRun(cron)

        # Event: the trigger is (re)validated and next_run cleared; leaving 'event' clears the trigger.
        if repeatType == 'event':
            fields = [f for f in fields if f != 'next_run = :next_run']
            params.pop('next_run', None)
            fields.append('event_trigger = :event_trigger')
            fields.append('next_run = NULL')
            params['event_trigger'] = self.eventTrigger(php_coalesce(data.get('event_trigger'), schedule.get('event_trigger')))
            if 'trigger_component_id' in data:
                fields.append('trigger_component_id = :trigger_component_id')
                params['trigger_component_id'] = (php_intval(data['trigger_component_id'])
                                                  if php_bool(data['trigger_component_id']) else None)
            elif 'event_trigger' in data:   # a hand-made trigger: no longer the option's
                fields.append('trigger_component_id = NULL')
        elif php_coalesce(schedule.get('repeat_type'), '') == 'event':
            fields.append('event_trigger = NULL')
            fields.append('trigger_component_id = NULL')
            if 'next_run = :next_run' not in fields:   # back to a timed schedule: from its time
                fields.append('next_run = :next_run')
                params['next_run'] = schedule['scheduled_time']

        if data.get('status') is not None:
            fields.append('status = :status')
            params['status'] = data['status']

        if not fields:
            return schedule

        sql = "UPDATE scheduled_workflows SET " + ', '.join(fields) + " WHERE id = :id"
        self.db.execute(sql, params)

        return self.findById(id)

    def delete(self, id: int, userId: int) -> bool:
        """PHP 109-117."""
        rowcount = self.db.execute(
            "DELETE FROM scheduled_workflows\n"
            "            WHERE id = :id AND user_id = :user_id",
            {'id': id, 'user_id': userId},
        )
        return rowcount > 0

    def findById(self, id: int) -> dict | None:
        """PHP 122-133."""
        row = self.db.fetch_one(
            "SELECT sw.*, w.name as workflow_name\n"
            "            FROM scheduled_workflows sw\n"
            "            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id\n"
            "            WHERE sw.id = :id",
            {'id': id},
        )
        return row if row else None

    def findByUser(self, userId: int) -> list[dict]:
        """PHP 138-149."""
        return self.db.fetch_all(
            "SELECT sw.*, w.name as workflow_name\n"
            "            FROM scheduled_workflows sw\n"
            "            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id\n"
            "            WHERE sw.user_id = :user_id\n"
            "            ORDER BY sw.next_run ASC",
            {'user_id': userId},
        )

    def findByWorkflow(self, workflowId: int, userId: int) -> list[dict]:
        """PHP 154-165."""
        return self.db.fetch_all(
            "SELECT sw.*, w.name as workflow_name\n"
            "            FROM scheduled_workflows sw\n"
            "            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id\n"
            "            WHERE sw.workflow_id = :workflow_id AND sw.user_id = :user_id\n"
            "            ORDER BY sw.next_run ASC",
            {'workflow_id': workflowId, 'user_id': userId},
        )

    def getDueSchedules(self, workflowIds: list | None = None) -> list[dict]:
        """Due schedules: pending and due, or 'running' for longer than STALE_RUNNING_MINUTES (a crashed
        run). `workflowIds` limits them (spec 2026-10-14 event-worker: only active workflows run)."""
        if workflowIds is not None and len(workflowIds) == 0:
            return []
        only = '' if workflowIds is None else (
            ' AND sw.workflow_id IN (' + ','.join(str(php_intval(i)) for i in workflowIds) + ')')
        now, stale = self._nowAndStale()
        return self.db.fetch_all(
            "SELECT sw.*, w.name as workflow_name, u.email as user_email\n"
            "            FROM scheduled_workflows sw\n"
            "            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id\n"
            "            LEFT JOIN users u ON sw.user_id = u.id\n"
            "            WHERE ((sw.status = 'pending' AND sw.next_run <= :now)\n"
            "               OR (sw.status = 'running' AND (sw.running_since IS NULL OR sw.running_since < :stale)))"
            + only + "\n"
            "            ORDER BY sw.next_run ASC\n"
            "            LIMIT 50",
            {'now': now, 'stale': stale},
        )

    def claim(self, id: int) -> bool:
        """Take a due schedule for this tick. Atomic: of two overlapping ticks, only one gets True.
        A 'running' row older than STALE_RUNNING_MINUTES can be taken again."""
        now, stale = self._nowAndStale()
        rowcount = self.db.execute(
            "UPDATE scheduled_workflows\n"
            "            SET status = 'running', running_since = :now\n"
            "            WHERE id = :id\n"
            "              AND ((status = 'pending' AND next_run <= :due)\n"
            "                   OR (status = 'running' AND (running_since IS NULL OR running_since < :stale)))",
            {'id': id, 'now': now, 'due': now, 'stale': stale},
        )
        return rowcount > 0

    def touchRunning(self, id: int) -> None:
        """Keep a claimed schedule's run fresh: a tick draining it for longer than STALE_RUNNING_MINUTES
        must not have it reclaimed by another tick. Only a running schedule is touched."""
        self.db.execute("UPDATE scheduled_workflows SET running_since = :now WHERE id = :id AND status = 'running'",
                        {'id': id, 'now': self._now().strftime('%Y-%m-%d %H:%M:%S')})

    def markCompleted(self, id: int, executionId: str | None = None) -> None:
        """PHP 202-230. `executionId` is accepted but unused (dead parameter
        in PHP too — kept for call-site parity)."""
        schedule = self.findById(id)
        if not schedule:
            return

        repeatType = schedule['repeat_type']
        repeatInterval = php_intval(schedule['repeat_interval'])

        if repeatType == 'event':
            # An event row has no next run: it runs when its event fires (spec 2026-10-14 event-worker §3).
            self.db.execute("UPDATE scheduled_workflows SET status = 'pending', last_run = NOW(), running_since = NULL WHERE id = :id",
                            {'id': id})
            return

        if repeatType == 'none':
            # One-time schedule - mark as completed
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'completed', last_run = NOW(), running_since = NULL\n"
                "            WHERE id = :id",
                {'id': id},
            )
        else:
            # Recurring - calculate next run and reset to pending
            nextRun = self._calculateNextRun(schedule['next_run'], repeatType, repeatInterval, schedule.get('cron'))
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'pending', last_run = NOW(), running_since = NULL, next_run = :next_run\n"
                "            WHERE id = :id",
                {'id': id, 'next_run': nextRun},
            )

    def markFailed(self, id: int, errorMessage: str) -> None:
        """PHP 235-263."""
        schedule = self.findById(id)
        if not schedule:
            return

        repeatType = schedule['repeat_type']

        if repeatType == 'none':
            # One-time - mark as failed permanently
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'failed', error_message = :error, last_run = NOW(), running_since = NULL\n"
                "            WHERE id = :id",
                {'id': id, 'error': errorMessage},
            )
        else:
            # Recurring - reset to pending for next attempt, but log the error
            repeatInterval = php_intval(schedule['repeat_interval'])
            nextRun = self._calculateNextRun(schedule['next_run'], repeatType, repeatInterval, schedule.get('cron'))
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'pending', error_message = :error, last_run = NOW(), running_since = NULL, next_run = :next_run\n"
                "            WHERE id = :id",
                {'id': id, 'error': errorMessage, 'next_run': nextRun},
            )

    def _calculateNextRun(self, currentRun: str, repeatType: str, interval: int, cron: str | None = None) -> str:
        """PHP 268-292 (`private function calculateNextRun`). `new
        DateTime($currentRun)` parses in PHP's configured default timezone
        (`PHP_TIMEZONE`, Europe/Berlin); `DateInterval` add/day-overflow/DST
        semantics are reproduced by `_add_months` (month overflow) and
        `_shift_out_of_dst_gap` (spring-forward gap normalization) above —
        see the 20-case fixture table in
        tests/unit/test_scheduled_workflow_service.py, generated via
        `php -r` against the live PHP interpreter."""
        if repeatType == 'cron':
            # From now, not from the last next_run: a late tick must not replay missed minutes.
            return self._nextCronRun(php_strval(cron if cron is not None else ''))
        dt = datetime.strptime(currentRun, '%Y-%m-%d %H:%M:%S')

        if repeatType == 'hourly':
            dt = dt + timedelta(hours=interval)
        elif repeatType == 'daily':
            dt = dt + timedelta(days=interval)
        elif repeatType == 'weekly':
            days = interval * 7
            dt = dt + timedelta(days=days)
        elif repeatType == 'monthly':
            dt = _add_months(dt, interval)
        # default: no repeat, unchanged

        dt = _shift_out_of_dst_gap(dt, php_tz())
        return dt.strftime('%Y-%m-%d %H:%M:%S')

    def pause(self, id: int, userId: int) -> bool:
        """PHP 297-306."""
        rowcount = self.db.execute(
            "UPDATE scheduled_workflows\n"
            "            SET status = 'paused'\n"
            "            WHERE id = :id AND user_id = :user_id",
            {'id': id, 'user_id': userId},
        )
        return rowcount > 0

    def resume(self, id: int, userId: int) -> bool:
        """PHP 311-320."""
        rowcount = self.db.execute(
            "UPDATE scheduled_workflows\n"
            "            SET status = 'pending'\n"
            "            WHERE id = :id AND user_id = :user_id AND status = 'paused'",
            {'id': id, 'user_id': userId},
        )
        return rowcount > 0

    def getStats(self, userId: int) -> dict:
        """PHP 325-340."""
        return self.db.fetch_one(
            "SELECT\n"
            "                COUNT(*) as total,\n"
            "                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,\n"
            "                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,\n"
            "                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,\n"
            "                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,\n"
            "                SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused\n"
            "            FROM scheduled_workflows\n"
            "            WHERE user_id = :user_id",
            {'user_id': userId},
        )
