"""Differential tests for AgentController.run (Phase 5, Task 2) --
POST /api/v1/agents/{id}/run. `chat` is NOT exercised here -- see the
NOTE below (fix round 1).

PHP live at http://localhost/gpt/backend, Python in-process. User 3.

AGENT_ID = 25 ("Transformer to Medium format") -- user 3's simplest
delegation-free agent: agent_type='worker', provider='claude', tools=[]
(verified live against the CONTEXTS DB `agents` table).

NOTE (fix round 1): a `chat()` validation-parity differential test
(`POST /agents/999999999/chat`, no LLM cost) was attempted here per the
round-1 ruling and DROPPED after it exposed a pre-existing, unrelated live
PHP bug, not something this task should paper over by matching it:
`backend/index.php`'s generic dispatch (lines ~159-196) does
`$statusCode = $result['status_code'] ?? 200;` then, for the default
"standard JSON response" branch, `http_response_code($statusCode);
... echo json_encode($result);` UNCONDITIONALLY -- but `AgentController::
chat()` (PHP 436-509) returns `void`. Verified live: `POST /agents/
999999999/chat` on PHP returns HTTP 200 (not 404) with body
`{"success":false,"error":"Agent not found"}null` -- the controller's own
`sendJsonResponse(..., 404)` fires correctly, then index.php's generic
epilogue runs anyway on the `null` return value, re-setting status to the
`?? 200` default and appending a second `echo json_encode(null)` ("null")
after the controller's own output. This affects EVERY chat() validation
branch (not-found/disabled/missing-input/bad-tools) identically, since
they all return void. The Python port's chat() does NOT reproduce this --
its validation failures return a `dict` that `main.py`'s `render()` turns
into a clean, correctly-status-coded JSON response (matching what PHP
*should* return, not what it currently does). Deliberately porting this
corruption into Python was judged out of this round's scope (it is not
about the streaming success-path SSE framing this round's ruling covers)
and worth a human decision rather than silent replication either way --
flagged in task-2-report.md.
"""
import pytest

from app.db import open_primary
from tests.differential.conftest import same

pytestmark = pytest.mark.differential

AGENT_ID = 25
MSG = 'Reply with exactly: hello world'


def test_validation_parity(both):
    same(*both('POST', '/api/v1/agents/999999999/run', json={'message': 'hi'}))
    same(*both('POST', '/api/v1/agents/999999999/run', json={'message': 'hi'}, auth=False))
    same(*both('POST', f'/api/v1/agents/{AGENT_ID}/run', json={}))
    same(*both('POST', f'/api/v1/agents/{AGENT_ID}/run', json={'message': '   '}))
    same(*both('POST', f'/api/v1/agents/{AGENT_ID}/run', json={'message': 'hi', 'tools': 'not-an-array'}))


def test_run_live_parity(both, config):
    """Costs LLM calls -- run exactly once against each backend. Compares
    top-level keys + provider/model, checks an `agent_executions` row landed
    on both backends, then deletes both rows by id (self-cleaning)."""
    a, b = both('POST', f'/api/v1/agents/{AGENT_ID}/run', json={'message': MSG})
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    ja, jb = a.json(), b.json()

    assert list(ja) == list(jb)
    assert ja['success'] is True and jb['success'] is True
    assert ja['provider'] == jb['provider'] == 'claude'
    assert ja['model'] == jb['model']
    assert set(ja['usage']) == set(jb['usage'])
    assert ja['agent'] == jb['agent'] == {'id': AGENT_ID, 'name': 'Transformer to Medium format', 'type': 'worker'}
    assert 'hello world' in ja['text'].lower() and 'hello world' in jb['text'].lower()

    db = open_primary(config)
    try:
        for execution_id in (ja['execution_id'], jb['execution_id']):
            row = db.fetch_one('SELECT id, status, agent_id FROM agent_executions WHERE id = ?', [execution_id])
            assert row is not None
            assert row['status'] == 'completed'
            assert row['agent_id'] == AGENT_ID
    finally:
        db.execute('DELETE FROM agent_executions WHERE id IN (?, ?)', [ja['execution_id'], jb['execution_id']])
        db.close()
