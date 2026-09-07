"""Port of backend/tests/Unit/LangGraphParityTest.php (Phase 6, Task 2)."""
from __future__ import annotations

from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


def test_topo_order_matches_analyzer():
    """PHP testTopoOrderMatchesAnalyzer (lines 10-22)."""
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent'}},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }
    a = WorkflowGraphAnalyzer.analyzeGraph(graph)
    assert a['order'] == ['1', '2', '3']
