"""Ports of backend/tests/Unit/PlaybookOutcomeTest.php and backend/tests/Unit/PlaybookSourceTest.php."""
from __future__ import annotations

import pytest

from app.agent_team.services.playbook_outcome import PlaybookOutcome
from app.agent_team.services.playbook_source import PlaybookSource
from tests.unit.playbook.conftest import PLAYBOOKS_DDL, sqlite_db

# --- PlaybookOutcomeTest -----------------------------------------------------------------


def test_statuses():
    assert PlaybookOutcome.exit('resolved') == 'done'
    assert PlaybookOutcome.exit('failed') == 'failed'
    assert PlaybookOutcome.exit('running') == 'failed'
    assert PlaybookOutcome.exit('handed_off') == 'failed'
    assert PlaybookOutcome.reason('handed_off', 'approval') == 'gate:approval'
    assert PlaybookOutcome.reason('running', None) == 'status:running'
    assert PlaybookOutcome.reason('resolved', None) is None
    assert PlaybookOutcome.failureText('bad_input', 'T').startswith('Playbook failed: bad_input\n\nT')


def test_node_result():
    assert PlaybookOutcome.nodeResult(None, 'T', 'Job: x') == {'exit': 'done', 'text': 'T\n\nJob: x'}
    assert PlaybookOutcome.nodeResult('bad_input', 'T', 'Job: x') == \
        {'exit': 'failed', 'text': 'Playbook failed: bad_input\n\nT\n\nJob: x'}
    assert PlaybookOutcome.nodeResult(None, 'T', None) == {'exit': 'done', 'text': 'T'}
    assert PlaybookOutcome.nodeResult('status:running', 'T', None) == \
        {'exit': 'failed', 'text': 'Playbook failed: status:running\n\nT'}


def test_error_reason():
    assert PlaybookOutcome.errorReason(RuntimeError('  boom\n  and\tmore \n')) == 'error:boom and more'


# --- PlaybookSourceTest ------------------------------------------------------------------

@pytest.fixture
def db():
    return sqlite_db(*PLAYBOOKS_DDL, 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)')


def _robot(db) -> int:
    return db.insert("INSERT INTO users (kind) VALUES ('service')")


def _pb(db, user: int, key: str, text: str) -> None:
    db.execute('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)', [user, key, key, text])


def test_from_input_reads_the_published_robot_copy(db):
    r = _robot(db)
    _pb(db, r, 'test', 'T-published')
    _pb(db, 7, 'test', 'T-draft')
    assert PlaybookSource.fromInput(db, 7, {}, '## Get job\n{"playbook":"test","task":"x"}') == \
        {'ok': True, 'key': 'test', 'text': 'T-published'}


def test_from_input_unpublished_draft(db):
    _robot(db)
    _pb(db, 7, 'test', 'T-draft')
    assert PlaybookSource.fromInput(db, 7, {}, '{"playbook":"test"}') == \
        {'ok': False, 'reason': 'playbook_not_published:test'}


def test_from_input_unknown_key(db):
    _robot(db)
    assert PlaybookSource.fromInput(db, 7, {}, '{"playbook":"nope"}') == {'ok': False, 'reason': 'playbook_not_found:nope'}


def test_from_input_bad_input_fails(db):
    _robot(db)
    for t in ['hello', '{"task":"x"}', '[1]', '{"playbook":5}']:
        assert PlaybookSource.fromInput(db, 7, {}, t) == {'ok': False, 'reason': 'bad_input'}, t


def test_from_input_rejects_invalid_key(db):
    _robot(db)
    assert PlaybookSource.fromInput(db, 7, {}, '{"playbook":"../x"}') == {'ok': False, 'reason': 'bad_input'}


def test_from_input_without_robot_account(db):
    assert PlaybookSource.fromInput(db, 7, {}, '{"playbook":"test"}') == {'ok': False, 'reason': 'playbook_not_found:test'}
    _pb(db, 7, 'test', 'D')
    assert PlaybookSource.fromInput(db, 7, {}, '{"playbook":"test"}') == \
        {'ok': False, 'reason': 'playbook_not_published:test'}


def test_custom_field(db):
    r = _robot(db)
    _pb(db, r, 'test', 'T')
    assert PlaybookSource.fromInput(db, 7, {'playbook_input_field': 'pb'}, '{"pb":"test"}')['ok'] is True


def test_is_from_input():
    assert PlaybookSource.isFromInput({'playbook_source': 'input'}) is True
    assert PlaybookSource.isFromInput({'playbook_source': 'fixed'}) is False
    assert PlaybookSource.isFromInput({}) is False


def test_job_line():
    assert PlaybookSource.jobLine('## Get job\n{ "playbook": "a/b",\n "task": "é" }') == 'Job: {"playbook":"a/b","task":"é"}'
    assert PlaybookSource.jobLine('{"task":"x"}') == 'Job: {"task":"x"}'
    assert PlaybookSource.jobLine('not json') is None
    assert PlaybookSource.jobLine('[1,2]') is None
    assert PlaybookSource.jobLine('"text"') is None
    assert PlaybookSource.jobLine('## Get job\n') is None
    assert PlaybookSource.jobLine('{}') == 'Job: {}'
    assert PlaybookSource.jobLine('{"a":{}}') == 'Job: {"a":{}}'
    assert PlaybookSource.jobLine('{"a":{"b":[]},"c":null}') == 'Job: {"a":{"b":[]},"c":null}'
