import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/fakeDb';
import { fakeHttp, jevAnswer } from './support/decisionDb';
import { JevRouter } from '../src/AgentTeam/JevRouter';
import { OpenAIDecisionRouter } from '../src/AgentTeam/OpenAIDecisionRouter';
import { DEFAULT_CONFIDENCE_FLOOR } from '../src/AgentTeam/DecisionRouter';
import { DECISION_ADAPTERS } from '../src/Services/DecisionRouters';
import { DECISION_PROTOCOLS } from '../src/Services/DecisionProtocols';

/**
 * Twins of backend/tests/Unit/JevRouterTest.php and OpenAIDecisionRouterTest.php: the outcome
 * mapping (which responses may decide a route), against recorded API shapes, with no network.
 */

const TARGETS = [
  { id: 1, name: 'Billing', description: 'Invoices, payments, refunds.' },
  { id: 2, name: 'Sales', description: 'Pricing, plans, demos.' },
];

const jev = (queue: any[], floor = DEFAULT_CONFIDENCE_FLOOR, url = '', model = '') => {
  const h = fakeHttp(queue);
  return { router: new JevRouter('test-key', h.http, floor, url, model), ...h };
};

// ── JevRouter ────────────────────────────────────────────────────────────────

test('Jev posts to a configured gateway URL', async () => {
  const j = jev([jevAnswer('Billing', 0.99)], DEFAULT_CONFIDENCE_FLOOR, 'https://gw.corp/jev');
  await j.router.route('I was charged twice.', TARGETS, 'Which team?');
  assert.equal(j.seen[0].url, 'https://gw.corp/jev');
});

test('Jev posts to the vendor URL by default, with the documented body', async () => {
  const j = jev([jevAnswer('Billing', 0.99)]);
  await j.router.route('I was charged twice.', TARGETS, 'Which team?');
  assert.equal(j.seen[0].url, JevRouter.URL);
  assert.equal(j.seen[0].headers.Authorization, 'Bearer test-key');
  const body = j.seen[0].body;
  assert.deepEqual(body.state, { request: 'I was charged twice.' });
  assert.equal(body.model, JevRouter.MODEL);
  assert.equal(body.questions.route.type, 'choice');
  assert.equal(body.questions.route.instructions, 'Which team?');
  assert.deepEqual(Object.keys(body.questions.route.criteria), ['Billing', 'Sales', 'unclear']);
});

test('a confident choice routes', async () => {
  const out = await jev([jevAnswer('Billing', 0.99)]).router.route('I was charged twice.', TARGETS, 'Which team?');
  assert.equal(out.outcome, 'routed');
  assert.equal(out.target?.id, 1);
  assert.equal(out.confidence, 0.99);
  assert.equal(out.usage.input_tokens, 342);
});

test('unclear routes nowhere', async () => {
  const out = await jev([jevAnswer(JevRouter.UNCLEAR, 1.0)]).router.route('hello', TARGETS, 'Which team?');
  assert.equal(out.outcome, 'unclear');
  assert.equal(out.target, null);
});

test('low confidence does not decide', async () => {
  const out = await jev([jevAnswer('Sales', 0.46)]).router.route('Upgrade me to annual.', TARGETS, 'Which team?');
  assert.equal(out.outcome, 'low_confidence');
  assert.equal(out.target?.name, 'Sales');
  assert.equal(out.reason, 'confidence 0.46 below floor 0.60');
});

test('the floor is configurable, not a belief', async () => {
  const out = await jev([jevAnswer('Sales', 0.46)], 0.4).router.route('Upgrade me.', TARGETS, 'Which team?');
  assert.equal(out.outcome, 'routed', 'a lower floor must let 0.46 through');
});

test('no key is unavailable, not fatal; the environment is never read', async () => {
  const prev = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'env-key-must-be-ignored';
  try {
    for (const key of ['', null]) {
      const r = new JevRouter(key, fakeHttp([]).http);
      assert.equal(r.isAvailable(), false);
      assert.equal((await r.route('x', TARGETS, 'q')).outcome, 'unavailable');
    }
  } finally {
    if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prev;
  }
});

