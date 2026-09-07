"""Unit tests for WorkflowController's execution endpoints (Phase 5, Task 6)
-- `run`, `runByName`, `runStream`, `runPlaybookNode`, `toolResult`. Port of
backend/src/AgentTeam/Controllers/WorkflowController.php:719-1094.

Every validation/ownership/scope/not-found string below is copied verbatim
from the PHP source. `workflowRepository`/`graphRepository` methods and
`workflowRunner`/`graphWorkflowRunner`/`PlaybookNodeRunner` are swapped for
plain lambdas/fakes directly on the constructed controller instance (same
style as tests/unit/test_agent_controller.py's `c.runner = FakeRunner()`)
rather than threaded through FakeDb call-order queues --
WorkflowRunner/GraphWorkflowRunner/WorkflowRepository/WorkflowGraphRepository
each have their own dedicated unit tests; this file only pins
WorkflowController's own branching, SSE framing, and response shaping.

PHP-truth strings pinned here:
  - "Authentication required"                                     (726, 862, 990, 1039)
  - "Workflow ID is required"                                      (732, 868)
  - "App key not authorized for this workflow (missing scope workflows:run)" (751)
  - 'A "workflow" name is required'                                 (825)
  - 'No workflow named "{name}" found for this account'             (840)
  - "Workflow not found or access denied"                     (763, 874)
  - "Workflow not found"                                       (770, 881)
  - "Workflow is disabled"                                      (776, 888)
  - "Invalid tool_call_id"                                          (1049)
"""
from __future__ import annotations

import re

import pytest
from starlette.datastructures import Headers

from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.models.workflow import Workflow
from app.support.http import Ctx

CFG = {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}}


class FakeDb:
    """Constructor-time-only stand-in. WorkflowController.__init__ now fires
    the same `SHOW TABLES LIKE 'system_llm_settings'` probe AgentController's
    does (LLMProviderResolver.applyDbSettings) -- answered here directly with
    an empty result (no providers configured). Every repository/runner call
    exercised by the tests below is monkeypatched directly on the controller
    instance (see module docstring), so no test needs a real query answered
    here except `runByName`'s own `SELECT id FROM agent_workflows ...`,
    which individual tests override via `c.db.fetch_one = ...`."""

    def fetch_all(self, sql, params=None):
        return []

    def fetch_one(self, sql, params=None):
        return None

    def fetch_column(self, sql, params=None):
        return []

    def execute(self, sql, params=None):
        return 0

    def insert(self, sql, params=None):
        return 1

    def begin(self) -> None:
        pass

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass


