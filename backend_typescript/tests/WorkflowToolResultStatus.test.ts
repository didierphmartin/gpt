/**
 * POST /workflows/tool-result and GET /workflows/runs/{runId}/events answer their error statuses
 * (401 / 400 / 404), as PHP's WorkflowController returns them in status_code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowController } from '../src/Controllers/WorkflowController';

test('testToolResultAnswersItsErrorStatuses', async () => {
  const c = new WorkflowController();
  assert.deepStrictEqual(await c.toolResult({ user_id: 0, body: {} } as any),
    { error: 'Authentication required', status_code: 401 });
  assert.deepStrictEqual(await c.toolResult({ user_id: 3, body: { tool_call_id: 'not-32-hex' } } as any),
    { error: 'Invalid tool_call_id', status_code: 400 });
});

test('testRunEventsAnswersItsErrorStatuses', async () => {
  const c = new WorkflowController();
  assert.deepStrictEqual(await c.runEvents({ user_id: 0, params: { runId: 'a'.repeat(32) } } as any),
    { error: 'Authentication required', status_code: 401 });
  assert.deepStrictEqual(await c.runEvents({ user_id: 3, params: { runId: 'nope' } } as any),
    { error: 'Invalid runId', status_code: 400 });
  assert.deepStrictEqual(await c.runEvents({ user_id: 3, params: { runId: '0'.repeat(32) } } as any),
    { error: 'Run not found', status_code: 404 });
});
