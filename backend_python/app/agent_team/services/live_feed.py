"""Port of backend/src/AgentTeam/Services/LiveFeed.php and LiveStream.php.

LiveFeed: what the live overlay has not shown yet of a workflow's runs (spec 2026-10-15 live-overlay §3.2). The
cursor is "<runId>:<complete lines read>". On a first connect only a run in progress is replayed (finished runs are
in Conversations); a run the pointer names that is not the cursor's is read from its first line, once it has shown
it is a real run: a quiet poll (ScheduleTick.drain re-runs until a run finds nothing) writes Start and the trigger
node, then is unlinked without a workflow_complete, so a run is held back until a work node or its end appears.
When the pointer has moved on, what the cursor's run wrote after the cursor is sent first.

LiveStream: one connection of the live overlay (§3.3): every 0.5 s the run events after the cursor, the active
row every 5 s, a ping every 15 s, then "bye" with the cursor the client reconnects from. Clock, sleep and output
are injected so the loop is testable.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable

from app.agent_team.services.start_option_graph import StartOptionGraph
from app.support.phpcompat import is_numeric, php_intval

_CURSOR = re.compile(r'^([a-f0-9]{32}):(\d+)$')


class LiveFeed:
    @classmethod
    def next(cls, log, workflowId: int, cursor: str | None) -> dict:
        curRun, curLines = cls._parse(cursor)
        runId = log.current(workflowId)
        tail = []
        if curRun is not None and curRun != runId:
            prev = cls._read(log, curRun)
            if prev is not None:
                tail = prev[curLines:]
                cursor = f'{curRun}:{max(curLines, len(prev))}'
        events = None if runId is None else cls._read(log, runId)
        if events is None:
            return {'events': tail, 'cursor': cursor}
        nxt = f'{runId}:{len(events)}'
        if curRun == runId:
            return {'events': events[curLines:], 'cursor': nxt}
        if not cls._real(events):
            return {'events': tail, 'cursor': cursor}
        if curRun is None and cls._finished(events):
            return {'events': [], 'cursor': nxt}
        return {'events': tail + events, 'cursor': nxt}

    @staticmethod
    def _read(log, runId: str) -> list | None:
        """The run's complete lines, or None when its file is gone."""
        try:
            with open(log.pathFor(runId), encoding='utf-8') as fh:
                raw = fh.read()
        except (OSError, ValueError):
            return None
        complete = raw[:raw.rfind('\n') + 1] if '\n' in raw else ''   # whole lines only: the runner may be mid-append
        events = []
        for line in ([] if complete == '' else complete.rstrip('\n').split('\n')):
            try:
                e = json.loads(line)
            except ValueError:
                e = None
            events.append(e if isinstance(e, dict) else {'type': 'unreadable'})
        return events

    @classmethod
    def _real(cls, events: list) -> bool:
        """A work node ran (not Start, not the Start option's trigger node) or the run ended."""
        for e in events:
            if (e.get('type') in ('node_start', 'node_complete') and e.get('node_type') != 'start'
                    and is_numeric(e.get('node_id')) and php_intval(e['node_id']) < StartOptionGraph.ID_OFFSET):
                return True
        return cls._finished(events)

    @staticmethod
    def _finished(events: list) -> bool:
        return any(e.get('type') in ('workflow_complete', 'workflow_error') for e in events)

    @staticmethod
    def _parse(cursor: str | None) -> tuple[str | None, int]:
        m = _CURSOR.match(cursor) if cursor is not None else None
        if m:
            return m.group(1), int(m.group(2))
        return None, 0


class LiveStream:
    @staticmethod
    def run(next: Callable, state: Callable, emit: Callable, sleep: Callable, now: Callable, aborted: Callable,
            cursor: str | None, maxSeconds: float = 50.0) -> str | None:
        start = now()
        stateAt = None
        pingAt = start
        while now() - start < maxSeconds:
            if aborted():
                return cursor
            r = next(cursor)
            for e in r['events']:
                emit('run', {'cursor': r['cursor'], 'event': e})
            cursor = r['cursor']
            if stateAt is None or now() - stateAt >= 5.0:
                emit('state', {'active': state()})
                stateAt = now()
            if now() - pingAt >= 15.0:
                emit('ping', {})
                pingAt = now()
            sleep(0.5)
        emit('bye', {'cursor': cursor})
        return cursor
