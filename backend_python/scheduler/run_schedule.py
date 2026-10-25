"""Port of backend/bin/run-schedule.php.

One event's runs (spec 2026-10-14 event-worker §3): the event worker starts this for a `ready`. Runs the workflow
of the event row <id> with the drain rule, records last_run, prints one JSON line. Exit 0 ok, 1 failed.

    cd backend_python && .venv/bin/python -m scheduler.run_schedule <schedule id>
"""
from __future__ import annotations

import json
import sys

from app.agent_team.services.schedule_tick import ScheduleTick
from app.support.phpcompat import php_intval


def _out(line: dict, code: int) -> int:
    print(json.dumps(line, separators=(',', ':'), ensure_ascii=True))
    return code


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    b = None
    try:
        from scheduler.bootstrap import boot
        b = boot()
        id = php_intval(argv[0] if argv else 0)
        schedule = b['schedules'].findById(id)
        if not schedule or (schedule.get('repeat_type') or '') != 'event':
            return _out({'ok': False, 'error': f'schedule #{id} is not an event schedule'}, 1)
        r = ScheduleTick.drain(lambda: b['runSchedule'](schedule))
        b['schedules'].markCompleted(id)   # last_run; an event row keeps no next_run
        return _out({'ok': True, **r}, 0)
    except Exception as e:  # noqa: BLE001 -- PHP catch (\Throwable)
        return _out({'ok': False, 'error': str(e)}, 1)
    finally:
        if b is not None:
            b['close']()


if __name__ == '__main__':
    sys.exit(main())
