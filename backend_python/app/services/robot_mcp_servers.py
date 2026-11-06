"""Port of Services/RobotMcpServers.php.

A robot workflow's MCP calls go to the robot's servers, matched to the caller's by slug (servers have no slug
column: the name's).
"""
from __future__ import annotations

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.support.phpcompat import php_strval


class RobotMcpServers:
    @staticmethod
    def missing(db, callerId: str, robotId: str, toolNames: list | None) -> list[str]:
        """The caller's servers behind these requested tools (mcp_<tool>, as a node selects them) that the robot has
        no enabled server for, by name. A None selection (every tool) names none."""
        tools = list(dict.fromkeys(php_strval(t)[4:] for t in (toolNames or []) if php_strval(t).startswith('mcp_')))
        if not tools:
            return []
        needed = db.fetch_column('SELECT DISTINCT s.name FROM mcp_server_tools t JOIN mcp_servers s ON s.id = t.server_id\n'
                                 '            WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = ?) AND t.tool_name IN ('
                                 + ','.join(['?'] * len(tools)) + ')\n            ORDER BY s.name', [callerId, *tools])
        have = {CodeNodeEmit.slug(php_strval(n)) for n in db.fetch_column(
            'SELECT name FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)', [robotId])}
        return [n for n in needed if CodeNodeEmit.slug(php_strval(n)) not in have]

    @staticmethod
    def missingResponse(server: str) -> dict:
        """The 422 body naming the first missing server."""
        return {'success': False, 'error_code': 'robot_server_missing', 'server': server,
                'error': f"The robot has no enabled \"{server}\" MCP server. Add it to the robot's connections.",
                'status_code': 422}
