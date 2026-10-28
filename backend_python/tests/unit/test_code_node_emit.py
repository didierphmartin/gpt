"""Port of backend/tests/Unit/CodeNodeEmitTest.php."""
from __future__ import annotations

import json

import pytest

from app.agent_team.services.code_node_emit import CodeNodeEmit


def _node(cfg: dict) -> dict:
    base = {'type': 'code', 'name': 'Poll', 'code': "def run(i, c):\n    return {'route': 'job', 'output': 1}",
            'exits': ['job', 'no_job', 'error'], 'mcp_servers': ['ServiceNow'], 'timeout_s': 20}
    return {'id': '5', 'node_type': 'code', 'config': {**base, **cfg}}


EDGES = [
    {'from': '5', 'to': '6', 'from_port': 'output_1'},
    {'from': '5', 'to': '7', 'from_port': 'output_2'},
    {'from': '5', 'to': '8', 'from_port': 'output_1'},
    {'from': '1', 'to': '5', 'from_port': 'output_1'},
]


def test_node_data_maps_ports_to_exits():
    d = CodeNodeEmit.nodeData(_node({}), EDGES, {'servicenow': 'http://localhost/servicenow/'})
    assert d['kind'] == 'code'
    assert d['exit_targets'] == {'job': ['6', '8'], 'no_job': ['7'], 'error': []}
    assert d['servers'] == ['http://localhost/servicenow/']
    assert d['mcp_servers'] == ['servicenow']
    assert d['timeout_s'] == 20
    assert d['display'] == 'Poll'


def test_node_data_carries_arg_decls():
    decls = [{'name': 'folder', 'required': True}]
    d = CodeNodeEmit.nodeData(_node({'arg_decls': decls}), [], {'servicenow': 'u'})
    assert d['arg_decls'] == decls
    assert CodeNodeEmit.nodeData(_node({}), [], {'servicenow': 'u'})['arg_decls'] == []
    for bad in ('x', {'a': {'name': 'folder'}}, None):
        assert CodeNodeEmit.nodeData(_node({'arg_decls': bad}), [], {'servicenow': 'u'})['arg_decls'] == []


@pytest.mark.parametrize('bad', [{'exits': ['Bad']}, {'exits': ['a', 'a']}, {'exits': []}, {'mcp_servers': ['Okta']},
                                 {'mcp_servers': [5]}, {'mcp_servers': 'ServiceNow'}, {'timeout_s': 0}])
def test_defaults_and_validation(bad):
    d = CodeNodeEmit.nodeData({'id': '5', 'node_type': 'code', 'config': {'type': 'code', 'code': "def run(i, c):\n    return i"}}, [], {})
    assert d['exits'] == ['next']
    assert d['timeout_s'] == 30
    with pytest.raises(RuntimeError) as e:
        CodeNodeEmit.nodeData(_node(bad), [], {'servicenow': 'u'})
    assert "'Poll'" in str(e.value), json.dumps(bad)


def test_slug_and_refusal():
    assert CodeNodeEmit.slug('Service Now (prod)') == 'service_now_prod_'
    graph = {'nodes': [_node({})], 'edges': []}
    assert CodeNodeEmit.hasCodeNodes(graph) is True
    with pytest.raises(RuntimeError, match='Code nodes are not supported by the ADK target yet'):
        CodeNodeEmit.refuseUnsupported(graph, 'ADK')


def test_empty_node_type_falls_through_to_config_type():
    graph = {'nodes': [{'id': '5', 'node_type': '', 'config': {'type': 'code'}}], 'edges': []}
    assert CodeNodeEmit.hasCodeNodes(graph) is True
    with pytest.raises(RuntimeError, match='Code nodes are not supported by the MAF target yet'):
        CodeNodeEmit.refuseUnsupported(graph, 'MAF')


def test_dangling_edges_are_ignored():
    # An edge to a node that is not in the graph must not put a missing id in exit_targets.
    edges = EDGES + [{'from': '5', 'to': '99', 'from_port': 'output_3'}]
    d = CodeNodeEmit.nodeData(_node({}), edges, {'servicenow': 'u'}, ['1', '5', '6', '7', '8'])
    assert d['exit_targets'] == {'job': ['6', '8'], 'no_job': ['7'], 'error': []}


def test_int_node_ids_and_db_edge_keys():
    """Python-only: the server runner hands int ids and from_node_id/to_node_id edges (PHP casts both)."""
    edges = [{'from_node_id': 5, 'to_node_id': 6, 'from_port': 'output_2'}]
    t = CodeNodeEmit.exitTargets('5', ['a', 'b'], edges, [5, 6])
    assert t == {'a': [], 'b': ['6']}
