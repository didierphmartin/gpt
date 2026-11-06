"""Port of Services/McpHostClient.php.

Talks to the Docker app's server supervisor (docker/mcps) with the shared Bearer token.
Bodies carry server secrets, so nothing here logs a request or a response.
"""
from __future__ import annotations

import json
from typing import Callable
from urllib.parse import urlparse

import httpx


class McpHostClient:
    def __init__(self, baseUrl: str, token: str, transport: Callable | None = None):
        """transport: (method, url, headers, body) -> (status, body text); status 0 = unreachable."""
        self.baseUrl = baseUrl
        self.token = token
        self.transport = transport or McpHostClient._http

    def request(self, method: str, path: str, body: dict | list | None = None) -> dict:
        headers = ['Authorization: Bearer ' + self.token, 'Accept: application/json']
        payload = None
        if body is not None:
            headers.append('Content-Type: application/json')
            payload = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
        try:
            status, text = self.transport(method, self.baseUrl.rstrip('/') + path, headers, payload)
        except Exception:  # noqa: BLE001 -- any transport failure reads as unreachable
            return {'status': 503, 'body': {'error': 'unreachable'}}
        if status < 100:
            return {'status': 503, 'body': {'error': 'unreachable'}}
        try:
            decoded = json.loads(text or '')
        except (ValueError, TypeError):
            decoded = None
        return {'status': status, 'body': decoded if isinstance(decoded, (dict, list)) else []}

    @staticmethod
    def timeoutFor(method: str, url: str) -> int:
        """Seconds to wait for the supervisor: install can run for minutes (dependency downloads); a call that
        stops a server (restart, enabled, delete, settings save) waits out its 10 s stop grace; the rest is quick."""
        path = urlparse(url).path or ''
        if path.endswith('/install'):
            return 900
        if (method == 'DELETE' or path.endswith('/restart') or path.endswith('/enabled')
                or (method == 'PUT' and path.endswith('/settings'))):
            return 30
        return 15

    @staticmethod
    def _http(method: str, url: str, headers: list, body: str | None) -> tuple:
        hdrs = {}
        for line in headers:
            name, _, value = line.partition(':')
            hdrs[name.strip()] = value.strip()
        try:
            with httpx.Client(timeout=httpx.Timeout(McpHostClient.timeoutFor(method, url), connect=5)) as client:
                r = client.request(method, url, headers=hdrs,
                                   content=body.encode('utf-8') if body is not None else None)
        except Exception:  # noqa: BLE001 -- curl_exec false
            return 0, ''
        return r.status_code, r.text
