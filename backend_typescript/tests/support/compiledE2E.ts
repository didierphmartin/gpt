/**
 * The compiled-target end-to-end scenarios of backend/tests/Unit/AdkCodeNodeE2ETest.php, which MafE2ETest and
 * NooaE2ETest reuse by overriding its hooks: a compiled script with code nodes RUNS (the runner venv) against a fake
 * MCP server (backend/tests/fixtures/fake_mcp_server.py), as a single file, a listening package and an A2A package.
 *
 * defineCompiledE2E() registers the scenarios (node:test) for one target; its config is the PHP class's protected
 * hooks (ENV_FLAG, emit, packageFiles, packageSources, a2aPackage, generatorClass). Opt-in: every test skips unless
 * process.env[flag] === '1' and the venv's python exists, as PHP's setUp() does. Test titles are PHP's method names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomInt } from 'node:crypto';
import { oarr } from '../../src/AgentTeam/compiler/php';
import { RunServerEmitter } from '../../src/AgentTeam/compiler/RunServerEmitter';
import { agentRecord, analyzedOf, withCode } from './adkAnalyses';
import { compile } from './memoryFixture';

export const E2E_PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
const FAKE_MCP = path.resolve(__dirname, '../../../backend/tests/fixtures/fake_mcp_server.py');

export interface CompiledE2EConfig {
  /** The opt-in variable (ENV_FLAG): ADK_E2E, MAF_E2E, NOOA_E2E. */
  flag: string;
  /** The target's name in the printed run output ("ADK", "MAF"...). */
  label: string;
  /** The single-file script of an analysis (emitAdk / emitMaf / emitNooa). */
  emit(analyzed: any): string;
  /** The package's own files (ADKPackage::files($analyzed, sys_get_temp_dir())). */
  packageFiles(analyzed: any): Promise<any[]> | any[];
  /** [workflow.py, common.py, agents/ files] of the package ("agents in separate files"). */
  packageSources(analyzed: any): [string, string, any[]] | any[];
  /** The target's A2A package of an analysis (servers/, orchestrator.py, api.py, the runtime). */
  a2aPackage(analyzed: any): Promise<any> | any;
  /** The target's generator class (the playbook scenarios compile through it, from an in-memory workflow). */
  generatorClass: any;
}

/** One test's processes and fake server (PHP's $server, $api, $log, $url). */
class Ctx {
  server: ChildProcess | null = null;
  api: ChildProcess | null = null;
  log = '';
  url = '';

  close(): void {
    for (const p of [this.api, this.server]) {
      if (p && p.exitCode === null) p.kill('SIGKILL');
    }
  }
}

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
    const c = net.connect({ host: '127.0.0.1', port, timeout: 100 });
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
    c.once('timeout', () => { c.destroy(); resolve(false); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = () => randomInt(0, 0xffffffff).toString(16).padStart(8, '0');
const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra });

async function startServer(ctx: Ctx, empty = false, mode = ''): Promise<void> {
  const port = await freePort();
  ctx.log = path.join(tmpdir(), `adk_e2e_${hex()}.jsonl`);
  const args = [FAKE_MCP, String(port), ctx.log];
  if (empty || mode !== '') args.push(empty ? 'empty' : mode);
  ctx.server = spawn('python3', args, { stdio: 'ignore' });
  ctx.url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (await canConnect(port)) return;
    await sleep(100);
  }
  assert.fail('fake MCP server did not start');
}

function calls(ctx: Ctx): any[] {
  if (!existsSync(ctx.log)) return [];   // no request yet: no log file
  return readFileSync(ctx.log, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** Runs the venv python in `dir` (stdout and stderr together, as proc_open with 2 => redirect 1). */
function runIn(dir: string, argv: string[], env: Record<string, string> = {}, label = 'output'): [number, string] {
  const r = spawnSync('sh', ['-c', 'exec "$0" "$@" 2>&1', E2E_PY, ...argv], {
    cwd: dir, env: baseEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 600000, killSignal: 'SIGKILL',
  });
  const text = r.stdout ?? '';
  process.stderr.write(`\n--- ${label} (${dir}) ---\n${text}\n`);
  return [r.status ?? -1, text];
}

function writeFiles(dir: string, files: any[]): void {
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    writeFileSync(path.join(dir, f.path), f.encoding === 'base64' ? Buffer.from(f.code, 'base64') : f.code);
  }
}

async function post(url: string, body: Record<string, any>): Promise<[number, any]> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return [r.status, json];
  } catch {
    return [0, null];
  }
}

