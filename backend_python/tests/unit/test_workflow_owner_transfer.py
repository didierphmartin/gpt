"""Port of backend/tests/Unit/AgentTeam/WorkflowOwnerTransferTest.php: Owner -> Robot. wf 75 keeps its id and graph;
what it uses and its schedule move to the robot, nothing is copied."""
from __future__ import annotations

import json

import pytest

from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.agent_team.services.workflow_owner_transfer import WorkflowOwnerTransfer, WorkflowTransferError
from app.code_component.code_component_store import CodeComponentStore
from app.services.robot_account import RobotAccount
from app.services.robot_ownership import RobotOwnership
from tests.unit import robot_schema
from tests.unit.test_workflow_lock import add_workflow_columns

CONFIG = {'edition': 'corporate'}
WF = robot_schema.WF
OWNER = robot_schema.OWNER
TABLES = ['agent_workflows', 'workflow_nodes', 'workflow_edges', 'code_components', 'playbooks', 'agents',
          'scheduled_workflows', 'active_workflows']


class Env:
    """RobotSchema's wf 75 plus a playbook node on playbook 5, an agent node on the owner's agent 31 (whose own playbook
    is 6), an agent node on user 1's public agent 32, the schedule row as id 40, and the owner's wf 64 linking To PDF."""

    def __init__(self):
        self.db, self.ids = robot_schema.create()
        robot_schema.agents_and_playbooks(self.db)
        self.robot = RobotAccount.ensure(self.db)
        db = self.db
        db.execute("INSERT INTO playbooks (id, user_id, pkey, title, text) VALUES (5, 2, 'mail-pdf', 'Mail', 't'), (6, 2, 'filing', 'Filing', 't')")
        db.execute("INSERT INTO agents (id, user_id, name, playbook_id) VALUES (31, 2, 'Filer', 6)")
        db.execute("INSERT INTO agents (id, user_id, name, visibility) VALUES (32, 1, 'Public helper', 'public')")

        def node(wf, type_, agent, cfg):
            db.insert('INSERT INTO workflow_nodes (workflow_id, node_type, agent_id, config) VALUES (?, ?, ?, ?)', [wf, type_, agent, json.dumps(cfg)])
        node(WF, 'playbook', None, {'type': 'playbook', 'playbook_id': 5})
        node(WF, 'agent', 31, {'type': 'agent', 'name': 'Filer'})
        node(WF, 'agent', 32, {'type': 'agent', 'name': 'Helper'})
        db.execute('UPDATE scheduled_workflows SET id = 40 WHERE workflow_id = 75')
        db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (64, 2, 'Other'), (66, 2, 'Unrelated')")
        node(64, 'code', None, {'type': 'code', 'code_component_id': self.ids['To PDF']})

    def transfer(self) -> WorkflowOwnerTransfer:
        return WorkflowOwnerTransfer(self.db, RobotOwnership(self.db, CONFIG))

    def snapshot(self) -> dict:
        return {t: [dict(r) for r in self.db.fetch_all(f'SELECT * FROM {t} ORDER BY 1')] for t in TABLES}

    def owner(self, table, id) -> int:
        return int(self.db.fetch_one(f'SELECT user_id FROM {table} WHERE id = {id}')['user_id'])

    def route(self, user, body):
        add_workflow_columns(self.db)
        return WorkflowController(self.db, CONFIG).owner({'user_id': user, 'body': body, 'params': {'id': WF}}, WF)


@pytest.fixture
def e():
    return Env()


def error(fn) -> WorkflowTransferError:
    with pytest.raises(WorkflowTransferError) as ex:
        fn()
    return ex.value


