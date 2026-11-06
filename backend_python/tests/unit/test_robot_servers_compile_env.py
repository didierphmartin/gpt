"""Port of backend/tests/Unit/RobotServersCompileEnvTest.php.

GET /robot/mcp-servers/compile-env: the robot's own enabled servers' headers as MCP_HEADERS_<SLUG>, for a compiled
robot workflow's .env -- the very values the interpreter sends when the robot runs (SQLite, no production DB).
"""
from __future__ import annotations

import pytest

from app.controllers.robot_servers_controller import RobotServersController
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    d = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, kind TEXT)',
                  'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, description TEXT,'
                  ' enabled INTEGER, headers TEXT)')
    d.execute("INSERT INTO users (id, kind) VALUES (3, 'user'), (120, 'service')")
    for row in (['120', 'Outlook', 'http://localhost:8770/mcp', 1, '{"X-Outlook-Account":"robot-key"}'],
                ['120', 'Share Point', 'http://localhost:8771/mcp', 1, '{"X-SharePoint-Account":"sp-key"}'],
                ['120', 'Jira', 'http://localhost:9000/mcp', 0, '{"Authorization":"off"}'],      # disabled
                ['120', 'Docs', 'http://localhost:9001/mcp', 1, None],                           # no headers
                ['3', 'Outlook', 'http://localhost:8770/mcp', 1, '{"X-Outlook-Account":"person-key"}']):
        d.execute('INSERT INTO mcp_servers (user_id, name, url, enabled, headers) VALUES (?, ?, ?, ?, ?)', row)
    return d


def call(db, user_id: int) -> dict:
    return RobotServersController(db, {'edition': 'individual'}).compileEnv({'user_id': user_id})


def test_the_robots_enabled_headers_by_slug(db):
    r = call(db, 3)
    assert r['success'] is True, r
    # only the robot's enabled rows with headers; never the person's own
    assert r['data']['vars'] == {
        'MCP_HEADERS_OUTLOOK': '{"X-Outlook-Account":"robot-key"}',
        'MCP_HEADERS_SHARE_POINT': '{"X-SharePoint-Account":"sp-key"}',
    }
    assert list(r['data']['vars']) == ['MCP_HEADERS_OUTLOOK', 'MCP_HEADERS_SHARE_POINT']


def test_signed_out_is_refused(db):
    r = call(db, 0)
    assert r['success'] is False
    assert r['status_code'] == 401
