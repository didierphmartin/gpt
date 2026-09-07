"""Port of backend/tests/Unit/WorkflowGraphAnalyzerAnalyzeTest.php (Phase 6, Task 1).

Exercises the DB-backed analyze() path with the repositories returning the
SAME object types they return in production -- specifically
WorkflowRepository.findById() returning a Workflow MODEL OBJECT (not a
dict).

Regression guard for the PHP bug where analyze() accessed $wf['name'] on a
Workflow object ("Cannot use object of type Workflow as array"), which
crashed every real generate-adk / generate-python call while the pure
analyzeGraph() unit tests passed.

DEVIATION FROM THE PHP ORACLE (documented): the PHP
WorkflowGraphAnalyzerAnalyzeTest mocks ONLY `PDO::query()` (for the
`system_llm_settings` lookup) and does NOT stub `PDO::prepare()`. Running
it live (`php vendor/bin/phpunit tests/Unit/WorkflowGraphAnalyzerAnalyzeTest.php`)
FAILS on this branch for BOTH test methods with
"Mockery\\Exception\\BadMethodCallException: Received Mockery_4_PDO::prepare(),
but no expectations were specified" -- WorkflowGraphAnalyzer::loadMcpToolsWithServers
(PHP 424-456) calls `$this->db->prepare()->execute()`, which the test's PDO
mock never anticipated (stale fixture, like the pin-test issue in
test_python_emit_helpers_pin.py). The backend_python `Db` wrapper doesn't
expose separate prepare()/execute() steps for a SELECT -- every other
ported repository (WorkflowRepository, AgentRepository, ...) calls
`self.db.fetch_all(sql, params)` for this, and this port's
`WorkflowGraphAnalyzer._loadMcpToolsWithServers` follows that same
established convention (see workflow_graph_analyzer.py). This test's FakeDb
therefore stubs `fetch_all` for BOTH the system_llm_settings query and the
MCP tool/server query, reflecting the real code path rather than the stale
PHP mock.
"""
from __future__ import annotations

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


class _FakeWorkflowRepo:
    def __init__(self, workflow: Workflow):
        self._workflow = workflow

    def findById(self, id_: int):
        return self._workflow if id_ == self._workflow.getId() else None


class _FakeGraphRepo:
    def __init__(self, graph: dict):
        self._graph = graph

    def getGraph(self, id_: int) -> dict:
        return self._graph


class _FakeAgentRepo:
    def findById(self, id_: int):
        return None


class _FakeDb:
    """Every `db.fetch_all(...)` call (system_llm_settings defaults lookup,
    MCP tool/server catalog lookup) returns an empty result set -- matching
    the PHP test's `$stmt->shouldReceive('fetchAll')->andReturn([])` for
    every query the real code path issues."""

    def fetch_all(self, sql, params=None):
        return []


def test_analyze_uses_workflow_object_api_and_returns_name():
    """PHP testAnalyzeUsesWorkflowObjectApiAndReturnsName (lines 29-67)."""
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {
                'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A',
                'provider': 'claude', 'model': 'm', 'selectedTools': [],
            }},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }

    # findById returns a Workflow MODEL OBJECT -- the production shape.
    workflow = Workflow({'id': 31, 'name': 'GEO Parallel Audit'})

    analyzer = WorkflowGraphAnalyzer(_FakeDb(), _FakeWorkflowRepo(workflow), _FakeGraphRepo(graph), _FakeAgentRepo())

    # Before the PHP fix this line threw: Error "Cannot use object of type Workflow as array".
    result = analyzer.analyze(31, '3')

    assert result['workflow']['name'] == 'GEO Parallel Audit'
    assert result['workflow']['id'] == 31
    assert '2' in result['agents']
    assert result['usedCatalog'] == {}


def test_analyze_falls_back_to_generated_name_when_blank():
    """PHP testAnalyzeFallsBackToGeneratedNameWhenBlank (lines 69-87)."""
    graph = {'nodes': [{'id': '1', 'type': 'start', 'config': {'type': 'start'}}], 'edges': []}
    workflow = Workflow({'id': 99, 'name': ''})

    analyzer = WorkflowGraphAnalyzer(_FakeDb(), _FakeWorkflowRepo(workflow), _FakeGraphRepo(graph), _FakeAgentRepo())
    result = analyzer.analyze(99, '1')

    assert result['workflow']['name'] == 'workflow_99'
