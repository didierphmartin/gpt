"""Port of backend/src/AgentTeam/Services/WorkflowRunLog.php (79 lines).

Per-run append-only event log. One JSONL file per workflow run, written as
events are emitted, so a run is debuggable after it ends, dies, loops, or its
SSE stream drops. Read back by the node form via the runEvents endpoint
(WorkflowController::runEvents, PHP 1159-1183).

Directory resolution (PHP `defaultDir`, PHP 21-25):
`$config['workflow_runs_dir'] ?? (dirname(__DIR__, 3) . '/storage/workflow-runs')`.
`__DIR__` for WorkflowRunLog.php is `backend/src/AgentTeam/Services`;
`dirname(..., 3)` walks up 3 levels (Services -> AgentTeam -> src -> backend),
landing on `backend/`, so the default resolves to
`<htdocs>/gpt/backend/storage/workflow-runs`. Verified 2026-09-07 via:

    php -r '$dir = ".../gpt/backend/src/AgentTeam/Services";
            echo dirname($dir, 3) . "/storage/workflow-runs";'
    => /Applications/XAMPP/xamppfiles/htdocs/gpt/backend/storage/workflow-runs

and confirmed live: that directory exists on disk with real *.jsonl run
files (82 entries as of 2026-09-07), and no `workflow_runs_dir` config key is
set anywhere in the live PHP config, so the default always applies. That is
`PHP_BACKEND / 'storage' / 'workflow-runs'` here (PHP_BACKEND =
`.../gpt/backend`) — NOT `PHP_BACKEND.parent`, unlike
`workflow_output_storage.py`'s base path (that file is 4 `..` up from
`__DIR__`, landing one level higher, on `gpt/`; this one is only 3 `..` up,
landing on `gpt/backend/`). Using the identical directory (not a
`backend_python`-local copy) is required so a run started by either backend
is readable by the other's runEvents endpoint.
"""
from __future__ import annotations

import os
import re

from app.config import PHP_BACKEND
from app.support.logger import error_log
from app.support.phpjson import dumps, php_json_decode

_RUN_ID_RE = re.compile(r'^[a-f0-9]{32}$')

_DEFAULT_BASE_DIR = str(PHP_BACKEND / 'storage' / 'workflow-runs')


class WorkflowRunLog:
    def __init__(self, base_dir: str):
        self.baseDir = base_dir.rstrip('/')

    @staticmethod
    def defaultDir(config: dict | None = None) -> str:
        """PHP 21-25."""
        config = config or {}
        override = config.get('workflow_runs_dir')
        return override if override is not None else _DEFAULT_BASE_DIR

    def pathFor(self, run_id: str) -> str:
        """PHP 27-30."""
        return self.baseDir + '/' + run_id + '.jsonl'

    @staticmethod
    def _isValidRunId(run_id: str) -> bool:
        """PHP 32-35."""
        return bool(_RUN_ID_RE.match(run_id))

    def append(self, run_id: str, event: dict) -> None:
        """PHP 37-59. Best-effort: every failure is logged, never raised —
        a broken run log must not take down the run itself."""
        if not self._isValidRunId(run_id):
            error_log('[WorkflowRunLog] refusing append for invalid runId')
            return
        try:
            if not os.path.isdir(self.baseDir):
                try:
                    os.makedirs(self.baseDir, mode=0o775, exist_ok=True)
                except OSError:
                    pass  # PHP: @mkdir() with the error-suppression operator
            try:
                # json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
                # (PHP 47) == phpjson.dumps (app/support/phpjson.py docstring:
                # unescaped slashes and non-ASCII, same as this module's default).
                line = dumps(event)
            except (TypeError, ValueError) as e:
                error_log(f'[WorkflowRunLog] json_encode failed for runId={run_id}')
                return
            try:
                with open(self.pathFor(run_id), 'a', encoding='utf-8') as fh:
                    # LOCK_EX (PHP FILE_APPEND | LOCK_EX) has no direct cross-platform
                    # stdlib equivalent; append-mode + GIL-serialized single-process
                    # writes give the same effective guarantee this process needs.
                    fh.write(line + '\n')
            except OSError:
                error_log(f'[WorkflowRunLog] write failed for runId={run_id}')
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            error_log(f'[WorkflowRunLog] append failed for runId={run_id}: {e}')

    def read(self, run_id: str) -> list | None:
        """PHP 61-78. None for an invalid id or a run that was never
        written; otherwise the list of decoded JSON events, skipping any
        line that isn't valid JSON or doesn't decode to an array (mirrors
        PHP's `is_array($decoded)` guard)."""
        if not self._isValidRunId(run_id):
            return None
        path = self.pathFor(run_id)
        if not os.path.isfile(path):
            return None
        events = []
        with open(path, 'r', encoding='utf-8') as fh:
            for raw_line in fh:
                line = raw_line.rstrip('\n').rstrip('\r')
                if line == '':
                    continue
                decoded = php_json_decode(line)
                if isinstance(decoded, (list, dict)):
                    events.append(decoded)
        return events
