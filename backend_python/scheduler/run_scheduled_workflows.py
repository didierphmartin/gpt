"""Port of backend/scheduler/run-scheduled-workflows.php (CLI branch).

Runs one scheduler tick (ScheduleTick) over the active schedule-mode workflows. Called by cron, or by the event
worker (scheduler/event_worker.py) once a minute while a schedule-mode workflow is active:

    * * * * * cd /path/to/backend_python && .venv/bin/python \\
        -m scheduler.run_scheduled_workflows >> /var/log/workflow-scheduler.log 2>&1

(documentation only -- do not install this crontab line yourself.)

The PHP file's HTTP branch (token-gated, JSON body) is served here by SchedulerController.run's
POST /api/v1/scheduler/run route. Command-line arguments are ignored, as in PHP.
"""
from __future__ import annotations

import sys

from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.agent_team.services.schedule_tick import ScheduleTick
from app.support.logger import error_log
from app.support.phpcompat import php_now
from scheduler.bootstrap import boot


def _log(line: str) -> None:
    print(f'[{php_now()}] {line}')


def main(argv: list[str] | None = None) -> int:
    try:
        b = boot()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1
    try:
        return _run(b)
    finally:
        b['close']()


def _run(b: dict) -> int:
    tick = ScheduleTick(b['schedules'], b['runSchedule'], _log)
    # Only the active schedule-mode workflows run (spec 2026-10-14 event-worker §3). A missing active_workflows
    # table (not migrated yet) must not break the tick: then nothing is due, never every schedule.
    try:
        activeWorkflowIds = ActiveWorkflowService(b['pdo']).scheduleWorkflowIds()
    except Exception as e:  # noqa: BLE001 -- PHP catch (\Throwable)
        error_log(f'Scheduler: active workflows unavailable, running none: {e}')
        print(f'Scheduler: active workflows unavailable, running none: {e}', file=sys.stderr)
        activeWorkflowIds = []
    results = tick.run(activeWorkflowIds)
    print(f"[{php_now()}] Completed: {results['executed_count']} succeeded, {results['failed_count']} failed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
