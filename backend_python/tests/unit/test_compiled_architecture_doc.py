"""Port of backend/tests/Unit/CompiledArchitectureDocTest.php: ARCHITECTURE.md of ADK, MAF and NOOA in each
code structure, as LangGraph's (test_lang_graph_architecture_doc.py)."""
from __future__ import annotations

import re

import pytest

from tests.unit import compiled_target_support as demo


def _generator_class(target: str):
    if target == 'adk':
        from app.agent_team.services.adk_generator import ADKGenerator
        return ADKGenerator
    if target == 'maf':
        from app.agent_team.services.maf_generator import MAFGenerator
        return MAFGenerator
    from app.agent_team.services.nooa_generator import NOOAGenerator
    return NOOAGenerator


# PHP: adk, maf, nooa -- each target joins once its Python port is PHP-faithful.
TARGETS = ('adk',)
CASES = [(t, m) for t in TARGETS for m in ('single', 'modular', 'a2a')]


def _compile(target: str, mode: str) -> dict:
    gen = demo.generator(_generator_class(target), demo.pdo())
    if mode == 'single':
        return gen.generate(demo.WORKFLOW_ID)
    if mode == 'modular':
        return gen.generatePackage(demo.WORKFLOW_ID)
    return gen.generateA2A(demo.WORKFLOW_ID)


@pytest.mark.parametrize('target,mode', CASES, ids=[f'{t} {m}' for t, m in CASES])
def test_every_structure_carries_its_architecture(target, mode):
    r = _compile(target, mode)
    doc = str(r['architecture'])
    assert doc.startswith('# Dispatcher demo: architecture')
    for section in ('## Files', '## Class diagram', '```mermaid\nclassDiagram', '## Workflow diagram',
                    '```mermaid\nflowchart LR', '## Classes and functions', '## How a run flows', '## How to change it'):
        assert section in doc, mode
    if mode != 'single':
        last = r['files'][-1]
        assert last['path'] == 'ARCHITECTURE.md', 'written beside the code, last'
        assert last['code'] == doc


@pytest.mark.parametrize('target,mode', CASES, ids=[f'{t} {m}' for t, m in CASES])
def test_it_describes_only_what_the_code_defines(target, mode):
    r = _compile(target, mode)
    code = '\n'.join(f['code'] for f in r['files']) if 'files' in r else r['code']
    names = re.findall(r'^### `([A-Za-z_]+)`', str(r['architecture']), re.M)
    assert names
    for name in names:
        assert re.search(r'^\s*(?:async\s+def|def|class)\s+' + re.escape(name) + r'\b|^' + re.escape(name) + r'\s*=', code, re.M), \
            f'{mode}: {name} is described but not defined'
    paths = [f['path'] for f in r['files']] if 'files' in r else [r['filename']]
    for p in re.findall(r'^\| `([^`]+)` \|', str(r['architecture']), re.M):
        if not p.endswith('/'):
            assert p in paths or (mode == 'single' and p == r['filename']), f'{mode}: {p}'
