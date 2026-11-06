"""Port of Services/McpTestRelay.php.

Carries ONE JSON-RPC message, unchanged, to an MCP server for the Test tab
and returns what came back. Transport errors are returned, never thrown.
"""
from __future__ import annotations

import json
import re
import time
from typing import Callable

import httpx

from app.providers._http import SHARED_SSL_CONTEXT

EXPOSED = ('content-type', 'mcp-session-id', 'mcp-protocol-version')

# (url, header lines, body, timeout seconds) -> {status, headers, body, error}
Http = Callable[[str, list, str, int], dict]


class McpTestRelay:
    def __init__(self, http: Http | None = None):
        self.http = http or McpTestRelay.send

    def relay(self, url: str, headers: dict, message, sessionId: str | None, protocolVersion: str) -> dict:
        """An empty protocol version sends no mcp-protocol-version header."""
        lines: list[str] = []
        protocolVersion = re.sub(r'[\r\n]', '', protocolVersion or '')
        if protocolVersion != '':
            lines.append('mcp-protocol-version: ' + protocolVersion)
        sessionId = '' if sessionId is None else re.sub(r'[\r\n]', '', sessionId)
        if sessionId != '':
            lines.append('mcp-session-id: ' + sessionId)
        for name, value in headers.items():
            lines.append(f'{name}: {value}')
        t0 = time.monotonic()
        try:
            res = self.http(url, lines, json.dumps(message, ensure_ascii=False, separators=(',', ':')), 20)
        except Exception as e:  # noqa: BLE001 — returned to the Test tab, never raised
            res = {'status': 0, 'headers': {}, 'body': '', 'error': str(e)}
        resHeaders = {str(k).lower(): v for k, v in dict(res.get('headers') or {}).items()}
        body = str(res.get('body') or '')
        return {
            'url': url,
            'status': int(res.get('status') or 0),
            'headers': McpTestRelay.exposedHeaders(resHeaders),
            'body': body,
            'messages': McpTestRelay.parseMessages(resHeaders.get('content-type', ''), body),
            'duration_ms': round((time.monotonic() - t0) * 1000),
            'error': res.get('error'),
        }

    @staticmethod
    def parseMessages(contentType: str, body: str) -> list:
        if 'text/event-stream' in (contentType or '').lower():
            out: list = []
            normalised = body.replace('\r\n', '\n').replace('\r', '\n')
            for event in re.split(r'\n\n+', normalised):
                data = [line[5:].lstrip(' ') for line in event.split('\n') if line.startswith('data:')]
                if data:
                    out.extend(McpTestRelay._messagesOf('\n'.join(data)))
            return out
        return McpTestRelay._messagesOf(body)

    @staticmethod
    def _messagesOf(text: str) -> list:
        """One JSON text → its JSON-RPC message objects (a batch array gives several)."""
        try:
            decoded = json.loads(text)
        except ValueError:
            return []
        if isinstance(decoded, dict):
            return [decoded]
        if isinstance(decoded, list):
            return [m for m in decoded if isinstance(m, dict)]
        return []

    @staticmethod
    def exposedHeaders(headers: dict) -> dict:
        lower = {str(k).lower(): v for k, v in headers.items()}
        return {name: str(lower[name]) for name in EXPOSED if name in lower}

    @staticmethod
    def send(url: str, headerLines: list, body: str, timeoutS: int) -> dict:
        """POST without following redirects; the curl() of the PHP relay."""
        headers = {'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json'}
        for line in headerLines:
            name, _, value = line.partition(':')
            headers[name.strip()] = value.strip()
        try:
            with httpx.Client(timeout=float(timeoutS), follow_redirects=False, verify=SHARED_SSL_CONTEXT) as client:
                r = client.post(url, content=body.encode('utf-8'), headers=headers)
        except httpx.HTTPError as e:
            return {'status': 0, 'headers': {}, 'body': '', 'error': str(e) or type(e).__name__}
        return {'status': r.status_code, 'headers': {k.lower(): v for k, v in r.headers.items()},
                'body': r.text, 'error': None}
