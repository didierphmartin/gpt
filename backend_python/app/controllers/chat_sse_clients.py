"""Port of the two anonymous SSE-client classes at the bottom of
Controllers/ChatController.php (createVerificationSSEClient /
createComparisonSSEClient). Each wraps a `sendEvent(event_name, data)`
callable and implements StreamingClientInterface.
"""
from __future__ import annotations

from typing import Callable

from app.contracts.streaming_client import StreamingClientInterface
from app.support.phpcompat import php_uniqid


class VerificationSseClient(StreamingClientInterface):
    def __init__(self, sendEvent: Callable[[str, object], None]):
        self.sendEvent = sendEvent
        self.sessionId = 'verify_' + php_uniqid()
        self.connected = True

    def sendProgress(self, message: str) -> None:
        self.sendEvent('verification_progress', message)

    def sendChunk(self, text: str) -> None:
        self.sendEvent('verifier_chunk', text)

    def sendResponse(self, data: dict) -> None:
        self.sendEvent('verification_response', data)

    def sendError(self, message: str, code: int = 500) -> None:
        self.sendEvent('verification_error', {'message': message, 'code': code})

    def complete(self) -> None:
        pass

    def sendCustomEvent(self, event_name: str, data: dict) -> None:
        self.sendEvent(event_name, data)

    def getSessionId(self) -> str:
        return self.sessionId

    def isConnected(self) -> bool:
        return self.connected

    def markHeadersInitialized(self) -> None:
        pass


class ComparisonSseClient(StreamingClientInterface):
    def __init__(self, sendEvent: Callable[[str, object], None]):
        self.sendEvent = sendEvent
        self.sessionId = 'compare_' + php_uniqid()
        self.connected = True

    def sendProgress(self, message: str) -> None:
        self.sendEvent('compare_progress', message)

    def sendChunk(self, text: str) -> None:
        self.sendEvent('compare_chunk', text)

    def sendResponse(self, data: dict) -> None:
        self.sendEvent('compare_response', data)

    def sendError(self, message: str, code: int = 500) -> None:
        self.sendEvent('compare_error', {'message': message, 'code': code})

    def complete(self) -> None:
        pass

    def sendCustomEvent(self, event_name: str, data: dict) -> None:
        # Namespace per-pane events so the comparer's tool-call emissions
        # don't collide with the primary's. Without this rename, both
        # panes' run_skill_script tool calls arrive on the same channel
        # and the frontend can't tell which pane to feed the result back into.
        if event_name == 'client_tool_call':
            self.sendEvent('compare_client_tool_call', data)
            return
        self.sendEvent(event_name, data)

    def getSessionId(self) -> str:
        return self.sessionId

    def isConnected(self) -> bool:
        return self.connected

    def markHeadersInitialized(self) -> None:
        pass
