/**
 * Port of backend/tests/Unit/LangGraphCodeNodeE2ETest.php. Opt-in (CODE_NODE_E2E=1): compiled code-node workflows
 * RUN with real Python + LangGraph against the mock ServiceNow MCP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { execPy, lgFiles, lgGenerator } from './support/lgFixtures';

const PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
const MCP = 'http://localhost/servicenow/?profile=mock&toolset=jobs';

function sqlStatements(): string[] {
  return [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
    "INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)",
    "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')",
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
    "INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)",
  ];
}

async function generateWith(graph: any, options: any, userId: string | null = '3'): Promise<any> {
  const gen = lgGenerator({ sql: sqlStatements(), workflow: { id: 44, name: 'Dispatcher demo', user_id: '3' }, graph });
  return gen.generate(44, userId, options);
}

/** setUp(): the reason to skip, or '' to run. */
async function skipReason(): Promise<string> {
  if (process.env.CODE_NODE_E2E !== '1') return 'Set CODE_NODE_E2E=1 to run.';
  if (!existsSync(PY)) return 'venv python missing';
  // A fresh connection per probe (as file_get_contents opens one): a pooled keep-alive socket may have been closed
  // by the server while a script ran (ECONNRESET).
  const answered = await new Promise<boolean>((resolve) => {
    const req = http.request(MCP, { method: 'POST', agent: false, timeout: 5000, headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
    req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });
  return answered ? '' : 'mock connector not answering';
}

function graph(code: string, servers: string[]): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'poll' } },
      { id: '2', node_type: 'code', config: { type: 'code', name: 'Poll ServiceNow jobs', code, exits: ['job', 'no_job'], mcp_servers: servers, timeout_s: 30 } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
      { id: '4', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2', from_port: 'output_1' },
      { from: '2', to: '3', from_port: 'output_1' },
      { from: '2', to: '4', from_port: 'output_2' },
    ],
  };
}

function pollGraph(): any {
  return graph(
    "def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n",
    ['ServiceNow'],
  );
}

function noJobGraph(): any {
  return graph("def run(input, call_tool):\n    return {'route': 'no_job', 'output': None}\n", []);
}

/** Writes the generated files to a temp dir, runs workflow.py poll; returns [rc, output]. */
function runScript(gen: any): [number, string] {
  const dir = path.join(tmpdir(), 'lgcn_e2e_' + randomBytes(4).toString('hex'));
  mkdirSync(dir);
  for (const [p, code] of Object.entries(lgFiles(gen))) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), code);
  }
  const r = execPy(PY, ['workflow.py', 'poll'], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'dummy', OPENAI_API_KEY: 'dummy', DEEPSEEK_API_KEY: 'dummy' },
    timeoutMs: 90000,
  });
  let text = r.text;
  if (r.rc === -1) text += '\n[timed out]';
  process.stderr.write(`\n--- E2E output (${dir}) ---\n${text}\n`);
  return [r.rc, text];
}

function assertJob(gen: any): void {
  const [rc, text] = runScript(gen);
  assert.equal(rc, 0, text);
  assert.ok(text.includes('SCTASK0000101'), text);
  assert.ok(text.includes('poll_jobs'), text);
  assert.match(text, /exit '?job'?/);
}

test('testSingleFileTakesTheJobExit', { timeout: 120000 }, async (t) => {
  const why = await skipReason();
  if (why) return t.skip(why);
  assertJob(await generateWith(pollGraph(), {}));
});

test('testModularTakesTheJobExit', { timeout: 120000 }, async (t) => {
  const why = await skipReason();
  if (why) return t.skip(why);
  assertJob(await generateWith(pollGraph(), { modular: true }));
});

test('testNoJobExitReachesOutputB', { timeout: 240000 }, async (t) => {
  const why = await skipReason();
  if (why) return t.skip(why);
  for (const opts of [{}, { modular: true }]) {
    const [rc, text] = runScript(await generateWith(noJobGraph(), opts));
    assert.equal(rc, 0, text);
    assert.ok(!text.includes('SCTASK0000101'), text);
    assert.match(text, /exit '?no_job'?/);
    assert.ok(text.includes('[4] output'), text);
    assert.ok(!text.includes('[3] output'), text);
  }
});

test('testBadCodeStopsTheScriptBeforeAnyNodeRuns', { timeout: 240000 }, async (t) => {
  const why = await skipReason();
  if (why) return t.skip(why);
  // spec §5.2: check_code at startup, single file and modular.
  const bad = graph("import requests\n\ndef run(input, call_tool):\n    return {'route': 'job', 'output': 1}\n", []);
  for (const opts of [{}, { modular: true }]) {
    const [rc, text] = runScript(await generateWith(bad, opts));
    assert.notEqual(rc, 0, text);
    assert.ok(text.includes("import of 'requests' is not allowed"), text);
    assert.ok(!text.includes('[info] Running'), text);
  }
});
