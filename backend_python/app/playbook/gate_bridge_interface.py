"""Port of backend/src/Playbook/GateBridgeInterface.php (18 lines).

Presents a human gate (form / approval / handoff / await-message) to a human
and blocks the calling thread until it is answered or times out. The
immediate-mode GateManager calls this synchronously from inside the
interpreter loop.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional


class GateBridgeInterface(ABC):
    @abstractmethod
    def ask(self, runId: int, kind: str, payload: dict, timeoutMs: int) -> Optional[dict]:
        """@param payload the gate's tool-call arguments (prompt/fields, approver/question, etc.)
        @return the decision payload the human gave, or None on timeout"""
        raise NotImplementedError
