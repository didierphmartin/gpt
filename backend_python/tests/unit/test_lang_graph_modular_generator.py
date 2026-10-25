"""Port of backend/tests/Unit/LangGraphModularGeneratorTest.php.

LangGraph compiler, modular mode ("agents in separate files"): workflow.py (the graph), common.py (the
shared runtime) and one importable module per agent/playbook node under agents/. The files run in ONE
process and link by `import`, so the tests check the split and the seam. Fixture shared with the A2A test.
"""
from __future__ import annotations

import os
import re

from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from tests.unit import lg_support as S


def _manifest() -> dict:
    return S.demo_generator().generate(44, '3', {'modular': True})


def _files() -> dict:
    return S.files_of(_manifest())


def test_layout_names_one_importable_module_per_agent_or_playbook_node():
    layout = LangGraphGenerator.modularLayout(S.demo_facts())
    assert layout['root'] == 'dispatcher_demo_modular'
    assert list(layout['agents']) == ['2', '3', '4', '5'], 'ORDER order, no start/output'
    assert layout['agents']['2']['file'] == 'agents/techbuddy.py'
    assert layout['agents']['3']['file'] == 'agents/it_claims.py'
    assert layout['agents']['4']['file'] == 'agents/human_resources.py'
    assert layout['agents']['5']['file'] == 'agents/playbook_hr.py'
    assert layout['agents']['3']['module'] == 'agents.it_claims'
    for e in layout['agents'].values():
        assert re.match(r'^[a-z_][a-z0-9_]*$', os.path.basename(e['file'])[:-3]), 'valid module name'


def test_module_names_fall_back_when_the_display_name_is_not_an_identifier():
    facts = S.demo_facts()
    facts['agentData']['3']['display'] = '2024 Réview!'
    facts['agentData']['4']['display'] = '2024 Review'
    layout = LangGraphGenerator.modularLayout(facts)
    assert layout['agents']['3']['file'] == 'agents/node_3_2024_review.py'
    assert layout['agents']['4']['file'] == 'agents/node_4_2024_review.py'


def test_modular_option_returns_a_manifest():
    m = _manifest()
    assert m['root'] == 'dispatcher_demo_modular'
    assert [f['path'] for f in m['files']] == [
        'workflow.py', 'common.py', 'api.py', 'agents/__init__.py',
        'agents/techbuddy.py', 'agents/it_claims.py', 'agents/human_resources.py', 'agents/playbook_hr.py',
        'requirements.txt', '.env.example', 'README.md', 'skills/html/SKILL.md',
        'ARCHITECTURE.md',
    ]
    for f in m['files']:
        if not f['path'].endswith('.py'):
            continue
        S.assert_compiles(f['code'], f['path'])
        if f['path'] == 'agents/__init__.py':
            continue
        assert 'PROVENANCE' in f['code'], f['path']
        if f['path'] in ('common.py', 'api.py'):
            continue
        assert 'GRAPH EDGES' in f['code'], f['path']


def test_common_module_holds_the_shared_runtime_and_no_graph():
    code = _files()['common.py']
    for needle in ['"""Shared runtime for workflow "Dispatcher demo"', 'def _make_llm(', 'class McpClient:',
                   'class ToolCatalog:', 'class SkillRuntime:', 'TOOLS = ToolCatalog(TOOL_CATALOG)',
                   'class Dispatcher:', 'def inject_datetime(', 'def build_context(',
                   'class DocumentConverter:', 'class WFState(', 'class PlaybookToolset:',
                   '    def gate(self, kind: str, name: str, args: dict) -> dict:', 'class Node(ABC):', 'def make_node(cfg: dict) -> Node:',
                   'class WorkflowGraph:', 'def save_output(', 'def print_run_summary(', 'RUN SUMMARY']:
        assert needle in code, f'missing: {needle}'
    assert '"get_news"' in code
    for needle in ['EDGES = ', 'ORDER = ', 'NODE_TYPES = ', 'NODE = {', 'AGENTS = {']:
        assert not re.search(r'(?<![A-Z_])' + re.escape(needle), code), f'common.py must not carry: {needle}'
    assert not re.search(r'^async def run\(', code, re.M)


