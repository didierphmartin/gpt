"""Port of backend/tests/Unit/RobotSkillPolicyTest.php and the guard tests of GraphWorkflowRunnerSkillTest.php: the
corporate robot uses public skills only; private bindings are refused, bound public skills are pinned."""
from __future__ import annotations

import json
import os

import pytest

from app.agent_team.controllers.active_workflow_controller import ActiveWorkflowController
from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.schedule_tick import ScheduleTick
from app.agent_team.services.workflow_owner_transfer import WorkflowOwnerTransfer
from app.controllers.skill_store_controller import SkillStoreController
from app.services.private_skills_refused import PrivateSkillsRefused
from app.services.robot_account import RobotAccount
from app.services.robot_ownership import RobotOwnership
from app.services.robot_skill_policy import RobotSkillPolicy
from app.services.skill_errors import SkillInUse
from app.services.skill_store import SkillStore
from tests.unit import robot_schema
from tests.unit.test_workflow_lock import add_workflow_columns

WF = robot_schema.WF
OWNER = robot_schema.OWNER
SECRET = [{'path': 'tools/secret', 'owner_id': OWNER, 'owner_name': 'Olga Ops'}]
MESSAGE = 'This workflow uses private skills. The robot can only use public skills.'


def files(name):
    return {'SKILL.md': f'---\nname: {name}\ndescription: d\n---\nbody\n'.encode()}


class Env:
    def __init__(self, root):
        self.root = root
        os.makedirs(root)
        self.db, _ = robot_schema.create()
        robot_schema.agents_and_playbooks(self.db)
        add_workflow_columns(self.db)
        self.robot = RobotAccount.ensure(self.db)
        self.db.execute("UPDATE users SET first_name = 'Olga', last_name = 'Ops' WHERE id = 2")
        # wf 75 binds the private skill "secret" (user 2's) and the public skill "shared"
        for d in ('tools/secret', 'shared'):
            self.db.execute('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)',
                            [WF, 'agent', json.dumps({'type': 'agent', 'bound_skill': {'dir_name': d}})])
        s = self.store()
        s.import_(OWNER, 'tools/secret', files('secret'), 'private')
        s.import_(OWNER, 'shared', files('shared'), 'public')

    def store(self, edition='corporate'):
        return SkillStore(self.root, edition, lambda leaf: self.policy().robotWorkflowsUsing(leaf))

    def policy(self, edition='corporate', store=None):
        return RobotSkillPolicy(self.db, {'edition': edition}, store or SkillStore(self.root, edition))

    def toRobot(self):
        WorkflowOwnerTransfer(self.db, RobotOwnership(self.db, {'edition': 'corporate'})).toRobot(OWNER, WF)

    def owner(self):
        return int(self.db.fetch_one(f'SELECT user_id FROM agent_workflows WHERE id = {WF}')['user_id'])


@pytest.fixture
def e(tmp_path):
    return Env(str(tmp_path / 'skills'))


def test_private_skills_listed_in_corporate(e):
    assert e.policy().privateSkills(WF) == SECRET


def test_unknown_skill_is_listed_without_owner(e):
    e.db.execute('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)',
                 [WF, 'agent', json.dumps({'bound_skill': {'dir_name': 'ghost'}})])
    assert {'path': 'ghost', 'owner_id': 0, 'owner_name': '', 'missing': True} in e.policy().privateSkills(WF)


def test_none_in_individual_or_folder_mode(e):
    assert e.policy('individual').privateSkills(WF) == []
    assert RobotSkillPolicy(e.db, {'edition': 'corporate'}, None).privateSkills(WF) == []


def test_transfer_refused_with_private_skills(e):
    t = WorkflowOwnerTransfer(e.db, RobotOwnership(e.db, {'edition': 'corporate'}), e.policy())
    for method in ('preview', 'toRobot'):
        with pytest.raises(PrivateSkillsRefused) as ex:
            getattr(t, method)(OWNER, WF)
        assert ex.value.skills == SECRET
    assert e.owner() == OWNER


def test_refusal_shape():
    assert RobotSkillPolicy.refusal(SECRET) == {'success': False, 'code': 'private_skills', 'message': MESSAGE,
                                                 'error': MESSAGE, 'data': {'skills': SECRET}, 'status_code': 409}


def test_transfer_route_answers_409(e, monkeypatch):
    monkeypatch.setenv('SKILLS_DIR', e.root)
    r = WorkflowController(e.db, {'edition': 'corporate'}).owner(
        {'user_id': OWNER, 'body': {'owner': 'robot', 'confirm': True}, 'params': {'id': WF}}, WF)
    assert r == RobotSkillPolicy.refusal(SECRET)


def test_activate_refused_with_private_skills(e):
    e.toRobot()
    with pytest.raises(PrivateSkillsRefused):
        ActiveWorkflowService(e.db, e.policy()).activate(e.robot, WF)


def test_activate_route_answers_409_and_passes_once_public(e, monkeypatch):
    e.toRobot()
    monkeypatch.setenv('SKILLS_DIR', e.root)
    c = ActiveWorkflowController(e.db, {'edition': 'corporate'})
    req = {'user_id': OWNER, 'params': {'id': WF}}
    assert c.activate(req) == RobotSkillPolicy.refusal(SECRET)
    e.store().setVisibility(OWNER, 'tools/secret', 'public')
    assert c.activate(req)['status_code'] != 409


