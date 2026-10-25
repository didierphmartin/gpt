/**
 * Differential tests for AgentController.run — POST /api/v1/agents/{id}/run — twin of
 * backend_python/tests/differential/test_agent_run.py. `chat` is NOT exercised here (see NOTE).
 *
 * PHP live at DIFF_PHP_BASE, TS in-process. User 3.
 *
 * AGENT_ID = 25 ("Transformer to Medium format") — user 3's simplest delegation-free agent:
 * agent_type='worker', provider='claude', tools=[] (verified live against the CONTEXTS DB).
 *
 * NOTE (from the Python port): a `chat()` validation-parity case (`POST /agents/999999999/chat`)
 * was dropped after it exposed a pre-existing live PHP bug: index.php's generic dispatch echoes
 * json_encode($result) unconditionally with `status_code ?? 200`, but AgentController::chat()
 * returns void — so PHP answers HTTP 200 with `{"success":false,"error":"Agent not found"}null`.
 * Every chat() validation branch is affected; the ports return clean, correctly-coded JSON.
 * Not replicated; a human decision.
 *
 * WRITES (dtest.write): test_run_live_parity — runs the agent once per backend (LLM cost), which
 * inserts an `agent_executions` row on each; both rows are deleted by id afterwards.
 */
import { dtest, same, sameKeys, sameKeySet, assert } from './harness';

const AGENT_ID = 25;
const MSG = 'Reply with exactly: hello world';

dtest('test_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/agents/999999999/run', { json: { message: 'hi' } })));
  same(...(await hx.both('POST', '/api/v1/agents/999999999/run', { json: { message: 'hi' }, auth: false })));
  same(...(await hx.both('POST', `/api/v1/agents/${AGENT_ID}/run`, { json: {} })));
  same(...(await hx.both('POST', `/api/v1/agents/${AGENT_ID}/run`, { json: { message: '   ' } })));
  same(...(await hx.both('POST', `/api/v1/agents/${AGENT_ID}/run`, { json: { message: 'hi', tools: 'not-an-array' } })));
});

/**
 * Costs LLM calls — run exactly once against each backend. Compares top-level keys +
 * provider/model, checks an `agent_executions` row landed on both, then deletes both by id.
 */
dtest.write('test_run_live_parity', async (hx) => {
  const [a, b] = await hx.both('POST', `/api/v1/agents/${AGENT_ID}/run`, { json: { message: MSG } });
  assert.ok(a.status === 200 && b.status === 200, `${a.text}\n${b.text}`);
  const ja = a.json();
  const jb = b.json();

  sameKeys(ja, jb);
  assert.equal(ja.success, true);
  assert.equal(jb.success, true);
  assert.equal(ja.provider, 'claude');
  assert.equal(jb.provider, 'claude');
  assert.equal(jb.model, ja.model);
  sameKeySet(ja.usage, jb.usage);
  const agent = { id: AGENT_ID, name: 'Transformer to Medium format', type: 'worker' };
  assert.deepStrictEqual(ja.agent, agent);
  assert.deepStrictEqual(jb.agent, agent);
  assert.ok(String(ja.text).toLowerCase().includes('hello world') && String(jb.text).toLowerCase().includes('hello world'));

  try {
    for (const executionId of [ja.execution_id, jb.execution_id]) {
      const row = await hx.primaryDb.fetchOne('SELECT id, status, agent_id FROM agent_executions WHERE id = ?', [executionId]);
      assert.ok(row);
      assert.equal(row.status, 'completed');
      assert.equal(row.agent_id, AGENT_ID);
    }
  } finally {
    await hx.primaryDb.execute('DELETE FROM agent_executions WHERE id IN (?, ?)', [ja.execution_id, jb.execution_id]);
  }
});
