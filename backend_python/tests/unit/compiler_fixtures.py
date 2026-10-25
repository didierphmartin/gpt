"""The compiler fixtures (tests/fixtures/compiler/workflows/*.json), built for the Python LangGraph compiler
exactly as tests/fixtures/compiler/php_compile.php builds them for the PHP one: an in-memory SQLite holding
schema.sql plus the fixture's rows, and in-memory workflow / graph / agent repositories."""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
from pathlib import Path

from app.agent_team.models.agent import Agent
from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from app.agent_team.services.start_document_store import StartDocumentStore
from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit.playbook.conftest import SqliteDb

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures' / 'compiler'
WORKFLOWS = FIXTURES / 'workflows'
SKILLS_ROOT = str(FIXTURES / 'skills')


def fixture_paths() -> list:
    return sorted(WORKFLOWS.glob('*.json'))


def load(path) -> dict:
    return json.loads(Path(path).read_text(encoding='utf-8'))


def fixture_db(sql: list) -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    for ddl in (FIXTURES / 'schema.sql').read_text(encoding='utf-8').split(';\n'):
        if ddl.strip():
            conn.execute(ddl)
    for stmt in sql:
        conn.execute(stmt)
    conn.commit()
    return SqliteDb(conn)


class FixtureWorkflowRepo:
    def __init__(self, row: dict):
        self.row = row

    def findById(self, id_, include_graph=False):
        return Workflow(self.row) if int(self.row['id']) == int(id_) else None


class FixtureGraphRepo:
    def __init__(self, graph: dict, components: dict):
        self.graph = graph
        self.components = components

    def getGraph(self, workflowId):
        graph = json.loads(json.dumps(self.graph))   # a fresh copy per read, as a repository returns
        return StartOptionGraph.expand(graph, lambda i: self.components.get(str(i)))


class FixtureAgentRepo:
    def __init__(self, agents: dict):
        self.agents = agents

    def findById(self, id_):
        row = self.agents.get(str(id_))
        return Agent(row) if row is not None else None


def generator(fx: dict) -> LangGraphGenerator:
    return LangGraphGenerator(
        fixture_db(fx.get('sql') or []),
        FixtureWorkflowRepo(fx['workflow']),
        FixtureGraphRepo(fx['graph'], fx.get('code_components') or {}),
        FixtureAgentRepo(fx.get('agents') or {}),
        SKILLS_ROOT,
        # A Start document is copied from storage/synergyaichatroot/<user folder>/ (no universalFS adapter).
        StartDocumentStore(str(fx['document_store']['user_folder']), None, str(FIXTURES / 'storage'))
        if 'document_store' in fx else None,
    )


def compile_python(fx: dict) -> dict:
    """{mode: generate() result | {'error': message}}, the PHP oracle's shape."""
    out = {}
    for mode in fx.get('modes') or ['single', 'modular', 'a2a']:
        try:
            out[mode] = generator(fx).generate(int(fx['workflow']['id']), str(fx.get('user_id') or '3'),
                                               {'a2a': mode == 'a2a', 'modular': mode == 'modular'})
        except Exception as e:  # noqa: BLE001 -- an error is a result to compare
            out[mode] = {'error': str(e)}
    return out


def php_binary() -> str | None:
    for cand in (os.environ.get('PHP_BIN'), '/Applications/XAMPP/xamppfiles/bin/php', shutil.which('php')):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def compile_php(paths: list) -> dict:
    """{fixture name: {mode: result}} from php_compile.php (raises when PHP fails)."""
    php = php_binary()
    env = dict(os.environ, XDEBUG_MODE='off')
    proc = subprocess.run([php, str(FIXTURES / 'php_compile.php'), *[str(p) for p in paths]],
                          capture_output=True, text=True, env=env, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f'php_compile.php failed ({proc.returncode}): {proc.stderr[-4000:]}')
    return json.loads(proc.stdout)


_GENERATED = re.compile(r'Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor')
_VERSION = re.compile(r'(WORKFLOW_VERSION = "\d+)-\d{8}"')


def normalize(text: str) -> str:
    """The wall clock is the only input the two compilers do not share: the Generated: stamp and the
    A2A/run-server WORKFLOW_VERSION date."""
    text = _GENERATED.sub('Generated:  <timestamp> by the SynergyAI workflow editor', text)
    return _VERSION.sub(r'\1-<date>"', text)


def file_map(result: dict) -> dict:
    """path -> normalized content (the single file's code under its filename, ARCHITECTURE.md under 'architecture')."""
    if 'error' in result:
        return {'<error>': result['error']}
    out = {}
    if 'files' in result:
        for f in result['files']:
            key = f['path'] + (' [base64]' if f.get('encoding') == 'base64' else '')
            out[key] = normalize(f['code'])
        out['<root>'] = result['root']
        if 'architecture' in result:
            out['<architecture>'] = normalize(result['architecture']) if result['architecture'] is not None else None
    else:
        out[result['filename']] = normalize(result['code'])
        out['<architecture>'] = normalize(result['architecture']) if result.get('architecture') is not None else None
        out['<keys>'] = ','.join(result.keys())
    return out
