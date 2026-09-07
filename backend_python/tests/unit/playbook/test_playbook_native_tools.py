"""Port of backend/tests/Unit/Playbook/PlaybookNativeToolsTest.php (186 lines, 11 cases)."""
from __future__ import annotations

import pytest

from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_native_tools import PlaybookNativeTools


def _doc():
    return PlaybookDocument.fromArray({'title': 'T',
        'trigger': {'kind': 'request', 'description': 'd'}, 'instructions': '#Resolve Request.'})


@pytest.fixture
def tools(pb_state):
    return PlaybookNativeTools(pb_state)


def test_definitions_structure(tools):
    defs = tools.definitions()
    assert len(defs) == 6
    for d in defs:
        assert isinstance(d, dict)
        assert d['type'] == 'function'
        assert 'name' in d['function']
        assert 'parameters' in d['function']
        assert d['function']['parameters']['type'] == 'object'


def test_definition_names(tools):
    defs = tools.definitions()
    names = [d['function']['name'] for d in defs]
    for n in ('send_direct_message', 'send_channel_message', 'send_email',
              'leave_internal_note', 'set_priority', 'resolve_request'):
        assert n in names


def test_send_direct_message(tools, pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {'email': 'user@test'}, {})
    result = tools.execute(id_, 0, 'send_direct_message', {'text': 'Hello user'})
    assert result['ok'] is True

    messages = pb_db.fetch_all('SELECT * FROM playbook_run_messages WHERE run_id = ?', [id_])
    assert len(messages) == 1
    assert messages[0]['direction'] == 'to_requester'
    assert messages[0]['audience'] is None
    assert messages[0]['text'] == 'Hello user'
    assert int(messages[0]['sensitive']) == 0


def test_send_direct_message_with_sensitive(tools, pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {'email': 'user@test'}, {})
    result = tools.execute(id_, 0, 'send_direct_message', {'text': 'Secret password', 'sensitive': True})
    assert result['ok'] is True

    messages = pb_db.fetch_all('SELECT * FROM playbook_run_messages WHERE run_id = ?', [id_])
    assert len(messages) == 1
    assert messages[0]['direction'] == 'to_requester'
    assert messages[0]['text'] == '«redacted»'
    assert int(messages[0]['sensitive']) == 1


def test_send_channel_message(tools, pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = tools.execute(id_, 0, 'send_channel_message', {'channel': 'general', 'text': 'Channel message'})
    assert result['ok'] is True

    messages = pb_db.fetch_all('SELECT * FROM playbook_run_messages WHERE run_id = ?', [id_])
    assert len(messages) == 1
    assert messages[0]['direction'] == 'to_channel'
    assert messages[0]['audience'] == 'general'
    assert messages[0]['text'] == 'Channel message'


def test_send_email(tools, pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = tools.execute(id_, 0, 'send_email', {'to': 'user@example.com', 'subject': 'Test', 'text': 'Email body'})
    assert result['ok'] is True

    messages = pb_db.fetch_all('SELECT * FROM playbook_run_messages WHERE run_id = ?', [id_])
    assert len(messages) == 1
    assert messages[0]['direction'] == 'to_email'
    assert messages[0]['audience'] == 'user@example.com'
    assert messages[0]['text'] == 'Email body'


def test_leave_internal_note(tools, pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = tools.execute(id_, 0, 'leave_internal_note', {'text': 'Internal note'})
    assert result['ok'] is True

    notes = pb_db.fetch_all('SELECT * FROM playbook_run_notes WHERE run_id = ?', [id_])
    assert len(notes) == 1
    assert notes[0]['text'] == 'Internal note'
    assert notes[0]['author'] == 'agent'


def test_set_priority(tools, pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = tools.execute(id_, 0, 'set_priority', {'priority': 'high', 'reason': 'Critical issue'})
    assert result['ok'] is True

    notes = pb_db.fetch_all('SELECT * FROM playbook_run_notes WHERE run_id = ?', [id_])
    assert len(notes) == 1
    assert 'priority' in notes[0]['text']
    assert 'high' in notes[0]['text']
    assert 'Critical issue' in notes[0]['text']


def test_resolve_request(tools, pb_state):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = tools.execute(id_, 0, 'resolve_request', {'outcome': 'success', 'summary': 'Resolved successfully'})
    assert result['ok'] is True
    assert result['terminal'] is True

    run = pb_state.getRun(id_)
    assert run['status'] == 'resolved'


def test_unknown_tool(tools, pb_state):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = tools.execute(id_, 0, 'unknown_tool', {})
    assert result['ok'] is False
    assert 'error' in result
