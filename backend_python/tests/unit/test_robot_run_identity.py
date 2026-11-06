"""Port of backend/tests/Unit/Controllers/RobotRunIdentityTest.php (the parts that need no live chat provider):
every run of a robot workflow runs as the robot; a locked one refuses its browser run doors after access."""
from __future__ import annotations

import pytest

from app.agent_team.controllers.code_node_controller import CodeNodeController
from app.agent_team.controllers.scheduled_workflow_controller import ScheduledWorkflowController
from app.agent_team.controllers.workflow_controller import WorkflowController
from app.controllers.chat_controller import ChatController
from app.services.robot_account import RobotAccount
from tests.unit import robot_schema
from tests.unit.test_workflow_lock import add_workflow_columns

CONFIG = {'edition': 'corporate'}


@pytest.fixture
def env():
    db, ids = robot_schema.create()
    add_workflow_columns(db)
    # user 3 may use the robot; user 1 may not
    db.execute("UPDATE users SET role = 'ops' WHERE id = 3")
    db.execute("INSERT INTO users (id, email, role) VALUES (119, 'filler@x.test', 'user')")
    robot = RobotAccount.ensure(db)
    db.execute(f'UPDATE agent_workflows SET user_id = {robot} WHERE id = 75')
    db.execute('DROP TABLE mcp_servers')   # MySQL keeps user_id as text
    db.execute('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, transport TEXT, enabled INTEGER)')
    db.execute('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, tool_description TEXT,'
               ' input_schema TEXT, has_ui INTEGER, ui_resource_uri TEXT)')
    db.execute("INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://mcp.test/u3-outlook', '{\"Authorization\":\"Bearer u3\"}', 'http', 1)")
    db.execute("INSERT INTO mcp_servers VALUES (6, '3', 'Converter', 'http://mcp.test/u3-conv', NULL, 'http', 1)")
    db.execute(f"INSERT INTO mcp_servers VALUES (7, '{robot}', 'Outlook', 'http://mcp.test/robot-outlook', '{{\"Authorization\":\"Bearer robot\"}}', 'http', 1)")
    db.execute("INSERT INTO mcp_server_tools (server_id, tool_name) VALUES (5, 'list_mail'), (6, 'convert'), (7, 'list_mail')")
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')")
    return db, ids, robot


def code_node(db, seen):
    def caller_for(userId):
        seen.append(str(userId))   # what MCPToolsLoader.loadToolsForUser receives
        return lambda server, tool, args: {'ok': True, 'result': []}
    return CodeNodeController(db, CONFIG, caller_for)


def lock(db, robot):
    db.execute(f"INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({robot}, 75, 'event', '2026-10-29 09:00:00')")


def assert_locked(r):
    assert [r.get('success'), r.get('error_code'), r.get('status_code'), r.get('error')] == \
        [False, 'locked', 423, 'Mail to PDF is running as the robot. Unlock it first.'], r


BODY = {'server': 'outlook', 'tool': 'list_mail', 'args': []}


def test_robot_is_user_120(env):
    assert env[2] == 120


def test_code_node_tool_call_of_a_robot_workflow_loads_the_robots_servers(env):
    db, _, _ = env
    seen = []
    code_node(db, seen).toolCall({'user_id': 3, 'body': {**BODY, 'workflow_id': 75}})
    code_node(db, seen).toolCall({'user_id': 3, 'body': BODY})
    assert seen == ['120', '3']


def test_code_node_tool_call_never_escalates(env):
    db, _, _ = env
    seen = []
    # user 1 may not use the robot; wf 9 is a personal workflow
    code_node(db, seen).toolCall({'user_id': 1, 'body': {**BODY, 'workflow_id': 75}})
    code_node(db, seen).toolCall({'user_id': 3, 'body': {**BODY, 'workflow_id': 9}})
    assert seen == ['1', '3']


def chat(db, userId, body):
    return ChatController(db, {**CONFIG, 'database': {}}).chat(
        {'user_id': userId, 'body': {**body, 'message': 'hi', 'streaming': False, 'memory': False}})


