/** Port of backend/tests/Unit/LangGraphMcpHeadersTest.php (spec 2026-10-07 §7.1: MCP headers come from MCP_HEADERS_<SLUG>, never from the script). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { sqlite, makeGenerator, execLines, python310 } from './support/lgFixturesB';

const SECRET = 'sekret-conn-key-7731';
const PY = python310();
const NO_PY = PY === null ? 'Python 3.10+ not available' : false;

function runPy(tail: string, env: Record<string, string> = {}): [number, string[]] {
  const py = "import json, os, sys, time\nclass httpx:\n    class Client:\n        pass\n"
    + "MCP_SERVER_SLUGS = {'http://o/mcp': 'outlook'}\n"
    + LangGraphRuntime.mcpClientBlock() + '\n' + tail;
  const dir = mkdtempSync(path.join(tmpdir(), 'hd'));
  const file = path.join(dir, 'hd.py');
  writeFileSync(file, py);
  try {
    return execLines([PY!, file], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

test('testHeadersFromEnvironmentAreMerged', { skip: NO_PY }, () => {
  const [rc, out] = runPy("print(json.dumps(MCP._headers('http://o/mcp'), sort_keys=True))",
    { MCP_HEADERS_OUTLOOK: '{"X-Outlook-Account": "k-1"}' });
  assert.equal(rc, 0, out.join('\n'));
  const h = JSON.parse(out[0]);
  assert.equal(h['X-Outlook-Account'], 'k-1');
  assert.equal(h['Content-Type'], 'application/json');
});

test('testNoVariableMeansBaseHeaders', { skip: NO_PY }, () => {
  const [, out] = runPy("print('X-Outlook-Account' in MCP._headers('http://o/mcp'), 'Accept' in MCP._headers('http://x/mcp'))");
  assert.deepEqual(out, ['False True']);
});

test('testBadHeaderJsonNamesTheVariable', { skip: NO_PY }, () => {
  const [rc, out] = runPy("MCP._headers('http://o/mcp')", { MCP_HEADERS_OUTLOOK: 'not json' });
  assert.notEqual(rc, 0);
  assert.ok(out.join('\n').includes('MCP_HEADERS_OUTLOOK'));
});

test('testNonObjectHeaderJsonNamesTheVariable', { skip: NO_PY }, () => {
  const [rc, out] = runPy("MCP._headers('http://o/mcp')", { MCP_HEADERS_OUTLOOK: '["a"]' });
  assert.notEqual(rc, 0);
  assert.ok(out.join('\n').includes('MCP_HEADERS_OUTLOOK'));
});

test('testNonStringOrMultilineHeaderValueNamesTheVariableNotTheValue', { skip: NO_PY }, () => {
  for (const bad of ['{"X-A": 5}', '{"X-A": "a\\nb"}']) {
    const [rc, out] = runPy("MCP._headers('http://o/mcp')", { MCP_HEADERS_OUTLOOK: bad });
    assert.notEqual(rc, 0);
    const text = out.join('\n');
    assert.ok(text.includes('MCP_HEADERS_OUTLOOK'));
    assert.ok(!text.includes('a\\nb'));
  }
});

test('testEveryRequestUsesServerHeaders', () => {
  const src = LangGraphRuntime.mcpClientBlock();
  assert.equal(count(src, 'headers=self.HEADERS'), 0, 'all requests go through _headers()');
  assert.equal(count(src, 'headers=h,'), 2);
  assert.equal(count(src, 'headers=self._headers(server_url)'), 2);
});

/** extraServers: seeded for the user; useExtra says whether the agent calls them. */
async function generate(options: any, extraServers: [string, string][] = [], useExtra = false): Promise<any> {
  const s = [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    `INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, '{"X-Outlook-Account": "${SECRET}"}')`,
  ];
  extraServers.forEach(([name, url], i) => {
    s.push(`INSERT INTO mcp_servers VALUES (${10 + i}, '3', '${name}', '${url}', 1, NULL)`);
    s.push(`INSERT INTO mcp_server_tools VALUES (${10 + i}, ${10 + i}, 'tool_${i}', 'T', '{}')`);
  });
  s.push("INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')");
  s.push("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
  sqlite(s);
  const tools = ['mcp_list_messages'];
  if (useExtra) extraServers.forEach((_, i) => tools.push('mcp_tool_' + i));
  const graph = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
      { id: '2', node_type: '', config: { type: 'agent-template', agent_name: 'Mailer', agent_type: 'standard',
        instructions: 'Read mail.', agent_provider: 'claude', model: 'claude-sonnet-4-6',
        tools, settings: { temperature: 0.7, max_tokens: 4096 } } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }],
  };
  return makeGenerator({ workflow: { id: 44, name: 'Mail', user_id: '3' }, graph }).generate(44, '3', options);
}

