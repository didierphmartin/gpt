"""Port of backend/tests/Unit/AgentTeam/RobotSchema.php: the robot tests' fixture — wf 75 of user 2 (Mail to PDF)
with its code components, Start option and schedule row."""
from __future__ import annotations

import json

from app.code_component.code_component_store import CodeComponentStore
from tests.unit import event_worker_schema
from tests.unit.playbook.conftest import SqliteDb

POLL = {'name': 'Poll Drop', 'code': 'def run(input, call_tool): pass', 'exits': ['new_mail', 'no_mail'],
        'mcp_servers': ['Outlook'], 'timeout_s': 20}
PDF = {'name': 'To PDF', 'code': 'v1', 'exits': ['done'], 'mcp_servers': ['Converter']}
SP = {'name': 'Store SharePoint', 'code': 'sp', 'exits': ['done'], 'mcp_servers': ['SharePoint', 'Outlook']}
WF = 75
OWNER = 2


def create(now=lambda: '2026-10-26 09:00:00') -> tuple[SqliteDb, dict[str, int]]:
    """event_worker_schema.create() plus the users/packages the robot needs (RobotControllerTest's), an empty LLM
    settings table (WorkflowController reads it), and wf 75 of user 2: Start on "Poll Drop" -> To PDF ->
    Store SharePoint -> Output, with its event schedule row. Returns the db and the owner's component ids by name."""
    db = event_worker_schema.create(now)
    db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,"
               " first_name TEXT, last_name TEXT, role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0)")
    db.execute('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)')
    db.execute("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'),"
               " ('ops', 'Ops', 0, '{\"use_robot\": true}')")
    db.execute("INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops'), (3, 'a@x.test', 'admin')")
    db.execute('CREATE TABLE system_llm_settings (provider_key TEXT, enabled INTEGER)')

    store = CodeComponentStore(db)
    ids: dict[str, int] = {}
    for c in (POLL, PDF, SP):
        ids[c['name']] = store.save(OWNER, None, dict(c))['id']
    store.setStartTrigger(OWNER, ids['Poll Drop'],
                          {'label': 'New drop', 'watch': event_worker_schema.WATCH, 'work_exit': 'new_mail'})
    db.execute('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)', [WF, OWNER, 'Mail to PDF'])

    def node(type_: str, cfg: dict) -> int:
        return db.insert('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)',
                         [WF, type_, json.dumps({'type': type_, **cfg})])

    start = node('start', {'start_option': ids['Poll Drop'], 'start_args': {'tag': 'vip'}})
    pdf = node('code', {'name': 'PDF', 'code_component_id': ids['To PDF']})
    sp = node('code', {'name': 'SP', 'code_component_id': ids['Store SharePoint']})
    out = node('output', {})
    for a, b in ((start, pdf), (pdf, sp), (sp, out)):
        db.execute('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (?, ?, ?, ?)',
                   [WF, a, b, 'output_1'])
    event_worker_schema.row(db, WF, OWNER, 'event', ids['Poll Drop'])
    return db, ids


def agents_and_playbooks(db: SqliteDb) -> None:
    """The agents and playbooks tables (unique per owner, as in MySQL; playbooks with the publish columns) and
    workflow_nodes.agent_id."""
    db.execute('ALTER TABLE workflow_nodes ADD COLUMN agent_id INTEGER')
    db.execute('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,'
               ' title TEXT NOT NULL, text TEXT NOT NULL, automation_id INTEGER, published_by INTEGER, published_at TEXT, source_id INTEGER,'
               ' created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))')
    db.execute("CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,"
               " category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,"
               " can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,"
               " playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,"
               " created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))")
