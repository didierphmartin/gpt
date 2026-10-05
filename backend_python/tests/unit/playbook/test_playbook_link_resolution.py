"""Port of backend/tests/Unit/Playbook/PlaybookLinkResolutionTest.php."""
from __future__ import annotations

import json

import pytest

from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.playbook.playbook_store import PlaybookStore
from tests.unit.playbook.conftest import OKTA


def test_get_nodes_fills_the_linked_text_for_the_workflow_owner(pbc_db):
    id_ = PlaybookStore(pbc_db).save(3, None, OKTA, 'okta-reset')['id']
    pbc_db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')")
    pbc_db.execute(f"INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{{\"name\":\"Reset\",\"playbook_id\":{id_}}}')")
    pbc_db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"name\":\"Gone\",\"playbook_id\":99}')")
    nodes = WorkflowGraphRepository(pbc_db).getNodes(1)
    assert nodes[0]['config']['playbook'] == OKTA
    assert 'playbook' not in nodes[1]['config']
    assert nodes[1]['config']['playbook_missing'] is True


def test_another_users_playbook_is_not_resolved(pbc_db):
    id_ = PlaybookStore(pbc_db).save(4, None, OKTA, 'okta-reset')['id']
    pbc_db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')")
    pbc_db.execute(f"INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{{\"playbook_id\":{id_}}}')")
    assert WorkflowGraphRepository(pbc_db).getNodes(1)[0]['config']['playbook_missing'] is True


def test_compile_refuses_a_missing_playbook_naming_the_node():
    node = {'id': '5', 'config': {'name': 'Gone', 'playbook_id': 99, 'playbook_missing': True}}
    with pytest.raises(RuntimeError, match=r'Playbook #99 not found \(node Gone\)\.'):
        LangGraphGenerator(None, None, None, None)._playbookData(node, {}, {}, '3')


def test_get_nodes_clears_a_stored_missing_flag_when_the_playbook_exists(pbc_db):
    id_ = PlaybookStore(pbc_db).save(3, None, OKTA, 'okta-reset')['id']
    pbc_db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')")
    pbc_db.execute(f"INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{{\"playbook_id\":{id_},\"playbook_missing\":true}}')")
    cfg = WorkflowGraphRepository(pbc_db).getNodes(1)[0]['config']
    assert 'playbook_missing' not in cfg
    assert cfg['playbook'] == OKTA


def test_create_node_never_stores_the_derived_keys(pbc_db):
    pbc_db.execute('DROP TABLE workflow_nodes')
    pbc_db.execute('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, '
                   'agent_id INTEGER, config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)')
    repo = WorkflowGraphRepository(pbc_db)
    node_id = repo.createNode(1, {'node_type': 'playbook', 'config': {'playbook_id': 7, 'playbook': 'stale', 'playbook_missing': True}})
    stored = json.loads(pbc_db.fetch_one(f'SELECT config FROM workflow_nodes WHERE id = {node_id}')['config'])
    assert stored['playbook_id'] == 7
    assert 'playbook' not in stored
    assert 'playbook_missing' not in stored

    repo.updateNode(node_id, {'node_type': 'playbook', 'config': {'playbook_id': 7, 'playbook': 'stale2', 'playbook_missing': True}})
    stored = json.loads(pbc_db.fetch_one(f'SELECT config FROM workflow_nodes WHERE id = {node_id}')['config'])
    assert 'playbook' not in stored
    assert 'playbook_missing' not in stored


def test_non_playbook_node_with_a_playbook_id_is_untouched(pbc_db):
    pbc_db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')")
    pbc_db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'agent', '{\"playbook_id\":99}')")
    assert WorkflowGraphRepository(pbc_db).getNodes(1)[0]['config'] == {'playbook_id': 99}