test('testSingleFileEmitsSlugsAndDocsButNoHeaderValue', async () => {
  const code: string = (await generate({})).code;
  assert.match(code, /MCP_SERVER_SLUGS = \{\s*"http:\/\/localhost\/outlook\/mcp": "outlook"\s*\}/);
  assert.ok(code.indexOf('MCP_SERVER_SLUGS = ') < code.indexOf('class McpClient'));
  assert.ok(code.includes('MCP_HEADERS_OUTLOOK='));
  assert.ok(!code.includes(SECRET));
});

test('testModularEmitsSlugsAndNoHeaderValue', async () => {
  const res = await generate({ modular: true });
  let all = '';
  for (const f of res.files) all += f.code + '\n';
  assert.ok(all.includes('MCP_SERVER_SLUGS = '));
  assert.ok(all.includes('MCP_HEADERS_OUTLOOK='));
  assert.ok(!all.includes(SECRET));
});

test('testOnlyServersTheWorkflowUsesAreListedAndDocumented', async () => {
  const code: string = (await generate({}, [['Calendar', 'http://localhost/cal/mcp']])).code;
  assert.ok(code.includes('"http://localhost/outlook/mcp": "outlook"'));
  assert.ok(!code.toLowerCase().includes('calendar'));
  assert.ok(!code.includes('MCP_HEADERS_CALENDAR'));
});

test('testTwoUsedServersWithTheSameSlugAreRefused', async () => {
  await assert.rejects(() => generate({}, [['outlook', 'http://localhost/other/mcp']], true),
    (e: any) => e instanceof Error && e.message.includes('MCP_HEADERS_OUTLOOK'));
});

test('testSameSlugOnAnUnusedServerIsFine', async () => {
  const code: string = (await generate({}, [['outlook', 'http://localhost/other/mcp']])).code;
  assert.ok(!code.includes('http://localhost/other/mcp'));
});

/** Two mailboxes on one Outlook MCP URL (different X-Outlook-Account): a code node checks $servers. */
async function generateCode(servers: string[]): Promise<any> {
  sqlite([
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, NULL)",
    "INSERT INTO mcp_servers VALUES (6, '3', 'Outlook Work', 'http://localhost/outlook/mcp', 1, NULL)",
    "INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 6, 'list_messages', 'List', '{}')",
  ]);
  const graph = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
      { id: '2', node_type: 'code', config: { type: 'code', name: 'Poll',
        code: "def run(input, call_tool):\n    return {'route': 'next', 'output': 'x'}\n",
        exits: ['next'], mcp_servers: servers, timeout_s: 30 } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }],
  };
  return makeGenerator({ workflow: { id: 44, name: 'Mail', user_id: '3' }, graph }).generate(44, '3', {});
}

test('testTwoUsedServersOnOneUrlAreRefused', async () => {
  let err: any = null;
  try {
    await generateCode(['Outlook', 'Outlook Work']);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, 'two used servers on one URL compiled');
  assert.ok(err.message.includes('"Outlook"'));
  assert.ok(err.message.includes('"Outlook Work"'));
  assert.ok(err.message.includes('one connection per MCP URL'));
});

test('testTheOneUsedServerOnASharedUrlKeepsItsOwnHeaderVariable', async () => {
  const code: string = (await generateCode(['Outlook Work'])).code;
  assert.ok(code.includes('"http://localhost/outlook/mcp": "outlook_work"'));
  assert.ok(code.includes('MCP_HEADERS_OUTLOOK_WORK='));
  assert.ok(!code.includes('MCP_HEADERS_OUTLOOK='));
});

test('testTheDocsSayOneConnectionPerUrl', async () => {
  assert.ok((await generate({})).code.includes('one connection per MCP URL'));
});
