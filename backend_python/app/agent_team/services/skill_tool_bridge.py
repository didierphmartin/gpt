"""File-based rendezvous between a workflow run (Python/SSE) and the
browser-side Pyodide dispatcher.

When the runner detects a `run_skill_script` tool call, it emits an
SSE event with a generated tool_call_id and then blocks on
awaitResult(). The browser runs the script, POSTs the result to
/api/v1/workflows/tool-result, the controller calls writeResult(),
the runner picks it up and continues.

Single-user, single-worker ergonomics — no DB, just /tmp files.
Polls every 100ms with a configurable timeout; default 5 minutes
matches the chat dispatcher's outer envelope.

Tool-call ids are 32-char random hex (~128 bits) so a forged POST
to the result endpoint can't collide with a real pending call.

Ported from backend/src/AgentTeam/Services/SkillToolBridge.php. The bridge
directory is read from env SKILL_TOOL_BRIDGE_DIR at call time (not import
time) so tests can monkeypatch it per test; default matches PHP's
sys_get_temp_dir() . '/synergy-workflow-tool' on this deployment.
"""
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Optional, Union

from app.support import phpjson


class SkillToolBridge:
    POLL_INTERVAL_US = 100_000     # 100 ms
    DEFAULT_TIMEOUT_MS = 300_000   # 5 min

    @staticmethod
    def generateToolCallId() -> str:
        return secrets.token_hex(16)

    def awaitResult(self, toolCallId: str, timeoutMs: int = DEFAULT_TIMEOUT_MS) -> Optional[Union[dict, list]]:
        """Block until the browser writes a result file for toolCallId, or
        the timeout expires. Returns the decoded result (dict or list) on
        success, None on timeout or malformed content."""
        path = self._resultPath(toolCallId)
        deadline = time.time() + (timeoutMs / 1000)
        while time.time() < deadline:
            if os.path.isfile(path):
                try:
                    raw = Path(path).read_text()
                except OSError:
                    raw = None
                try:
                    os.unlink(path)
                except OSError:
                    pass
                if raw is None:
                    return None
                try:
                    decoded = json.loads(raw)
                except ValueError:
                    return None
                return decoded if isinstance(decoded, (dict, list)) else None
            time.sleep(0.1)
        return None

    def writeResult(self, toolCallId: str, result: Union[dict, list]) -> None:
        """Write the browser's result for toolCallId. Idempotent: if the
        file already exists (browser POSTed twice for the same call),
        the latest write wins."""
        d = self._dir()
        if not os.path.isdir(d):
            # World-writable on purpose: XAMPP/Apache can run children under
            # MIXED uids, and the writer (tool-result POST) and the reader
            # (the blocked run) may land on children with different uids. A
            # 0700 dir owned by one uid made the other's write fail silently
            # and the waiting leg poll forever (observed live 2026-09-01,
            # playbook runs 14/15). Tool-call ids are 128-bit secrets, so a
            # shared dir leaks nothing.
            try:
                os.makedirs(d, mode=0o777, exist_ok=True)
            except OSError:
                pass
            try:
                os.chmod(d, 0o777)  # mkdir mode is masked by umask; force it.
            except OSError:
                pass
        path = self._resultPath(toolCallId)
        tmp = f'{path}.{secrets.token_hex(4)}'
        try:
            Path(tmp).write_text(phpjson.dumps(result))
        except OSError:
            pass
        try:
            os.chmod(tmp, 0o666)
        except OSError:
            pass
        try:
            os.replace(tmp, path)
        except OSError:
            pass

    @staticmethod
    def _dir() -> str:
        return os.environ.get('SKILL_TOOL_BRIDGE_DIR', '/tmp/synergy-workflow-tool')

    @staticmethod
    def _resultPath(toolCallId: str) -> str:
        # Hex-only IDs by construction; reject anything else defensively
        # in case the controller ever forwards a forged value.
        safe = re.sub(r'[^a-f0-9]', '', toolCallId, flags=re.IGNORECASE)
        return os.path.join(SkillToolBridge._dir(), f'{safe}.result')