def test_transfer_moves_the_workflow_and_everything_it_uses(e):
    before = e.snapshot()
    r = e.transfer().toRobot(OWNER, WF)
    components = sorted(e.ids.values())
    assert r == {'workflow_id': WF, 'moved': {'components': components, 'playbooks': [5, 6], 'agents': [31], 'schedules': [40]}}
    after = e.snapshot()
    for t in TABLES:
        assert len(after[t]) == len(before[t]), f'no new or deleted {t} rows'
    assert after['workflow_nodes'] == before['workflow_nodes']
    assert after['workflow_edges'] == before['workflow_edges']
    assert e.owner('agent_workflows', WF) == e.robot
    for id in components:
        assert e.owner('code_components', id) == e.robot
    assert [e.owner('playbooks', 5), e.owner('playbooks', 6)] == [e.robot, e.robot]
    assert [e.owner('agents', 31), e.owner('agents', 32)] == [e.robot, 1]   # another user's agent stays
    assert e.owner('scheduled_workflows', 40) == e.robot
    assert [e.owner('agent_workflows', 64), e.owner('agent_workflows', 66)] == [OWNER, OWNER]


def test_clash_refuses_and_changes_nothing(e):
    CodeComponentStore(e.db).save(e.robot, None, {'name': 'Store SharePoint', 'code': 'x', 'exits': ['done']})
    e.db.execute(f"INSERT INTO agents (user_id, name) VALUES ({e.robot}, 'Filer')")
    e.db.execute(f"INSERT INTO agent_workflows (id, user_id, name) VALUES (90, {e.robot}, 'Mail to PDF')")
    before = e.snapshot()
    err = error(lambda: e.transfer().toRobot(OWNER, WF))
    clashes = [{'kind': 'workflow', 'name': 'Mail to PDF'}, {'kind': 'component', 'name': 'Store SharePoint'},
               {'kind': 'agent', 'name': 'Filer'}]
    assert [err.kind, err.status, err.clashes] == ['clash', 409, clashes]
    assert e.snapshot() == before
    assert e.transfer().preview(OWNER, WF)['clashes'] == clashes


def test_playbook_clash_is_by_key(e):
    e.db.execute(f"INSERT INTO playbooks (user_id, pkey, title, text) VALUES ({e.robot}, 'filing', 'Other title', 't')")
    assert error(lambda: e.transfer().toRobot(OWNER, WF)).clashes == [{'kind': 'playbook', 'name': 'filing'}]


def test_a_clash_with_a_published_robot_copy_says_unpublish_first(e):
    e.db.execute(f"INSERT INTO playbooks (user_id, pkey, title, text, source_id) VALUES ({e.robot}, 'filing', 'Filing', 't', 6)")
    err = error(lambda: e.transfer().toRobot(OWNER, WF))
    assert err.clashes == [{'kind': 'playbook', 'name': 'filing', 'published': True}]
    assert 'playbook "filing" is published to the robot: unpublish it first' in str(err)
    assert e.transfer().preview(OWNER, WF)['clashes'] == err.clashes


def test_preview_lists_shared_workflows_and_missing_servers(e):
    e.db.execute('INSERT INTO mcp_servers (user_id, name, url, enabled) VALUES (?, ?, ?, ?)', [str(e.robot), 'outlook', 'http://o', 1])   # matches "Outlook" by slug
    e.db.execute('INSERT INTO mcp_servers (user_id, name, url, enabled) VALUES (?, ?, ?, ?)', [str(OWNER), 'Converter', 'http://c', 1])  # the owner's, not the robot's
    before = e.snapshot()
    assert e.transfer().preview(OWNER, WF) == {'needs_servers': ['Converter', 'SharePoint'], 'shared_with': [{'id': 64, 'name': 'Other'}],
                                               'clashes': []}
    assert e.snapshot() == before


def test_the_owners_active_workflow_is_deactivated(e):
    ActiveWorkflowService(e.db).activate(OWNER, WF)
    e.transfer().toRobot(OWNER, WF)
    assert e.db.fetch_one('SELECT COUNT(*) AS n FROM active_workflows')['n'] == 0


