"""Port of backend/src/Playbook/Adapters/LoaderMcpExecutor.php (81 lines).

Adapts MCPToolsLoader (DB-backed MCP tool cache + JSON-RPC proxy) to the
playbook interpreter's McpExecutorInterface.

The loader keys its tools by `mcp_<tool_name>` and stores per-tool the
server it came from (`server_name`). This adapter re-keys that map as
"<server_slug>.<tool_name>" (e.g. "okta.search_users") so playbooks can
address tools the same way regardless of which MCP server hosts them.

The caller is responsible for having already called
`loader.loadToolsForUser(...)` before constructing this adapter.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from app.playbook.mcp_executor_interface import McpExecutorInterface

_SLUG_RE = re.compile(r'[^a-z0-9]+', re.IGNORECASE)


class LoaderMcpExecutor(McpExecutorInterface):
    def __init__(self, loader):
        self.loader = loader

    def call(self, server: str, tool: str, args: dict) -> dict:
        entry = self._findEntry(server, tool)
        if entry is None:
            return {'ok': False, 'error': f"MCP tool '{server}.{tool}' not found"}

        result = self.loader.executeTool('mcp_' + entry['original_name'], args)

        if isinstance(result, dict) and result.get('error') is True:
            return {'ok': False, 'error': result.get('message') if result.get('message') is not None else 'MCP tool execution failed'}

        return {'ok': True, 'result': result}

    def availableTools(self) -> dict:
        tools = {}
        for entry in self.loader.getTools().values():
            key = self._slug(entry['server_name']) + '.' + entry['original_name']
            tools[key] = {
                'description': entry.get('description') if entry.get('description') is not None else '',
                'input_schema': self._decodeSchema(entry.get('input_schema_json')),
            }
        return tools

    def _findEntry(self, server: str, tool: str) -> Optional[dict]:
        """Find the loader's tool entry matching "<slug(server_name)>.<original_name>"."""
        for entry in self.loader.getTools().values():
            if self._slug(entry['server_name']) == server and entry['original_name'] == tool:
                return entry
        return None

    def _slug(self, serverName: str) -> str:
        return _SLUG_RE.sub('_', serverName).lower()

    def _decodeSchema(self, json_str: Optional[str]) -> dict:
        if json_str is None or json_str == '':
            return {'type': 'object', 'properties': {}}
        try:
            decoded = json.loads(json_str)
        except (ValueError, TypeError):
            return {'type': 'object', 'properties': {}}
        return decoded if isinstance(decoded, (dict, list)) else {'type': 'object', 'properties': {}}
