import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/fakeDb';
import { router } from '../src/routes';
import { routeMiss } from '../src/Support/RouteMiss';

/** index.php's route-miss envelopes: 405 + allowed_methods for a known path, else 404. */
function miss(method: string, path: string): { status: number; body: any } {
  const out: any = {};
  const res: any = { status: (s: number) => ((out.status = s), { json: (b: any) => (out.body = b) }) };
  routeMiss(router)({ method, path } as any, res);
  return out;
}

test('a known path under another method answers 405 with its methods', () => {
  const r = miss('PATCH', '/api/v1/prompts');
  assert.equal(r.status, 405);
  assert.deepEqual(r.body.success, false);
  assert.equal(r.body.error, 'Method not allowed');
  assert.deepEqual([...r.body.allowed_methods].sort(), ['GET', 'POST']);
});

test('a param route matches by pattern', () => {
  const r = miss('POST', '/api/v1/me/mcp-servers/12/override');
  assert.equal(r.status, 405);
  assert.deepEqual([...r.body.allowed_methods].sort(), ['DELETE', 'PUT']);
});

test('an unknown path answers 404', () => {
  assert.deepEqual(miss('GET', '/api/v1/definitely-missing'), {
    status: 404, body: { success: false, error: 'Endpoint not found', uri: '/api/v1/definitely-missing' },
  });
});
