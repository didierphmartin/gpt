"""Port of the ADK/MAF/NOOA cases of backend/tests/Unit/GeneratedDocParityTest.php
(Phase 6, Task 3). The LangGraph cases belong to Task 2's
`lang_graph_generator.py` port -- not duplicated here.

Every compile target documents the generated script the same way, for any
workflow shape: PROVENANCE, GRAPH NODES, GRAPH EDGES, EXECUTION ORDER, DATA
FLOW, TO RUN in the module docstring, and a uniform comment block before
each node definition. Also pins the analyzer fix that made editor-saved
agent nodes (DB node_type '') vanish from ADK/MAF/NOOA.

DEVIATION FROM THE PHP ORACLE (documented, mirrors the established pattern
in test_workflow_graph_analyzer_analyze.py): the PHP test drives a real PDO
SQLite connection through WorkflowGraphAnalyzer's `$this->db->prepare()`/
`query()` calls. The backend_python `Db` wrapper -- and this port's
WorkflowGraphAnalyzer._loadMcpToolsWithServers / generate()'s
system_llm_settings lookup -- both go through `db.fetch_all(sql, params)`
(see workflow_graph_analyzer.py / adk_generator.py / maf_generator.py /
nooa_generator.py). This test's `_FakeDb` therefore wraps a real in-memory
sqlite3 connection (same schema + rows as the PHP oracle's `pdo()`) and
answers `fetch_all` from it, reflecting the real Python code path rather
than PDO's prepare()/query() split.
"""
from __future__ import annotations

import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.maf_generator import MAFGenerator
from app.agent_team.services.nooa_generator import NOOAGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer

PLAYBOOK = (
    "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n"
    "1. #Get PTO Balance for the requester.\n"
    "2. #Request Approval from the manager then #Resolve Request.\n\n"
    "Tools used: Workday\n\n"
    "Actions used: #Get PTO Balance; #Request Approval; #Resolve Request\n"
)


def _agent(name: str, agent_type: str = 'standard') -> dict:
    return {
        'type': 'agent-template', 'agent_name': name, 'agent_type': agent_type,
        'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
        'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096},
    }


def _graph() -> dict:
    """The Dispatcher-demo shape, with the '' node_type the editor really saves."""
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
            {'id': '2', 'node_type': '', 'config': _agent('techBuddy', 'dispatcher')},
            {'id': '3', 'node_type': '', 'config': _agent('IT claims')},
            {'id': '4', 'node_type': '', 'config': _agent('Human resources')},
            {'id': '5', 'node_type': 'playbook', 'config': {'type': 'playbook', 'name': 'Playbook HR',
                'playbook': PLAYBOOK, 'agent_provider': 'deepseek', 'model': 'deepseek-v4-flash', 'writes_enabled': True}},
            {'id': '6', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
            {'from': '3', 'to': '6'}, {'from': '4', 'to': '5'}, {'from': '5', 'to': '6'},
        ],
    }


class _FakeWorkflowRepo:
    def __init__(self, workflow: Workflow):
        self._workflow = workflow

    def findById(self, id_: int, include_graph: bool = False):
        return self._workflow if id_ == self._workflow.id else None


class _FakeGraphRepo:
    def __init__(self, graph: dict):
        self._graph = graph

    def getGraph(self, id_: int) -> dict:
        return self._graph


class _FakeAgentRepo:
    def findById(self, id_: int):
        return None


class _FakeDb:
    """Wraps a real in-memory sqlite3 connection with the same schema + rows
    as the PHP oracle's `pdo()` fixture."""

    def __init__(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        c = self.conn.cursor()
        c.execute('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)')
        c.execute('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)')
        c.execute('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)')
        c.execute("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)")
        c.execute("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}}}')")
        c.execute("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)")
        self.conn.commit()

    def fetch_all(self, sql, params=None):
        cur = self.conn.cursor()
        cur.execute(sql, params or {})
        return [dict(row) for row in cur.fetchall()]


def _generate_all() -> dict[str, str]:
    db = _FakeDb()
    wf_repo = _FakeWorkflowRepo(Workflow({'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'}))
    graph_repo = _FakeGraphRepo(_graph())
    agent_repo = _FakeAgentRepo()
    out = {}
    for label, cls in [('ADK', ADKGenerator), ('MAF', MAFGenerator), ('NOOA', NOOAGenerator)]:
        out[label] = cls(db, wf_repo, graph_repo, agent_repo).generate(44, '3')['code']
    return out


def test_analyzer_reads_empty_node_type_from_config():
    assert WorkflowGraphAnalyzer.typeOf({'node_type': '', 'config': {'type': 'agent-template'}}) == 'agent-template'
    assert WorkflowGraphAnalyzer.typeOf({'node_type': 'playbook', 'config': {'type': 'agent'}}) == 'playbook'
    assert WorkflowGraphAnalyzer.typeOf({'config': {}}) == 'agent'


def test_every_target_carries_the_same_documentation_sections():
    for target, code in _generate_all().items():
        doc = code[:code.index('"""', 3)]
        for needle in [
            'PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
            'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
            'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), '
            'DISPATCHER -> one of: IT claims | Human resources',
            'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
            'layer 2:  IT claims  ||  Human resources',
            'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF',
        ]:
            assert needle in doc, f"{target}: docstring lacks {needle}"
        assert re.search(
            r'Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor', doc
        ), target
        assert '# ---- node 2: techBuddy (agent-template) ' in code, target
        assert ('#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default'
                in code), target
        assert '#   dispatcher     : routes to one of: IT claims | Human resources' in code, target
        assert '#   children       : IT claims (3) | Human resources (4)' in code, target
        assert '#   parents        : techBuddy (2)' in code, target


def test_agents_with_empty_db_node_type_compile_on_every_target():
    for target, code in _generate_all().items():
        assert 'You are Human resources.' in code, f"{target} lost the agent node"


def test_playbook_and_dispatcher_support_is_stated_honestly():
    all_codes = _generate_all()
    for t in ['ADK', 'MAF', 'NOOA']:
        code = all_codes[t]
        assert 'NOT RUN BY THIS TARGET (playbook nodes are not supported here' in code, t
        assert 'menu NOT honoured by this target: all children run' in code, t
        assert '(run in PARALLEL -- dispatcher menu not honoured by this target)' in code, t
        assert 'PLAYBOOK_GATE_MODE' not in code, t
        doc = code[:code.index('"""', 3)]
        assert 'DEEPSEEK_API_KEY' not in doc, f"{t}: an unsupported node's provider key must not be listed"


def test_every_target_still_emits_valid_python():
    for target, code in _generate_all().items():
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(code)
            path = f.name
        try:
            proc = subprocess.run([sys.executable, '-m', 'py_compile', path], capture_output=True, text=True)
            assert proc.returncode == 0, f"{target}: {proc.stdout + proc.stderr}"
        finally:
            pathlib.Path(path).unlink(missing_ok=True)
