/**
 * Port of backend/tests/Unit/LangGraphStandaloneE2ETest.php. Opt-in (CODE_NODE_E2E=1): the modular package / single
 * file of a Start-option workflow runs with real Python against the fake Outlook MCP server
 * (backend/tests/fixtures/compiled/fake_outlook_mcp.py): it catches the event, routes it with a code node (no LLM),
 * records one run, and stays quiet on the empty poll that follows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';
import { execLines, makeGenerator, PHP_FIXTURES, sqlite } from './support/lgFixturesB';

const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
const FAKE = path.join(PHP_FIXTURES, 'compiled/fake_outlook_mcp.py');
const SKIP = process.env.CODE_NODE_E2E !== '1' ? 'Set CODE_NODE_E2E=1 to run.' : !existsSync(VENV) ? 'venv python missing' : false;

const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
  + "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";
const CLASSIFY = "def run(input, call_tool):\n    return {'route': 'claim' if 'Claim' in input else 'other', 'output': input}\n";

function pdo(): void {
  sqlite([
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
    "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1, NULL)",
    "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)",
  ]);
}

/** Start option (17) -> Classify (19) -> claim: Output A (18) / other: Output B (20). */
function graph(): Promise<any> {
  const raw = {
    nodes: [
      { id: '17', node_type: 'start', config: { type: 'start', start_option: 5 } },
      { id: '19', node_type: 'code', config: { type: 'code', name: 'Classify',
        code: CLASSIFY, exits: ['claim', 'other'], mcp_servers: [], timeout_s: 30 } },
      { id: '18', node_type: 'output', config: { type: 'output' } },
      { id: '20', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from_node_id: '17', to_node_id: '19', from_port: 'output_1' },
      { from_node_id: '19', to_node_id: '18', from_port: 'output_1' },
      { from_node_id: '19', to_node_id: '20', from_port: 'output_2' },
    ],
  };
  return StartOptionGraph.expand(raw, (_id: number) => ({ name: 'Outlook: get new email', code: POLL,
    exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 30,
    start_trigger: { label: 'Outlook: get new email', work_exit: 'new_mail',
      watch: { server: 'Outlook', tool: 'wait_for_new', args: { folder: 'Inbox' } } } }));
}

async function generate(options: any = { modular: true }): Promise<any> {
  pdo();
  const g = await graph();
  return makeGenerator({ workflow: { id: 44, name: 'Email triage', user_id: '3', output_storage_enabled: true }, graph: g })
    .generate(44, '3', options);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

async function waitListening(port: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await canConnect(port)) return true;
    await sleep(100);
  }
  return false;
}

