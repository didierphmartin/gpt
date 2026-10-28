"""Port of backend/tests/Unit/EventWorker/EventWorkerSchema.php: the tables the event worker reads, in SQLite;
NOW() comes from the test's clock."""
from __future__ import annotations

import json
import sqlite3

from tests.unit.playbook.conftest import SqliteDb

WATCH = {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'args': {'folder': 'Inbox'}}}


def create(now) -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.create_function('NOW', 0, now)
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, enabled INTEGER DEFAULT 1)')
    conn.execute('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, config TEXT)')
    conn.execute("CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, from_node_id INTEGER,"
                 " to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1')")
    conn.execute('CREATE TABLE code_components (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, start_trigger TEXT,'
                 ' args TEXT, provides TEXT)')
    conn.execute('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, url TEXT,'
                 ' headers TEXT, enabled INTEGER DEFAULT 1)')
    conn.execute("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workflow_id INTEGER,"
                 " input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending', repeat_type TEXT DEFAULT 'none',"
                 " repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT, trigger_component_id INTEGER,"
                 " last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)")
    conn.execute("CREATE TABLE active_workflows (user_id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL"
                 " REFERENCES agent_workflows (id) ON DELETE CASCADE, mode TEXT NOT NULL, trigger_component_id INTEGER,"
                 " activated_at TEXT NOT NULL, watch_state TEXT NOT NULL DEFAULT 'starting', watch_message TEXT, watch_checked_at TEXT)")
    conn.commit()
    return SqliteDb(conn)


def workflow(db: SqliteDb, id: int, user: int, option: int | None, linked: bool = True) -> None:
    """Workflow `id` of user `user`: Start (on option `option`, or plain) linked to an Output unless `linked` is False."""
    db.execute('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)', [id, user, f'wf {id}'])
    cfg = json.dumps({'type': 'start', **({'start_option': option} if option else {})})
    start = db.insert("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, 'start', ?)", [id, cfg])
    out = db.insert("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, 'output', '{}')", [id])
    if linked:
        db.execute('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)', [id, start, out])


def option(db: SqliteDb, id: int, user: int) -> None:
    db.execute('INSERT INTO code_components (id, user_id, name, start_trigger) VALUES (?, ?, ?, ?)',
               [id, user, f'c {id}', json.dumps({'label': 'New email', 'watch': WATCH, 'work_exit': 'new_mail'})])


def row(db: SqliteDb, wf: int, user: int, type: str, component: int | None = None, status: str = 'pending') -> int:
    """A saved schedule row; returns its id."""
    return db.insert('INSERT INTO scheduled_workflows (user_id, workflow_id, status, repeat_type, event_trigger,'
                     ' trigger_component_id, next_run) VALUES (?, ?, ?, ?, ?, ?, ?)',
                     [user, wf, status, type, json.dumps(WATCH) if type == 'event' else None, component,
                      None if type == 'event' else '2026-10-15 09:00:00'])
