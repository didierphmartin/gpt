"""Shared helpers of the ported PHP LangGraph compiler tests (backend/tests/Unit/LangGraph*Test.php).

PHP builds its generators from createMock() repositories and a sqlite PDO; here the same is done with
small fake repositories and SqliteDb over sqlite3. The generated programs are run the way the PHP tests
run them: `python3` (or /usr/local/bin/python3) for stdlib-only probes, the SynergyAI runner venv
(langgraph, langchain, a2a installed) for real runs.
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from tests.unit.playbook.conftest import SqliteDb

REPO = Path(__file__).resolve().parents[3]
PHP_FIXTURES = REPO / 'backend' / 'tests' / 'fixtures'
VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python'


def db(*statements: str) -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    for s in statements:
        conn.execute(s)
    conn.commit()
    return SqliteDb(conn)


MCP_DDL = ('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
           'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)')
LLM_DDL = 'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)'


class WfRepo:
    def __init__(self, wf: Workflow | dict):
        self.wf = wf if isinstance(wf, Workflow) else Workflow(wf)

    def findById(self, id_, include_graph=False):
        return self.wf


class GraphRepo:
    def __init__(self, graph: dict):
        self.graph = graph

    def getGraph(self, workflowId):
        return self.graph


class AgentRepo:
    def __init__(self, agents: dict | None = None):
        self.agents = agents or {}

    def findById(self, id_):
        return self.agents.get(int(id_))


def generator(database, graph: dict, wf: dict | Workflow | None = None, agents: dict | None = None,
              skillsRoot: str | None = None, startDocuments=None) -> LangGraphGenerator:
    wf = wf if wf is not None else {'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'}
    return LangGraphGenerator(database, WfRepo(wf), GraphRepo(graph), AgentRepo(agents), skillsRoot, startDocuments)


_SKILLS_ROOT = None


def skills_root() -> str:
    """A skills root for the fixtures' skill bindings (html, lgtest), as PHP's skillsRoot()."""
    global _SKILLS_ROOT
    if _SKILLS_ROOT is None:
        root = tempfile.mkdtemp(prefix='lg_fixture_skills_')
        for d in ('html', 'lgtest'):
            os.makedirs(f'{root}/{d}', exist_ok=True)
            Path(f'{root}/{d}/SKILL.md').write_text(f'---\nname: {d}\n---\nFixture skill.\n')
        _SKILLS_ROOT = root
    return _SKILLS_ROOT


def python3() -> str:
    """PHP's choice: /usr/local/bin/python3 when executable, else python3 on PATH."""
    return '/usr/local/bin/python3' if os.access('/usr/local/bin/python3', os.X_OK) else (shutil.which('python3') or sys.executable)


def require_py310() -> str:
    py = python3()
    r = subprocess.run([py, '-c', 'import sys; assert sys.version_info >= (3, 10)'], capture_output=True)
    if r.returncode != 0:
        pytest.skip('Python 3.10+ not available')
    return py


def exec_lines(text: str) -> list:
    """PHP exec()'s output array: one entry per line, trailing whitespace of each line dropped."""
    if text == '':
        return []
    lines = text.split('\n')
    if lines[-1] == '':
        lines.pop()
    return [line.rstrip(' \t\n\r\x0b\x0c') for line in lines]


def venv() -> str:
    if not os.access(VENV, os.X_OK):
        pytest.skip('venv python missing')
    return VENV


def assert_compiles(code: str, label: str = '') -> None:
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(code)
        path = f.name
    try:
        r = subprocess.run([python3(), '-m', 'py_compile', path], capture_output=True, text=True)
        assert r.returncode == 0, f'{label}: {r.stdout}{r.stderr}'
    finally:
        os.unlink(path)


def files_of(result: dict) -> dict:
    return {f['path']: f['code'] for f in result['files']}


def write_package(result: dict, base: str | None = None) -> str:
    """Write a manifest {root, files} to disk; returns the package folder."""
    import base64
    base = base or tempfile.mkdtemp(prefix='lgpkg_')
    root = os.path.join(base, result.get('root', 'pkg'))
    for f in result['files']:
        p = os.path.join(root, f['path'])
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = base64.b64decode(f['code']) if f.get('encoding') == 'base64' else f['code'].encode('utf-8')
        with open(p, 'wb') as fh:
            fh.write(data)
    return root