/** Starts the fake Outlook server on a free port; returns [process, port]. */
async function startFake(callLog: string, ...extra: string[]): Promise<[ChildProcess, number]> {
  const port = await freePort();
  const fake = spawn(VENV, [FAKE, String(port), callLog, ...extra], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (await waitListening(port)) return [fake, port];
  fake.kill('SIGKILL');
  assert.fail('the fake Outlook server never started listening');
}

/** A running program whose stdout+stderr accumulate into .text. */
function startProgram(args: string[], cwd: string, env: Record<string, string>): { proc: ChildProcess; text: () => string; exited: Promise<void> } {
  let text = '';
  const proc = spawn(VENV, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => { text += d.toString('utf8'); });
  proc.stderr!.on('data', (d) => { text += d.toString('utf8'); });
  const exited = new Promise<void>((resolve) => proc.once('close', () => resolve()));
  return { proc, text: () => text, exited };
}

function fileLines(f: string): string[] {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

function countValues(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function kill(p: ChildProcess | null): void {
  if (p !== null && p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
}

/** Final review I1: quiet wakes of the single file print only the banner, one listening line and the stop line. */
test('testQuietWakesOfTheSingleFilePrintNothing', { skip: SKIP }, async () => {
  const dir = path.join(tmpdir(), 'lgstandalone_' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  let fake: ChildProcess | null = null;
  let wf: ChildProcess | null = null;
  try {
    const single = await generate({});
    writeFileSync(path.join(dir, single.filename), single.code);
    let port: number;
    [fake, port] = await startFake(`${dir}/calls.log`, 'always-ready');
    for (const flags of [[], ['--quiet']]) {
      const prog = startProgram([single.filename, ...flags], dir, {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', MCP_URL_OUTLOOK: `http://127.0.0.1:${port}/mcp`,
        SYNERGYAI_OUTPUT_ROOT: `${dir}/outputs`, PYTHONUNBUFFERED: '1',
      });
      wf = prog.proc;
      const before = fileLines(`${dir}/calls.log`).length;
      let now: Record<string, number> = {};
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        now = countValues(fileLines(`${dir}/calls.log`).slice(before));
        if ((now['poll_new_mail'] ?? 0) >= 5) break;
        await sleep(100);
      }
      await sleep(300);
      wf.kill('SIGTERM');
      await prog.exited;
      wf = null;
      const text = prog.text();
      process.stdout.write(`\n--- single file ${flags.join(' ')} ---\n${text}------------------\n`);
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      assert.ok((now['poll_new_mail'] ?? 0) >= 5, text);
      assert.equal(lines.length, 3, text);
      assert.ok(lines[0].startsWith('Listening for events: outlook.wait_for_new {"folder":"Inbox"} (Ctrl-C to stop)'));
      assert.match(lines[1], /^\[watch \d\d:\d\d\] Listening for events$/);
      assert.equal(lines[2], '[watch] stopped.');
    }
    const runs = existsSync(`${dir}/runs`) ? readdirSync(`${dir}/runs`).filter((f) => f.endsWith('.jsonl')) : [];
    assert.deepEqual(runs, [], 'quiet runs leave no log');
    assert.ok(!existsSync(`${dir}/outputs`));
  } finally {
    kill(wf);
    kill(fake);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('testACompiledWatchWorkflowCatchesAnEventRoutesItAndStaysQuietAfterwards', { skip: SKIP }, async () => {
  const dir = path.join(tmpdir(), 'lgstandalone_' + randomBytes(4).toString('hex'));
  mkdirSync(`${dir}/pkg`, { recursive: true });
  const port = await freePort();
  let fake: ChildProcess | null = null;
  let wf: ChildProcess | null = null;
  try {
    for (const f of (await generate()).files) {
      mkdirSync(path.dirname(`${dir}/pkg/${f.path}`), { recursive: true });
      writeFileSync(`${dir}/pkg/${f.path}`, (f.encoding ?? '') === 'base64' ? Buffer.from(f.code, 'base64') : f.code);
    }
    writeFileSync(`${dir}/pkg/.env`, `MCP_URL_OUTLOOK=http://127.0.0.1:${port}/mcp\n`);

    fake = spawn(VENV, [FAKE, String(port), `${dir}/calls.log`], { stdio: ['ignore', 'ignore', 'ignore'] });
    assert.ok(await waitListening(port), 'the fake Outlook server never started listening');

    const prog = startProgram(['workflow.py'], `${dir}/pkg`, {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SYNERGYAI_OUTPUT_ROOT: `${dir}/outputs`, PYTHONUNBUFFERED: '1',
    });
    wf = prog.proc;
    const until = Date.now() + 20000;
    let doneAt: number | null = null;
    while (Date.now() < until) {
      if (doneAt === null && /Done in/.test(prog.text())) doneAt = Date.now();
      if (doneAt !== null && Date.now() - doneAt > 1500) break;
      await sleep(100);
    }
    wf.kill('SIGTERM');
    await prog.exited;
    wf = null;
    const text = prog.text();
    process.stdout.write(`\n--- E2E stdout ---\n${text}------------------\n`);

    assert.ok(text.includes('Listening for events: outlook.wait_for_new'));
    assert.match(text, /\[\d\d:\d\d\] New event — From: jane@acme\.com · Subject: Claim for water damage/);
    assert.ok(text.includes('  ✓ Classify'));
    assert.ok(text.includes('[watch] stopped.'));

    const logs = existsSync(`${dir}/pkg/runs`) ? readdirSync(`${dir}/pkg/runs`).filter((f) => f.endsWith('.jsonl')) : [];
    assert.equal(logs.length, 1, `one run only; the empty poll is quiet\n${text}`);
    const events = fileLines(`${dir}/pkg/runs/${logs[0]}`).filter((l) => l !== '').map((l) => JSON.parse(l));
    const done = events.filter((e) => e.type === 'node_complete' && (e.node_name ?? '') === 'Classify');
    assert.equal(done.length, 1);
    assert.equal(done[0].exit, 'claim');
    const last = events[events.length - 1];
    assert.equal(last.type, 'workflow_complete');
    assert.equal(last.success, true);

    const outputs = existsSync(`${dir}/outputs`)
      ? readdirSync(`${dir}/outputs`).filter((d) => statSync(`${dir}/outputs/${d}`).isDirectory())
        .flatMap((d) => readdirSync(`${dir}/outputs/${d}`).filter((f) => !f.startsWith('.')))
      : [];
    assert.equal(outputs.length, 1, 'one saved output');

    const calls = countValues(fileLines(`${dir}/calls.log`).filter((l) => l !== ''));
    assert.equal(calls['poll_new_mail'] ?? 0, 2, 'one poll with mail, one quiet poll');
    assert.ok((calls['wait_for_new'] ?? 0) >= 1);

    assert.ok(existsSync(`${dir}/pkg/.run.lock`), 'the program took the run lock');
    const lock = 'import fcntl, sys\nfh = open(sys.argv[1], "a+")\nfcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)\nprint("LOCKED")';
    const [, out] = execLines([VENV, '-c', lock, `${dir}/pkg/.run.lock`]);
    assert.deepEqual(out, ['LOCKED'], 'the run lock is free after exit');
  } finally {
    kill(wf);
    kill(fake);
    rmSync(dir, { recursive: true, force: true });
  }
});