def test_robot_run_refused_and_a_persons_own_is_not_checked(e, monkeypatch):
    monkeypatch.setenv('SKILLS_DIR', e.root)
    r = WorkflowController(e.db, {'edition': 'corporate'}).run({'user_id': OWNER, 'params': {'id': WF}, 'body': {}}, WF)
    assert r.get('code') != 'private_skills'
    e.toRobot()
    r = WorkflowController(e.db, {'edition': 'corporate'}).run({'user_id': OWNER, 'params': {'id': WF}, 'body': {}}, WF)
    assert r == RobotSkillPolicy.refusal(SECRET)


def test_robot_compile_refused_with_private_skills(e, monkeypatch):
    e.toRobot()
    monkeypatch.setenv('SKILLS_DIR', e.root)
    c = WorkflowController(e.db, {'edition': 'corporate'})
    req = {'user_id': OWNER, 'params': {'id': WF}, 'query': {'modular': '1'}}
    for route in ('generatePython', 'generateAdk', 'generateMaf', 'generateNooa'):
        assert getattr(c, route)(req, WF) == RobotSkillPolicy.refusal(SECRET), route


def test_robot_workflows_using_matches_the_leaf(e):
    assert e.policy().robotWorkflowsUsing('shared') == []   # wf 75 is still the owner's
    e.toRobot()
    assert e.policy().robotWorkflowsUsing('shared') == [{'id': WF, 'name': 'Mail to PDF'}]
    assert e.policy().robotWorkflowsUsing('other') == []


def test_make_private_refused_when_robot_workflow_binds_it(e):
    e.toRobot()
    with pytest.raises(SkillInUse) as ex:
        e.store().setVisibility(OWNER, 'shared', 'private')
    assert ex.value.workflows() == [{'id': WF, 'name': 'Mail to PDF'}]
    assert ex.value.statusCode() == 409
    assert os.path.isdir(f'{e.root}/public/shared')
    assert not os.path.isdir(f'{e.root}/users/{OWNER}/shared')


def test_delete_refused_when_robot_workflow_binds_it(e, monkeypatch):
    e.toRobot()
    monkeypatch.setenv('SKILLS_DIR', e.root)
    c = SkillStoreController(e.db, {'edition': 'corporate'})
    r = c.delete({'user_id': OWNER, 'query': {'path': 'shared'}})
    assert [r['status_code'], r['data']['robot_workflows']] == [409, [{'id': WF, 'name': 'Mail to PDF'}]]
    assert os.path.isdir(f'{e.root}/public/shared')
    r = c.visibility({'user_id': OWNER, 'body': {'path': 'shared', 'visibility': 'private'}})
    assert [r['status_code'], r['data']['robot_workflows'][0]['name']] == [409, 'Mail to PDF']


def test_rename_refused_but_regroup_allowed(e):
    e.toRobot()
    s = e.store()
    s.move(OWNER, 'shared', 'grp/shared')   # same leaf: still found by the robot
    with pytest.raises(SkillInUse):
        s.move(OWNER, 'grp/shared', 'grp/renamed')


def test_unbound_skills_are_free(e):
    e.toRobot()
    s = e.store()
    s.import_(OWNER, 'free', files('free'), 'public')
    s.setVisibility(OWNER, 'free', 'private')
    assert os.path.isdir(f'{e.root}/users/{OWNER}/free')
    s.delete(OWNER, 'free')
    assert not os.path.isdir(f'{e.root}/users/{OWNER}/free')


def test_scheduled_robot_run_refused_and_runner_not_invoked(e):
    e.toRobot()

    class Wf:
        def isEnabled(self):
            return True

    class Repo:
        def findById(self, id):
            return Wf()

    class Never:
        def run(self, *a):
            raise AssertionError('runner must not run')
    run = ScheduleTick.workflowRunner(Repo(), None, Never(), Never(), e.policy())
    r = run({'workflow_id': WF, 'user_id': e.robot})
    assert [r['success'], r['code'], r['skills']] == [False, 'private_skills', SECRET]


# ---------------------------------------------------------------- GraphWorkflowRunnerSkillTest (the guard)

def test_a_bound_skill_without_a_browser_is_refused():
    with pytest.raises(RuntimeError) as ex:
        GraphWorkflowRunner.assertBoundSkillRunnable({'bound_skill': {'dir_name': 'pdf-tools', 'source': 'local'}}, {})
    assert str(ex.value) == 'Skill "pdf-tools" can only run from the editor or in a compiled program: this run has no browser to run it.'
    with pytest.raises(RuntimeError):   # a legacy inline skill_content does not rescue it
        GraphWorkflowRunner.assertBoundSkillRunnable({'bound_skill': {'dir_name': 'pdf-tools'}, 'skill_content': 'old'}, {})


def test_the_guard_passes_when_the_browser_sent_the_skill_or_nothing_is_bound():
    GraphWorkflowRunner.assertBoundSkillRunnable({'bound_skill': {'dir_name': 'pdf-tools'}}, {'pdf-tools': {'skill_content': 'x'}})
    for cfg in ({}, {'skill_content': 'inline only'}, {'bound_skill': {'dir_name': ''}}, {'bound_skill': None}):
        GraphWorkflowRunner.assertBoundSkillRunnable(cfg, {})
