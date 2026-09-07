"""Thread-to-queue SSE bridge (spec §3). The controller thread calls send(); the async
StreamingResponse generator in main.py drains `queue`. Framing mirrors PHP's $sendEvent."""
from __future__ import annotations

import asyncio

from app.support.phpjson import dumps, php_json_encode


def format_sse_frame(event: str, data) -> bytes:
    out = f'event: {event}\n'
    if isinstance(data, str):
        for line in data.split('\n'):
            out += f'data: {line}\n'
    else:
        out += 'data: ' + dumps(data) + '\n'
    out += '\n'
    return out.encode('utf-8')


def format_sse_data_frame(data) -> bytes:
    """Bare `data:` frame, NO `event:` line — mirrors a PHP endpoint that
    writes `echo "data: " . json_encode($event) . "\n\n"` directly (e.g.
    AgentController.php:486, :507), rather than the named-event
    `$sendEvent($event, $data)` helper format_sse_frame() above mirrors.
    A str payload (e.g. the literal '[DONE]' sentinel) is written verbatim,
    one `data:` line per `\n`-split line, exactly like PHP's `echo` would
    produce for a plain string. A non-str payload is encoded with PHP's
    actual `json_encode()` defaults (escaped '/' and non-ASCII) via
    php_json_encode — NOT the cosmetic `dumps()` used by format_sse_frame,
    since this frame's bytes must match PHP's plain `json_encode($event)`
    call (no flags) exactly, not just decode identically."""
    out = ''
    if isinstance(data, str):
        for line in data.split('\n'):
            out += f'data: {line}\n'
    else:
        out += 'data: ' + php_json_encode(data) + '\n'
    out += '\n'
    return out.encode('utf-8')


class SseStream:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self.queue: asyncio.Queue = asyncio.Queue()
        self.started_future: asyncio.Future = loop.create_future()
        self.started = False
        self.ended = False
        self.aborted = False

    def start(self) -> None:
        if self.started:
            return
        self.started = True
        self._loop.call_soon_threadsafe(self._set_started)

    def _set_started(self) -> None:
        if not self.started_future.done():
            self.started_future.set_result(True)

    def send(self, event: str, data) -> None:
        if self.aborted:
            raise RuntimeError('CLIENT_ABORTED')
        if not self.started:
            self.start()
        frame = format_sse_frame(event, data)
        self._loop.call_soon_threadsafe(self.queue.put_nowait, frame)
        if self.aborted:                      # PHP: connection_aborted() checked after flush()
            raise RuntimeError('CLIENT_ABORTED')

    def send_data(self, data) -> None:
        """Same start/abort semantics as send(), but framed with
        format_sse_data_frame() (bare `data:`, no `event:` line)."""
        if self.aborted:
            raise RuntimeError('CLIENT_ABORTED')
        if not self.started:
            self.start()
        frame = format_sse_data_frame(data)
        self._loop.call_soon_threadsafe(self.queue.put_nowait, frame)
        if self.aborted:                      # PHP: connection_aborted() checked after flush()
            raise RuntimeError('CLIENT_ABORTED')

    def end(self) -> None:
        if self.ended:
            return
        self.ended = True
        self._loop.call_soon_threadsafe(self.queue.put_nowait, None)

    def mark_aborted(self) -> None:
        self.aborted = True
