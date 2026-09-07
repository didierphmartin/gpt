"""Port of backend/src/AgentTeam/Services/PlaybookAgentTools.php (54 lines).

A playbook agent's `tools` selection = the MCP tools its #Actions bind to,
named the way the runtime and the agent form name them (mcp_<tool>). Kept in
step on every save so the form's checkboxes show what the playbook needs.
Native verbs and unbound actions contribute nothing.
"""
from __future__ import annotations

from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor
from app.playbook.playbook_analyzer import PlaybookAnalyzer
from app.playbook.playbook_document import PlaybookDocument
from app.support.logger import error_log


class PlaybookAgentTools:
    @staticmethod
    def fromPlaybookText(text: str, availableTools: list) -> list:
        """@param availableTools "server.tool" ids @return mcp_<tool> names, unique, prose order."""
        try:
            doc = PlaybookDocument.fromConsoleText(text)
        except Exception:
            return []
        analysis = PlaybookAnalyzer().analyze(doc, availableTools, [])
        out = []
        for a in analysis['actions']:
            if (a.get('kind') if a.get('kind') is not None else '') != 'bound':
                continue
            target = a.get('target') if a.get('target') is not None else ''
            dot = target.find('.')
            if dot == -1:
                continue  # agent.* bindings have no MCP tool
            name = 'mcp_' + target[dot + 1:]
            if name not in out:
                out.append(name)
        return out

    @staticmethod
    def forUser(db, userId: str, text: str) -> list:
        """Same, against the user's live MCP registry. Never throws (returns [] on any failure)."""
        try:
            from app.services.mcp_tools_loader import MCPToolsLoader
            loader = MCPToolsLoader(db)
            loader.loadToolsForUser(userId)
            return PlaybookAgentTools.fromPlaybookText(text, list(LoaderMcpExecutor(loader).availableTools().keys()))
        except Exception as e:
            error_log(f'[PlaybookAgentTools] registry unavailable: {e}')
            return []
