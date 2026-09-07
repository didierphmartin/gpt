"""Port of backend/src/Playbook/Adapters/SkillBridgeGateBridge.php (37 lines).

Wires GateManager's immediate-mode human gates (trigger_form /
request_approval / prompt_handoff / await_message) onto the existing
workflow client-tool bridge: emit a 'gate_request' SSE event carrying a
fresh tool_call_id, then block on SkillToolBridge.awaitResult() until the
browser posts a decision to the existing /api/v1/workflows/tool-result
endpoint (WorkflowController.toolResult() accepts any 32-hex tool_call_id
with no further validation).
"""
from __future__ import annotations

from typing import Callable, Optional

from app.agent_team.services.skill_tool_bridge import SkillToolBridge
from app.playbook.gate_bridge_interface import GateBridgeInterface


class SkillBridgeGateBridge(GateBridgeInterface):
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit

    def ask(self, runId: int, kind: str, payload: dict, timeoutMs: int) -> Optional[dict]:
        toolCallId = SkillToolBridge.generateToolCallId()

        self.emit({
            'type': 'gate_request',
            'tool_call_id': toolCallId,
            'kind': kind,
            'payload': payload,
            'run_id': runId,
        })

        return SkillToolBridge().awaitResult(toolCallId, timeoutMs)
