"""Port of backend/tests/Unit/WorkflowGraphAnalyzerTest.php (Phase 6, Task 1)."""
from __future__ import annotations

import pytest

from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


def _diamond() -> dict:
    """A diamond: start(1) -> a(2), start(1) -> b(3), a(2) -> out(4), b(3) -> out(4)."""
    return {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {
                'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'You are A',
                'provider': 'claude', 'model': 'claude-sonnet-4-6', 'selectedTools': [],
            }},
            {'id': '3', 'type': 'agent', 'config': {
                'type': 'agent', 'agent_name': 'B', 'systemPrompt': 'You are B',
                'provider': 'gemini', 'model': 'gemini-2.5-pro', 'selectedTools': [],
            }},
            {'id': '4', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2'}, {'from': '1', 'to': '3'},
            {'from': '2', 'to': '4'}, {'from': '3', 'to': '4'},
        ],
    }


def test_layers_group_independent_nodes():
    """PHP testLayersGroupIndependentNodes (lines 27-35)."""
    a = WorkflowGraphAnalyzer.analyzeGraph(_diamond())
    # level 0: [1]; level 1: [2,3] (independent, same depth); level 2: [4]
    assert a['layers'][0] == ['1']
    assert sorted(a['layers'][1]) == ['2', '3']
    assert a['layers'][2] == ['4']


def test_parents_and_children():
    """PHP testParentsAndChildren (lines 37-44)."""
    a = WorkflowGraphAnalyzer.analyzeGraph(_diamond())
    assert sorted(a['parents']['4']) == ['2', '3']
    assert sorted(a['children']['1']) == ['2', '3']


def test_start_node_and_order_guarantees():
    """PHP testStartNodeAndOrderGuarantees (lines 46-52)."""
    a = WorkflowGraphAnalyzer.analyzeGraph(_diamond())
    assert a['startNodeId'] == '1'
    assert '1' in a['order']
    assert all(isinstance(x, str) for x in a['order'])


def test_cycle_throws_runtime_exception():
    """PHP testCycleThrowsRuntimeException (lines 54-67)."""
    with pytest.raises(RuntimeError):
        WorkflowGraphAnalyzer.analyzeGraph({
            'nodes': [
                {'id': '1', 'type': 'agent'},
                {'id': '2', 'type': 'agent'},
            ],
            'edges': [
                {'from': '1', 'to': '2'},
                {'from': '2', 'to': '1'},
            ],
        })


def test_agent_surfaces_bound_skill_dir():
    """PHP testAgentSurfacesBoundSkillDir (lines 69-86). analyzeGraph is
    structural; skills come from the config-aware path. Assert the helper
    directly."""
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {
                'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'do it',
                'provider': 'claude', 'model': 'm', 'selectedTools': [],
                'bound_skill': {'id': None, 'source': 'local', 'dir_name': 'GEO/geo-report', 'name': 'R'},
            }},
        ],
        'edges': [{'from': '1', 'to': '2'}],
    }
    WorkflowGraphAnalyzer.analyzeGraph(graph)
    skills = WorkflowGraphAnalyzer.skillsFromConfig(graph['nodes'][1]['config'])
    assert skills == [{'dir': 'GEO/geo-report'}]


def test_legacy_inline_skill_content_becomes_inline_entry():
    """PHP testLegacyInlineSkillContentBecomesInlineEntry (lines 88-92)."""
    cfg = {'type': 'agent', 'skill_content': 'legacy instructions'}
    assert WorkflowGraphAnalyzer.skillsFromConfig(cfg) == [{'inline': 'legacy instructions'}]


def test_no_skill_yields_empty_list():
    """PHP testNoSkillYieldsEmptyList (lines 94-97)."""
    assert WorkflowGraphAnalyzer.skillsFromConfig({'type': 'agent'}) == []
