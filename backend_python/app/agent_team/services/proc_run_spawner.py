"""Port of backend/src/AgentTeam/Services/RunSpawner.php and ProcRunSpawner.php.

The event worker's children (spec 2026-10-14 event-worker §3): `python -m scheduler.run_schedule <id>` per event
run (PHP: bin/run-schedule.php), killed past `runLimitS`, and the scheduler tick (`python -m
scheduler.run_scheduled_workflows`), one at a time. Children run with `backendDir` as their working directory;
their output goes to the worker's own stdout/stderr.
"""
from __future__ import annotations

import subprocess
import time
from collections.abc import Callable
from typing import Protocol


class RunSpawner(Protocol):
    def start(self, key: int, scheduleId: int) -> None:
        """Start the run of schedule `scheduleId` for key (a user id)."""

    def done(self) -> dict:
        """{key: exit code} for the runs that ended since the last call."""

    def scheduleTick(self) -> None:
        """Start the scheduler tick for the active schedule-mode workflows, unless the previous one still runs."""


class ProcRunSpawner:
    RUN_MODULE = 'scheduler.run_schedule'
    TICK_MODULE = 'scheduler.run_scheduled_workflows'

    def __init__(self, python: str, backendDir: str, runLimitS: int = 1800, log: Callable[[str], None] | None = None):
        self.python = python
        self.backendDir = backendDir
        self.runLimitS = runLimitS
        self.log = log if log is not None else (lambda line: None)
        self.runs: dict[int, dict] = {}
        self.tick: subprocess.Popen | None = None
        self.tickStarted = 0.0

    def _spawn(self, args: list[str]) -> subprocess.Popen | None:
        try:
            return subprocess.Popen([self.python, '-m', *args], cwd=self.backendDir, stdin=subprocess.DEVNULL)
        except OSError:
            return None

    def start(self, key: int, scheduleId: int) -> None:
        if key in self.runs:
            self.log(f'run for user {key} is still in flight: schedule {scheduleId} not started')
            raise RuntimeError(f'a run for user {key} is still in flight')
        proc = self._spawn([self.RUN_MODULE, str(scheduleId)])
        if proc is None:
            self.log(f'run for user {key} (schedule {scheduleId}) could not start')
        self.runs[key] = {'proc': proc, 'started': time.time()}

    def done(self) -> dict:
        self._reapTick()
        out = {}
        for key, r in list(self.runs.items()):
            proc = r['proc']
            if proc is None:
                out[key] = 127
                del self.runs[key]
                continue
            code = proc.poll()
            if code is None and time.time() - r['started'] > self.runLimitS:
                self.log(f'run for user {key} passed {self.runLimitS} s: killed')
                proc.kill()
                proc.wait()
                code = 137
            if code is not None:
                out[key] = int(code)
                del self.runs[key]
        return out

    def _reapTick(self) -> None:
        """Close a finished tick; kill one past `runLimitS` so a hung tick never blocks the schedule-mode workflows."""
        if self.tick is None:
            return
        if self.tick.poll() is None:
            if time.time() - self.tickStarted <= self.runLimitS:
                return
            self.log(f'scheduler tick passed {self.runLimitS} s: killed')
            self.tick.kill()
            self.tick.wait()
        self.tick = None

    def scheduleTick(self) -> None:
        self._reapTick()
        if self.tick is not None:
            return   # the previous minute's tick still runs
        self.tick = self._spawn([self.TICK_MODULE])
        self.tickStarted = time.time()

    def stopAll(self, graceS: int) -> None:
        """SIGTERM: let the children finish up to `graceS`, then kill them."""
        end = time.time() + graceS
        while (self.runs or self.tick is not None) and time.time() < end:
            self.done()
            time.sleep(0.2)
        if self.tick is not None:
            self.tick.kill()
            self.tick.wait()
            self.tick = None
        for r in self.runs.values():
            if r['proc'] is not None:
                r['proc'].kill()
