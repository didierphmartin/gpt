"""Port of backend/src/Playbook/PlaybookRunState.php (205 lines).

Uses the app's `Db` wrapper (fetch_one/fetch_all/execute/insert) rather than
raw PDO — see app/db.py. Every SQL statement below is copied byte-identical
from the PHP source (only the placeholder style is unchanged: `?`).
"""
from __future__ import annotations

from typing import Callable, Optional

from app.support.phpcompat import php_now
from app.support.phpjson import dumps as _json_dumps


class PlaybookRunState:
    REDACTED = '«redacted»'

    def __init__(self, db, transcript):
        self._conn = db
        self.transcript = transcript
        # fn(): Db — builds a FRESH connection after disconnect()
        self._reconnector: Optional[Callable[[], object]] = None

    def setReconnector(self, fn: Callable[[], object]) -> None:
        self._reconnector = fn

    def disconnect(self) -> None:
        """Drop the DB connection on purpose (no-op without a reconnector).
        Called before blocking on a human gate: the remote MySQL kills idle
        connections after ~60s, so a connection held across a gate wait is a
        guaranteed "server has gone away" (observed live 2026-09-01, run 18)."""
        if self._reconnector is not None:
            self._conn = None

    def _db(self):
        """Current connection, lazily rebuilt after disconnect()."""
        if self._conn is None:
            self._conn = self._reconnector()
        return self._conn

    def createRun(self, userId: int, doc, requester: dict, variables: dict) -> int:
        now = php_now()
        return self._db().insert(
            'INSERT INTO playbook_runs\n'
            '                (user_id, playbook_title, document, status, requester, variables, pending_gate, current_leg, coverage, created_at, updated_at, resolved_at)\n'
            '             VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, NULL)',
            [
                userId,
                doc.title,
                _json_dumps(doc.toArray()),
                'running',
                _json_dumps(requester),
                _json_dumps(variables),
                now,
                now,
            ],
        )

    def setStatus(self, runId: int, status: str) -> None:
        self._db().execute(
            'UPDATE playbook_runs SET status = ?, updated_at = ? WHERE id = ?',
            [status, php_now(), runId],
        )

    def addMessage(self, runId: int, direction: str, audience: Optional[str], text: str, sensitive: bool = False) -> None:
        self._db().execute(
            'INSERT INTO playbook_run_messages (run_id, direction, audience, text, `sensitive`, created_at)\n'
            '             VALUES (?, ?, ?, ?, ?, ?)',
            [
                runId,
                direction,
                audience,
                self.REDACTED if sensitive else text,
                1 if sensitive else 0,
                php_now(),
            ],
        )

    def addNote(self, runId: int, text: str, author: str = 'agent') -> None:
        self._db().execute(
            'INSERT INTO playbook_run_notes (run_id, author, text, created_at) VALUES (?, ?, ?, ?)',
            [runId, author, text, php_now()],
        )

    def ledgerAppend(
        self,
        runId: int,
        leg: int,
        actionName: str,
        tool: str,
        args: dict,
        outcome: str,
        summary: Optional[str],
        sensitive: bool = False,
    ) -> None:
        seqValues = self._db().fetch_column(
            'SELECT COALESCE(MAX(seq), 0) FROM playbook_run_ledger WHERE run_id = ?',
            [runId],
        )
        currentMax = seqValues[0] if seqValues else 0
        seq = 1 + int(currentMax)

        argsJson = _json_dumps(self.REDACTED) if sensitive else self._canon(args)
        resultSummary = self.REDACTED if sensitive else summary

        self._db().execute(
            'INSERT INTO playbook_run_ledger\n'
            '                (run_id, leg, seq, action_name, tool, args, outcome, result_summary, returned_ids, `sensitive`, duration_ms, created_at)\n'
            '             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)',
            [
                runId,
                leg,
                seq,
                actionName,
                tool,
                argsJson,
                outcome,
                resultSummary,
                1 if sensitive else 0,
                php_now(),
            ],
        )

    def ledgerFindOk(self, runId: int, tool: str, args: dict) -> Optional[dict]:
        return self._db().fetch_one(
            "SELECT * FROM playbook_run_ledger WHERE run_id = ? AND tool = ? AND outcome = 'ok' AND args = ?\n"
            '             ORDER BY seq DESC',
            [runId, tool, self._canon(args)],
        )

    def gateOpen(self, runId: int, leg: int, kind: str, args: dict, askedOf: str) -> int:
        return self._db().insert(
            'INSERT INTO playbook_run_gates (run_id, leg, kind, args, asked_of, opened_at, closed_at, decision, actor)\n'
            '             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)',
            [
                runId,
                leg,
                kind,
                _json_dumps(args),
                askedOf,
                php_now(),
            ],
        )

    def gateClose(self, gateId: int, decision: dict, actor: str) -> None:
        self._db().execute(
            'UPDATE playbook_run_gates SET closed_at = ?, decision = ?, actor = ? WHERE id = ?',
            [php_now(), _json_dumps(decision), actor, gateId],
        )

    def getRun(self, runId: int) -> dict:
        row = self._db().fetch_one('SELECT * FROM playbook_runs WHERE id = ?', [runId])
        return row if row is not None else {}

    def ledgerAll(self, runId: int) -> list:
        rows = self._db().fetch_all(
            'SELECT * FROM playbook_run_ledger WHERE run_id = ? ORDER BY seq ASC',
            [runId],
        )
        return rows or []

    def _canon(self, a: dict) -> str:
        """Recursively ksort then json_encode so identical args match regardless of key order."""
        return _json_dumps(self._ksortRecursive(a))

    def _ksortRecursive(self, a):
        if isinstance(a, dict):
            return {k: self._ksortRecursive(v) for k, v in sorted(a.items(), key=lambda kv: kv[0])}
        if isinstance(a, list):
            return [self._ksortRecursive(v) for v in a]
        return a
