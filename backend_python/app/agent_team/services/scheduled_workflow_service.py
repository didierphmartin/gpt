"""Port of backend/src/AgentTeam/Services/ScheduledWorkflowService.php (341 lines).

Handles CRUD operations and scheduling logic for workflow schedules. No
model class ports PHP's row shape here (PHP returns plain associative
arrays from every method — no `new Scheduled...`/`toArray()` in the source),
so this port returns dicts in PHP's key order too.
"""
from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone

from app.support.phpcompat import php_coalesce, php_intval, php_tz


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
    def __init__(self, db):
        self.db = db

    def create(self, data: dict) -> dict | None:
        """PHP 28-52."""
        scheduled_time = data['scheduled_time']
        next_run = scheduled_time  # First run is the scheduled time

        new_id = self.db.insert(
            "INSERT INTO scheduled_workflows\n"
            "            (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type, repeat_interval, next_run, created_at)\n"
            "            VALUES\n"
            "            (:user_id, :workflow_id, :input_prompt, :scheduled_time, 'pending', :repeat_type, :repeat_interval, :next_run, NOW())",
            {
                'user_id': data['user_id'],
                'workflow_id': data['workflow_id'],
                'input_prompt': data.get('input_prompt'),
                'scheduled_time': scheduled_time,
                'repeat_type': php_coalesce(data.get('repeat_type'), 'none'),
                'repeat_interval': php_coalesce(data.get('repeat_interval'), 1),
                'next_run': next_run,
            },
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

    def getDueSchedules(self) -> list[dict]:
        """PHP 170-184."""
        return self.db.fetch_all(
            "SELECT sw.*, w.name as workflow_name, u.email as user_email\n"
            "            FROM scheduled_workflows sw\n"
            "            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id\n"
            "            LEFT JOIN users u ON sw.user_id = u.id\n"
            "            WHERE sw.status = 'pending'\n"
            "              AND sw.next_run <= NOW()\n"
            "            ORDER BY sw.next_run ASC\n"
            "            LIMIT 50"
        )

    def markRunning(self, id: int) -> None:
        """PHP 189-197."""
        self.db.execute(
            "UPDATE scheduled_workflows\n"
            "            SET status = 'running'\n"
            "            WHERE id = :id",
            {'id': id},
        )

    def markCompleted(self, id: int, executionId: str | None = None) -> None:
        """PHP 202-230. `executionId` is accepted but unused (dead parameter
        in PHP too — kept for call-site parity)."""
        schedule = self.findById(id)
        if not schedule:
            return

        repeatType = schedule['repeat_type']
        repeatInterval = php_intval(schedule['repeat_interval'])

        if repeatType == 'none':
            # One-time schedule - mark as completed
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'completed', last_run = NOW()\n"
                "            WHERE id = :id",
                {'id': id},
            )
        else:
            # Recurring - calculate next run and reset to pending
            nextRun = self._calculateNextRun(schedule['next_run'], repeatType, repeatInterval)
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'pending', last_run = NOW(), next_run = :next_run\n"
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
                "            SET status = 'failed', error_message = :error, last_run = NOW()\n"
                "            WHERE id = :id",
                {'id': id, 'error': errorMessage},
            )
        else:
            # Recurring - reset to pending for next attempt, but log the error
            repeatInterval = php_intval(schedule['repeat_interval'])
            nextRun = self._calculateNextRun(schedule['next_run'], repeatType, repeatInterval)
            self.db.execute(
                "UPDATE scheduled_workflows\n"
                "            SET status = 'pending', error_message = :error, last_run = NOW(), next_run = :next_run\n"
                "            WHERE id = :id",
                {'id': id, 'error': errorMessage, 'next_run': nextRun},
            )

    def _calculateNextRun(self, currentRun: str, repeatType: str, interval: int) -> str:
        """PHP 268-292 (`private function calculateNextRun`). `new
        DateTime($currentRun)` parses in PHP's configured default timezone
        (`PHP_TIMEZONE`, Europe/Berlin); `DateInterval` add/day-overflow/DST
        semantics are reproduced by `_add_months` (month overflow) and
        `_shift_out_of_dst_gap` (spring-forward gap normalization) above —
        see the 20-case fixture table in
        tests/unit/test_scheduled_workflow_service.py, generated via
        `php -r` against the live PHP interpreter."""
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
