"""Port of backend/tests/Unit/Playbook/PlaybookRunStateTest.php (72 lines, 5 cases)."""
from __future__ import annotations

from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_transcript import PlaybookTranscript


def _doc():
    return PlaybookDocument.fromArray({'title': 'T',
        'trigger': {'kind': 'request', 'description': 'd'}, 'instructions': '#Resolve Request.'})


def test_create_run_and_status(pb_state):
    id_ = pb_state.createRun(1, _doc(), {'email': 'low@test'}, {})
    assert pb_state.getRun(id_)['status'] == 'running'
    pb_state.setStatus(id_, 'resolved')
    assert pb_state.getRun(id_)['status'] == 'resolved'


def test_ledger_replay_guard(pb_state):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    pb_state.ledgerAppend(id_, 0, '#Reset Password (Okta)', 'okta.reset_password',
                           {'user_id': 'u1', 'send_email': True}, 'ok', 'done')
    hit = pb_state.ledgerFindOk(id_, 'okta.reset_password', {'user_id': 'u1', 'send_email': True})
    assert hit is not None
    assert pb_state.ledgerFindOk(id_, 'okta.reset_password', {'user_id': 'OTHER'}) is None
    assert pb_state.ledgerFindOk(id_ + 1, 'okta.reset_password', {'user_id': 'u1', 'send_email': True}) is None


def test_sensitive_redaction(pb_state):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    pb_state.ledgerAppend(id_, 0, '#Get Key', 'okta.get_key', {'secret': 'ABC'}, 'ok', 'key=ABC', True)
    row = pb_state.ledgerAll(id_)[0]
    assert row['args'] == '"«redacted»"'
    assert row['result_summary'] == '«redacted»'


def test_disconnect_reconnects_lazily_via_reconnector(pb_state, pb_db):
    doc = PlaybookDocument.fromArray({'title': 'T',
        'trigger': {'kind': 'request', 'description': 'd'}, 'instructions': '#Resolve Request.'})
    id_ = pb_state.createRun(1, doc, {}, {})
    calls = {'n': 0}

    def reconnector():
        calls['n'] += 1
        return pb_db

    pb_state.setReconnector(reconnector)
    pb_state.disconnect()
    # First DB op after disconnect must reconnect exactly once and work.
    pb_state.addNote(id_, 'after reconnect')
    assert calls['n'] == 1
    row = pb_db.fetch_one(f'SELECT text FROM playbook_run_notes WHERE run_id = {id_}')
    assert row['text'] == 'after reconnect'
    # Without a reconnector, disconnect() is a no-op (sqlite tests keep working).


def test_transcript_round_trip(pb_state, pb_dir):
    id_ = pb_state.createRun(1, _doc(), {}, {})
    t = PlaybookTranscript(pb_dir)
    t.append(id_, {'type': 'leg_started', 'leg': 0})
    t.append(id_, {'type': 'tool_call', 'tool': 'okta.search_users'})
    events = t.read(id_)
    assert len(events) == 2
    assert events[0]['type'] == 'leg_started'
    assert 'ts' in events[0]
