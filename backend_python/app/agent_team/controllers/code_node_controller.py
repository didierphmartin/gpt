"""Port of backend/src/AgentTeam/Controllers/CodeNodeController.php.

POST /api/v1/workflows/code-node/tool-call -- a code node's call_tool from the editor.

Runs server.tool(args) with the logged-in user's MCP servers and returns the raw MCP result
(the harness needs structuredContent and isError). The declared-tools check is the harness's,
so it is identical when compiled; this endpoint gives the user no more than their own MCP access.
"""
from __future__ import annotations

import re
from typing import Callable

from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support.phpcompat import php_intval

_SERVER_RE = re.compile(r'^[a-z0-9_]{1,64}$')
_TOOL_RE = re.compile(r'^[A-Za-z0-9_.-]{1,128}$')


class CodeNodeController:
    def __init__(self, db, config: dict | None = None, callerFor: Callable | None = None):
        def default_caller_for(userId: int):
            loader = MCPToolsLoader(db)
            loader.loadToolsForUser(str(userId))
            executor = LoaderMcpExecutor(loader)

            def call(server, tool, args):
                try:
                    return executor.callRaw(server, tool, args)
                finally:
                    loader.close()   # Python-only: release the loader's httpx pool (PHP's dies with the request)
            return call

        self.callerFor = callerFor if callerFor is not None else default_caller_for

    def toolCall(self, request: dict) -> dict:
        userId = php_intval(request.get('user_id') if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'ok': False, 'error': 'Authentication required', 'status_code': 401}
        body = request.get('body') if isinstance(request.get('body'), dict) else {}
        server = body.get('server')
        tool = body.get('tool')
        args = body.get('args') if body.get('args') is not None else []
        if (not isinstance(server, str) or not _SERVER_RE.match(server)
                or not isinstance(tool, str) or not _TOOL_RE.match(tool) or not isinstance(args, (dict, list))):
            return {'ok': False, 'error': 'body must be {server: slug, tool: name, args: object}', 'status_code': 400}
        return self.callerFor(userId)(server, tool, args)
