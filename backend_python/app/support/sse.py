"""Thread-to-queue SSE bridge (spec §3). The controller thread calls send(); the async
StreamingResponse generator in main.py drains `queue`. Framing mirrors PHP's $sendEvent."""
from __future__ import annotations

import asyncio

from app.support.phpjson import dumps


def format_sse_frame(event: str, data) -> bytes:
    out = f'event: {event}\n'
    if isinstance(data, str):
        for line in data.split('\n'):
            out += f'data: {line}\n'
    else:
        out += 'data: ' + dumps(data) + '\n'
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

    def end(self) -> None:
        if self.ended:
            return
        self.ended = True
        self._loop.call_soon_threadsafe(self.queue.put_nowait, None)

    def mark_aborted(self) -> None:
        self.aborted = True
