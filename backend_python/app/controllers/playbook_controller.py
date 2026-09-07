"""Port of backend/src/Controllers/PlaybookController.php (106 lines).

Registration-time playbook validation (spec T4).

Parses the submitted playbook, resolves its action bindings against the
caller's available MCP tools and agents, and reports blocking errors before
any run is ever created.

Route: POST /api/v1/playbooks/validate
"""
from __future__ import annotations

from typing import Callable, Optional

from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor
from app.playbook.playbook_analyzer import PlaybookAnalyzer
from app.playbook.playbook_document import PlaybookDocument


class PlaybookController:
    def __init__(self, db, config: dict, loaderFactory: Optional[Callable[[Optional[str]], object]] = None):
        self.db = db
        self.config = config
        # Injection seam for tests; production leaves this None.
        self.loaderFactory = loaderFactory

    def validate(self, request: dict) -> dict:
        """POST /api/v1/playbooks/validate — body: { "playbook": object|string }"""
        userId = request.get('user_id')
        if userId is None or userId == '':
            return {
                'success': False,
                'error': 'Authentication required',
                'status_code': 401,
            }

        body = request.get('body') if request.get('body') is not None else {}
        playbook = body.get('playbook') if isinstance(body, dict) else None

        try:
            if isinstance(playbook, str):
                doc = PlaybookDocument.fromConsoleText(playbook)
            elif isinstance(playbook, dict):
                doc = PlaybookDocument.fromArray(playbook)
            else:
                raise ValueError('Field "playbook" (object or string) is required.')
        except ValueError as e:
            return {
                'valid': False,
                'errors': [str(e)],
                'status_code': 422,
            }

        loader = self._makeLoader(str(userId))
        executor = LoaderMcpExecutor(loader)
        availableTools = list(executor.availableTools().keys())
        availableAgents = self._loadAgentNames(userId)

        result = PlaybookAnalyzer().analyze(doc, availableTools, availableAgents)
        valid = result['errors'] == []

        return {
            'valid': valid,
            'actions': result['actions'],
            'gates': result['gates'],
            'checklist': result['checklist'],
            'errors': result['errors'],
            'warnings': result['warnings'],
            'notices': result.get('notices') if result.get('notices') is not None else [],
            'status_code': 200 if valid else 422,
        }

    def _makeLoader(self, userId: str):
        if self.loaderFactory is not None:
            return self.loaderFactory(userId)
        from app.services.mcp_tools_loader import MCPToolsLoader
        loader = MCPToolsLoader(self.db)
        loader.loadToolsForUser(userId)
        return loader

    def _loadAgentNames(self, userId) -> list:
        return self.db.fetch_column('SELECT name FROM agents WHERE user_id = ?', [userId])