test('a transport failure is an error with no time', async () => {
  const out = await jev([new Error('timeout')]).router.route('x', TARGETS, 'q');
  assert.equal(out.outcome, 'error');
  assert.equal(out.target, null);
  assert.equal(out.ms, null);
});

test('an HTTP error status is an error (Guzzle throws on it)', async () => {
  const out = await jev([{ status: 401, body: '{"error":"bad key"}' }]).router.route('x', TARGETS, 'q');
  assert.equal(out.outcome, 'error');
  assert.match(String(out.reason), /Client error: `POST https:\/\/api\.typesafe\.ai\/v1\/systemone` resulted in a `401/);
  assert.equal(out.ms, null);
});

test('a branch named unclear is refused, and calls nobody', async () => {
  const j = jev([]);
  const out = await j.router.route('x', [{ id: 1, name: 'unclear', description: 'x' }, { id: 2, name: 'Sales', description: 'y' }], 'q');
  assert.equal(out.outcome, 'error');
  assert.match(String(out.reason), /unusable target name/);
  assert.equal(j.seen.length, 0);
});

test('a menu of one is refused', async () => {
  const out = await jev([]).router.route('x', [TARGETS[0]], 'q');
  assert.equal(out.outcome, 'error');
  assert.match(String(out.reason), /at least two/);
  assert.equal(out.ms, null);
});

test('an off-menu answer is an error', async () => {
  const out = await jev([jevAnswer('Engineering', 0.99)]).router.route('x', TARGETS, 'q');
  assert.equal(out.outcome, 'error');
  assert.match(String(out.reason), /not on the menu/);
});

test('an answer without a choice keeps its time and usage', async () => {
  const out = await jev([{ body: { answers: [], usage: { input_tokens: 342, output_tokens: 0 } } }]).router.route('x', TARGETS, 'q');
  assert.equal(out.outcome, 'error');
  assert.equal(out.reason, 'no choice in the response');
  assert.equal(typeof out.ms, 'number');
  assert.equal(out.usage.input_tokens, 342);
});

test('the model comes from the row; empty is the vendor default', async () => {
  const a = jev([jevAnswer('Billing', 0.99)], 0.6, '', 'jev-2');
  await a.router.route('x', TARGETS, 'q');
  assert.equal(a.seen[0].body.model, 'jev-2');
  const b = jev([jevAnswer('Billing', 0.99)]);
  await b.router.route('x', TARGETS, 'q');
  assert.equal(b.seen[0].body.model, JevRouter.MODEL);
});

test('a target without a description is described by its name, cut at 400 characters', async () => {
  const j = jev([jevAnswer('Billing', 0.99)]);
  await j.router.route('x', [{ id: 1, name: 'Billing', description: 'é'.repeat(500) }, { id: 2, name: 'Sales', description: '' }], 'q');
  assert.equal(j.seen[0].body.questions.route.criteria.Sales, 'Sales');
  assert.equal(j.seen[0].body.questions.route.criteria.Billing, 'é'.repeat(400));
});

// ── OpenAIDecisionRouter ─────────────────────────────────────────────────────

const OTARGETS = [
  { id: 1, name: 'Billing', description: 'Invoices, payments, refunds.' },
  { id: 2, name: 'Sales', description: '' },
];

const oai = (queue: any[], floor = DEFAULT_CONFIDENCE_FLOOR, url = '', model = '') => {
  const h = fakeHttp(queue);
  return { router: new OpenAIDecisionRouter('test-key', h.http, floor, url, model), ...h };
};

const oAnswer = (choice: string, confidence: number) => ({
  body: {
    model: 'gpt-6-luna',
    answers: [{ type: 'choice', name: 'route', choice, confidence, probabilities: [{ value: choice, probability: confidence }] }],
    usage: { input_tokens: 120, output_tokens: 0 },
  },
});

test('OpenAI: it sends the documented request', async () => {
  const o = oai([oAnswer('Billing', 0.95)]);
  await o.router.route('I was charged twice.', OTARGETS, 'Which team?');
  assert.equal(o.seen[0].url, OpenAIDecisionRouter.URL);
  assert.equal(o.seen[0].headers.Authorization, 'Bearer test-key');
  const body = o.seen[0].body;
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.input, 'I was charged twice.');
  const q = body.questions[0];
  assert.deepEqual({ type: q.type, name: q.name, instructions: q.instructions }, { type: 'choice', name: 'route', instructions: 'Which team?' });
  assert.deepEqual(q.choices.map((c: any) => c.value), ['Billing', 'Sales', 'unclear']);
  assert.equal(q.choices[1].description, 'Sales', 'no description falls back to the name');
});

test('OpenAI: gateway URL and row model', async () => {
  const o = oai([oAnswer('Billing', 0.95)], 0.6, 'https://gw.corp/decisions', 'gpt-6-luna-2026-10-06');
  await o.router.route('x', OTARGETS, 'q');
  assert.equal(o.seen[0].url, 'https://gw.corp/decisions');
  assert.equal(o.seen[0].body.model, 'gpt-6-luna-2026-10-06');
});

test('OpenAI: outcomes', async () => {
  const out = await oai([oAnswer('Billing', 0.93)]).router.route('x', OTARGETS, 'q');
  assert.deepEqual([out.outcome, out.target?.id, out.confidence, out.usage.input_tokens], ['routed', 1, 0.93, 120]);
  assert.equal((await oai([oAnswer('unclear', 1.0)]).router.route('hello', OTARGETS, 'q')).outcome, 'unclear');
  const low = await oai([oAnswer('Sales', 0.46)]).router.route('x', OTARGETS, 'q');
  assert.deepEqual([low.outcome, low.target?.id], ['low_confidence', 2]);
  assert.equal((await oai([oAnswer('Support', 0.99)]).router.route('x', OTARGETS, 'q')).outcome, 'error');
});

test('OpenAI: a refusal is an error that keeps its usage', async () => {
  const out = await oai([{ body: { answers: [{ type: 'refusal', name: 'route' }], usage: { input_tokens: 9 } } }]).router.route('x', OTARGETS, 'q');
  assert.deepEqual([out.outcome, out.reason, out.usage.input_tokens], ['error', 'the model refused to answer', 9]);
  assert.notEqual(out.ms, null);
});

test('OpenAI: failures and bad menus', async () => {
  assert.equal((await new OpenAIDecisionRouter(null).route('x', OTARGETS, 'q')).outcome, 'unavailable');
  const net = await oai([new Error('down')]).router.route('x', OTARGETS, 'q');
  assert.deepEqual([net.outcome, net.ms], ['error', null]);
  const o = oai([]);
  assert.equal((await o.router.route('x', [OTARGETS[0], { id: 3, name: 'Unclear' }], 'q')).outcome, 'error');
  assert.equal((await o.router.route('x', [OTARGETS[0]], 'q')).outcome, 'error');
  assert.deepEqual(o.seen, [], 'a refused menu calls nobody');
});

test('OpenAI: API errors report their own message', async () => {
  const msg = 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/account/billing to keep going.';
  const body = JSON.stringify({ error: { message: msg, type: 'insufficient_quota', code: 'insufficient_quota' } });
  const out = await oai([{ status: 429, body }]).router.route('x', OTARGETS, 'q');
  assert.equal(out.outcome, 'error');
  assert.equal(out.reason, `OpenAI HTTP 429 (insufficient_quota): ${msg}`);
  assert.equal((await oai([{ status: 502, body: '<html>' }]).router.route('x', OTARGETS, 'q')).reason, 'OpenAI HTTP 502');
});

test('every decision protocol has an adapter', () => {
  assert.deepEqual(Object.keys(DECISION_ADAPTERS).sort(), Object.keys(DECISION_PROTOCOLS).sort());
  assert.equal(DECISION_ADAPTERS.openai, OpenAIDecisionRouter);
  assert.equal(DECISION_ADAPTERS.typesafe, JevRouter);
  assert.equal(DECISION_PROTOCOLS.openai.legacy_env, null, 'OPENAI_API_KEY is the chat key');
});
