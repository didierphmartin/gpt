"""The compiler fixtures (tests/fixtures/compiler/workflows/*.json), built for a Python compiler (LangGraph,
ADK, MAF, NOOA) exactly as tests/fixtures/compiler/php_compile.php builds them for the PHP one: an in-memory SQLite holding
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


TARGETS = ('langgraph', 'adk', 'maf', 'nooa')


def _generator_class(target: str):
    if target == 'langgraph':
        return LangGraphGenerator
    if target == 'adk':
        from app.agent_team.services.adk_generator import ADKGenerator
        return ADKGenerator
    if target == 'maf':
        from app.agent_team.services.maf_generator import MAFGenerator
        return MAFGenerator
    if target == 'nooa':
        from app.agent_team.services.nooa_generator import NOOAGenerator
        return NOOAGenerator
    raise ValueError(f'unknown target {target}')


def modes(fx: dict, target: str = 'langgraph') -> list:
    """LangGraph compiles the modes the fixture lists; ADK, MAF and NOOA always all three (php_compile.php)."""
    return (fx.get('modes') or ['single', 'modular', 'a2a']) if target == 'langgraph' else ['single', 'modular', 'a2a']


def generator(fx: dict, target: str = 'langgraph'):
    return _generator_class(target)(
        fixture_db(fx.get('sql') or []),
        FixtureWorkflowRepo(fx['workflow']),
        FixtureGraphRepo(fx['graph'], fx.get('code_components') or {}),
        FixtureAgentRepo(fx.get('agents') or {}),
        SKILLS_ROOT,
        # A Start document is copied from storage/synergyaichatroot/<user folder>/ (no universalFS adapter).
        StartDocumentStore(str(fx['document_store']['user_folder']), None, str(FIXTURES / 'storage'))
        if 'document_store' in fx else None,
    )


def compile_python(fx: dict, target: str = 'langgraph') -> dict:
    """{mode: generate() result | {'error': message}}, the PHP oracle's shape. ADK, MAF and NOOA compile as
    WorkflowController.compiledTargetResponse() does: generate(), generatePackage(), generateA2A()."""
    out = {}
    wf_id, user = int(fx['workflow']['id']), str(fx.get('user_id') or '3')
    for mode in modes(fx, target):
        try:
            gen = generator(fx, target)
            if target == 'langgraph':
                out[mode] = gen.generate(wf_id, user, {'a2a': mode == 'a2a', 'modular': mode == 'modular'})
            elif mode == 'a2a':
                out[mode] = gen.generateA2A(wf_id, user)
            elif mode == 'modular':
                out[mode] = gen.generatePackage(wf_id, user)
            else:
                out[mode] = gen.generate(wf_id, user)
        except Exception as e:  # noqa: BLE001 -- an error is a result to compare
            out[mode] = {'error': str(e)}
    return out


def php_binary() -> str | None:
    for cand in (os.environ.get('PHP_BIN'), '/Applications/XAMPP/xamppfiles/bin/php', shutil.which('php')):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def compile_php(paths: list, target: str = 'langgraph') -> dict:
    """{fixture name: {mode: result}} from php_compile.php --target=<target> (raises when PHP fails)."""
    php = php_binary()
    env = dict(os.environ, XDEBUG_MODE='off')
    proc = subprocess.run([php, str(FIXTURES / 'php_compile.php'), f'--target={target}', *[str(p) for p in paths]],
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
        for f in result.get('package_files') or []:   # requirements.txt, .env.example, README.md beside the script
            out['<package_files>/' + f['path']] = normalize(f['code'])
        out['<keys>'] = ','.join(result.keys())
    return out
