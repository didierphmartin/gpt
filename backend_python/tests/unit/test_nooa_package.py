"""Port of backend/tests/Unit/NOOAPackageTest.php and the NOOA cases of CompiledArchitectureDocTest.php.

The "Dispatcher demo" workflow (Start -> techBuddy (dispatcher) -> IT claims | Human resources -> Output) in
an in-memory SQLite read through the real repositories (compiled_target_support, the port of PHP's
tests/Unit/Support/DispatcherDemoFixture) -- never a configured database.
"""
from __future__ import annotations

import re

import pytest

from app.agent_team.services.nooa_generator import NOOAGenerator
from tests.unit import compiled_target_support as demo
from tests.unit import lg_support as S


def _compile(mode: str) -> dict:
    gen = demo.generator(NOOAGenerator, demo.pdo())
    if mode == 'single':
        return gen.generate(demo.WORKFLOW_ID)
    if mode == 'modular':
        return gen.generatePackage(demo.WORKFLOW_ID)
    return gen.generateA2A(demo.WORKFLOW_ID)


def _files() -> dict:
    return demo.package_files(NOOAGenerator)


def test_exposes_the_contract():
    assert 'async def run_workflow(prompt: str, session: str | None = None) -> str:' in _files()['workflow.py']


def test_emits_the_package_files():
    # the run server and script, plus the folder's own files (CompiledPackage); agents in separate files
    assert sorted(_files()) == ['.env.example', 'ARCHITECTURE.md', 'README.md', '__init__.py', 'agents/__init__.py',
                                'agents/human_resources.py', 'agents/it_claims.py', 'agents/techbuddy.py', 'api.py',
                                'common.py', 'requirements.txt', 'workflow.py']


def test_swarm_is_still_refused():
    """Spec §9: NOOA is batch-only, permanently. The refusal fires from workflowRepo.findById() alone: one
    agent_workflows row with orchestration='swarm', read back through a real WorkflowRepository."""
    db = S.db('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, orchestration TEXT)',
              "INSERT INTO agent_workflows (id, user_id, name, orchestration) VALUES (1, '1', 'Swarm Fixture', 'swarm')")
    gen = demo.generator(NOOAGenerator, db)
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
