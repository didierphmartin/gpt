"""Ports of backend/src/Automation/AutomationMcp.php and LiveAutomationMcp.php.

AutomationMcp: the two MCP calls the automations API makes, behind an interface so tests use a fake. Both answer
the callRaw shape. LiveAutomationMcp: describe through the loader (like CodeNodeController), install by one
JSON-RPC POST.
"""
from __future__ import annotations

import json
import re
import time
from typing import Protocol

import httpx

from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor
from app.services.mcp_tools_loader import MCPToolsLoader

_SLUG = re.compile(r'[^a-z0-9]+', re.IGNORECASE)
_DATA_LINE = re.compile(r'^data:\s?(.*)$', re.M)


class AutomationMcp(Protocol):
    def describe(self, userId: int, serverName: str, key: str) -> dict:
        """describe_item {key} on the owner's server called serverName: {'ok': True, 'result': raw MCP result} or
        {'ok': False, 'error': reason}."""

    def install(self, url: str, headerLines: list, args: dict, timeoutSeconds: int) -> dict:
        """install_app on the deploy URL with the server's stored headers (header lines, never returned to a caller)."""


class LiveAutomationMcp:
    def __init__(self, db):
        self.db = db

    def describe(self, userId: int, serverName: str, key: str) -> dict:
        loader = MCPToolsLoader(self.db)
        loader.loadToolsForUser(str(userId))
        slug = _SLUG.sub('_', serverName).lower()
        return LoaderMcpExecutor(loader).callRaw(slug, 'describe_item', {'key': key})

    def install(self, url: str, headerLines: list, args: dict, timeoutSeconds: int) -> dict:
        body = json.dumps({'jsonrpc': '2.0', 'id': int(time.time()), 'method': 'tools/call',
                           'params': {'name': 'install_app', 'arguments': args}}, separators=(',', ':'))
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        for line in headerLines:
            name, _, value = line.partition(':')
            headers[name.strip()] = value.strip()
        try:
            with httpx.Client(timeout=httpx.Timeout(timeoutSeconds, connect=15)) as client:
                r = client.post(url, content=body.encode('utf-8'), headers=headers)
        except Exception:  # noqa: BLE001 -- curl_exec false / curl_error
            return {'ok': False, 'error': 'unreachable'}
        if r.status_code >= 400:
            return {'ok': False, 'error': 'http_' + str(r.status_code)}
        resp = r.text
        m = _DATA_LINE.findall(resp)
        if m:
            resp = m[-1]
        try:
            rpc = json.loads(resp)
        except ValueError:
            rpc = None
        if not isinstance(rpc, dict):
            return {'ok': False, 'error': 'bad_answer'}
        if rpc.get('error') is not None:
            e = rpc['error']
            return {'ok': False, 'error': str(e['message']) if isinstance(e, dict) and e.get('message') is not None
                    else 'rpc_error'}
        return {'ok': True, 'result': rpc['result'] if rpc.get('result') is not None else []}
