"""Port of backend/src/AgentTeam/Services/WatchTransport.php and CurlMultiTransport.php.

The event worker's long-polls (spec 2026-10-14 event-worker §3): one open request per key (a user id).
PHP drives them all from one curl_multi handle; this port runs each request on a worker thread
(HttpWatchTransport) and hands back the finished ones from done(), the same contract.
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Protocol

import httpx


class WatchTransport(Protocol):
    def start(self, key: int, url: str, headers: list[str], body: str) -> None:
        """headers: header lines ("Name: value")."""

    def cancel(self, key: int) -> None: ...

    def done(self) -> dict:
        """{key: (body | False, http code, error)} for the requests that finished since the last call."""


class HttpWatchTransport:
    """WatchTransport over a thread pool: every active workflow's long-poll in this one process."""

    # The server answers by 150 s (wait_for_new's cap); a request still open at 180 s is a dead connection.
    TIMEOUT_S = 180

    def __init__(self, max_workers: int = 64):
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix='watch')
        self._handles: dict[int, concurrent.futures.Future] = {}
        self._lock = threading.Lock()

    @classmethod
    def _post(cls, url: str, headers: list[str], body: str) -> tuple:
        hdrs = {}
        for line in headers:
            name, _, value = line.partition(':')
            hdrs[name.strip()] = value.strip()
        try:
            with httpx.Client(timeout=httpx.Timeout(cls.TIMEOUT_S, connect=15)) as client:
                r = client.post(url, content=body.encode('utf-8'), headers=hdrs)
            return r.text, r.status_code, ''
        except Exception as e:  # noqa: BLE001 -- curl reports every transport failure as an error string
            return False, 0, str(e) or e.__class__.__name__

    def start(self, key: int, url: str, headers: list[str], body: str) -> None:
        self.cancel(key)
        with self._lock:
            self._handles[key] = self._pool.submit(self._post, url, headers, body)

    def cancel(self, key: int) -> None:
        # A request already on the wire cannot be interrupted from here: it is forgotten, so its answer is dropped.
        with self._lock:
            f = self._handles.pop(key, None)
        if f is not None:
            f.cancel()

    def done(self) -> dict:
        out = {}
        with self._lock:
            for key, f in list(self._handles.items()):
                if f.done():
                    out[key] = f.result() if not f.cancelled() else (False, 0, 'cancelled')
                    del self._handles[key]
        return out

    def wait(self, seconds: float) -> None:
        """Sleep until a request has news, at most `seconds`."""
        with self._lock:
            pending = list(self._handles.values())
        if not pending:
            time.sleep(seconds)
            return
        concurrent.futures.wait(pending, timeout=seconds, return_when=concurrent.futures.FIRST_COMPLETED)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