/** GET /live for `seconds`: the SSE text (curl: the stream is chunked and never ends on its own). */
function live(base: string, seconds: number): string {
  return spawnSync('curl', ['-s', '-N', '-m', String(seconds), `${base}/live`], { encoding: 'utf8' }).stdout ?? '';
}

function runFiles(dir: string): string[] {
  const d = path.join(dir, 'runs');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(d, f)) : [];
}

function runEvents(dir: string): any[] {
  const out: any[] = [];
  for (const f of runFiles(dir)) {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (l.trim() !== '') out.push(JSON.parse(l));
    }
  }
  return out;
}

async function startApi(ctx: Ctx, dir: string): Promise<string> {
  const port = await freePort();
  const log = openSync(path.join(dir, 'api.log'), 'a');
  ctx.api = spawn(E2E_PY, ['api.py', '--port', String(port)], { cwd: dir, env: baseEnv(), stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/.well-known/workflow.json`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return base;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  assert.fail('api.py did not start:\n' + readFileSync(path.join(dir, 'api.log'), 'utf8'));
}

async function completedRun(dir: string): Promise<any[]> {
  for (let i = 0; i < 150; i++) {
    for (const f of runFiles(dir)) {
      const ev = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
      if (ev.some((e) => e.type === 'workflow_complete')) return ev;
    }
    await sleep(200);
  }
  assert.fail('no recorded run:\n' + (existsSync(path.join(dir, 'api.log')) ? readFileSync(path.join(dir, 'api.log'), 'utf8') : ''));
}

/** The run's answer as the program prints it: after "FINAL OUTPUT" (MAF, NOOA) or "[workflow] done" (ADK), up to RUN SUMMARY. */
function finalAnswer(text: string): string {
  let i = text.lastIndexOf('FINAL OUTPUT');
  if (i < 0) i = text.lastIndexOf('[workflow] done');
  assert.ok(i >= 0, `no final answer in:\n${text}`);
  const end = text.indexOf('RUN SUMMARY', i);
  return text.slice(i, end > 0 ? end : text.length);
}

const FILE = "def run(input, call_tool):\n    call_tool('outlook', 'move_mail', {'id': input['id'], 'folder': 'Inbox/' + NODE_NAME})\n"
  + "    return {'output': 'filed ' + input['subject']}\n";

const TRIGGER = "def run(input, call_tool):\n    m = call_tool('outlook', 'next_mail', {})\n"
  + "    return {'route': 'new_mail' if m else 'no_mail', 'output': m}\n";

/** Start -> trigger T (new_mail | no_mail) -> branch B (on new_mail) -> Output; no LLM node. */
function analyzed(ctx: Ctx, branchCode: string): any {
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start', prompt: 'go' } },
    { id: '10', type: 'code', config: { type: 'code', name: 'T', code: TRIGGER, exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 30 } },
    { id: '3', type: 'code', config: { type: 'code', name: 'B', code: branchCode, exits: ['next'], mcp_servers: ['Outlook'], timeout_s: 30 } },
    { id: '5', type: 'output', config: { type: 'output' } },
  ], edges: [
    { from: '1', to: '10', from_port: 'output_1' },
    { from: '10', to: '3', from_port: 'output_1' },
    { from: '3', to: '5', from_port: 'output_1' },
  ] };
  const a = analyzedOf(graph, {
    workflow: { id: 99, name: 'adk e2e' }, usedCatalog: [], usedServers: [],
    serverSlugs: { [ctx.url]: 'outlook' }, startPrompt: 'go', startDocuments: [],
    agents: [], playbooks: [],
  });
  return withCode(a, graph, ['10', '3'], { outlook: ctx.url }, ['1', '10', '3', '5']);
}

/** Start -> trigger T -> dispatcher D (Jev) -> code A | code B -> Output; no LLM turn at all. */
function jevAnalyzed(ctx: Ctx, unclearBranch = ''): any {
  const file = "def run(input, call_tool):\n    call_tool('outlook', 'move_mail', {'id': input['id'], 'folder': 'Inbox/' + NODE_NAME})\n"
    + "    return 'filed ' + input['subject']\n";
  const code = (id: string, name: string, src: string, exits: string[]) => ({ id, type: 'code',
    config: { type: 'code', name, code: src, exits, mcp_servers: ['Outlook'], timeout_s: 30 } });
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start', prompt: 'go' } },
    code('10', 'T', TRIGGER, ['new_mail', 'no_mail']),
    { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'D', agent_type: 'dispatcher', provider: 'claude', model: 'm' } },
    code('3', 'A', file, ['next']),
    code('4', 'B', file, ['next']),
    { id: '5', type: 'output', config: { type: 'output' } },
  ], edges: [
    { from: '1', to: '10', from_port: 'output_1' }, { from: '10', to: '2', from_port: 'output_1' },
    { from: '2', to: '3' }, { from: '2', to: '4' }, { from: '3', to: '5' }, { from: '4', to: '5' },
  ] };
  const a = analyzedOf(graph, {
    workflow: { id: 98, name: 'adk jev' }, usedCatalog: [], usedServers: [],
    serverSlugs: { [ctx.url]: 'outlook' }, startPrompt: 'go', startDocuments: [], playbooks: [],
    agents: { 2: agentRecord('D', 'Route the email.', 'claude', 'm') },
    decisions: { 2: { decision_question: 'Which team handles this email?', routing_mode: 'jev',
      unclear_branch: unclearBranch, min_confidence: 0.6,
      decision: [{ provider: 'jev', protocol: 'typesafe', url: ctx.url + '/systemone',
        model: 'jev-latest', key_env: 'JEV_API_KEY', url_env: 'JEV_BASE_URL' }] } },
  });
  return withCode(a, graph, ['10', '3', '4'], { outlook: ctx.url });
}

/** Start -> dispatcher D (Jev) -> agent A | agent B -> Output, every model the fake one ("answer from <model>"). */
function a2aAnalyzed(ctx: Ctx): any {
  const agent = (id: string, name: string, extra: Record<string, any> = {}) => ({ id, type: 'agent',
    config: { type: 'agent', agent_name: name, provider: 'deepseek', model: 'fake-' + name.toLowerCase(), ...extra } });
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start', prompt: 'my car claim' } },
    agent('2', 'D', { agent_type: 'dispatcher' }), agent('3', 'A'), agent('4', 'B'),
    { id: '5', type: 'output', config: { type: 'output' } },
  ], edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '2', to: '4' },
    { from: '3', to: '5' }, { from: '4', to: '5' }] };
  const ag = (name: string, prompt: string) => agentRecord(name, prompt, 'deepseek', 'fake-' + name.toLowerCase(), { skills: [] });
  return analyzedOf(graph, {
    workflow: { id: 96, name: 'a2a e2e' }, usedCatalog: [], usedServers: [], serverSlugs: [],
    startPrompt: 'my car claim', playbooks: [], code: [],
    // a Start document (copied into the package) and output storage ON: the A2A orchestrator honours both
    startDocuments: [{ name: 'note.txt', path: 'start_documents/note.txt' }],
    outputStorageEnabled: true, outputFolder: null,
    agents: { 2: ag('D', 'Route the request.'), 3: ag('A', 'Handle it as A.'), 4: ag('B', 'Handle it as B.') },
    decisions: { 2: { decision_question: 'Which agent handles this?', routing_mode: 'jev', unclear_branch: '',
      min_confidence: 0.6, decision: [{ provider: 'jev', protocol: 'typesafe', url: ctx.url + '/systemone',
        model: 'jev-latest', key_env: 'JEV_API_KEY', url_env: 'JEV_BASE_URL' }] } },
  });
}

/** Start -> playbook PB (deepseek "fake-pb", one #Request Approval) -> Output, as an in-memory workflow. */
function playbookFixture(): any {
  const pb = 'Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. Say hello.\n2. #Request Approval from the manager then finish.\n\nActions used: #Request Approval\n';
  return {
    workflow: { id: 74, name: 'Playbook e2e', user_id: 3, orchestration: 'workflow' },
    user_id: null,
    graph: {
      nodes: [
        { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
        { id: '2', node_type: 'playbook', config: { type: 'playbook', name: 'PB', playbook: pb, agent_provider: 'deepseek', model: 'fake-pb', writes_enabled: true } },
        { id: '3', node_type: 'output', config: { type: 'output' } },
      ],
      edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
    },
  };
}

/** Registers the E2E scenarios for one compile target. */
export function defineCompiledE2E(cfg: CompiledE2EConfig): void {
  const skipReason = (): string => {
    if (process.env[cfg.flag] !== '1') return `Set ${cfg.flag}=1 to run.`;
    if (!existsSync(E2E_PY)) return 'venv python missing';
    return '';
  };

  /** A scenario: skipped as setUp() skips, its processes stopped as tearDown() stops them. */
  const scenario = (name: string, body: (ctx: Ctx) => Promise<void>): void => {
    test(name, { timeout: 600000 }, async (t) => {
      const why = skipReason();
      if (why) return t.skip(why);
      const ctx = new Ctx();
      try {
        await body(ctx);
      } finally {
        ctx.close();
      }
    });
  };

  const run_ = (a: any): [number, string] => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adk_e2e_'));
    writeFileSync(path.join(dir, 'workflow.py'), cfg.emit(a));
    writeFileSync(path.join(dir, '.env'), 'MCP_HEADERS_OUTLOOK={"X-Outlook-Account":"acc-1"}\n');
    return runIn(dir, ['workflow.py', 'go'], {}, `${cfg.label} E2E output`);
  };

  const runJev = (a: any): [number, string] => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adk_jev_'));
    writeFileSync(path.join(dir, 'workflow.py'), cfg.emit(a));
    writeFileSync(path.join(dir, '.env'), 'MCP_HEADERS_OUTLOOK={"X-Outlook-Account":"acc-1"}\nJEV_API_KEY=jev-test-key\n');
    return runIn(dir, ['workflow.py', 'go'], {}, `${cfg.label} Jev output`);
  };

  /** The E2E graph as a listening package (watch on outlook.wait_for_new), written to a folder; returns the folder. */
  const writeListeningPackage = async (ctx: Ctx, aIn: any = null, startMode = 'watch'): Promise<string> => {
    let a = aIn;
    if (a === null) {
      // the branch takes 3 s, as a real one (an LLM, a mail move) does: /live sends a run it sees in
      // progress; one already over at its first look is history (LiveFeed's rule)
      a = analyzed(ctx, 'import time\n' + FILE + '\n# slow\n');
      a['code']['3']['source'] = String(a['code']['3']['source']).split('def run(input, call_tool):\n').join('def run(input, call_tool):\n    time.sleep(3)\n');
    }
    a['startMode'] = startMode;
    a['defaultWatch'] = { server: 'outlook', tool: 'wait_for_new', args: [] };
    a['package'] = true;
    const [workflowPy, commonPy, nodeFiles] = cfg.packageSources(a) as [string, string, any[]];
    const pkg = RunServerEmitter.package({ code: workflowPy }, 'adk e2e', 'e2e', 'run server', commonPy, true);
    const dir = mkdtempSync(path.join(tmpdir(), 'adk_listen_'));
    writeFiles(dir, [...pkg.files, ...nodeFiles, ...(await cfg.packageFiles(a))]);
    writeFileSync(path.join(dir, '.env'), 'MCP_HEADERS_OUTLOOK={"X-Outlook-Account":"acc-1"}\nJEV_API_KEY=jev-test-key\n');
    return dir;
  };

  const moves = (ctx: Ctx) => calls(ctx).filter((c) => (c.tool ?? '') === 'move_mail');

  scenario('testRoutesFilesAndSendsHeaders', async (ctx) => {
    await startServer(ctx);
    const [rc, text] = run_(analyzed(ctx, FILE));
    assert.equal(rc, 0, text);
    assert.ok(text.includes('filed test 50'), text);
    const m = moves(ctx);
    assert.equal(m.length, 1);
    assert.equal(m[0].args.folder, 'Inbox/B');
    for (const c of calls(ctx)) {
      assert.equal(c.headers?.['x-outlook-account'] ?? null, 'acc-1', JSON.stringify(c));
    }
  });

  /** A node's arguments (a component's settings, a Start option's Start args) reach its code as ARGS. */
  scenario('testTheCodeReadsItsArguments', async (ctx) => {
    await startServer(ctx);
    const a = analyzed(ctx, "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n");
    a['code']['3']['args'] = oarr([['folder', 'Didier']]);
    const [rc, text] = run_(a);
    assert.equal(rc, 0, text);
    assert.ok(text.includes('folder=Didier'), text);
  });

  /**
   * The Output takes a node once, and only through the exit it took: Convert(2) took done -> Store(5); its
   * error link to the Output carries nothing, and Store's two exits to the same Output give one answer.
   */
  scenario('testTheOutputTakesANodeOnceAndOnlyThroughTheExitItTook', async () => {
    const code = (name: string, text: string) => ({ type: 'code', name, exits: ['done', 'error'],
      mcp_servers: [], timeout_s: 30, code: `def run(input, call_tool):\n    return {'route': 'done', 'output': '${text}'}\n` });
    const graph = { nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'go' } },
      { id: '2', type: 'code', config: code('Convert', 'PACKAGE') },
      { id: '5', type: 'code', config: code('Store', 'STORED') },
      { id: '3', type: 'output', config: { type: 'output' } },
    ], edges: [
      { from: '1', to: '2', from_port: 'output_1' },
      { from: '2', to: '5', from_port: 'output_1' },
      { from: '2', to: '3', from_port: 'output_2' },
      { from: '5', to: '3', from_port: 'output_1' },
      { from: '5', to: '3', from_port: 'output_2' },
    ] };
    const a = withCode(analyzedOf(graph, {
      workflow: { id: 99, name: 'adk e2e' }, usedCatalog: [], usedServers: [],
      serverSlugs: [], startPrompt: 'go', startDocuments: [], agents: [], playbooks: [],
    }), graph, ['2', '5'], {}, ['1', '2', '5', '3']);
    const [rc, text] = run_(a);
    assert.equal(rc, 0, text);
    assert.ok(text.includes('STORED'), text);
    assert.ok(!finalAnswer(text).includes('PACKAGE'), text);
    assert.equal(finalAnswer(text).split('STORED').length - 1, 1, text);
  });

  scenario('testNoMailSkipsEverythingDownstream', async (ctx) => {
    await startServer(ctx, true);
    const [rc, text] = run_(analyzed(ctx, FILE));
    assert.equal(rc, 0, text);
    assert.ok(text.includes('skipped (its branch was not taken)'), text);
    // nothing to do: the answer is the Output's, empty -- not the trigger's text (review I1)
    assert.match(text, /\[workflow\] done in [0-9.]+s, 0 chars|Final output: 0 chars/);
    assert.deepEqual(moves(ctx), []);
  });

  scenario('testFailingCodeStopsTheRun', async (ctx) => {
    await startServer(ctx);
    const [rc, text] = run_(analyzed(ctx, "def run(input, call_tool):\n    return call_tool('other', 'x', {})\n"));
    assert.notEqual(rc, 0, text);
    assert.ok(text.includes("code node 'B' failed"), text);
  });

  scenario('testPackageListensRecordsAndStops', async (ctx) => {
    await startServer(ctx);
    const dir = await writeListeningPackage(ctx);
    const base = await startApi(ctx, dir);
    // the canvas connects to /live first, then the runs come (a new connection streams runs from then on)
    const liveOut = openSync(path.join(dir, 'live.txt'), 'w');
    const liveProc = spawn('curl', ['-s', '-N', '-m', '20', `${base}/live`], { stdio: ['ignore', liveOut, 'ignore'] });
    const liveDone = new Promise((r) => liveProc.once('exit', r));
    await sleep(500);
    let [code, r] = await post(`${base}/listen`, {});
    assert.equal(code, 200, JSON.stringify(r));
    assert.equal(r.listening, true);
    let events: any[] = [];
    for (let i = 0; i < 150; i++) {
      events = runEvents(dir);
      if (events.some((e) => e.type === 'workflow_complete')) break;
      await sleep(200);
    }
    const done = events.filter((e) => e.type === 'workflow_complete');
    assert.ok(done.length > 0, 'no completed run:\n' + readFileSync(path.join(dir, 'api.log'), 'utf8'));
    assert.equal(done[0].success, true, JSON.stringify(done[0]));
    // the drain runs again at once; that quiet run's file exists while it runs, then goes
    for (let i = 0; i < 50 && runFiles(dir).length !== 1; i++) await sleep(200);
    events = runEvents(dir);   // the real run's events only
    const completed = new Map<string, any>();
    for (const e of events) {
      if (e.type === 'node_complete') completed.set(String(e.node_id), e);
    }
    assert.deepEqual([...completed.keys()], ['1', '10', '3', '5']);
    assert.equal(completed.get('10').exit, 'new_mail');
    assert.equal(completed.get('1').node_type, 'start');
    for (let i = 0; i < 50 && runFiles(dir).length !== 1; i++) await sleep(200);
    assert.equal(runFiles(dir).length, 1, "the drain's second, quiet run leaves no file");
    assert.equal(moves(ctx).length, 1);
    // GET /live streams the run to the canvas
    await liveDone;   // curl ends at -m 20
    const stream = readFileSync(path.join(dir, 'live.txt'), 'utf8');
    assert.match(stream, /event: run\ndata: .*"node_id":\s*"10"/);
    assert.match(stream, /"type":\s*"workflow_complete"/);
    // a served run is refused while listening
    [code] = await post(`${base}/runs`, { prompt: 'x' });
    assert.equal(code, 409);
    // stop: the state line says so once the wait in flight returns
    await post(`${base}/listen`, { stop: true });
    let state = '';
    for (let i = 0; i < 10 && !state.includes('Not listening: stopped'); i++) {
      await sleep(1000);
      state = live(base, 2);
    }
    assert.ok(state.includes('Not listening: stopped'), state);
  });

  scenario('testQuietWakeLeavesNoRun', async (ctx) => {
    await startServer(ctx, true);
    const dir = await writeListeningPackage(ctx);
    const base = await startApi(ctx, dir);
    await post(`${base}/listen`, {});
    for (let i = 0; i < 50 && calls(ctx).filter((c) => (c.tool ?? '') === 'next_mail').length < 1; i++) await sleep(200);
    await sleep(2000);   // the run after the wake has ended
    assert.deepEqual(runFiles(dir), [], 'a quiet run leaves no run file');
    assert.match(live(base, 2), /"listening":\s*true/);
  });

  scenario('testJevRoutesWithoutAnLlmTurn', async (ctx) => {
    await startServer(ctx, false, 'claim');
    const [rc, text] = runJev(jevAnalyzed(ctx));
    assert.equal(rc, 0, text);
    assert.ok(text.includes("jev routed to 'B' (confidence 0.97"), text);
    const jev = calls(ctx).filter((c) => (c.method ?? '') === 'jev');
    assert.equal(jev.length, 1);
    assert.equal(jev[0].headers.authorization, 'Bearer jev-test-key');
    assert.deepEqual(jev[0].criteria, ['A', 'B', 'unclear']);
    assert.ok(String(jev[0].request).includes('my car claim'));   // the trigger's email, not a prompt
    const m = moves(ctx);
    assert.equal(m[0]?.args?.folder ?? null, 'Inbox/B');
    assert.equal(m.length, 1);
  });

  scenario('testUnclearStopsAsNotClassified', async (ctx) => {
    await startServer(ctx);   // "test 50": no "claim" -> the fake Jev answers unclear
    const [rc, text] = runJev(jevAnalyzed(ctx));
    assert.equal(rc, 0, text);
    assert.ok(text.includes('Not classified: dispatcher "D" did not route the request (jev: unclear'), text);
    assert.deepEqual(moves(ctx), []);
  });

  scenario('testUnclearGoesToTheUnclearBranch', async (ctx) => {
    await startServer(ctx);
    const [rc, text] = runJev(jevAnalyzed(ctx, 'A'));
    assert.equal(rc, 0, text);
    assert.ok(text.includes("sent to the unclear branch 'A'"), text);
    assert.equal(moves(ctx)[0]?.args?.folder ?? null, 'Inbox/A');
  });

  /** Review I1: a dispatcher that does not route is work, not a quiet poll -- the run is recorded and answers why. */
  scenario('testListeningNotClassifiedIsRecorded', async (ctx) => {
    await startServer(ctx);   // "test 50": the fake Jev answers unclear
    const dir = await writeListeningPackage(ctx, jevAnalyzed(ctx));
    const base = await startApi(ctx, dir);
    await post(`${base}/listen`, {});
    const ev = await completedRun(dir);
    const done = ev.filter((e) => e.type === 'workflow_complete')[0];
    assert.equal(done.success, true);
    assert.ok(String(done.output).includes('Not classified: dispatcher "D"'));
    const d = ev.filter((e) => e.type === 'node_complete' && String(e.node_id) === '2');
    assert.equal(d[0].success, true);
  });

  /** Review I1: a decision model that cannot answer (no usable provider) is an error the canvas shows. */
  scenario('testListeningJevErrorIsRecorded', async (ctx) => {
    await startServer(ctx, false, 'claim');
    const a = jevAnalyzed(ctx);
    a['decisions']['2']['decision'] = [];   // routing names jev, but no jev provider was compiled in: unavailable
    const dir = await writeListeningPackage(ctx, a);
    const base = await startApi(ctx, dir);
    await post(`${base}/listen`, {});
    const ev = await completedRun(dir);
    const d = ev.filter((e) => e.type === 'node_complete' && String(e.node_id) === '2');
    assert.equal(d[0].success, false);
    assert.ok(String(d[0].error).includes('Error: dispatcher "D" did not route the request (jev: unavailable'));
    const done = ev.filter((e) => e.type === 'workflow_complete')[0];
    assert.ok(String(done.output).includes('Error: dispatcher "D"'));
  });

  /** Review I2: a node runs when one parent reached it, even if another parent's exit went elsewhere. */
  scenario('testOtherParentStillReachesTheNode', async (ctx) => {
    await startServer(ctx);
    const code = (id: string, name: string, src: string, exits: string[]) => ({ id, type: 'code',
      config: { type: 'code', name, code: src, exits, mcp_servers: [], timeout_s: 30 } });
    const graph = { nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'go' } },
      code('10', 'T', "def run(input, call_tool):\n    return {'route': 'a', 'output': 'from T'}\n", ['a', 'b']),
      code('11', 'U', "def run(input, call_tool):\n    return 'from U'\n", ['next']),
      code('12', 'X', "def run(input, call_tool):\n    return 'X ran'\n", ['next']),
      { id: '5', type: 'output', config: { type: 'output' } },
    ], edges: [
      { from: '1', to: '10', from_port: 'output_1' }, { from: '1', to: '11', from_port: 'output_1' },
      { from: '10', to: '12', from_port: 'output_2' }, { from: '11', to: '12', from_port: 'output_1' },
      { from: '12', to: '5', from_port: 'output_1' },
    ] };
    const a = withCode(analyzedOf(graph, {
      workflow: { id: 97, name: 'two parents' }, usedCatalog: [], usedServers: [], serverSlugs: [],
      startPrompt: 'go', startDocuments: [], agents: [], playbooks: [],
    }), graph, ['10', '11', '12']);
    const [rc, text] = run_(a);
    assert.equal(rc, 0, text);
    assert.ok(text.includes('X ran'), text);
  });

  /** Review I3: the package's CLI prints the answer of a one-off run. */
  scenario('testPackageCliPrintsTheAnswer', async (ctx) => {
    await startServer(ctx);
    const dir = await writeListeningPackage(ctx, analyzed(ctx, FILE), 'prompt');
    const [rc, text] = runIn(dir, ['workflow.py', 'go']);
    assert.equal(rc, 0, text);
    assert.ok(text.includes('filed test 50'), text);
  });

  /** A2A: the orchestrator spawns one A2A agent server per node; Jev routes; only the chosen agent runs. */
  scenario('testA2ARoutesOverAgentServers', async (ctx) => {
    await startServer(ctx);
    const pkg = await cfg.a2aPackage(a2aAnalyzed(ctx));
    const dir = mkdtempSync(path.join(tmpdir(), 'adk_e2e_a2a_'));
    writeFiles(dir, pkg.files);
    writeFileSync(path.join(dir, '.env'), `JEV_API_KEY=jev-test-key\nDEEPSEEK_API_KEY=fake\nDEEPSEEK_BASE_URL=${ctx.url}/v1\n`);
    mkdirSync(path.join(dir, 'start_documents'), { recursive: true });
    writeFileSync(path.join(dir, 'start_documents/note.txt'), 'The policy number is PN-4242.');
    const [rc, text] = runIn(dir, ['orchestrator.py', 'my car claim'],
      { A2A_BASE_PORT: String(randomInt(21000, 29001)), SYNERGYAI_OUTPUT_ROOT: path.join(dir, 'out') }, 'A2A output');
    assert.equal(rc, 0, text);
    assert.ok(text.includes('answer from fake-b'), text);
    const llm = calls(ctx).filter((c) => (c.method ?? '') === 'llm');
    assert.deepEqual([...new Set(llm.map((c) => c.model))], ['fake-b'], JSON.stringify(llm));
    assert.ok(llm[0].messages.join(' ').includes('my car claim'));
    // Review I3: the Start's document reaches the nodes, and the answer is saved (output storage ON)
    assert.ok(llm[0].messages.join(' ').includes('PN-4242'));
    const outDir = path.join(dir, 'out', 'workflow');
    const saved = existsSync(outDir) ? readdirSync(outDir) : [];
    assert.equal(saved.length, 1, 'the answer is saved under SYNERGYAI_OUTPUT_ROOT');
    assert.ok(readFileSync(path.join(outDir, saved[0]), 'utf8').trim().startsWith('answer from fake-b'));
    const jev = calls(ctx).filter((c) => (c.method ?? '') === 'jev');
    assert.equal(jev.length, 1);
    assert.ok(String(jev[0].request).includes('my car claim'));
  });

  const writeTo = (ctx: Ctx, files: any[], prefix: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), `adk_e2e_${prefix}_`));
    writeFiles(dir, files);
    writeFileSync(path.join(dir, '.env'), `DEEPSEEK_API_KEY=fake\nDEEPSEEK_BASE_URL=${ctx.url}/v1\nPLAYBOOK_GATE_MODE=auto\n`);
    return dir;
  };

  const playbookCompile = async (mode: 'modular' | 'a2a'): Promise<any[]> => {
    const r = await compile(playbookFixture(), cfg.generatorClass, mode);
    assert.ok(r.ok, r.error);
    return r.result.files;
  };

  /** Review C1: a playbook's tool calls (its approval gate) run in a package -- the runtime lives in common.py there. */
  scenario('testPlaybookToolCallRunsInThePackage', async (ctx) => {
    await startServer(ctx);
    const dir = writeTo(ctx, await playbookCompile('modular'), 'pbmod');
    const [rc, text] = runIn(dir, ['workflow.py', 'go']);
    assert.equal(rc, 0, text);
    assert.ok(!text.includes('RecursionError'), text);
    assert.ok(text.includes('answer from fake-pb after tool'), text);
  });

  /** Review C1: the same over A2A (the gate goes to the orchestrator, answered by PLAYBOOK_GATE_MODE=auto). */
  scenario('testPlaybookToolCallRunsOverA2A', async (ctx) => {
    await startServer(ctx);
    const dir = writeTo(ctx, await playbookCompile('a2a'), 'pba2a');
    const [rc, text] = runIn(dir, ['orchestrator.py', 'go'], { A2A_BASE_PORT: String(randomInt(21000, 29001)), PLAYBOOK_GATE_MODE: 'auto' });
    assert.equal(rc, 0, text);
    assert.ok(!text.includes('RecursionError'), text);
    assert.ok(text.includes('answer from fake-pb after tool'), text);
  });
}
