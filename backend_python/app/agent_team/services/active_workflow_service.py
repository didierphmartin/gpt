"""Port of backend/src/AgentTeam/Services/ActiveWorkflowService.php and ActiveWorkflowError.php.

The workflow each user activated with ▶ on Start (spec 2026-10-14 event-worker): the event worker runs it on its
schedule, or on its Start option's event. One per user. Ticking a mode never activates; a mode change deactivates.
"""
from __future__ import annotations

import json
from datetime import datetime

from app.support.phpcompat import php_bool, php_intval, php_trim


class ActiveWorkflowError(RuntimeError):
    """A refused activation (spec 2026-10-14 event-worker §2): kind for the editor, status for the API."""

    def __init__(self, kind: str, message: str, status: int):
        super().__init__(message)
        self.kind = kind
        self.status = status


def _ts(v) -> int:
    """strtotime() of a DB 'Y-m-d H:i:s' value."""
    return int(datetime.fromisoformat(str(v).strip().replace('T', ' ')).timestamp())


class ActiveWorkflowService:
    TIMED = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'cron']

    def __init__(self, db):
        self.db = db

    def mode(self, workflowId: int) -> dict:
        """The workflow's input mode, read from its saved data as the editor's StartOptions.active() reads it: the
        newest pending/running schedule row decides; an event row counts only while Start is on that row's option."""
        row = self.db.fetch_one("SELECT * FROM scheduled_workflows WHERE workflow_id = ? AND status IN ('pending', 'running')\n"
                                "            ORDER BY id DESC LIMIT 1", [workflowId])
        if row is None:
            return {'mode': 'prompt', 'schedule': None, 'component_id': None}
        if (row.get('repeat_type') if row.get('repeat_type') is not None else '') != 'event':
            return {'mode': 'schedule' if row.get('repeat_type') in self.TIMED else 'mode_gone',
                    'schedule': row, 'component_id': None}
        cid = php_intval(row.get('trigger_component_id') if row.get('trigger_component_id') is not None else 0)
        start = self._startNode(workflowId)
        onIt = (cid > 0 and start is not None
                and php_intval(start['config'].get('start_option') if start['config'].get('start_option') is not None else 0) == cid
                and self._isOption(cid))
        return {'mode': 'option' if onIt else 'mode_gone', 'schedule': row, 'component_id': cid if cid else None}

    def startHasLinks(self, workflowId: int) -> bool:
        """Only what Start reaches is active: a Start with no outgoing edge has nothing to run."""
        start = self._startNode(workflowId)
        if start is None:
            return False
        n = self.db.fetch_column('SELECT COUNT(*) FROM workflow_edges WHERE from_node_id = ?', [start['id']])
        return php_intval(n[0] if n else 0) > 0

    def activate(self, userId: int, workflowId: int) -> dict:
        wf = self.db.fetch_one('SELECT id, user_id, name FROM agent_workflows WHERE id = ?', [workflowId])
        if not wf or php_intval(wf['user_id']) != userId:
            raise ActiveWorkflowError('not_found', 'Workflow not found', 404)
        mode = self.mode(workflowId)
        if mode['mode'] not in ('schedule', 'option'):
            raise ActiveWorkflowError('no_trigger', 'Pick Set Schedule or a code option first', 422)
        if not self.startHasLinks(workflowId):
            raise ActiveWorkflowError('no_links', 'Start has no links', 422)
        before = self.get(userId)
        replaced = ({'workflow_id': php_intval(before['workflow_id']), 'workflow_name': before['workflow_name']}
                    if before and php_intval(before['workflow_id']) != workflowId else None)
        self.db.begin()
        try:
            self.db.execute('DELETE FROM active_workflows WHERE user_id = ?', [userId])
            self.db.execute("INSERT INTO active_workflows (user_id, workflow_id, mode, trigger_component_id, activated_at, watch_state)\n"
                            "                VALUES (?, ?, ?, ?, NOW(), 'starting')",
                            [userId, workflowId, mode['mode'], mode['component_id']])
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return {'active': self.get(userId), 'replaced': replaced}

    def deactivate(self, userId: int, workflowId: int) -> None:
        self.db.execute('DELETE FROM active_workflows WHERE user_id = ? AND workflow_id = ?', [userId, workflowId])

    def get(self, userId: int) -> dict | None:
        """The user's active row, or None; ages in seconds from the database's NOW() (the worker's clock)."""
        row = self.db.fetch_one('SELECT a.*, w.name AS workflow_name, NOW() AS db_now FROM active_workflows a\n'
                                '            LEFT JOIN agent_workflows w ON w.id = a.workflow_id WHERE a.user_id = ?', [userId])
        if not row:
            return None
        now = _ts(row['db_now'])
        row['checked_age_s'] = now - _ts(row['watch_checked_at']) if php_bool(row.get('watch_checked_at')) else None
        row['activated_age_s'] = now - _ts(row['activated_at'])
        del row['db_now']
        return row

    def all(self) -> list[dict]:
        """Every active row with its workflow's owner and enabled flag (the worker's reconcile)."""
        return self.db.fetch_all('SELECT a.*, w.user_id AS owner_id, w.enabled FROM active_workflows a\n'
                                 '            JOIN agent_workflows w ON w.id = a.workflow_id ORDER BY a.user_id')

    def check(self, row: dict) -> dict:
        """Whether the worker may serve the row now; a row that may not is idle, not deactivated (fixing it resumes it)."""
        mode = self.mode(php_intval(row['workflow_id']))
        if php_intval(row.get('enabled') if row.get('enabled') is not None else 1) != 1:
            reason = 'disabled'
        elif mode['mode'] != row['mode']:
            reason = 'mode_gone'
        elif not self.startHasLinks(php_intval(row['workflow_id'])):
            reason = 'no_links'
        else:
            reason = None
        return {'ok': reason is None, 'reason': reason, 'mode': mode}

    def sweep(self) -> list[int]:
        """Deactivate the rows whose workflow's mode (or option) is no longer the one activated; returns their workflow ids."""
        gone = []
        for row in self.all():
            mode = self.mode(php_intval(row['workflow_id']))
            same = (mode['mode'] == row['mode']
                    and (row['mode'] != 'option'
                         or php_intval(mode['component_id']) == php_intval(row['trigger_component_id'])))
            if not same:
                self.deactivate(php_intval(row['user_id']), php_intval(row['workflow_id']))
                gone.append(php_intval(row['workflow_id']))
        return gone

    def setState(self, userId: int, state: str, message: str | None) -> None:
        self.db.execute('UPDATE active_workflows SET watch_state = ?, watch_message = ?, watch_checked_at = NOW() WHERE user_id = ?',
                        [state, message, userId])

    def scheduleWorkflowIds(self) -> list[int]:
        """The schedule-mode workflows the scheduler tick may run: only the rows that qualify now (check(): enabled,
        Start linked, still in schedule mode), the ones the worker shows as scheduled -- an idle one must not run."""
        return [php_intval(row['workflow_id']) for row in self.all()
                if row['mode'] == 'schedule' and self.check(row)['ok']]

    def _startNode(self, workflowId: int) -> dict | None:
        """The workflow's Start node (not its other nodes), config decoded."""
        row = self.db.fetch_one("SELECT id, config FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'start' ORDER BY id LIMIT 1",
                                [workflowId])
        if not row:
            return None
        cfg = None
        if isinstance(row['config'], str):
            try:
                cfg = json.loads(row['config'])
            except ValueError:
                cfg = None
        return {'id': php_intval(row['id']), 'config': cfg if isinstance(cfg, dict) else {}}

    def _isOption(self, componentId: int) -> bool:
        t = self.db.fetch_column('SELECT start_trigger FROM code_components WHERE id = ?', [componentId])
        t = t[0] if t else None
        return isinstance(t, str) and php_trim(t) != '' and php_trim(t) != 'null'
