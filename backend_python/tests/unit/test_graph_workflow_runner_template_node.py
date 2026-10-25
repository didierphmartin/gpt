"""Port of backend/tests/Unit/GraphWorkflowRunnerTemplateNodeTest.php.

An agent-template node set up on the canvas (a dispatcher with its provider and routing in the node) runs as an
inline agent on the server, as it does in the editor's browser run; a template never set up still stops the run.
"""
from __future__ import annotations

from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner


def _node(type_: str, config: dict, agentId=None) -> dict:
    return {'id': '7', 'node_type': type_, 'agent_id': agentId, 'config': config}


def test_a_canvas_dispatcher_runs_as_an_agent():
    dispatcher = _node('agent-template', {'type': 'agent-template', 'agent_name': 'email dispatcher',
                                          'agent_type': 'dispatcher', 'agent_provider': 'claude', 'isTemplate': False,
                                          'settings': {'routing_mode': 'jev', 'unclear_branch': 'Miscellaneous'}})
    out = GraphWorkflowRunner.configuredTemplatesAsAgents({'nodes': [dispatcher], 'edges': []})
    assert out['nodes'][0]['node_type'] == 'agent'
    assert out['nodes'][0]['config'] == dispatcher['config']


def test_a_template_linked_to_a_saved_agent_runs_that_agent():
    out = GraphWorkflowRunner.configuredTemplatesAsAgents({'nodes': [
        _node('agent-template', {'type': 'agent-template', 'agent_id': 42}),
    ], 'edges': []})
    assert out['nodes'][0]['node_type'] == 'agent'
    assert out['nodes'][0]['agent_id'] == 42


def test_an_empty_column_falls_back_to_the_config_type():
    out = GraphWorkflowRunner.configuredTemplatesAsAgents({'nodes': [
        _node('', {'type': 'agent-template', 'agent_name': 'triage', 'instructions': 'Sort it.'}),
    ], 'edges': []})
    assert out['nodes'][0]['node_type'] == 'agent'


def test_a_template_never_set_up_is_left_to_fail():
    nodes = [
        _node('agent-template', {'type': 'agent-template', 'isTemplate': True, 'agent_name': 'Agent'}),
        _node('agent-template', {'type': 'agent-template', 'agent_name': '', 'instructions': ''}),
    ]
    out = GraphWorkflowRunner.configuredTemplatesAsAgents({'nodes': nodes, 'edges': []})
    assert out['nodes'][0]['node_type'] == 'agent-template'
    assert out['nodes'][1]['node_type'] == 'agent-template'


def test_other_nodes_and_edges_are_untouched():
    graph = {'nodes': [_node('code', {'type': 'code', 'agent_name': 'x'}), _node('output', {})],
             'edges': [{'from_node_id': '1', 'to_node_id': '7'}]}
    assert GraphWorkflowRunner.configuredTemplatesAsAgents(graph) == graph