def ctx(body=None, query=None, params=None, user_id=3):
    return Ctx(method='POST', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
               params=params or {}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


def workflow(id=1, user_id=3, enabled=1, name='WF A') -> Workflow:
    return Workflow({
        'id': id, 'user_id': user_id, 'workspace_id': None, 'name': name, 'description': '',
        'steps': '[]', 'triggers': '[]', 'variables': '[]', 'enabled': enabled,
        'created_at': 'c', 'updated_at': 'u', 'output_storage_enabled': 0, 'output_folder': None,
    })


def controller(access=True, wf=None, nodes=None) -> WorkflowController:
    """`nodes` controls the graph-vs-step-based branch: None/[] -> step-based,
    a non-empty list -> graph-based (`getNodes()` non-empty)."""
    c = WorkflowController(FakeDb(), CFG)
    wf = wf if wf is not None else workflow()
    c.workflowRepository.canUserAccess = lambda uid, wid: access
    c.workflowRepository.findById = lambda wid, include_graph=False: (wf if access else None)
    c.graphRepository.getNodes = lambda wid: (nodes if nodes is not None else [])
    return c


class FakeWorkflowRunner:
    def __init__(self, result=None):
        self.calls = []
        self.result = result if result is not None else {'success': True, 'outputs': {}}

    def run(self, wf, user_id, input_variables=None):
        self.calls.append((wf, user_id, input_variables))
        return dict(self.result)


class FakeGraphRunner:
    def __init__(self, result=None):
        self.calls = []
        self.stream_calls = []
        self.stream_context = None
        self.result = result if result is not None else {'success': True, 'node_outputs': {}}

    def run(self, wf, user_id, input_variables=None, client_skills=None, inline_documents=None, scratch_files=None):
        self.calls.append((wf, user_id, input_variables, client_skills, inline_documents, scratch_files))
        return dict(self.result)

    def setStreamContext(self, sc):
        self.stream_context = sc


class FakeSse:
    def __init__(self):
        self.sent = []
        self.sent_data = []

    def send(self, event, data):
        self.sent.append((event, data))

    def send_data(self, data):
        self.sent_data.append(data)


class FakePlaybookNodeRunner:
    """Swapped in for `app.agent_team.controllers.workflow_controller.PlaybookNodeRunner`."""

    last_instance = None

    def __init__(self, config):
        self.config = config
        self.run_calls = []
        self.result = {'output': 'done', 'run_id': 1, 'status': 'completed'}
        self.raise_ = None
        FakePlaybookNodeRunner.last_instance = self

    def run(self, userId, nodeConfig, requestText, emit):
        self.run_calls.append((userId, nodeConfig, requestText))
        if self.raise_:
            raise self.raise_
        if emit:
            emit({'type': 'round', 'leg': 0})
        return self.result


# ============================================================================
# run
# ============================================================================

def test_run_unauthenticated_returns_401():
    c = controller()
    r = c.run(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_run_missing_id_returns_400():
    c = controller()
    r = c.run(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_run_app_key_missing_scope_returns_403():
    c = controller()
    request = ctx()
    request['auth_type'] = 'app_key'
    request['app_key_scopes'] = ['workflows:run:2']
    r = c.run(request, 1)
    assert r == {
        'success': False,
        'error': 'App key not authorized for this workflow (missing scope workflows:run)',
        'status_code': 403,
    }


def test_run_app_key_scoped_to_this_workflow_succeeds():
    c = controller()
    fake = FakeWorkflowRunner()
    c.workflowRunner = fake
    request = ctx()
    request['auth_type'] = 'app_key'
    request['app_key_scopes'] = ['workflows:run:1']
    r = c.run(request, 1)
    assert r['success'] is True
    assert len(fake.calls) == 1


def test_run_app_key_global_scope_succeeds():
    c = controller()
    fake = FakeWorkflowRunner()
    c.workflowRunner = fake
    request = ctx()
    request['auth_type'] = 'app_key'
    request['app_key_scopes'] = ['workflows:run']
    r = c.run(request, 1)
    assert r['success'] is True


def test_run_access_denied_returns_404():
    c = controller(access=False)
    r = c.run(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_run_not_found_returns_404():
    c = controller(access=True)
    c.workflowRepository.findById = lambda wid, include_graph=False: None
    r = c.run(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found', 'status_code': 404}


def test_run_disabled_returns_400():
    c = controller(wf=workflow(enabled=0))
    r = c.run(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow is disabled', 'status_code': 400}


def test_run_step_based_delegates_to_workflow_runner():
    c = controller(nodes=[])
    fake = FakeWorkflowRunner({'success': True, 'outputs': {'a': 1}})
    fake_graph = FakeGraphRunner()
    c.workflowRunner = fake
    c.graphWorkflowRunner = fake_graph
    r = c.run(ctx(body={'variables': {'x': 1}}), 1)
    assert r == {'success': True, 'outputs': {'a': 1}, 'status_code': 200}
    assert len(fake.calls) == 1
    assert fake.calls[0][1] == 3
    assert fake.calls[0][2] == {'x': 1}
    assert fake_graph.calls == []


def test_run_inputs_key_used_when_variables_absent():
    c = controller(nodes=[])
    fake = FakeWorkflowRunner()
    c.workflowRunner = fake
    c.run(ctx(body={'inputs': {'y': 2}}), 1)
    assert fake.calls[0][2] == {'y': 2}


def test_run_graph_workflow_delegates_to_graph_runner():
    c = controller(nodes=[{'id': 1, 'node_type': 'start'}])
    fake = FakeWorkflowRunner()
    fake_graph = FakeGraphRunner({'success': True, 'node_outputs': {'n1': 'out'}})
    c.workflowRunner = fake
    c.graphWorkflowRunner = fake_graph
    r = c.run(ctx(), 1)
    assert r == {'success': True, 'node_outputs': {'n1': 'out'}, 'status_code': 200}
    assert len(fake_graph.calls) == 1
    assert fake.calls == []


def test_run_failure_status_code_500():
    c = controller(nodes=[])
    c.workflowRunner = FakeWorkflowRunner({'success': False, 'error': 'boom'})
    r = c.run(ctx(), 1)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


def test_run_exception_returns_500():
    c = controller()

    def boom(uid, wid):
        raise RuntimeError('db down')

    c.workflowRepository.canUserAccess = boom
    r = c.run(ctx(), 1)
    assert r == {'success': False, 'error': 'db down', 'status_code': 500}


# ============================================================================
# runByName
# ============================================================================

def test_runByName_unauthenticated_returns_401():
    c = controller()
    r = c.runByName(ctx(user_id=0, body={'workflow': 'WF A'}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_runByName_blank_name_returns_400():
    c = controller()
    r = c.runByName(ctx(body={'workflow': '   '}))
    assert r == {'success': False, 'error': 'A "workflow" name is required', 'status_code': 400}


def test_runByName_missing_name_key_returns_400():
    c = controller()
    r = c.runByName(ctx(body={}))
    assert r == {'success': False, 'error': 'A "workflow" name is required', 'status_code': 400}


def test_runByName_not_found_returns_404():
    c = controller()
    c.db.fetch_one = lambda sql, params=None: None
    r = c.runByName(ctx(body={'workflow': 'Missing'}))
    assert r == {
        'success': False,
        'error': 'No workflow named "Missing" found for this account',
        'status_code': 404,
    }


def test_runByName_success_resolves_id_and_delegates_to_run():
    c = controller(nodes=[])
    fake = FakeWorkflowRunner({'success': True, 'outputs': {}})
    c.workflowRunner = fake
    lookups = []

    def fetch_one(sql, params=None):
        lookups.append((sql, params))
        return {'id': 7}

    c.db.fetch_one = fetch_one
    r = c.runByName(ctx(body={'workflow': 'WF A'}))
    assert r['success'] is True
    assert r['status_code'] == 200
    assert lookups == [(
        "SELECT id FROM agent_workflows WHERE user_id = ? AND name = ? LIMIT 1",
        [3, 'WF A'],
    )]


# ============================================================================
# runStream
# ============================================================================

def test_runStream_unauthenticated_streams_error_and_done():
    c = controller()
    sse = FakeSse()
    request = ctx(user_id=0)
    request['sse'] = sse
    r = c.runStream(request, 1)
    assert r is None
    assert sse.sent_data == [{'type': 'error', 'error': 'Authentication required'}, '[DONE]']


def test_runStream_missing_id_streams_error_and_done():
    c = controller()
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 0)
    assert sse.sent_data == [{'type': 'error', 'error': 'Workflow ID is required'}, '[DONE]']


def test_runStream_access_denied_streams_error_and_done():
    c = controller(access=False)
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 1)
    assert sse.sent_data == [{'type': 'error', 'error': 'Workflow not found or access denied'}, '[DONE]']


def test_runStream_not_found_streams_error_and_done():
    c = controller(access=True)
    c.workflowRepository.findById = lambda wid, include_graph=False: None
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 1)
    assert sse.sent_data == [{'type': 'error', 'error': 'Workflow not found'}, '[DONE]']


def test_runStream_disabled_streams_error_and_done():
    c = controller(wf=workflow(enabled=0))
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 1)
    assert sse.sent_data == [{'type': 'error', 'error': 'Workflow is disabled'}, '[DONE]']


def test_runStream_graph_invalid_streams_error_and_done():
    c = controller(nodes=[{'id': 1, 'node_type': 'start'}])
    c.graphRepository.validateGraph = lambda wid: ['Workflow must have at least one Output node']
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 1)
    assert sse.sent_data == [
        {'type': 'error', 'error': 'Invalid workflow: Workflow must have at least one Output node'},
        '[DONE]',
    ]


def test_runStream_graph_success_sets_stream_context_and_runs():
    c = controller(nodes=[{'id': 1, 'node_type': 'start'}])
    c.graphRepository.validateGraph = lambda wid: []
    fake_graph = FakeGraphRunner({'success': True, 'node_outputs': {}})
    c.graphWorkflowRunner = fake_graph
    sse = FakeSse()
    request = ctx(body={
        'variables': {'prompt': 'hi'},
        'client_skills': {'s1': {}},
        'inline_documents': {'d1': {}},
        'scratch_files': [{'doc_id': 'd1', 'path': '/scratch/d1'}],
    })
    request['sse'] = sse
    c.runStream(request, 1)
    assert fake_graph.stream_context is not None
    assert len(fake_graph.calls) == 1
    _, user_id, input_variables, client_skills, inline_documents, scratch_files = fake_graph.calls[0]
    assert user_id == 3
    assert input_variables == {'prompt': 'hi'}
    assert client_skills == {'s1': {}}
    assert inline_documents == {'d1': {}}
    assert scratch_files == [{'doc_id': 'd1', 'path': '/scratch/d1'}]
    # Graph path streams its own events through streamContext -- runStream
    # itself only ever appends the terminal [DONE] sentinel here.
    assert sse.sent_data == ['[DONE]']


def test_runStream_step_based_streams_info_and_complete_frames():
    c = controller(nodes=[])
    fake = FakeWorkflowRunner({'success': True, 'output': 'hello', 'node_outputs': {'k': 'v'}})
    c.workflowRunner = fake
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 1)
    assert sse.sent_data == [
        {'type': 'info', 'message': 'Step-based workflow - running without streaming'},
        {'type': 'workflow_complete', 'success': True, 'output': 'hello', 'node_outputs': {'k': 'v'}},
        '[DONE]',
    ]


def test_runStream_exception_streams_error_and_done():
    c = controller(nodes=[])

    class Boom(FakeWorkflowRunner):
        def run(self, wf, user_id, input_variables=None):
            raise RuntimeError('kaboom')

    c.workflowRunner = Boom()
    sse = FakeSse()
    request = ctx()
    request['sse'] = sse
    c.runStream(request, 1)
    assert sse.sent_data == [
        {'type': 'info', 'message': 'Step-based workflow - running without streaming'},
        {'type': 'error', 'error': 'kaboom'},
        '[DONE]',
    ]


def test_runStream_frame_bytes_end_to_end_with_real_sse_stream():
    """Exact wire-byte proof: bare `data:` frames, no `event:` line, ending
    in the literal `data: [DONE]\\n\\n` sentinel (PHP 887-893, 968-969)."""
    import asyncio

    from app.support.sse import SseStream

    c = controller(nodes=[])
    c.workflowRunner = FakeWorkflowRunner({'success': True, 'output': 'hi', 'node_outputs': {}})

    async def run():
        loop = asyncio.get_running_loop()
        sse = SseStream(loop)
        request = ctx()
        request['sse'] = sse
        await loop.run_in_executor(None, c.runStream, request, 1)
        await loop.run_in_executor(None, sse.end)
        frames = []
        while True:
            frame = await sse.queue.get()
            if frame is None:
                break
            frames.append(frame)
        return frames

    frames = asyncio.run(run())
    assert frames == [
        b'data: {"type":"info","message":"Step-based workflow - running without streaming"}\n\n',
        b'data: {"type":"workflow_complete","success":true,"output":"hi","node_outputs":{}}\n\n',
        b'data: [DONE]\n\n',
    ]


# ============================================================================
# runPlaybookNode
# ============================================================================

def test_runPlaybookNode_unauthenticated_sends_named_error_frame_only(monkeypatch):
    c = controller()
    sse = FakeSse()
    request = ctx(user_id=0)
    request['sse'] = sse
    r = c.runPlaybookNode(request)
    assert r is None
    assert sse.sent == [('error', {'error': 'Authentication required'})]
    assert sse.sent_data == []  # no [DONE] sentinel on this endpoint


def test_runPlaybookNode_success_sends_round_events_then_named_done_frame(monkeypatch):
    monkeypatch.setattr(
        'app.agent_team.controllers.workflow_controller.PlaybookNodeRunner', FakePlaybookNodeRunner)
    c = controller()
    sse = FakeSse()
    request = ctx(body={'node_config': {'playbook': 'x'}, 'prompt': 'hi'})
    request['sse'] = sse
    c.runPlaybookNode(request)
    assert sse.sent_data == [{'type': 'round', 'leg': 0}]
    assert sse.sent == [('done', {'output': 'done', 'run_id': 1, 'status': 'completed'})]
    userId, nodeConfig, requestText = FakePlaybookNodeRunner.last_instance.run_calls[0]
    assert userId == 3
    assert nodeConfig == {'playbook': 'x'}
    assert requestText == 'hi'


def test_runPlaybookNode_exception_sends_named_error_frame(monkeypatch):
    def raising_ctor(config):
        runner = FakePlaybookNodeRunner(config)
        runner.raise_ = RuntimeError('leg failed')
        return runner

    monkeypatch.setattr(
        'app.agent_team.controllers.workflow_controller.PlaybookNodeRunner', raising_ctor)
    c = controller()
    sse = FakeSse()
    request = ctx(body={})
    request['sse'] = sse
    c.runPlaybookNode(request)
    assert sse.sent == [('error', {'error': 'leg failed'})]


# ============================================================================
# toolResult
# ============================================================================

def test_toolResult_unauthenticated_returns_error_without_status_code():
    c = controller()
    r = c.toolResult(ctx(user_id=0))
    # No status_code key -- PHP's http_response_code(401) is dead code here,
    # same as runEvents (see workflow_controller.py's toolResult docstring):
    # backend/index.php always derives the final status from
    # `$result['status_code'] ?? 200`.
    assert r == {'error': 'Authentication required'}
    assert 'status_code' not in r


def test_toolResult_missing_tool_call_id_returns_invalid():
    c = controller()
    r = c.toolResult(ctx(body={}))
    assert r == {'error': 'Invalid tool_call_id'}


def test_toolResult_malformed_tool_call_id_returns_invalid():
    c = controller()
    r = c.toolResult(ctx(body={'tool_call_id': 'not-32-hex-chars'}))
    assert r == {'error': 'Invalid tool_call_id'}


def test_toolResult_success_writes_result_via_bridge(monkeypatch, tmp_path):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path))
    c = controller()
    toolCallId = 'a' * 32
    body = {'tool_call_id': toolCallId, 'success': True, 'output': 'result text'}
    r = c.toolResult(ctx(body=body))
    assert r == {'success': True}
    written = tmp_path / f'{toolCallId}.result'
    assert written.is_file()
    import json as _json
    assert _json.loads(written.read_text()) == body
