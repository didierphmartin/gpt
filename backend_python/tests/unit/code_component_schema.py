"""CodeComponentStoreTest::schema() and ::POLL (backend/tests/Unit/CodeComponent/CodeComponentStoreTest.php)."""
from __future__ import annotations

import json
import sqlite3

from tests.unit.playbook.conftest import SqliteDb

POLL = {'name': 'Poll Inbox', 'description': 'New mail in Inbox',
        'code': "def run(input, call_tool):\n    return {'route': 'new_mail', 'output': 1}",
        'exits': ['new_mail', 'no_mail', 'error'], 'mcp_servers': ['Outlook'], 'timeout_s': 20}

TRIGGER = {'label': 'New email',
           'watch': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'args': {'folder': 'Inbox'}}},
           'work_exit': 'new_mail'}


def schema_db() -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.create_function('NOW', 0, lambda: '2026-10-14 09:00:00')
    conn.execute('CREATE TABLE code_components (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,'
                 ' description TEXT, code TEXT NOT NULL, exits TEXT NOT NULL, mcp_servers TEXT NOT NULL, timeout_s INTEGER NOT NULL DEFAULT 30,'
                 ' start_trigger TEXT, args TEXT, provides TEXT, created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))')
    conn.execute('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)')
    conn.execute('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER,'
                 ' config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)')
    conn.execute("CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, from_node_id INTEGER,"
                 " to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1', condition_expr TEXT, created_at TEXT)")
    conn.execute("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workflow_id INTEGER,"
                 " input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending', repeat_type TEXT DEFAULT 'none',"
                 " repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT, trigger_component_id INTEGER,"
                 " last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)")
    conn.commit()
    return SqliteDb(conn)


def jenc(v) -> str:
    """json_encode() default output (compact)."""
    return json.dumps(v, separators=(',', ':'))
