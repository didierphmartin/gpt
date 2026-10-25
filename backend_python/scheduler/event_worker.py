"""Port of backend/bin/event-worker.php.

The event worker (spec 2026-10-14 event-worker): runs each user's active workflow -- on its schedule, or on its
Start option's event -- until SIGTERM / SIGINT.

    cd backend_python && .venv/bin/python -m scheduler.event_worker

Only one worker runs at a time (an exclusive lock on ~/Library/Caches/synergyai-event-worker.lock, shared with
the PHP worker so a PHP and a Python worker never both hold a wait on the same mailbox).
"""
from __future__ import annotations

import fcntl
import os
import signal
import sys
import time
import traceback

import pymysql

from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.agent_team.services.event_worker import EventWorker
from app.agent_team.services.proc_run_spawner import ProcRunSpawner
from app.agent_team.services.watch_call import WatchCall
from app.agent_team.services.watch_transport import HttpWatchTransport
from app.config import load_config
from app.db import open_primary
from app.support.phpcompat import php_now


def _log(line: str) -> None:
    print(f'[{php_now()}] {line}', flush=True)


def main() -> int:
    config = load_config()
    backendDir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # One worker at a time: a second one would hold a second wait on the same mailbox and run the workflow twice.
    # The lock is held for the process's lifetime and freed by the OS on exit; children do not inherit it.
    lockPath = os.path.join(os.environ.get('HOME') or '/Users/didierphmartin', 'Library/Caches/synergyai-event-worker.lock')
    os.makedirs(os.path.dirname(lockPath), mode=0o755, exist_ok=True)
    try:
        lock = open(lockPath, 'a')   # noqa: SIM115 -- held until exit
    except OSError:
        _log(f'cannot open the lock file {lockPath}')
        return 1
    os.set_inheritable(lock.fileno(), False)
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        _log(f'another event worker is running (lock {lockPath} held): exiting')
        return 0

    stop = {'v': False}

    def on_signal(signum, frame):
        stop['v'] = True
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    transport = HttpWatchTransport()
    runs = ProcRunSpawner(sys.executable, backendDir, 1800, _log)
    worker = None
    db = None
    lastPing = 0.0
    _log(f'event worker started (pid {os.getpid()})')
    while not stop['v']:
        try:
            if worker is None:
                db = open_primary(config)
                conn = db
                worker = EventWorker(ActiveWorkflowService(conn),
                                     lambda user, name: WatchCall.server(conn, user, name),
                                     transport, runs, time.time, _log)
            # EventWorker.step() swallows its own errors, so a dead connection is found here, every 5 s.
            if time.time() - lastPing >= 5.0:
                db.fetch_column('SELECT 1')
                lastPing = time.time()
            worker.step()
            transport.wait(1.0)
        except pymysql.err.Error as e:
            # The database went away: keep the waits, reconnect in 10 s (spec §4).
            _log(f'database: {e} -- retrying in 10 s')
            if db is not None:
                db.close()
            worker = None
            db = None
            lastPing = 0.0
            time.sleep(10)
        except Exception as e:  # noqa: BLE001 -- a bug must not kill the process: log it, carry on after 1 s
            tb = traceback.extract_tb(e.__traceback__)
            where = f' at {tb[-1].filename}:{tb[-1].lineno}' if tb else ''
            _log(f'{type(e).__name__}: {e}{where}')
            time.sleep(1)
    _log('stopping: letting runs finish (≤ 30 s)')
    if worker is not None:
        worker.stop()
    runs.stopAll(30)
    transport.close()
    _log('event worker stopped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
