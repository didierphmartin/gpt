import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load() {
  const code = readFileSync(new URL('../assets/js/mcp-tool-tester.js', import.meta.url), 'utf8');
  vm.runInThisContext(code);
  return globalThis.MCPToolTester;
}
const MCPToolTester = load();

const tool = {
  name: 'get_feed',
  description: 'Fetch a feed',
  inputSchema: {
    type: 'object',
    required: ['url', 'limit'],
    properties: {
      url:     { type: 'string',  description: 'Feed URL' },
      limit:   { type: 'integer' },
      verbose: { type: 'boolean' },
      tags:    { type: 'array' },
      opts:    { type: 'object' },
    },
  },
};

test('coerceArgs follows MCPeek rules', () => {
  const args = MCPToolTester.coerceArgs(tool, {
    url: ' https://a.b/rss ', limit: '5', verbose: 'TRUE', tags: 'a, b', opts: '{"x":1}',
  });
  assert.deepStrictEqual(args, {
    url: 'https://a.b/rss', limit: 5, verbose: true, tags: ['a', 'b'], opts: { x: 1 },
  });
});

test('coerceArgs skips empty values and parses JSON arrays', () => {
  const args = MCPToolTester.coerceArgs(tool, { url: '', tags: '[1,2]', opts: 'not json', verbose: '1' });
  assert.deepStrictEqual(args, { tags: [1, 2], opts: 'not json', verbose: true });
});

test('coerceArgs returns {} for tools without properties', () => {
  assert.deepStrictEqual(MCPToolTester.coerceArgs({ name: 'x' }, { a: '1' }), {});
});

test('buildInputsHtml renders one text input per property with required marker', () => {
  const html = MCPToolTester.buildInputsHtml(tool, 'mcp-arg-3-0');
  assert.match(html, /id="mcp-arg-3-0-0"/);
  assert.match(html, /id="mcp-arg-3-0-4"/);
  assert.match(html, /url<span[^>]*>\*<\/span>/);
  assert.match(html, /placeholder="Feed URL"/);
  assert.match(html, /placeholder="integer"/);
  assert.doesNotMatch(html, /verbose<span class="mcp-tool-required"/);
  assert.strictEqual((html.match(/type="text"/g) || []).length, 5);
});

test('buildInputsHtml escapes html in names and descriptions', () => {
  const html = MCPToolTester.buildInputsHtml(
    { name: 'x', inputSchema: { properties: { '<b>': { description: '"q"' } } } }, 'p');
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /placeholder="&quot;q&quot;"/);
});
