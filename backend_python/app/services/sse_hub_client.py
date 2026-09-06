"""Port of Services/SSEHubClient.php.

Server-Sent Events (SSE) client for streaming responses.

The stream is obtained from the `stream` constructor kwarg or, when omitted,
from the `current_stream` ContextVar (set by `ChatController` in the request
thread before calling the assistant — thread-local because the whole request
runs in one thread).
"""
from __future__ import annotations

import contextvars

import httpx

from app.contracts.streaming_client import StreamingClientInterface
from app.support.logger import error_log
from app.support.phpjson import dumps
from app.support.sse import SseStream

current_stream: contextvars.ContextVar[SseStream | None] = contextvars.ContextVar('sse_current_stream', default=None)


class SSEHubClient(StreamingClientInterface):
    current_stream = current_stream

    def __init__(self, sessionId: str, hubUrl: str | None = None, debug: bool = False, stream: SseStream | None = None):
        self.sessionId = sessionId
        self.hubUrl = hubUrl
        self.debug = debug
        self.connected = False
        self.headersSet = False
        self._stream = stream

    @classmethod
    def create(cls, sessionId: str, hubUrl: str | None = None, debug: bool = False, stream: SseStream | None = None) -> 'SSEHubClient':
        """Static factory method."""
        return cls(sessionId, hubUrl, debug, stream=stream)

    def _get_stream(self) -> SseStream | None:
        return self._stream if self._stream is not None else current_stream.get()

    def markHeadersInitialized(self) -> None:
        """Mark headers as already initialized (when headers are set externally)."""
        self.headersSet = True
        self.connected = True
        self._log(f"Headers marked as initialized for session: {self.sessionId}")

    def sendProgress(self, message: str) -> None:
        """Send a progress message to the client."""
        self._sendEvent('progress', message)

    def sendResponse(self, data: dict) -> None:
        """Send a response (JSON data) to the client."""
        self._sendEvent('response', dumps(data))

    def sendError(self, message: str, code: int = 500) -> None:
        """Send an error to the client."""
        self._sendEvent('error', dumps({
            'error': True,
            'message': message,
            'code': code,
        }))

    def sendChunk(self, text: str) -> None:
        """Send a chunk of streaming text."""
        # DEBUG: Log EXACT data being sent to frontend (json_encode shows \n as \\n)
        error_log(f"📤 SENDING TO FRONTEND (len={len(text)}): " + dumps(text))
        self._sendEvent('chunk', text)

    def complete(self) -> None:
        """Signal that streaming is complete."""
        self._sendEvent('complete', dumps({'status': 'done'}))
        self.connected = False

    def sendCustomEvent(self, eventName: str, data: dict) -> None:
        """Send a custom event with arbitrary data."""
        self._sendEvent(eventName, dumps(data))

    def getSessionId(self) -> str:
        """Get the session ID."""
        return self.sessionId

    def isConnected(self) -> bool:
        """Check if the client is connected."""
        stream = self._get_stream()
        return self.connected and not (stream is not None and stream.aborted)

    def _sendEvent(self, event: str, data: str) -> None:
        """Send an SSE event."""
        if self.hubUrl:
            self._sendToHub(event, data)
        else:
            self._sendDirect(event, data)

    def _sendDirect(self, event: str, data: str) -> None:
        """Send event directly via the stream (for direct streaming)."""
        if not self.headersSet:
            self.headersSet = True
            self.connected = True
            self._log(f"SSE headers initialized for session: {self.sessionId}")

        stream = self._get_stream()
        if stream is not None:
            stream.send(event, data)

        self._log(f"Direct SSE sent - event: {event}")

    def _sendToHub(self, event: str, data: str) -> None:
        """Send event to an SSE hub server."""
        try:
            payload = {
                'session_id': self.sessionId,
                'event': event,
                'data': data,
            }
            r = httpx.post(self.hubUrl, json=payload, timeout=5)
            if r.status_code != 200:
                self._log(f"Hub send failed with HTTP {r.status_code}")
        except Exception as e:
            self._log("Hub send error: " + str(e))

    def _log(self, message: str) -> None:
        """Log a debug message."""
        if self.debug:
            error_log(f"[SSEHubClient] {message}")
