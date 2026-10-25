"""Port of backend/tests/Unit/NOOAPackageTest.php and the NOOA cases of CompiledArchitectureDocTest.php.

The "Dispatcher demo" workflow (Start -> techBuddy (dispatcher) -> IT claims | Human resources -> Output) of
PHP's tests/Unit/Support/DispatcherDemoFixture, built as a compiler fixture (compiler_fixtures: an in-memory
SQLite database, never a configured one).
"""
from __future__ import annotations

import re

import pytest

from app.agent_team.services.nooa_generator import NOOAGenerator
from tests.unit import compiler_fixtures as cf
from tests.unit import lg_support as S


def _agent(name: str, typ: str = 'standard') -> dict:
    return {'type': 'agent-template', 'agent_name': name, 'agent_type': typ,
            'instructions': f'You are {name}.', 'agent_provider': 'deepseek', 'model': '', 'tools': []}


_WF = 44
_FX = {
    'workflow': {'id': _WF, 'user_id': 3, 'name': 'Dispatcher demo', 'description': 'Routes a request to IT or HR',
                 'steps': '[]', 'orchestration': 'workflow'},
    'graph': {
        'nodes': [{'id': str(i), 'drawflow_node_id': str(i), 'node_type': t, 'config': c} for i, (t, c) in {
            1: ('start', {'type': 'start', 'prompt': 'My laptop will not boot.'}),
            2: ('agent', _agent('techBuddy', 'dispatcher')),
            3: ('agent', _agent('IT claims')),
            4: ('agent', _agent('Human resources')),
            5: ('output', {'type': 'output'}),
        }.items()],
        'edges': [{'from': str(a), 'to': str(b)} for a, b in [(1, 2), (2, 3), (2, 4), (3, 5), (4, 5)]],
    },
    'sql': ["INSERT INTO system_llm_settings (provider_key, model, enabled) VALUES ('deepseek', 'deepseek-chat', 1)",
            "INSERT INTO system_llm_settings (provider_key, model, enabled) VALUES ('claude', 'claude-sonnet-4-6', 1)"],
}


def _compile(mode: str) -> dict:
    gen = cf.generator(_FX, 'nooa')
    if mode == 'single':
        return gen.generate(_WF)
    if mode == 'modular':
        return gen.generatePackage(_WF)
    return gen.generateA2A(_WF)


def _files() -> dict:
    return {f['path']: f['code'] for f in _compile('modular')['files']}


def test_exposes_the_contract():
    assert 'async def run_workflow(prompt: str, session: str | None = None) -> str:' in _files()['workflow.py']


def test_emits_the_package_files():
    # the run server and script, plus the folder's own files (CompiledPackage); agents in separate files
    assert sorted(_files()) == ['.env.example', 'ARCHITECTURE.md', 'README.md', '__init__.py', 'agents/__init__.py',
                                'agents/human_resources.py', 'agents/it_claims.py', 'agents/techbuddy.py', 'api.py',
                                'common.py', 'requirements.txt', 'workflow.py']


def test_swarm_is_still_refused():
    """Spec §9: NOOA is batch-only, permanently. The refusal fires from workflowRepo.findById() alone."""
    gen = NOOAGenerator(S.db(), S.WfRepo({'id': 1, 'user_id': '1', 'name': 'Swarm Fixture', 'orchestration': 'swarm'}),
                        S.GraphRepo({'nodes': [], 'edges': []}), S.AgentRepo())
    with pytest.raises(RuntimeError, match='NOOA cannot compile'):
        gen.generate(1)


# ---- CompiledArchitectureDocTest.php, the NOOA cases ----

MODES = ['single', 'modular', 'a2a']


@pytest.mark.parametrize('mode', MODES)
def test_every_structure_carries_its_architecture(mode):
    r = _compile(mode)
    doc = str(r['architecture'])
    assert doc.startswith('# Dispatcher demo: architecture')
    for section in ['## Files', '## Class diagram', '```mermaid\nclassDiagram', '## Workflow diagram',
                    '```mermaid\nflowchart LR', '## Classes and functions', '## How a run flows', '## How to change it']:
        assert section in doc, mode
    if mode != 'single':
        last = r['files'][-1]
        assert last['path'] == 'ARCHITECTURE.md', 'written beside the code, last'
        assert last['code'] == doc


@pytest.mark.parametrize('mode', MODES)
def test_it_describes_only_what_the_code_defines(mode):
    r = _compile(mode)
    code = '\n'.join(f['code'] for f in r['files']) if 'files' in r else r['code']
    names = re.findall(r'^### `([A-Za-z_]+)`', str(r['architecture']), re.M)
    assert names
    for name in names:
        n = re.escape(name)
        assert re.search(r'^\s*(?:async\s+def|def|class)\s+' + n + r'\b|^' + n + r'\s*=', code, re.M), \
            f'{mode}: {name} is described but not defined'
    # every file the table names is a file of the compile
    paths = [f['path'] for f in r['files']] if 'files' in r else [r['filename']]
    for p in re.findall(r'^\| `([^`]+)` \|', str(r['architecture']), re.M):
        if not p.endswith('/'):
            assert p in paths or (mode == 'single' and p == r['filename']), f'{mode}: {p}'