def test_transfer_is_idempotent_and_repairs_schedules(e):
    e.transfer().toRobot(OWNER, WF)
    e.db.execute('UPDATE scheduled_workflows SET user_id = 2 WHERE id = 40')
    r = e.transfer().toRobot(OWNER, WF)
    assert r == {'workflow_id': WF, 'moved': {'components': [], 'playbooks': [], 'agents': [], 'schedules': [40]}}
    assert e.owner('scheduled_workflows', 40) == e.robot
    assert e.transfer().preview(OWNER, WF) == {'needs_servers': ['Converter', 'Outlook', 'SharePoint'], 'shared_with': [], 'clashes': []}


def test_access(e):
    err = error(lambda: e.transfer().toRobot(1, WF))   # role without use_robot
    assert [err.kind, err.status] == ['forbidden', 403]
    e.db.execute("UPDATE users SET role = 'ops' WHERE id = 3")   # may use the robot, not the owner
    err = error(lambda: e.transfer().preview(3, WF))
    assert [err.kind, err.status] == ['not_found', 404]
    assert e.owner('agent_workflows', WF) == OWNER


def test_owner_route(e):
    assert e.route(2, {'owner': 'me', 'confirm': True})['status_code'] == 422
    assert e.route(1, {'owner': 'robot'})['status_code'] == 403
    assert e.route(0, {'owner': 'robot'})['status_code'] == 401
    r = e.route(2, {'owner': 'robot', 'confirm': False})
    assert [r['success'], r['status_code'], r['data']['shared_with']] == [True, 200, [{'id': 64, 'name': 'Other'}]]
    assert e.owner('agent_workflows', WF) == OWNER

    e.db.execute(f"INSERT INTO agents (user_id, name) VALUES ({e.robot}, 'Filer')")
    r = e.route(2, {'owner': 'robot', 'confirm': True})
    assert [r['success'], r['status_code'], r['error_code'], r['clashes']] == [False, 409, 'clash', [{'kind': 'agent', 'name': 'Filer'}]]
    assert 'Filer' in r['error']

    e.db.execute(f'DELETE FROM agents WHERE user_id = {e.robot}')
    r = e.route(2, {'owner': 'robot', 'confirm': True})
    assert [r['success'], r['status_code'], r['data']['workflow_id']] == [True, 200, WF]
    assert e.owner('agent_workflows', WF) == e.robot

    e.db.execute(f"INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({e.robot}, 75, 'event', '2026-10-29 09:00:00')")
    r = e.route(2, {'owner': 'robot', 'confirm': True})
    assert [r['status_code'], r['error_code']] == [423, 'locked']


def test_duplicate_copies_graph_and_paused_schedules(e):
    add_workflow_columns(e.db)
    for c in ('pos_x INTEGER', 'pos_y INTEGER', 'drawflow_node_id TEXT'):
        e.db.execute(f'ALTER TABLE workflow_nodes ADD COLUMN {c}')
    e.db.execute('ALTER TABLE workflow_edges ADD COLUMN condition_expr TEXT')
    e.transfer().toRobot(OWNER, WF)
    r = WorkflowController(e.db, CONFIG).duplicate({'user_id': 2, 'body': {}, 'params': {'id': WF}}, WF)
    assert [r['success'], r['status_code'], r['data']['name']] == [True, 201, 'Mail to PDF (Copy)']
    new = r['data']['id']
    assert e.owner('agent_workflows', new) == 2
    assert (e.db.fetch_one(f'SELECT COUNT(*) AS n FROM workflow_nodes WHERE workflow_id = {new}')['n']
            == e.db.fetch_one(f'SELECT COUNT(*) AS n FROM workflow_nodes WHERE workflow_id = {WF}')['n'])
    assert e.db.fetch_one(f'SELECT COUNT(*) AS n FROM workflow_edges WHERE workflow_id = {new}')['n'] == 3
    s = e.db.fetch_one(f'SELECT user_id, status FROM scheduled_workflows WHERE workflow_id = {new}')
    assert (int(s['user_id']), s['status']) == (2, 'paused')
    r = WorkflowController(e.db, CONFIG).duplicate({'user_id': 2, 'body': {}, 'params': {'id': WF}}, WF)
    assert r['data']['name'] == 'Mail to PDF (Copy 2)'
