"""Ports of backend/tests/Unit/WorkflowRefResolverTest.php and Controllers/WorkflowControllerRefsTest.php."""
from __future__ import annotations

import json

import pytest

from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.services.workflow_ref_resolver import UnresolvedRefsException, WorkflowRefResolver
from app.agent_team.services.workflow_repository import WorkflowRepository
from tests.unit.code_component_schema import schema_db


def comp(db, user, name, exits):
    db.execute("INSERT INTO code_components (user_id, name, code, exits, mcp_servers) VALUES (?, ?, 'c', ?, '[]')",
               [user, name, json.dumps(exits)])


@pytest.fixture
def r():
    db = schema_db()
    db.execute('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT)')
    # id 1 is another user's copy of the same pkey, id 2 the owner's.
    db.execute("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (4, 'reset-pw', 'x', 'x'), (3, 'reset-pw', 'y', 'y')")
    comp(db, 4, 'Poll', ['x'])
    comp(db, 3, 'Poll', ['new_mail', 'no_mail', 'error'])
    resolver = WorkflowRefResolver(db)
    resolver.test_db = db
    return resolver


def missing(r, nodes, edges=None) -> list:
    with pytest.raises(UnresolvedRefsException) as e:
        r.resolve(3, nodes, edges or [])
    return e.value.missing


def test_playbook_ref_becomes_the_owners_id(r):
    out = r.resolve(3, [{'id': '1', 'node_type': 'playbook',
                         'config': {'type': 'playbook', 'playbook_ref': 'reset-pw', 'exits': ['done', 'failed']}}], [])
    cfg = out['nodes'][0]['config']
    assert cfg['playbook_id'] == 2
    assert 'playbook_ref' not in cfg
    assert cfg['exits'] == ['done', 'failed']


def test_component_ref_and_args_and_edge_ports(r):
    nodes = [
        {'id': '1', 'node_type': 'playbook', 'config': {'playbook_ref': 'reset-pw'}},
        {'id': '2', 'node_type': 'code', 'config': {'code_component_ref': 'Poll', 'args': {'a': 1}}},
        {'id': '3', 'node_type': 'agent', 'config': {}},
    ]
    edges = [
        {'from': '1', 'to': '3', 'from_port_name': 'failed'},
        {'from': '1', 'to': '3', 'from_port_name': 'done'},
        {'from': '2', 'to': '3', 'from_port_name': 'no_mail'},
        {'from': '2', 'to': '3', 'from_port_name': 'error', 'to_port': 'input_1'},
        {'from': '3', 'to': '1', 'from_port': 'output_1'},
    ]
    out = r.resolve(3, nodes, edges)
    cfg = out['nodes'][1]['config']
    assert cfg['code_component_id'] == 2
    assert 'code_component_ref' not in cfg
    assert cfg['args'] == {'a': 1}
    assert [e['from_port'] for e in out['edges']] == ['output_2', 'output_1', 'output_2', 'output_3', 'output_1']
    assert 'from_port_name' not in out['edges'][0]
    assert out['edges'][3]['to_port'] == 'input_1'


def test_start_option_ref_and_its_edges(r):
    nodes = [{'id': 's', 'node_type': 'start', 'config': {'start_option_ref': 'Poll', 'start_args': {'q': 'x'}}},
             {'id': 'a', 'node_type': 'agent', 'config': {}}]
    out = r.resolve(3, nodes, [{'from': 's', 'to': 'a', 'from_port_name': 'no_mail'}])
    assert out['nodes'][0]['config']['start_option'] == 2
    assert out['nodes'][0]['config']['start_args'] == {'q': 'x'}
    assert 'start_option_ref' not in out['nodes'][0]['config']
    assert out['edges'][0]['from_port'] == 'output_2'


def test_unknown_playbook_and_component_are_listed_together(r):
    m = missing(r, [{'id': '1', 'node_type': 'playbook', 'config': {'playbook_ref': 'nope'}},
                    {'id': '2', 'node_type': 'code', 'config': {'code_component_ref': 'Ghost'}}])
    assert len(m) == 2
    assert 'nope' in m[0]
    assert 'Ghost' in m[1]


def test_unknown_exit_name_is_missing(r):
    m = missing(r, [{'id': '1', 'node_type': 'code', 'config': {'code_component_ref': 'Poll'}},
                    {'id': '2', 'node_type': 'agent', 'config': {}}],
                [{'from': '1', 'to': '2', 'from_port_name': 'bogus'}])
    assert len(m) == 1
    assert 'bogus' in m[0]


def test_another_users_playbook_is_not_used(r):
    r.test_db.execute("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (4, 'only-theirs', 'x', 'x')")
    assert len(missing(r, [{'id': '1', 'node_type': 'playbook', 'config': {'playbook_ref': 'only-theirs'}}])) == 1


def test_a_graph_without_refs_is_unchanged(r):
    nodes = [{'id': '1', 'node_type': 'agent', 'config': {'x': 1}},
             {'id': '2', 'node_type': 'code', 'config': {'code': 'y', 'exits': ['next']}}]
    edges = [{'from': '1', 'to': '2', 'from_port': 'output_2'}]
    assert r.resolve(3, nodes, edges) == {'nodes': nodes, 'edges': edges}


# ---------------------------------------------------------------- WorkflowController

@pytest.fixture
def ctl():
    db = schema_db()
    db.execute('DROP TABLE agent_workflows')
    db.execute("CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER, name TEXT,"
               " description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, output_storage_enabled INTEGER DEFAULT 0,"
               " output_folder TEXT, orchestration TEXT DEFAULT 'workflow', created_at TEXT, updated_at TEXT)")
    db.execute('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT)')
    db.execute("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'reset-pw', 'x', 'x')")
    c = WorkflowController.__new__(WorkflowController)   # PHP: newInstanceWithoutConstructor
    repo = WorkflowRepository(db)
    c.db = db
    c.workflowRepository = repo
    c.graphRepository = repo.getGraphRepository()
    return c


def create(c, nodes, edges=None):
    return c.create({'user_id': 3, 'body': {'name': 'Reset', 'definition': {'nodes': nodes, 'edges': edges or []}}})


def test_unknown_names_give_422_and_insert_no_workflow(ctl):
    r = create(ctl, [{'id': '1', 'node_type': 'playbook', 'config': {'playbook_ref': 'nope'}}])
    assert r['status_code'] == 422
    assert r['error'] == 'unknown references'
    assert len(r['missing']) == 1
    assert ctl.db.fetch_column('SELECT COUNT(*) FROM agent_workflows')[0] == 0


def test_valid_named_graph_creates_the_workflow_with_resolved_ids(ctl):
    r = create(ctl, [{'id': '1', 'node_type': 'playbook', 'config': {'playbook_ref': 'reset-pw'}},
                     {'id': '2', 'node_type': 'agent', 'config': {}}],
               [{'from': '1', 'to': '2', 'from_port_name': 'failed'}])
    assert r['status_code'] == 201, r
    cfg = json.loads(ctl.db.fetch_column("SELECT config FROM workflow_nodes WHERE node_type = 'playbook'")[0])
    assert cfg['playbook_id'] == 1
    assert 'playbook_ref' not in cfg
    assert ctl.db.fetch_column('SELECT from_port FROM workflow_edges')[0] == 'output_2'
    assert ctl.db.fetch_column('SELECT COUNT(*) FROM agent_workflows')[0] == 1