def test_chat_refuses_a_tool_whose_server_the_robot_lacks(env):
    db, _, _ = env
    r = chat(db, 3, {'tools': ['mcp_convert'], 'workflow_id': 75})
    assert [r.get('success'), r.get('status_code'), r.get('error_code'), r.get('server')] == [False, 422, 'robot_server_missing', 'Converter']


def test_browser_run_doors_refuse_a_locked_robot_workflow_after_access(env):
    db, _, robot = env
    lock(db, robot)
    seen = []
    body = {**BODY, 'workflow_id': 75}
    assert_locked(code_node(db, seen).toolCall({'user_id': 3, 'body': body}))
    assert seen == []
    code_node(db, seen).toolCall({'user_id': 1, 'body': body})   # no access: the lock is not revealed
    assert seen == ['1']
    assert_locked(chat(db, 3, {'tools': ['mcp_list_mail'], 'workflow_id': 75}))


class FakeSse:
    def __init__(self):
        self.frames = []
        self.status_code = 200

    def send(self, event, data):
        self.frames.append((event, data))

    def send_data(self, data):
        self.frames.append(('data', data))


def test_a_locked_robot_workflows_playbook_node_answers_423(env):
    db, _, robot = env
    lock(db, robot)
    sse = FakeSse()
    WorkflowController(db, CONFIG).runPlaybookNode({'user_id': 3, 'sse': sse, 'body': {
        'node_config': {'playbook': 'Title: T\nInstructions: Do #Leave Internal Note.'}, 'prompt': 'go', 'workflow_id': 75}})
    assert sse.status_code == 423
    assert sse.frames[0][0] == 'error' and 'running as the robot' in sse.frames[0][1]['error']


def test_schedule_of_a_robot_workflow_is_the_robots(env):
    db, ids, robot = env
    db.execute(f'UPDATE code_components SET user_id = {robot}')
    sc = ScheduledWorkflowController(db, CONFIG)
    r = sc.create({'user_id': 3, 'body': {'workflow_id': 75, 'scheduled_time': '2026-11-01 10:00:00',
                                          'trigger_component_id': ids['Poll Drop']}})
    assert r['success'] is True, r
    assert int(r['data']['user_id']) == 120
    assert int(r['data']['trigger_component_id']) == ids['Poll Drop']
    sid = int(r['data']['id'])
    u = sc.update({'user_id': 3, 'params': {'id': sid}, 'body': {'input_prompt': 'go'}}, sid)
    assert u['success'] is True, u
    assert int(u['data']['user_id']) == 120
    # not robot-permitted: the robot workflow is not found
    assert sc.create({'user_id': 1, 'body': {'workflow_id': 75, 'scheduled_time': '2026-11-01 10:00:00'}})['status_code'] == 404


def test_run_executes_as_the_robot(env):
    db, _, _ = env
    wf = WorkflowController(db, CONFIG)
    calls = []
    wf.graphWorkflowRunner.run = lambda workflow, userId, *a: calls.append(userId) or {'success': True}
    r = wf.run({'user_id': 3, 'params': {'id': 75}, 'body': {}}, 75)
    assert r['success'] is True, r
    assert calls == [120]


def test_run_by_name_finds_robot_workflows_and_the_callers_own_wins(env):
    db, _, _ = env
    wf = WorkflowController(db, CONFIG)
    db.execute("UPDATE agent_workflows SET orchestration = 'swarm' WHERE id = 75")

    def by_name(u):
        return WorkflowController(db, CONFIG).runByName({'user_id': u, 'body': {'workflow': 'Mail to PDF'}})
    assert 'swarm' in by_name(3)['error']           # the robot's, found by name
    assert by_name(1)['status_code'] == 404          # not robot-permitted
    db.execute("UPDATE agent_workflows SET name = 'Mail to PDF', enabled = 0 WHERE id = 9")
    assert by_name(3)['error'] == 'Workflow is disabled'   # the caller's own wins
    assert wf is not None
