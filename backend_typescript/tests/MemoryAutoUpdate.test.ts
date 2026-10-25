import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { buildMemoryBlock, buildMerged } from '../src/AgentTeam/UserMemoryRepository';
import { MemoryExtractor } from '../src/AgentTeam/MemoryExtractor';
import { MemoryAutoUpdater, MemoryStore } from '../src/AgentTeam/MemoryAutoUpdater';
import { KimiProvider } from '../src/Providers/KimiProvider';

/**
 * The chat path's user memory, as PHP runs it: UserMemoryRepository::buildMemoryBlock appended to
 * the system prompt (options.memory_context), and the post-response MemoryAutoUpdater /
 * MemoryExtractor. No database (fake Kysely executor) and no network (fetch replaced).
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Each Claude call answers the next text; records the request bodies. */
function claudeAnswers(...texts: Array<string | Error>): any[] {
  const bodies: any[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const t = texts[Math.min(i++, texts.length - 1)];
    if (t instanceof Error) throw t;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: t }] }), { status: 200 });
  }) as any;
  return bodies;
}

test('buildMerged appends only lines not already present (case-insensitive)', () => {
  assert.equal(buildMerged('Uses PHP\n', ['uses php', ' Likes TS ', '', 'Likes TS']), 'Uses PHP\nLikes TS');
  assert.equal(buildMerged('', ['a', 'b']), 'a\nb');
  assert.equal(buildMerged('x  ', ['X']), 'x');
});

test('buildMemoryBlock renders both scopes with headers and skips empty ones', async () => {
  installFakeDb(() => [{ scope: 'memory', content: ' repo is gpt \n' }, { scope: 'user', content: '' }]);
  assert.equal(await buildMemoryBlock(4), '## Memory\nrepo is gpt');
  assert.equal(queries[0].sql, 'SELECT scope, content FROM user_memories WHERE user_id = ?');
  installFakeDb(() => [{ scope: 'memory', content: 'm' }, { scope: 'user', content: 'u' }]);
  assert.equal(await buildMemoryBlock(4), '## Memory\nm\n\n## User\nu');
  assert.equal(await buildMemoryBlock(0), '');
  installFakeDb(() => {
    throw new Error('db down');
  });
  assert.equal(await buildMemoryBlock(4), '');
});

test('the memory block lands after the persona and before the skill content', async () => {
  let body: any;
  globalThis.fetch = (async (_u: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 });
  }) as any;
  const p = new KimiProvider({ provider_key: 'kimi', api_key: 'k', model: 'm', base_url: '', chat_endpoint: '', api_format: 'openai', max_tokens: 1, temperature: 0.6, system_prompt: 'persona  ' });
  await p.chat({ message: 'q', conversation_history: [], memory_context: '## Memory\nm', skill_content: 'SKILL' });
  assert.match(body.messages[0].content, /\n\npersona\n\n## Memory\nm\n\nSKILL$/);
});

test('MemoryExtractor.parseJson keeps non-empty string additions and caps the reason', () => {
  assert.deepEqual(MemoryExtractor.parseJson('```json\n{"memory_additions":["a"," ",3],"user_additions":"b","reason":"r"}\n```'),
    { memory_additions: ['a'], user_additions: ['b'], reason: 'r' });
  assert.equal(MemoryExtractor.parseJson('not json'), null);
});

test('MemoryExtractor.extract posts one Messages call to the resolved endpoint', async () => {
  const bodies = claudeAnswers('{"memory_additions":[],"user_additions":["Prefers French"],"reason":"pref"}');
  let url = '';
  const f = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => {
    url = String(u);
    return (f as any)(u, init);
  }) as any;
  const r = await new MemoryExtractor('key', 'https://gw.example/', '').extract('haiku', '', 'x', 'I prefer answers in French', 'ok');
  assert.deepEqual(r, { memory_additions: [], user_additions: ['Prefers French'], reason: 'pref' });
  assert.equal(url, 'https://gw.example/v1/messages');
  assert.equal(bodies[0].max_tokens, 512);
  assert.match(bodies[0].messages[0].content, /=== CURRENT MEMORY ===\n\(empty\)\n\n=== CURRENT USER ===\nx/);
});

test('filterDuplicates keeps the indices the model calls new; a failed call keeps everything', async () => {
  claudeAnswers('Here you go: [1] because the first is covered');
  assert.deepEqual(await new MemoryExtractor('k').filterDuplicates('m', 'existing', ['a', 'b']), ['b']);
  claudeAnswers(new Error('down'));
  assert.deepEqual(await new MemoryExtractor('k').filterDuplicates('m', 'existing', ['a', 'b']), ['a', 'b']);
  assert.deepEqual(await new MemoryExtractor('k').filterDuplicates('m', '  ', ['a']), ['a']);
});

/** An in-memory store recording writes. */
function memoryStore(initial: Record<string, string>, enabled = true): MemoryStore & { writes: any[]; events: any[] } {
  const data = { memory: '', user: '', ...initial };
  const s: any = {
    writes: [], events: [],
    getSettings: async () => ({ enabled, model: 'claude-haiku-4-5-20251001' }),
    getBoth: async () => ({ ...data }),
    setScope: async (_u: number, scope: string, content: string) => {
      s.writes.push([scope, content]);
      (data as any)[scope] = content;
    },
    logEvent: async (...args: any[]) => s.events.push(args),
  };
  return s;
}

test('MemoryAutoUpdater short-circuits on short messages, no key, and disabled settings', async () => {
  claudeAnswers('{}');
  assert.equal(await new MemoryAutoUpdater('k', '', '', memoryStore({})).run(1, 's', 'too short', 'x'), null);
  assert.equal(await new MemoryAutoUpdater('', '', '', memoryStore({})).run(1, 's', 'a long enough user message', 'x'), null);
  assert.equal(await new MemoryAutoUpdater('k', '', '', memoryStore({}, false)).run(1, 's', 'a long enough user message', 'x'), null);
});

test('MemoryAutoUpdater merges additions per scope and logs an auto_extract event', async () => {
  claudeAnswers('{"memory_additions":["Works on gpt"],"user_additions":["Lives in Montreal"],"reason":"facts"}', '[0]');
  const store = memoryStore({ memory: '', user: 'Speaks French' });
  const r = await new MemoryAutoUpdater('k', '', '', store).run(7, 'chat_1', 'I live in Montreal and work on gpt', 'noted');
  assert.deepEqual(r, { reason: 'facts', written: ['memory', 'user'] });
  assert.deepEqual(store.writes, [['memory', 'Works on gpt'], ['user', 'Speaks French\nLives in Montreal']]);
  assert.deepEqual(store.events[0], [7, 'memory', 'auto_extract', '', 'Works on gpt', 'facts', 'chat_1']);
});

test('MemoryAutoUpdater compacts a scope that outgrows its budget', async () => {
  const long = 'x'.repeat(1370);
  claudeAnswers('{"memory_additions":[],"user_additions":["New fact"],"reason":"r"}', '[0]', 'compacted');
  const store = memoryStore({ user: long });
  const r = await new MemoryAutoUpdater('k', '', '', store).run(7, 's', 'a long enough user message', 'x');
  assert.deepEqual(r?.written, ['user']);
  assert.deepEqual(store.writes, [['user', 'compacted']]);
  assert.equal(store.events[0][2], 'compact');
});
