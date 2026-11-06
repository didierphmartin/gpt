"""RobotMcpServers (Services/RobotMcpServers.php; PHP covers it through RobotRunIdentityTest, ported with its wiring)."""
from __future__ import annotations

from app.services.robot_mcp_servers import RobotMcpServers
from tests.unit import robot_schema


def test_missing_names_the_callers_servers_the_robot_lacks_by_slug():
    db, _ = robot_schema.create()
    db.execute('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, tool_name TEXT)')
    for sid, user, name, enabled in ((1, 2, 'Outlook', 1), (2, 2, 'Share Point', 1), (3, 120, 'outlook', 1),
                                     (4, 120, 'Share-Point', 0)):
        db.execute('INSERT INTO mcp_servers (id, user_id, name, url, enabled) VALUES (?, ?, ?, ?, ?)', [sid, user, name, 'http://x', enabled])
    db.execute("INSERT INTO mcp_server_tools (server_id, tool_name) VALUES (1, 'list_mail'), (2, 'upload'), (2, 'list')")
    assert RobotMcpServers.missing(db, '2', '120', ['mcp_list_mail', 'mcp_upload', 'mcp_list', 'other']) == ['Share Point']
    assert RobotMcpServers.missing(db, '2', '120', ['mcp_list_mail']) == []
    assert RobotMcpServers.missing(db, '2', '120', None) == []
    r = RobotMcpServers.missingResponse('Share Point')
    assert list(r) == ['success', 'error_code', 'server', 'error', 'status_code']
    assert r['error'] == "The robot has no enabled \"Share Point\" MCP server. Add it to the robot's connections."
    assert r['status_code'] == 422


def test_robot_schema_fixture():
    db, ids = robot_schema.create()
    assert list(ids) == ['Poll Drop', 'To PDF', 'Store SharePoint']
    assert db.fetch_one('SELECT user_id, name FROM agent_workflows WHERE id = 75') == {'user_id': 2, 'name': 'Mail to PDF'}
    assert len(db.fetch_all('SELECT id FROM workflow_nodes WHERE workflow_id = 75')) == 4
    assert len(db.fetch_all('SELECT id FROM workflow_edges WHERE workflow_id = 75')) == 3
    row = db.fetch_one('SELECT repeat_type, trigger_component_id FROM scheduled_workflows WHERE workflow_id = 75')
    assert row == {'repeat_type': 'event', 'trigger_component_id': ids['Poll Drop']}
    robot_schema.agents_and_playbooks(db)
    assert db.fetch_all('SELECT * FROM agents') == [] and db.fetch_all('SELECT * FROM playbooks') == []
