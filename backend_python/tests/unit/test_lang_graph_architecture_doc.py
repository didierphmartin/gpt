"""Port of backend/tests/Unit/LangGraphArchitectureDocTest.php.

ARCHITECTURE.md: the LangGraph compiler describes the package it emits -- its files, the classes actually
present, this workflow's graph, how a run flows and how to change it -- for single, modular and A2A.
"""
from __future__ import annotations

import io
import re
import zipfile

import pytest

from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from tests.unit import lg_support as S


def _generate(graph, mode: str) -> dict:
    g = graph if isinstance(graph, dict) else S.graphs()[graph]
    gen = S.generator(S.demo_db(), g, skillsRoot=S.skills_root())
    return gen.generate(44, '3', {} if mode == 'single' else {mode: True})


def _mermaid_blocks(doc: str) -> dict:
    out = {}
    for body in re.findall(r'```mermaid\n(.*?)```', doc, re.S):
        out[body.split('\n', 1)[0]] = body
    return out


def test_every_mode_exposes_the_doc_and_keeps_its_existing_keys():
    single = _generate('dispatcher_demo', 'single')
    assert list(single) == ['filename', 'code', 'architecture', 'package_files']
    assert [f['path'] for f in single['package_files']] == ['requirements.txt', '.env.example', 'README.md']
    for mode in ('modular', 'a2a'):
        r = _generate('dispatcher_demo', mode)
        assert list(r) == ['root', 'files', 'architecture'], mode
        last = r['files'][-1]
        assert last['path'] == 'ARCHITECTURE.md', f'{mode}: written beside the code, last'
        assert last['code'] == r['architecture'], mode


def test_doc_has_both_diagrams_and_every_section():
    for mode in ('single', 'modular', 'a2a'):
        doc = _generate('dispatcher_demo', mode)['architecture']
        assert doc.startswith('# Dispatcher demo'), mode
        for h in ['## Files', '## Class diagram', '## Workflow diagram', '## Classes', '## How a run flows', '## How to change it']:
            assert f'\n{h}\n' in doc, f'{mode}: {h}'
        assert list(_mermaid_blocks(doc)) == ['classDiagram', 'flowchart LR'], mode


def test_files_table_names_the_real_files_of_each_mode():
    single = _generate('dispatcher_demo', 'single')['architecture']
    assert '| `dispatcher_demo_langgraph.py` |' in single
    modular = _generate('dispatcher_demo', 'modular')
    for f in modular['files']:
        m = re.match(r'^skills/(.+)/SKILL\.md$', f['path'])
        row = f'skills/{m.group(1)}/' if m else f['path']
        if f['path'].startswith('skills/') and row == f['path']:
            continue
        assert f'| `{row}` |' in modular['architecture'], f['path']
    assert '`run_node = make_node(NODE).run`' in modular['architecture']
    a2a = _generate('dispatcher_demo', 'a2a')
    for f in a2a['files']:
        assert f"| `{f['path']}` |" in a2a['architecture'], f['path']


def test_class_diagram_lists_only_the_classes_present():
    base = ['Node', 'AgentNode', 'DispatcherNode', 'NodeKind', 'Dispatcher', 'DecisionResult',
            'RouteDecision', 'WorkflowGraph', 'ToolCatalog', 'McpClient', 'SkillRuntime', 'RunEvents', 'DocumentConverter']
    adapter = ['JevRouter']
    playbook = ['PlaybookNode', 'PlaybookRun', 'PlaybookToolset']
    a2aOnly = ['AgentSupervisor', 'NodeExecutor']
    cases = [
        ('dispatcher_demo', 'modular', base + adapter + playbook, a2aOnly),
        ('dispatcher_demo', 'a2a', base + adapter + playbook + a2aOnly, []),
        ('linear', 'single', base, adapter + playbook + a2aOnly),
    ]
    for graph, mode, present, absent in cases:
        r = _generate(graph, mode)
        doc = r['architecture']
        diagram = _mermaid_blocks(doc)['classDiagram']
        code = r['code'] if mode == 'single' else '\n'.join(f['code'] for f in r['files'])
        for cls in present:
            assert re.search(r'\b' + cls + r'\b', diagram), f'{graph}/{mode}: {cls} in the diagram'
            assert f'### {cls}\n' in doc, f'{graph}/{mode}: {cls} described'
            assert re.search(r'^class ' + cls + r'\b', code, re.M), f'{graph}/{mode}: {cls} really emitted'
        for cls in absent:
            assert not re.search(r'\b' + cls + r'\b', diagram), f'{graph}/{mode}: no {cls}'
            assert f'### {cls}' not in doc, f'{graph}/{mode}: no {cls} section'


