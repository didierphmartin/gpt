"""Port of backend/tests/Unit/Controllers/RobotWorkflowSaveTest.php (dfa0070 final-review fixes): a robot workflow's
links resolve against the robot's rows, never the editor's; names are unique per owner."""
from __future__ import annotations

import json

import pytest

from app.agent_team.controllers.agent_controller import AgentController
from app.agent_team.controllers.workflow_controller import WorkflowController
from app.code_component.code_component_store import CodeComponentStore
from app.playbook.playbook_store import PlaybookStore
from app.services.robot_account import RobotAccount
from tests.unit import robot_schema
from tests.unit.playbook.conftest import OKTA
from tests.unit.test_workflow_lock import add_workflow_columns

CONFIG = {'edition': 'corporate'}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv('GPT_EDITION', 'corporate')
    db, ids = robot_schema.create()
    robot_schema.agents_and_playbooks(db)
    add_workflow_columns(db)
    for c in ('pos_x INTEGER', 'pos_y INTEGER', 'drawflow_node_id TEXT'):
        db.execute(f'ALTER TABLE workflow_nodes ADD COLUMN {c}')
    db.execute('ALTER TABLE workflow_edges ADD COLUMN condition_expr TEXT')
    db.execute('CREATE UNIQUE INDEX uq_workflows_user_name ON agent_workflows (user_id, name)')
    # user 3 may use the robot; user 1 may not
    db.execute("UPDATE users SET role = 'ops' WHERE id = 3")
    db.execute("INSERT INTO users (id, email, role) VALUES (119, 'filler@x.test', 'user')")
    robot = RobotAccount.ensure(db)
    db.execute(f'UPDATE agent_workflows SET user_id = {robot} WHERE id = 75')
    db.execute(f'UPDATE code_components SET user_id = {robot}')
    db.execute(f'UPDATE scheduled_workflows SET user_id = {robot}')
    return db, ids, robot


def update(db, user, wf, body):
    return WorkflowController(db, CONFIG).update({'user_id': user, 'params': {'id': wf}, 'body': body, 'query': {}}, wf)


def linked_component_ids(db, wf):
    return [json.loads(r['config']).get('code_component_id') for r in
            db.fetch_all("SELECT config FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'code' ORDER BY id", [wf])]


def test_dsl_save_of_a_robot_workflow_links_the_robots_component_not_the_editors(env):
    db, ids, _ = env
    mine = CodeComponentStore(db).save(3, None, dict(robot_schema.SP))['id']   # user 3's own "Store SharePoint"
    r = update(db, 3, 75, {'definition': {'nodes': [
        {'id': '1', 'node_type': 'code', 'config': {'type': 'code', 'name': 'SP', 'code_component_ref': 'Store SharePoint'}},
    ], 'edges': []}})
    assert r['success'] is True, r
    assert mine != ids['Store SharePoint']
    assert linked_component_ids(db, 75) == [ids['Store SharePoint']]


def test_editor_save_linking_a_personal_component_into_a_robot_workflow_is_refused(env):
    db, ids, _ = env
    mine = CodeComponentStore(db).save(3, None, {'name': 'Mine', 'code': '', 'exits': ['done'], 'mcp_servers': []})['id']
    before = linked_component_ids(db, 75)
    r = update(db, 3, 75, {'name': 'Renamed', 'definition': {'nodes': [
        {'id': '1', 'node_type': 'code', 'config': {'type': 'code', 'name': 'X', 'code_component_id': mine}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'PDF', 'code_component_id': ids['To PDF']}},
    ], 'edges': []}})
    assert [r['success'], r['status_code'], r.get('error_code')] == [False, 422, 'unknown_references'], r
    assert r['missing'] == [f'code component #{mine}']
    assert linked_component_ids(db, 75) == before
    assert db.fetch_one('SELECT name FROM agent_workflows WHERE id = 75')['name'] == 'Mail to PDF'


