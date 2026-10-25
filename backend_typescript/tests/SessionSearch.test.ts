import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { ToolsManager } from '../src/Services/ToolsManager';
import { SessionSearchService } from '../src/AgentTeam/SessionSearchService';

/** SessionSearchService::registerAsTool / ::search (Hermes Layer 3) — the chat path's session_search tool. */

test('registerAsTool needs a positive user id', () => {
  assert.equal(SessionSearchService.registerAsTool(new ToolsManager(), 0), false);
  const tm = new ToolsManager();
  assert.equal(SessionSearchService.registerAsTool(tm, 7), true);
  assert.deepEqual(tm.getToolDefinitions()[0].input_schema.required, ['query']);
});

test('session_search is scoped to the registered user and clamps the limit', async () => {
  installFakeDb((sql) =>
    sql.includes('FROM conversation_contexts')
      ? [{ id: '3', title: 'T', created_at: 'c', updated_at: 'u', provider: 'claude', message_count: '2', score: '1.5', context_data: JSON.stringify({ messages: [{ role: 'user', content: 'Redis cache' }] }) }]
      : [],
  );
  const tm = new ToolsManager();
  SessionSearchService.registerAsTool(tm, 7);
  assert.deepEqual(await tm.execute('session_search', { query: '  ' }), { error: 'query is required' });
  const r = await tm.execute('session_search', { query: 'redis', limit: 99 });
  const q = queries.find((x) => x.sql.includes('FROM conversation_contexts'))!;
  assert.deepEqual(q.parameters, ['redis', 7, 'redis']);
  assert.match(q.sql, /LIMIT 15\s*$/);
  assert.deepEqual(r, {
    query: 'redis',
    hit_count: 1,
    hits: [{ id: 3, title: 'T', created_at: 'c', updated_at: 'u', provider: 'claude', message_count: 2, score: 1.5, snippet: 'user: Redis cache' }],
  });
});

test('extractPlainText reads string content and text blocks, root list or messages key', () => {
  assert.equal(SessionSearchService.extractPlainText(JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }])), 'user: hi\nassistant: yo');
  assert.equal(SessionSearchService.extractPlainText('not json'), 'not json');
});

test('buildSnippet centres on the first hit, else takes the head', () => {
  const text = 'a'.repeat(50) + 'needle' + 'b'.repeat(50);
  assert.equal(SessionSearchService.buildSnippet('short', ['x'], 20), 'short');
  assert.equal(SessionSearchService.buildSnippet(text, ['zzz'], 20), 'a'.repeat(20) + '…');
  assert.equal(SessionSearchService.buildSnippet(text, ['needle'], 20), '…' + 'a'.repeat(10) + 'needle' + 'bbbb' + '…');
});