def test_no_playbook_section_without_a_playbook():
    doc = _generate('linear', 'modular')['architecture']
    assert 'Playbook' not in doc
    assert 'PLAYBOOK_GATE_MODE' not in doc


def test_workflow_diagram_names_every_node_and_labels_dispatcher_choices():
    flow = _mermaid_blocks(_generate('dispatcher_demo', 'modular')['architecture'])['flowchart LR']
    for name in ['Start', 'techBuddy', 'IT claims', 'Human resources', 'Playbook HR', 'Output']:
        assert f'"{name}' in flow, name
    assert 'n1 --> n2' in flow
    assert 'n2 -.->|choice| n3' in flow
    assert 'n2 -.->|choice| n4' in flow
    assert 'n4 --> n5' in flow
    assert 'n1 -.->' not in flow
    linear = _mermaid_blocks(_generate('linear', 'single')['architecture'])['flowchart LR']
    for name in ['Start', 'Researcher', 'Writer', 'Output']:
        assert f'"{name}' in linear, name
    assert 'choice' not in linear


def test_ingestion_workflow_is_refused():
    with pytest.raises(RuntimeError) as e:
        _generate({
            'nodes': [
                {'id': '1', 'node_type': 'start', 'config': {'type': 'start'}},
                {'id': '2', 'node_type': 'loader', 'config': {'type': 'loader'}},
                {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
            ],
            'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
        }, 'single')
    assert 'Node "node_2" (loader) cannot be compiled: LangGraph runs start, agent, playbook, code and output nodes.' in str(e.value)


def test_a_doc_failure_still_returns_the_code_files():
    facts = S.demo_facts()
    facts['workflow'] = None   # build() calls facts['workflow'].isOutputStorageEnabled(): raises
    for mode in ('modular', 'a2a'):
        code = [{'path': 'workflow.py', 'code': 'print(1)'}, {'path': 'agents/a.py', 'code': 'NODE = {}'}]
        r = LangGraphGenerator._withArchitecture({'root': f'demo_{mode}', 'files': list(code)}, facts, mode)
        assert r['files'] == code, f'{mode}: the code files, nothing added'
        assert 'architecture' in r, mode
        assert r['architecture'] is None, mode
        z = WorkflowController.langGraphZipResponse(r, mode)
        with zipfile.ZipFile(io.BytesIO(z['raw_body'])) as zf:
            assert zf.namelist() == [f'demo_{mode}/workflow.py', f'demo_{mode}/agents/a.py'], mode


def test_ingestion_package_gets_no_architecture_doc():
    facts = S.demo_facts()
    facts['byId']['99'] = {'id': '99', 'node_type': 'loader', 'config': {'type': 'loader'}}
    r = LangGraphGenerator._withArchitecture({'root': 'feed_modular', 'files': [{'path': 'workflow.py', 'code': ''}]}, facts, 'modular')
    assert [f['path'] for f in r['files']] == ['workflow.py']
    assert r['architecture'] is None


def test_run_flow_and_change_sections_follow_the_mode():
    single = _generate('dispatcher_demo', 'single')['architecture']
    assert '`_run_local_node`' in single
    modular = _generate('dispatcher_demo', 'modular')['architecture']
    assert '`_run_node_module`' in modular
    assert 'python workflow.py' in modular
    a2a = _generate('dispatcher_demo', 'a2a')['architecture']
    assert '`_run_remote_node`' in a2a
    assert 'python orchestrator.py' in a2a
    for doc in (single, modular, a2a):
        for needle in ['WorkflowGraph.run(prompt)', 'save_output', 'RUN SUMMARY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY',
                       '`<PROVIDER>_API_KEY` per decision model']:
            assert needle in doc