def test_agent_module_imports_the_runtime_and_bakes_only_its_own_node():
    code = _files()['agents/it_claims.py']
    for needle in ['"""Agent module "IT claims" -- node 3 of workflow "Dispatcher demo"',
                   'from common import', 'run_node = make_node(NODE).run', 'NODE = {', '"kind": "agent"',
                   '# ---- node 3: IT claims (agent)', '<== this module']:
        assert needle in code, f'missing: {needle}'
    assert '"tool_names": ["get_news","run_skill_script"]' in code
    assert '"skills": [{"dir":"html"}]' in code
    for needle in ['class McpClient', 'class ToolCatalog', 'def _make_llm(', 'TOOL_CATALOG = ', 'def build_agent_card', 'uvicorn']:
        assert needle not in code, f'agent module must not carry: {needle}'


def test_dispatcher_module_carries_its_menu():
    code = _files()['agents/techbuddy.py']
    assert '"kind": "dispatcher"' in code
    assert ('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, '
            '{"id": "4", "name": "Human resources", "description": ""}]') in code
    assert 'run_node = make_node(NODE).run' in code


def test_playbook_module_keeps_console_gates():
    files = _files()
    code = files['agents/playbook_hr.py']
    assert '"kind": "playbook"' in code
    assert '"instructions": """' in code
    assert 'class PlaybookNode(Node):' in files['common.py']
    assert '"workday__get_pto_balance"' in code
    assert '_a2a_gate' not in code
    assert 'requires_input(' not in code


def test_workflow_module_wires_the_graph_over_the_agent_modules():
    code = _files()['workflow.py']
    for needle in ['"""LangGraph workflow: Dispatcher demo', 'from agents.techbuddy import run_node as techbuddy_run',
                   'from agents.playbook_hr import run_node as playbook_hr_run', 'from common import',
                   'EDGES = ', 'ORDER = ', 'NODE_TYPES = ', 'def build_graph(recorder: RunRecorder | None = None) -> WorkflowGraph:',
                   'async def run(', 'save_output(', 'print_run_summary(',
                   'if __name__ == "__main__":', 'AGENT MODULES']:
        assert needle in code, f'missing: {needle}'
    for needle in ['class PlaybookToolset:', 'class ToolCatalog', 'create_react_agent(', 'PLAYBOOK_SYSTEM_PROMPT = ']:
        assert needle not in code, f'workflow.py must not carry: {needle}'


def test_every_cross_module_import_resolves():
    files = _files()
    bound = {}
    for path, code in files.items():
        if not path.endswith('.py'):
            continue
        mod = 'workflow' if path == 'workflow.py' else ('common' if path == 'common.py' else 'agents.' + os.path.basename(path)[:-3])
        bound[mod] = S.bound_names(code)
    checked = 0
    for path, code in files.items():
        if not path.endswith('.py'):
            continue
        for m in re.finditer(r'^from\s+(common|agents\.\w+)\s+import\s+(.+)$', code, re.M):
            assert m.group(1) in bound, f'{path} imports unknown module {m.group(1)}'
            for name in m.group(2).split(','):
                name = name.strip()
                a = re.match(r'^(\w+)\s+as\s+\w+$', name)
                symbol = a.group(1) if a else name
                assert symbol in bound[m.group(1)], f'{path}: {m.group(1)} does not define {symbol}'
                checked += 1
    assert checked > 10, 'expected the modules to actually import from each other'


def test_single_file_output_unchanged_without_the_option():
    code = S.demo_generator().generate(44, '3')['code']
    assert '"""Standalone LangGraph workflow: Dispatcher demo' in code
    assert 'PLAYBOOKS = {' in code
    assert 'from common import' not in code
