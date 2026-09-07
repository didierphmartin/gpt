"""Ports of backend/tests/Unit/Playbook/Fake*.php — test doubles shared
across the Playbook unit suite."""
from __future__ import annotations

from app.playbook.gate_bridge_interface import GateBridgeInterface
from app.playbook.mcp_executor_interface import McpExecutorInterface


class FakeMcpExecutor(McpExecutorInterface):
    """Port of FakeMcpExecutor.php (43 lines)."""

    def __init__(self):
        self.calls: list = []
        # map "server.tool" => canned result
        self.canned: dict = {}

    def call(self, server: str, tool: str, args: dict) -> dict:
        self.calls.append({'server': server, 'tool': tool, 'args': args})
        key = f'{server}.{tool}'
        return self.canned.get(key, {'ok': True, 'result': {'done': True}})

    def availableTools(self) -> dict:
        return {
            'okta.search_users': {
                'description': 'Search Okta users by attribute',
                'input_schema': {
                    'type': 'object',
                    'properties': {'email': {'type': 'string'}},
                    'required': ['email'],
                },
            },
            'okta.reset_password': {
                'description': 'Reset an Okta user password',
                'input_schema': {
                    'type': 'object',
                    'properties': {'user_id': {'type': 'string'}},
                    'required': ['user_id'],
                },
            },
        }


class FakeGateBridge(GateBridgeInterface):
    """Port of FakeGateBridge.php (29 lines).

    @param queue queued answers, in order; None entries mean timeout.
    Exhausted queue also times out."""

    def __init__(self, queue: list | None = None, onAsk=None):
        self.calls: list = []
        self._queue = list(queue) if queue else []
        self._onAsk = onAsk

    def ask(self, runId: int, kind: str, payload: dict, timeoutMs: int):
        self.calls.append({'runId': runId, 'kind': kind, 'payload': payload, 'timeoutMs': timeoutMs})
        if self._onAsk is not None:
            self._onAsk(runId, kind, payload)
        if not self._queue:
            return None
        return self._queue.pop(0)


class FakeNodeRunnerBridge(GateBridgeInterface):
    """Port of FakeNodeRunnerBridge.php (36 lines).

    Stand-in for SkillBridgeGateBridge in PlaybookNodeRunnerTest: mirrors the
    real adapter's contract (emit a 'gate_request' event, then hand back a
    decision) without touching SkillToolBridge's filesystem rendezvous, so
    the unit test resolves synchronously instead of polling for a result
    file."""

    _DEFAULT_ANSWER = {'actor': 'approver1', 'decision': 'approved'}
    _UNSET = object()

    def __init__(self, emit, answer=_UNSET):
        self.calls: list = []
        self._emit = emit
        self._answer = self._DEFAULT_ANSWER if answer is self._UNSET else answer

    def ask(self, runId: int, kind: str, payload: dict, timeoutMs: int):
        import secrets
        toolCallId = secrets.token_hex(16)
        self.calls.append({'runId': runId, 'kind': kind, 'payload': payload})
        self._emit({
            'type': 'gate_request',
            'tool_call_id': toolCallId,
            'kind': kind,
            'payload': payload,
            'run_id': runId,
        })
        return self._answer
