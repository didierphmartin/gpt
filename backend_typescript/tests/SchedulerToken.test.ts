import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/fakeDb';
import { SchedulerController } from '../src/Controllers/SchedulerController';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/AgentTeam/SchedulerTokenTest.php: without a signed-in user,
 * /scheduler/run needs the configured token; a blank SCHEDULER_TOKEN never matches.
 */

function ctx(body: Record<string, unknown>, headers: Record<string, string> = {}): Ctx {
  return { method: 'POST', uri: '/', headers, query: {}, body, user_id: null, auth_type: null, params: {}, remote_addr: '127.0.0.1' } as any;
}

async function run401(configured: string, c: Ctx): Promise<void> {
  const r = await new SchedulerController({ token: configured }).run(c);
  assert.equal(r.status_code, 401);
  assert.equal(r.error, 'Authentication required');
}

test('a blank configured token refuses every token', async () => {
  await run401('', ctx({ token: '' }));
  await run401('', ctx({}));
  await run401('', ctx({}, { 'x-scheduler-token': '' }));
});

test('a wrong or non-string token is refused', async () => {
  await run401('s3cret', ctx({ token: 'nope' }));
  await run401('s3cret', ctx({ token: ['s3cret'] }));
  await run401('s3cret', ctx({ token: 's3cre' }));
});
