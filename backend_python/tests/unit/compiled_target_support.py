"""Port of backend/tests/Unit/Support/DispatcherDemoFixture.php: a self-contained "Dispatcher demo" workflow
in an in-memory SQLite database, for the compile-target package tests (ADK / MAF / NOOA).

Start -> techBuddy (dispatcher) -> IT claims | Human resources -> Output, in the tables the real
repositories read, so the generators run unchanged against real WorkflowRepository /
WorkflowGraphRepository / AgentRepository objects -- never the database configured in .env.
"""
from __future__ import annotations

import json
import sqlite3

from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.agent_team.services.workflow_repository import WorkflowRepository
from tests.unit.playbook.conftest import SqliteDb

WORKFLOW_ID = 44


def pdo() -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    for ddl in (
        "CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER,"
        " name TEXT, description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1,"
        " created_at TEXT, updated_at TEXT, output_storage_enabled INTEGER DEFAULT 0, output_folder TEXT,"
        " orchestration TEXT DEFAULT 'workflow')",
        'CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY, workflow_id INTEGER, node_type TEXT,'
        ' agent_id INTEGER, config TEXT, pos_x INTEGER DEFAULT 0, pos_y INTEGER DEFAULT 0,'
        ' drawflow_node_id TEXT, created_at TEXT)',
        "CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY, workflow_id INTEGER, from_node_id INTEGER,"
        " to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1',"
        " condition_expr TEXT, created_at TEXT)",
        'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
        'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT,'
        ' description TEXT, input_schema TEXT)',
        'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    ):
        conn.execute(ddl)
    conn.execute("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-chat', 1)")
    conn.execute("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)")
    conn.execute("INSERT INTO agent_workflows (id, user_id, name, description, steps, orchestration)"
                 f" VALUES ({WORKFLOW_ID}, 3, 'Dispatcher demo', 'Routes a request to IT or HR', '[]', 'workflow')")

    def agent(name: str, type_: str = 'standard') -> dict:
        return {'type': 'agent-template', 'agent_name': name, 'agent_type': type_,
                'instructions': f'You are {name}.', 'agent_provider': 'deepseek', 'model': '', 'tools': []}

    nodes = {
        1: ('start', {'type': 'start', 'prompt': 'My laptop will not boot.'}),
        2: ('agent', agent('techBuddy', 'dispatcher')),
        3: ('agent', agent('IT claims')),
        4: ('agent', agent('Human resources')),
        5: ('output', {'type': 'output'}),
    }
    for id_, (type_, config) in nodes.items():
        conn.execute('INSERT INTO workflow_nodes (id, workflow_id, node_type, agent_id, config, drawflow_node_id)'
                     ' VALUES (?, ?, ?, NULL, ?, ?)', (id_, WORKFLOW_ID, type_, json.dumps(config), str(id_)))
    for frm, to in ((1, 2), (2, 3), (2, 4), (3, 5), (4, 5)):
        conn.execute('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)',
                     (WORKFLOW_ID, frm, to))
    conn.commit()
    return SqliteDb(conn)


def generator(generator_class, db):
    """A generator class (ADKGenerator, MAFGenerator, NOOAGenerator) over db with the real repositories."""
    return generator_class(db, WorkflowRepository(db), WorkflowGraphRepository(db), AgentRepository(db))


def package_files(generator_class) -> dict:
    """generatePackage() of the fixture workflow, as {path: code}."""
    pkg = generator(generator_class, pdo()).generatePackage(WORKFLOW_ID)
    return {f['path']: f['code'] for f in pkg['files']}
