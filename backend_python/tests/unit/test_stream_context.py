"""Unit tests for StreamContext (port of backend/src/AgentTeam/Services/StreamContext.php).

No PHP unit oracle exists for this class; cases are written against the PHP source
directly (each emit* method's exact event dict, and isStreaming/callback semantics).
"""
import time

from app.agent_team.services.stream_context import StreamContext


def test_is_streaming_reflects_callback_presence():
    ctx = StreamContext()
    assert ctx.isStreaming() is False

    ctx2 = StreamContext(lambda e: None)
    assert ctx2.isStreaming() is True

    ctx.setEventCallback(lambda e: None)
    assert ctx.isStreaming() is True


def test_constructor_defaults():
    ctx = StreamContext()
    assert ctx.getUserId() == 0
    assert ctx.getRootExecutionId() is None


def test_constructor_user_id():
    ctx = StreamContext(None, 42)
    assert ctx.getUserId() == 42


def test_set_root_execution_id_is_fluent():
    ctx = StreamContext()
    result = ctx.setRootExecutionId(99)
    assert result is ctx
    assert ctx.getRootExecutionId() == 99


def test_emit_calls_callback_with_data():
    events = []
    ctx = StreamContext(events.append)
    ctx.emit({'type': 'custom', 'x': 1})
    assert events == [{'type': 'custom', 'x': 1}]


def test_emit_no_callback_does_not_raise():
    ctx = StreamContext()
    ctx.emit({'type': 'custom'})  # no callback set — just logs a warning, no exception


def test_emit_agent_start_event_shape():
    events = []
    ctx = StreamContext(events.append)
    before = time.time()
    ctx.emitAgentStart(1, 'Agent A', 'manager', parent_agent_id=None, execution_id=7)
    after = time.time()

    assert len(events) == 1
    e = events[0]
    assert e['type'] == 'agent_start'
    assert e['agent_id'] == 1
    assert e['agent_name'] == 'Agent A'
    assert e['agent_type'] == 'manager'
    assert e['parent_agent_id'] is None
    assert e['execution_id'] == 7
    assert before <= e['timestamp'] <= after
    assert list(e.keys()) == ['type', 'agent_id', 'agent_name', 'agent_type', 'parent_agent_id', 'execution_id', 'timestamp']


def test_emit_agent_start_defaults():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitAgentStart(1, 'Agent A', 'worker')
    e = events[0]
    assert e['parent_agent_id'] is None
    assert e['execution_id'] is None


def test_emit_agent_delegate_event_shape_and_task_truncation():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitAgentDelegate(1, 'Manager', 2, 'Worker', 'do the thing')
    e = events[0]
    assert e['type'] == 'agent_delegate'
    assert e['from_agent_id'] == 1
    assert e['from_agent_name'] == 'Manager'
    assert e['to_agent_id'] == 2
    assert e['to_agent_name'] == 'Worker'
    assert e['task'] == 'do the thing'
    assert 'timestamp' in e
    assert list(e.keys()) == ['type', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'task', 'timestamp']


def test_emit_agent_delegate_truncates_long_task_at_200_chars():
    events = []
    ctx = StreamContext(events.append)
    long_task = 'x' * 250
    ctx.emitAgentDelegate(1, 'Manager', 2, 'Worker', long_task)
    e = events[0]
    assert e['task'] == ('x' * 200) + '...'


def test_emit_agent_delegate_exactly_200_chars_no_ellipsis():
    events = []
    ctx = StreamContext(events.append)
    task = 'x' * 200
    ctx.emitAgentDelegate(1, 'Manager', 2, 'Worker', task)
    e = events[0]
    assert e['task'] == task
    assert not e['task'].endswith('...')


def test_emit_agent_complete_event_shape_success():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitAgentComplete(1, 'Agent A', 'standard')
    e = events[0]
    assert e['type'] == 'agent_complete'
    assert e['agent_id'] == 1
    assert e['agent_name'] == 'Agent A'
    assert e['agent_type'] == 'standard'
    assert e['success'] is True
    assert e['error'] is None
    assert e['execution_id'] is None
    assert list(e.keys()) == ['type', 'agent_id', 'agent_name', 'agent_type', 'success', 'error', 'execution_id', 'timestamp']


def test_emit_agent_complete_event_shape_failure():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitAgentComplete(1, 'Agent A', 'standard', success=False, error='boom', execution_id=5)
    e = events[0]
    assert e['success'] is False
    assert e['error'] == 'boom'
    assert e['execution_id'] == 5


def test_emit_agent_thinking_event_shape_and_default_status():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitAgentThinking(1, 'Agent A')
    e = events[0]
    assert e['type'] == 'agent_thinking'
    assert e['agent_id'] == 1
    assert e['agent_name'] == 'Agent A'
    assert e['status'] == 'thinking'
    assert list(e.keys()) == ['type', 'agent_id', 'agent_name', 'status', 'timestamp']


def test_emit_agent_thinking_custom_status():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitAgentThinking(1, 'Agent A', 'delegating')
    assert events[0]['status'] == 'delegating'


def test_emit_chunk_event_shape_no_timestamp():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitChunk('hello', 1, 'Agent A')
    e = events[0]
    assert e == {'type': 'chunk', 'text': 'hello', 'agent_id': 1, 'agent_name': 'Agent A'}
    assert 'timestamp' not in e


def test_emit_error_event_shape():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitError('something broke')
    e = events[0]
    assert e['type'] == 'error'
    assert e['error'] == 'something broke'
    assert e['agent_id'] is None
    assert list(e.keys()) == ['type', 'error', 'agent_id', 'timestamp']


def test_emit_error_with_agent_id():
    events = []
    ctx = StreamContext(events.append)
    ctx.emitError('boom', agent_id=3)
    assert events[0]['agent_id'] == 3
