"""Differential tests for AgentController.run (Phase 5, Task 2) --
POST /api/v1/agents/{id}/run. `chat` (SSE) isn't in this task's differential
scope per the brief.

PHP live at http://localhost/gpt/backend, Python in-process. User 3.

AGENT_ID = 25 ("Transformer to Medium format") -- user 3's simplest
delegation-free agent: agent_type='worker', provider='claude', tools=[]
(verified live against the CONTEXTS DB `agents` table).
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
