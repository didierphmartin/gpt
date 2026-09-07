"""Port of the LangGraph cases of backend/tests/Unit/GeneratedDocParityTest.php
(Phase 6, Task 2). The ADK/MAF/NOOA cases of that PHP file are Task 3's to
port (separate file, not duplicated here) -- see the umbrella brief.

Every compile target documents the generated script the same way, for any
workflow shape: PROVENANCE, GRAPH NODES, GRAPH EDGES, EXECUTION ORDER, DATA
FLOW, TO RUN in the module docstring, and a uniform comment block before each
node definition. This file exercises that contract against LangGraphGenerator
only.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer

PLAYBOOK = ("Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n"
            "1. #Get PTO Balance for the requester.\n"
            "2. #Request Approval from the manager then #Resolve Request.\n\n"
            "Tools used: Workday\n\n"
            "Actions used: #Get PTO Balance; #Request Approval; #Resolve Request\n")

_WORKDAY_PTO = {
    'tool_name': 'get_pto_balance', 'description': 'Get balances',
    'input_schema': '{"type":"object","properties":{"email":{"type":"string"}}}',
    'server_name': 'Workday', 'server_url': 'http://localhost/mockstack/index.php/workday',
    'server_user_id': '3', 'enabled': 1,
}
_LLM_ROWS = [{'provider_key': 'claude', 'model': 'claude-sonnet-4-5'}]


class _FakeDb:
    def __init__(self, mcp_rows, llm_rows):
        self._mcp_rows = mcp_rows
        self._llm_rows = llm_rows

    def fetch_all(self, sql, params=None):
        params = params or {}
        if 'system_llm_settings' in sql:
            return list(self._llm_rows)
        if 'mcp_server_tools' in sql:
            uid = params.get('uid')
            out = []
            for row in self._mcp_rows:
                if row.get('enabled', 1) != 1:
                    continue
                row_uid = row.get('server_user_id')
                if row_uid is None or (uid is not None and str(row_uid) == str(uid)):
                    out.append(row)
            return out
        return []


class _FakeWorkflowRepo:
    def __init__(self, workflow: Workflow):
        self._wf = workflow

    def findById(self, id_, include_graph=False):
        return self._wf if id_ == self._wf.getId() else None


class _FakeGraphRepo:
    def __init__(self, graph: dict):
        self._graph = graph

    def getGraph(self, id_):
        return self._graph


class _FakeAgentRepo:
    def findById(self, id_):
        return None


def _agent(name: str, agent_type: str = 'standard') -> dict:
    """The Dispatcher-demo shape, with the '' node_type the editor really saves."""
    return {
        'type': 'agent-template', 'agent_name': name, 'agent_type': agent_type,
        'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
        'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096},
    }


def _graph() -> dict:
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


def _generate() -> str:
    wf = Workflow({'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'})
    db = _FakeDb([_WORKDAY_PTO], _LLM_ROWS)
    gen = LangGraphGenerator(db, _FakeWorkflowRepo(wf), _FakeGraphRepo(_graph()), _FakeAgentRepo())
    return gen.generate(44, '3')['code']


def test_analyzer_reads_empty_node_type_from_config():
    """PHP testAnalyzerReadsEmptyNodeTypeFromConfig (lines 83-88)."""
    assert WorkflowGraphAnalyzer.typeOf({'node_type': '', 'config': {'type': 'agent-template'}}) == 'agent-template'
    assert WorkflowGraphAnalyzer.typeOf({'node_type': 'playbook', 'config': {'type': 'agent'}}) == 'playbook'
    assert WorkflowGraphAnalyzer.typeOf({'config': {}}) == 'agent'


def test_every_target_carries_the_same_documentation_sections():
    """PHP testEveryTargetCarriesTheSameDocumentationSections (lines 90-110), LangGraph only."""
    code = _generate()
    doc = code[:code.index('"""', 3)]
    for needle in [
        'PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
        'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
        'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), DISPATCHER -> one of: IT claims | Human resources',
        'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
        'layer 2:  IT claims  ||  Human resources',
        'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF',
    ]:
        assert needle in doc, f"docstring lacks {needle}"
    assert re.search(r'Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor', doc)
    # Uniform per-node comment block before every agent definition.
    assert '# ---- node 2: techBuddy (agent-template) ' in code
    assert '#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default' in code
    assert '#   dispatcher     : routes to one of: IT claims | Human resources' in code
    assert '#   children       : IT claims (3) | Human resources (4)' in code
    assert '#   parents        : techBuddy (2)' in code


def test_agents_with_empty_db_node_type_compile_on_langgraph():
    """PHP testAgentsWithEmptyDbNodeTypeCompileOnEveryTarget (lines 112-117), LangGraph only."""
    assert 'You are Human resources.' in _generate()


def test_playbook_and_dispatcher_support_is_stated_honestly():
    """PHP testPlaybookAndDispatcherSupportIsStatedHonestly (lines 119-136), the $lg block only
    (the ADK/MAF/NOOA foreach in the PHP test is Task 3's to port)."""
    lg = _generate()
    assert 'playbook "Time Off", 1 bound / 0 unbound action(s), writes ON' in lg
    assert '(dispatcher: only the chosen one runs)' in lg
    assert 'PLAYBOOK_GATE_MODE' in lg
    assert 'DEEPSEEK_API_KEY (deepseek)' in lg


def test_every_target_still_emits_valid_python():
    """PHP testEveryTargetStillEmitsValidPython (lines 138-147), LangGraph only."""
    code = _generate()
    fd, path = tempfile.mkstemp(suffix='.py')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(code)
        r = subprocess.run(['python3', '-m', 'py_compile', path], capture_output=True, text=True)
        assert r.returncode == 0, r.stdout + r.stderr
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