def bound_names(code: str) -> list:
    """Every top-level name a module binds (definitions and names pulled in by its own imports)."""
    names = []
    for line in code.split('\n'):
        m = re.match(r'^(?:async\s+)?def\s+(\w+)', line)
        if m:
            names.append(m.group(1))
            continue
        m = re.match(r'^class\s+(\w+)', line)
        if m:
            names.append(m.group(1))
            continue
        m = re.match(r'^(\w+)\s*(?::[^=]+)?=[^=]', line)
        if m:
            names.append(m.group(1))
            continue
        m = re.match(r'^from\s+[\w.]+\s+import\s+(.+)$', line)
        if m:
            for n in m.group(1).split(','):
                n = n.strip()
                if n in ('', '('):
                    continue
                a = re.search(r'\s+as\s+(\w+)', n)
                names.append(a.group(1) if a else n.strip('()'))
            continue
        m = re.match(r'^import\s+(\w+)', line)
        if m:
            names.append(m.group(1))
    out = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


# ---- the Dispatcher-demo fixture of LangGraphA2AGeneratorTest (shared by the modular / doc tests) ----

PLAYBOOK = ("Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n"
            "2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\n"
            "Actions used: #Get PTO Balance; #Request Approval; #Resolve Request\n")


def demo_db():
    return db(
        'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
        'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
        'CREATE TABLE system_llm_settings (provider_key TEXT, display_name TEXT, model TEXT, base_url TEXT, api_format TEXT, protocol TEXT, enabled INTEGER, sort_order INTEGER)',
        "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
        "INSERT INTO mcp_servers VALUES (9, NULL, 'News', 'http://localhost/news/', 1)",
        """INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{"type":"object","properties":{"email":{"type":"string"}}}')""",
        "INSERT INTO mcp_server_tools VALUES (2, 9, 'get_news', 'News', '{}')",
        "INSERT INTO system_llm_settings (provider_key, model, enabled) VALUES ('claude', 'claude-sonnet-4-5', 1)",
        "INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order) VALUES ('jev', 'Jev', 'jev-latest', NULL, 'router', 'typesafe', 1, 100)",
    )


def demo_agent(name, typ='standard', tools=None, extra=None):
    base = {'type': 'agent-template', 'agent_name': name, 'agent_type': typ,
            'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
            'tools': tools or [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}
    return {**(extra or {}), **base}


def demo_graph() -> dict:
    """Dispatcher-demo shape: start -> dispatcher -> {IT claims, Human resources -> playbook} -> output."""
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
            {'id': '2', 'node_type': '', 'config': demo_agent('techBuddy', 'dispatcher')},
            {'id': '3', 'node_type': '', 'config': demo_agent('IT claims', 'standard', ['mcp_get_news', 'run_skill_script'],
                                                             {'bound_skill': {'dir_name': 'html'}})},
            {'id': '4', 'node_type': '', 'config': demo_agent('Human resources')},
            {'id': '5', 'node_type': 'playbook', 'config': {'type': 'playbook', 'name': 'Playbook HR', 'playbook': PLAYBOOK,
                                                              'agent_provider': 'deepseek', 'model': 'deepseek-flash', 'writes_enabled': True}},
            {'id': '6', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
            {'from': '3', 'to': '6'}, {'from': '4', 'to': '5'}, {'from': '5', 'to': '6'},
        ],
    }


def graphs() -> dict:
    """LangGraphOutputStructureTest::graphs(): the Dispatcher demo, a plain chain, a playbook-only flow."""
    def agent(name):
        return {'type': 'agent-template', 'agent_name': name, 'agent_type': 'standard',
                'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
                'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}
    return {
        'dispatcher_demo': demo_graph(),
        'linear': {
            'nodes': [
                {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'write something'}},
                {'id': '2', 'node_type': '', 'config': agent('Researcher')},
                {'id': '3', 'node_type': '', 'config': agent('Writer')},
                {'id': '4', 'node_type': 'output', 'config': {'type': 'output'}},
            ],
            'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '3', 'to': '4'}],
        },
        'playbook_only': {
            'nodes': [
                {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
                {'id': '2', 'node_type': 'playbook', 'config': {'type': 'playbook', 'name': 'Playbook HR', 'playbook': PLAYBOOK,
                                                                  'agent_provider': 'deepseek', 'model': 'deepseek-v4-flash',
                                                                  'writes_enabled': True}},
                {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
            ],
            'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
        },
    }


def demo_generator():
    return generator(demo_db(), demo_graph(), skillsRoot=skills_root())


def demo_facts() -> dict:
    return demo_generator()._analyzeForEmit(44, '3')