def test_robot_workflow_refuses_personal_playbooks_agents_and_start_options(env):
    db, _, robot = env
    pb = PlaybookStore(db).save(3, None, OKTA, 'okta-reset')['id']
    db.execute(f"INSERT INTO agents (id, user_id, name) VALUES (40, 3, 'Mine'), (41, 1, 'Shared'), (42, {robot}, 'Robots')")
    db.execute("UPDATE agents SET visibility = 'public' WHERE id = 41")
    opt = CodeComponentStore(db).save(3, None, {**robot_schema.POLL, 'name': 'My poll'})['id']
    r = update(db, 3, 75, {'definition': {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'start_option': opt}},
        {'id': '2', 'node_type': 'playbook', 'config': {'type': 'playbook', 'playbook_id': pb}},
        {'id': '3', 'node_type': 'agent', 'agent_id': 40, 'config': {'type': 'agent'}},
        {'id': '4', 'node_type': 'agent', 'agent_id': 41, 'config': {'type': 'agent'}},
        {'id': '5', 'node_type': 'agent', 'agent_id': 42, 'config': {'type': 'agent'}},
    ], 'edges': []}})
    assert r['status_code'] == 422, r
    assert r['missing'] == [f'start option component #{opt}', f'playbook #{pb}', 'agent #40']


def test_a_personal_workflow_still_links_its_owners_rows(env):
    db, ids, _ = env
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')")
    mine = CodeComponentStore(db).save(3, None, dict(robot_schema.SP))['id']
    r = update(db, 3, 9, {'definition': {'nodes': [
        {'id': '1', 'node_type': 'code', 'config': {'type': 'code', 'name': 'SP', 'code_component_ref': 'Store SharePoint'}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'PDF', 'code_component_id': ids['To PDF']}},
    ], 'edges': []}})
    assert r['success'] is True, r
    assert linked_component_ids(db, 9) == [mine, ids['To PDF']]


def test_renaming_a_robot_workflow_to_a_name_the_robot_has_is_409(env):
    db, _, robot = env
    db.execute(f"INSERT INTO agent_workflows (id, user_id, name) VALUES (80, {robot}, 'Other')")
    r = update(db, 3, 75, {'name': 'Other'})
    assert [r['success'], r['status_code'], r.get('error_code')] == [False, 409, 'name_taken'], r
    assert db.fetch_one('SELECT name FROM agent_workflows WHERE id = 75')['name'] == 'Mail to PDF'


def agents(db, user, method, id, body=None):
    return getattr(AgentController(db, CONFIG), method)({'user_id': user, 'params': {'id': id}, 'body': body or {}}, id)


def test_robot_agent_takes_only_a_robot_playbook(env):
    db, _, robot = env
    s = PlaybookStore(db)
    mine = s.save(3, None, OKTA, 'mine')['id']
    robots = s.save(robot, None, OKTA, 'robots')['id']
    db.execute(f"INSERT INTO agents (id, user_id, name, agent_type) VALUES (50, {robot}, 'Robot agent', 'playbook')")
    assert agents(db, 3, 'update', 50, {'playbook_id': mine})['status_code'] == 404
    assert db.fetch_one('SELECT playbook_id FROM agents WHERE id = 50')['playbook_id'] is None
    r = agents(db, 3, 'update', 50, {'playbook_id': robots})
    assert r['success'] is True, r
    assert int(db.fetch_one('SELECT playbook_id FROM agents WHERE id = 50')['playbook_id']) == robots


def test_renaming_a_robot_agent_to_a_name_the_robot_has_is_409(env):
    db, _, robot = env
    db.execute(f"INSERT INTO agents (id, user_id, name) VALUES (50, {robot}, 'A'), (51, {robot}, 'B')")
    r = agents(db, 3, 'update', 50, {'name': 'B'})
    assert [r['success'], r['status_code'], r.get('error_code')] == [False, 409, 'name_taken'], r
    assert db.fetch_one('SELECT name FROM agents WHERE id = 50')['name'] == 'A'
