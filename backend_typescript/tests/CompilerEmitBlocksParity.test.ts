/**
 * Differential test of the compiler's emit-block classes against backend/'s PHP: LangGraphRuntime,
 * PythonEmitHelpers, RunServerEmitter, PlaybookEmit, CodeNodeEmit and StartDocumentStore. Every public
 * static (and the private ones that shape output) runs on both sides with the same arguments and the
 * results must be byte-identical. PHP runs through tests/fixtures/compiler/emit_blocks_call.php, whose
 * tagged arguments keep the shapes JSON loses (floats like 1.0, stdClass).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIXTURES, fixturePath, maskStamps, phpBin, phpSkipReason } from './support/phpCompiler';
import {
  JSON_PRESERVE_ZERO_FRACTION, JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, PhpFloat, entries, isStd, jsonDecodePhp, json_encode, oarr, stdObj,
} from '../src/AgentTeam/compiler/php';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { PythonEmitHelpers } from '../src/AgentTeam/compiler/PythonEmitHelpers';
import { RunServerEmitter } from '../src/AgentTeam/compiler/RunServerEmitter';
import { PlaybookEmit } from '../src/AgentTeam/compiler/PlaybookEmit';
import { StartDocumentStore } from '../src/AgentTeam/compiler/StartDocumentStore';
import { CodeNodeEmit } from '../src/AgentTeam/CodeNodeEmit';

const SKIP = phpSkipReason();
const opt = { skip: SKIP || false };
const SCRIPT = path.join(FIXTURES, 'emit_blocks_call.php');

/** A TS value as emit_blocks_call.php's tagged JSON (PhpFloat -> {$float}, stdClass -> {$obj}). */
function tag(v: any): any {
  if (v instanceof PhpFloat) return oarr([['$float', v.v]]);
  if (Buffer.isBuffer(v) || v === null || typeof v !== 'object') return v;
  if (isStd(v)) return oarr([['$obj', oarr(entries(v).map(([k, x]) => [k, tag(x)] as [string, any]))]]);
  if (Array.isArray(v)) return v.map(tag);
  if (v.$facts !== undefined || v.$analyzed !== undefined) return v;
  return oarr(entries(v).map(([k, x]) => [k, tag(x)] as [string, any]));
}

function runPhp(args: string[], stdin?: string): any {
  const bin = phpBin();
  if (bin === null) throw new Error(SKIP);
  const r = spawnSync(bin, [SCRIPT, ...args], {
    input: stdin, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, XDEBUG_MODE: 'off', TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
  if (r.status !== 0) throw new Error(`emit_blocks_call.php exited ${r.status}: ${r.stderr}`);
  return jsonDecodePhp(r.stdout.trim().split('\n').pop() ?? '');
}

/** PHP's return value ({result, json}) or {error} when it threw. */
function php(cls: string, method: string, args: any[] = []): { result?: any; json?: string; error?: string } {
  const req = { class: cls, method, args: args.map((a) => tag(a)) };
  const r = runPhp(['call'], json_encode(req, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
  return r.ok ? { result: r.result, json: r.json } : { error: r.error };
}

function phpStr(cls: string, method: string, args: any[] = []): string {
  const r = php(cls, method, args);
  if (r.error !== undefined) throw new Error(`${cls}::${method} threw: ${r.error}`);
  return r.result;
}

function tsTry<T>(fn: () => T): { result?: T; error?: string } {
  try {
    return { result: fn() };
  } catch (e: any) {
    return { error: e.message };
  }
}

const enc = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);

/** Same answer (as json_encode text) or the same exception message on both sides. */
function sameValue(label: string, ts: () => any, cls: string, method: string, args: any[]): void {
  const p = php(cls, method, args);
  const t = tsTry(ts);
  if (p.error !== undefined || t.error !== undefined) {
    assert.equal(t.error, p.error, `${label}: exceptions differ`);
    return;
  }
  assert.equal(enc(t.result), p.json, label);
}

// ── LangGraphRuntime ─────────────────────────────────────────────────────────

test('LangGraphRuntime: nodeClassesBlock for every (withPlaybook, withCode)', opt, () => {
  for (const pb of [true, false]) for (const code of [true, false]) {
    assert.equal(LangGraphRuntime.nodeClassesBlock(pb, code), phpStr('LangGraphRuntime', 'nodeClassesBlock', [pb, code]), `${pb},${code}`);
  }
  assert.equal(LangGraphRuntime.nodeClassesBlock(true), phpStr('LangGraphRuntime', 'nodeClassesBlock', [true]));
});

test('LangGraphRuntime: dispatcherBlock / decisionAdaptersBlock for every protocol set', opt, () => {
  for (const ps of [[], ['typesafe'], ['openai'], ['typesafe', 'openai'], ['openai', 'typesafe']]) {
    assert.equal(LangGraphRuntime.dispatcherBlock(ps), phpStr('LangGraphRuntime', 'dispatcherBlock', [ps]), ps.join(','));
    assert.equal(LangGraphRuntime.decisionAdaptersBlock(ps), phpStr('LangGraphRuntime', 'decisionAdaptersBlock', [ps]), ps.join(','));
  }
  sameValue('unknown protocol', () => LangGraphRuntime.dispatcherBlock(['nope']), 'LangGraphRuntime', 'dispatcherBlock', [['nope']]);
  assert.deepEqual({ ...LangGraphRuntime.ADAPTER_CLASSES }, { typesafe: 'JevRouter', openai: 'OpenAIDecisionRouter' });
});

test('LangGraphRuntime: flagged blocks (codeHarness, output, skillRuntime)', opt, () => {
  for (const f of [true, false]) {
    assert.equal(LangGraphRuntime.codeHarnessBlock(f), phpStr('LangGraphRuntime', 'codeHarnessBlock', [f]), `codeHarness ${f}`);
    assert.equal(LangGraphRuntime.outputBlock(f), phpStr('LangGraphRuntime', 'outputBlock', [f]), `output ${f}`);
    assert.equal(LangGraphRuntime.skillRuntimeBlock(f), phpStr('LangGraphRuntime', 'skillRuntimeBlock', [f]), `skillRuntime ${f}`);
  }
  assert.equal(LangGraphRuntime.codeHarnessBlock(), phpStr('LangGraphRuntime', 'codeHarnessBlock'));
  assert.equal(LangGraphRuntime.outputBlock(), phpStr('LangGraphRuntime', 'outputBlock'));
  assert.equal(LangGraphRuntime.skillRuntimeBlock(), phpStr('LangGraphRuntime', 'skillRuntimeBlock'));
});

test('LangGraphRuntime: every argument-free block', opt, () => {
  const blocks = ['runRecordBlock', 'liveFeedBlock', 'consoleBlock', 'runContextBlock', 'workflowGraphBlock', 'cronBlock',
    'watchBlock', 'listenerBlock', 'llmFactoryBlock', 'documentConverterBlock', 'mcpClientBlock', 'toolCatalogBlock',
    'runEventsBlock', 'playbookBlock', 'decisionHead', 'dispatcherClasses'] as const;
  for (const b of blocks) {
    assert.equal((LangGraphRuntime as any)[b](), phpStr('LangGraphRuntime', b), b);
  }
  for (const p of ['typesafe', 'openai']) {
    assert.equal((LangGraphRuntime as any).adapterBlock(p), phpStr('LangGraphRuntime', 'adapterBlock', [p]), p);
  }
});

// ── PythonEmitHelpers ────────────────────────────────────────────────────────

const JSON_INPUTS: Array<[string, any]> = [
  ['scalars', oarr([['a', null], ['b', true], ['c', false], ['d', 0], ['e', -3], ['s', 'x: true']])],
  ['floats', oarr([['t', new PhpFloat(0.7)], ['one', new PhpFloat(1.0)], ['big', new PhpFloat(1e20)], ['small', new PhpFloat(1.5e-7)], ['neg', new PhpFloat(-2.25)]])],
  ['empty list', []],
  ['empty std', stdObj({})],
  ['nested empty', oarr([['list', []], ['obj', stdObj({})], ['deep', oarr([['x', [[], stdObj({})]]])]])],
  ['list', ['a', 1, new PhpFloat(2.0), null, true]],
  ['numeric keys out of order', oarr([['10', 'ten'], ['2', 'two'], ['abc', 'x']])],
  ['list-like keys', oarr([['0', 'a'], ['1', 'b']])],
  ['unicode', oarr([['é', 'café — ✓ 日本語 😀'], ['sep', 'a b c'], ['ctrl', 'tab\tnl\ncr\r\u0001'], ['slash', 'a/b\\c"d']])],
  ['std nested', oarr([['cfg', stdObj(oarr([['k', 'v'], ['n', new PhpFloat(3.0)]]))]])],
  ['string', 'just "a" string/with: null'],
  ['number', 42],
  ['float', new PhpFloat(0.1)],
  ['null', null],
];

test('PythonEmitHelpers: jsonToPython on varied inputs, with and without forceObject', opt, () => {
  for (const [label, v] of JSON_INPUTS) {
    for (const force of [false, true]) {
      assert.equal(PythonEmitHelpers.jsonToPython(v, force), phpStr('PythonEmitHelpers', 'jsonToPython', [v, force]), `${label} force=${force}`);
    }
  }
});

test('PythonEmitHelpers: pyStr', opt, () => {
  for (const s of ['', 'plain', 'line1\nquote"x', 'back\\slash\ttab\rcr', 'café ✓ 😀', ' ']) {
    assert.equal(PythonEmitHelpers.pyStr(s), phpStr('PythonEmitHelpers', 'pyStr', [s]), JSON.stringify(s));
  }
});

test('PythonEmitHelpers: the shared Python blocks', opt, () => {
  for (const b of ['mcpClientBlock', 'skillDepsBlock', 'skillFsSyncBlock', 'eventSinkBlock', 'documentConverterBlock']) {
    assert.equal((PythonEmitHelpers as any)[b](), phpStr('PythonEmitHelpers', b), b);
  }
});

test('PythonEmitHelpers: providerKeyEnv', opt, () => {
  for (const p of ['claude', 'Anthropic', 'OPENAI', 'gemini', 'google', 'grok', 'xai', 'kimi', 'moonshot', 'deepseek', 'glm', 'jev', '', 'toString']) {
    sameValue(p, () => PythonEmitHelpers.providerKeyEnv(p), 'PythonEmitHelpers', 'providerKeyEnv', [p]);
  }
});

const DOC_NODES: any[] = [
  { id: '1', type: 'start', name: 'Start', prompt: 'Summarise the latest news about renewable energy in Europe and the policy changes that came with it.', provider: '', model: '', tools: [], skills: [], dispatch: [], parents: [], children: ['Triage (2)'], playbook: null, supported: true },
  { id: '2', type: 'agent', name: 'Triage', provider: 'claude', model: 'claude-sonnet-4-5', temperature: new PhpFloat(0.7), max_tokens: 4096, thinking: 'on', tools: ['news.get_news'], skills: ['docx'], dispatch: ['Writer (3)', 'Playbook HR (5)'], parents: ['Start (1)'], children: ['Writer (3)', 'Playbook HR (5)'], playbook: null, supported: true, marker: '<- entry' },
  { id: '3', type: 'agent', name: 'Writer', provider: 'OpenAI', model: '', temperature: new PhpFloat(1.0), max_tokens: null, thinking: 'default', tools: [], skills: [], dispatch: [], parents: ['Triage (2)'], children: ['Output (6)'], playbook: null, supported: true },
  { id: '5', type: 'playbook', name: 'Playbook HR', provider: 'deepseek', model: 'deepseek-flash', temperature: new PhpFloat(0.2), max_tokens: 2048, thinking: null, tools: [], skills: [], dispatch: [], parents: ['Triage (2)'], children: ['Output (6)'], playbook: { title: 'Time Off — “PTO”', writes: true, bound: 1, unbound: 2 }, supported: true },
  { id: '7', type: 'code', name: 'Poll 日本', provider: '', model: '', tools: [], skills: [], dispatch: [], parents: [], children: [], playbook: null, supported: false },
  { id: '8', type: 'agent', name: 'Kimi', provider: 'kimi', model: 'k2', thinking: 'off', tools: [], skills: [], dispatch: [], parents: [], children: [], playbook: { title: 'No bound', writes: false, bound: null }, supported: false },
  { id: '6', type: 'output', name: 'Output', provider: '', model: '', tools: [], skills: [], dispatch: [], parents: ['Writer (3)', 'Playbook HR (5)'], children: [], playbook: null, supported: true },
];

test('PythonEmitHelpers: nodeSummary and nodeCommentBlock on varied node descriptors', opt, () => {
  for (const n of DOC_NODES) {
    for (const ds of [true, false]) {
      const nn = { ...n, dispatch_supported: ds };
      assert.equal((PythonEmitHelpers as any).nodeSummary(nn), phpStr('PythonEmitHelpers', 'nodeSummary', [nn]), `summary ${n.id} ${ds}`);
    }
    for (const indent of ['', '    ']) {
      assert.equal(PythonEmitHelpers.nodeCommentBlock(n, indent), phpStr('PythonEmitHelpers', 'nodeCommentBlock', [n, indent]), `comment ${n.id}`);
    }
  }
  const cjk = { ...DOC_NODES[0], prompt: '日本語のテキスト'.repeat(10) };
  assert.equal((PythonEmitHelpers as any).nodeSummary(cjk), phpStr('PythonEmitHelpers', 'nodeSummary', [cjk]), 'cjk prompt');
  const emoji = { ...DOC_NODES[0], prompt: '😀 short' };
  assert.equal((PythonEmitHelpers as any).nodeSummary(emoji), phpStr('PythonEmitHelpers', 'nodeSummary', [emoji]), 'emoji prompt');
  const exact = { ...DOC_NODES[0], prompt: 'x'.repeat(70) };
  assert.equal((PythonEmitHelpers as any).nodeSummary(exact), phpStr('PythonEmitHelpers', 'nodeSummary', [exact]), 'exactly 70');
});

function docOf(extra: Record<string, any>): any {
  return {
    target: 'LangGraph (Python)', workflow: { id: 44, name: 'Dispatcher demo — “é”' }, nodes: DOC_NODES,
    edges: [['1', '2'], ['2', '3'], ['2', '5'], [3, 6], ['5', '6'], ['9', '6']],
    layers: [['1'], ['2'], ['3', '5'], [6], '7'],
    data_flow: 'Start -> Triage -> one of Writer | Playbook\n  each node gets its parents\' text\n\n',
    run: { deps: ['pip install langgraph', 'pip install httpx'], usage: 'python workflow.py "hi"', extra: ['# extra line'], env_path: '.env' },
    storage: { enabled: true, folder: '' },
    generated_at: '2026-10-25 10:00:00 UTC',
    ...extra,
  };
}

test('PythonEmitHelpers: workflowDocBlock on varied docs', opt, () => {
  const docs: Array<[string, any]> = [
    ['full, dispatch honoured', docOf({ dispatch_supported: true })],
    ['dispatch not honoured', docOf({})],
    ['no edges, no run, storage off', docOf({ edges: [], run: {}, storage: { enabled: false }, layers: [] })],
    ['storage folder', docOf({ storage: { enabled: true, folder: '/tmp/out' } })],
    ['storage default', docOf({ storage: { enabled: 1, default: '<program folder>/outputs/workflow/' } })],
    ['scalar deps/extra', docOf({ run: { deps: 'pip install one', extra: 'only', usage: null } })],
    ['no providers', docOf({ nodes: [DOC_NODES[0], DOC_NODES[6]], edges: [['1', '6']], layers: [['1'], ['6']] })],
    ['int ids', docOf({ nodes: DOC_NODES.map((n) => ({ ...n, id: Number(n.id) })), dispatch_supported: true })],
  ];
  for (const [label, d] of docs) {
    assert.equal(PythonEmitHelpers.workflowDocBlock(d), phpStr('PythonEmitHelpers', 'workflowDocBlock', [d]), label);
  }
  // No generated_at: the stamp is date('Y-m-d H:i:s T') on both sides (masked: the seconds may tick).
  const d = docOf({});
  delete d.generated_at;
  const ts = PythonEmitHelpers.workflowDocBlock(d);
  const ph = phpStr('PythonEmitHelpers', 'workflowDocBlock', [d]);
  assert.equal(maskStamps(ts), maskStamps(ph));
  const stamp = (s: string) => /Generated: {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (\S+)/.exec(s)?.[1];
  assert.equal(stamp(ts), stamp(ph), 'time zone abbreviation');
});

// ── RunServerEmitter ─────────────────────────────────────────────────────────

test('RunServerEmitter: emit / runtimeBlock / listenBlock / commonBlock', opt, () => {
  const cases: Array<[string, string, string, string]> = [
    ['Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"'],
    ['Dispatcher demo — “é” /x', 'line one\n  line "two"\n\nlast\n', 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME', 'WORKFLOW_VERSION = "44-20261025"'],
    ['', '', '', ''],
  ];
  for (const [n, doc, imp, ver] of cases) {
    for (const listen of [false, true]) {
      assert.equal(RunServerEmitter.emit(n, doc, imp, ver, listen), phpStr('RunServerEmitter', 'emit', [n, doc, imp, ver, listen]), `${n} ${listen}`);
    }
    assert.equal(RunServerEmitter.emit(n, doc, imp, ver), phpStr('RunServerEmitter', 'emit', [n, doc, imp, ver]), n);
  }
  for (const b of ['runtimeBlock', 'listenBlock', 'commonBlock']) {
    assert.equal((RunServerEmitter as any)[b](), phpStr('RunServerEmitter', b), b);
  }
  const rt = RunServerEmitter.runtimeBlock();
  assert.equal((RunServerEmitter as any).withListen(rt), phpStr('RunServerEmitter', 'withListen', [rt]));
  sameValue('withListen without anchors', () => (RunServerEmitter as any).withListen('x'), 'RunServerEmitter', 'withListen', ['x']);
});

test('RunServerEmitter: package with representative arguments', opt, () => {
  const cases: any[][] = [
    [{ code: '# workflow' }, 'Dispatcher demo', 'adk', 'adk run server'],
    [{ code: '# w' }, 'Café — Ünïcode / 日本 v2.0!', 'maf', 'maf run server', null, false],
    [{}, '__Weird__Name__', 'nooa', 'nooa line', '# my common\n', true],
    [{ code: 7 }, '', 'adk', 'x', null, true],
  ];
  for (const c of cases) {
    sameValue(String(c[1]), () => (RunServerEmitter.package as any)(...c), 'RunServerEmitter', 'package', c);
  }
});

// ── PlaybookEmit ─────────────────────────────────────────────────────────────

const AVAILABLE = oarr<any>([
  ['workday.get_pto_balance', { server_url: 'http://localhost/mockstack/index.php/workday', tool: 'get_pto_balance', description: 'Get balances', input_schema: oarr([['type', 'object'], ['properties', oarr([['email', oarr([['type', 'string']])]])]]) }],
  ['news.get_news', { server_url: 'http://localhost/news/', tool: 'get_news', description: 'News', input_schema: stdObj({}) }],
  ['okta.lookup_users', { server_url: 'http://okta/', tool: 'lookup_users', description: 'Users', input_schema: [] }],
]);
const DEFAULTS = oarr([['claude', 'claude-sonnet-4-5'], ['deepseek', 'deepseek-chat'], ['openai', 'gpt-5']]);

function demoPlaybookNode(): any {
  const fx = JSON.parse(require('node:fs').readFileSync(fixturePath('dispatcher_demo'), 'utf8'));
  return fx.graph.nodes.find((n: any) => n.id === '5');
}

const PB_JSON = {
  title: 'Reset password', domain: 'IT', instructions: '1. #Lookup Users (Okta) for the requester.\n2. #Reset Password then #Send Email.\n3. #Escalate To Agent',
  actions_used: ['#Lookup Users (Okta)', '#Reset Password', '#Send Email', '#Escalate To Agent'],
  bindings: { '#Reset Password': null, '#Escalate To Agent': 'agent.helper' },
  policy: { writes_enabled: false, on_unbound: 'skip' }, approvers: ['manager', 'it-lead'],
};

test('PlaybookEmit: nodeData on the dispatcher_demo playbook node and other playbooks', opt, () => {
  const demo = demoPlaybookNode();
  const cases: Array<[string, any]> = [
    ['dispatcher_demo node 5', demo],
    ['writes off, settings', { ...demo, config: { ...demo.config, writes_enabled: false, settings: { temperature: 1, max_tokens: '2048', thinking: 'on' } } }],
    ['no provider, no model', { id: 12, config: { playbook: demo.config.playbook } }],
    ['provider casing + llm_provider', { drawflow_node_id: '13', config: { playbook: demo.config.playbook, llm_provider: 'OpenAI', settings: { temperature: '0.25', thinking: 'maybe' } } }],
    ['JSON playbook (agent binding error)', { id: '14', config: { name: 'IT', playbook: PB_JSON } }],
    ['JSON playbook bound', { id: '15', config: { name: 'IT', playbook: { ...PB_JSON, bindings: { '#Reset Password': null } } } }],
    ['console text unbound', { id: '16', config: { agent_name: 'Agent', playbook: 'Title: X\nInstructions: Do #Something Odd then #Send Email.\nActions used: #Something Odd; #Send Email' } }],
    ['missing playbook', { id: '17', config: { name: 'Gone', playbook_missing: true, playbook_id: 9 } }],
    ['no text', { id: '18', config: { playbook: '   ' } }],
    ['invalid text', { id: '19', config: { playbook: 'nothing here' } }],
    ['no config', { _id: '20' }],
  ];
  for (const [label, node] of cases) {
    for (const uid of ['3', null]) {
      sameValue(label, () => PlaybookEmit.nodeData(node, AVAILABLE, DEFAULTS, uid), 'PlaybookEmit', 'nodeData', [node, AVAILABLE, DEFAULTS, uid]);
    }
  }
});

test('PlaybookEmit: inputNodeData, modelSettings, refuseLangGraphOnly', opt, () => {
  const nodes: any[] = [
    { id: '5', config: { playbook_source: 'input', name: 'From input', writes_enabled: 1, playbook_input_field: 'pb' } },
    { id: '6', config: { playbook_source: 'input', playbook_input_field: '' } },
    { id: '7', config: { playbook_source: 'fixed', exits: ['done', 'failed'], agent_provider: 'Gemini', model: 'g', settings: { temperature: 0, max_tokens: 1.9 } } },
    { id: '8', config: { exits: ['done', 'failed'] } },
    { id: '9', config: { exits: 'failed' } },
    { id: '10' },
  ];
  const edges = [
    { from: '7', to: '11', from_port: 'output_1' }, { from: '7', to: '12', from_port: 'output_3' },
    { from: '8', to: '13', from_port: 'output_2' },
  ];
  for (const n of nodes) {
    sameValue(`input ${n.id}`, () => PlaybookEmit.inputNodeData(n, DEFAULTS, '4'), 'PlaybookEmit', 'inputNodeData', [n, DEFAULTS, '4']);
    sameValue(`settings ${n.id}`, () => (PlaybookEmit as any).modelSettings(n.config ?? [], DEFAULTS), 'PlaybookEmit', 'modelSettings', [n.config ?? [], DEFAULTS]);
    sameValue(`refuse ${n.id}`, () => PlaybookEmit.refuseLangGraphOnly(n, edges), 'PlaybookEmit', 'refuseLangGraphOnly', [n, edges]);
  }
});

function phpAnalyzed(fixture: string): any {
  return runPhp(['analyzed', fixturePath(fixture)]);
}

test('PlaybookEmit: docNodes and extraDeps over the dispatcher_demo analysis', opt, () => {
  const analyzed = phpAnalyzed('dispatcher_demo');
  const demo = demoPlaybookNode();
  sameValue('no playbooks', () => PlaybookEmit.docNodes(analyzed), 'PlaybookEmit', 'docNodes', [analyzed]);
  sameValue('extraDeps none', () => PlaybookEmit.extraDeps(analyzed), 'PlaybookEmit', 'extraDeps', [analyzed]);
  const pd = PlaybookEmit.nodeData(demo, AVAILABLE, DEFAULTS, '3');
  const withPb = oarr(entries(analyzed));
  withPb['playbooks'] = oarr([['5', pd]]);
  sameValue('with playbook', () => PlaybookEmit.docNodes(withPb), 'PlaybookEmit', 'docNodes', [withPb]);
  const many = oarr(entries(analyzed));
  many['playbooks'] = oarr([
    ['5', pd], ['10', { ...pd, provider: 'anthropic' }], ['2', { ...pd, provider: 'Google' }], ['7', { ...pd, provider: 'kimi' }],
    ['8', { ...pd, provider: undefined }],
  ]);
  sameValue('extraDeps many', () => PlaybookEmit.extraDeps(many), 'PlaybookEmit', 'extraDeps', [many]);
  sameValue('extraDeps one', () => PlaybookEmit.extraDeps(withPb), 'PlaybookEmit', 'extraDeps', [withPb]);
});

/** supportBlock() embeds LangGraphGenerator.llmFactoryLines(): '' when that module loads, else why not. */
function generatorUnloadable(): string {
  try {
    require('../src/AgentTeam/LangGraphGenerator');
    return '';
  } catch (e: any) {
    return 'LangGraphGenerator does not load yet: ' + String(e.message).split('\n')[0];
  }
}

test('PlaybookEmit: supportBlock (embeds LangGraphGenerator.llmFactoryLines)', { skip: SKIP || generatorUnloadable() || false }, () => {
  for (const f of [true, false]) {
    assert.equal(PlaybookEmit.supportBlock(f), phpStr('PlaybookEmit', 'supportBlock', [f]), `supportBlock ${f}`);
  }
});

test('PlaybookEmit: metadataBlock, runtimeBlock', opt, () => {
  assert.equal(PlaybookEmit.runtimeBlock(), phpStr('PlaybookEmit', 'runtimeBlock'));
  const demo = demoPlaybookNode();
  const pd = PlaybookEmit.nodeData(demo, AVAILABLE, DEFAULTS, '3');
  const pd1 = PlaybookEmit.nodeData({ ...demo, config: { ...demo.config, settings: { temperature: 1, max_tokens: 100 } } }, AVAILABLE, DEFAULTS, null);
  for (const pbs of [oarr([['5', pd], ['12', PlaybookEmit.inputNodeData({ id: '12', config: {} }, DEFAULTS, null)], ['3', pd1]]), [], oarr()]) {
    assert.equal(PlaybookEmit.metadataBlock(pbs), phpStr('PlaybookEmit', 'metadataBlock', [pbs]));
  }
});

// ── CodeNodeEmit ─────────────────────────────────────────────────────────────

test('CodeNodeEmit: nodeData / exitTargets with numeric-looking ids out of numeric order', opt, () => {
  const node = (cfg: Record<string, any>) => ({
    id: '10', node_type: 'code',
    config: { type: 'code', name: 'Poll', code: 'def run(i, c):\n    return i', exits: ['job', 'no_job', 'error'], mcp_servers: ['ServiceNow', 'Outlook Mail', 'servicenow'], timeout_s: 20, ...cfg },
  });
  const edges = [
    { from: '10', to: '9', from_port: 'output_1' }, { from: '10', to: '2', from_port: 'output_2' },
    { from: 10, to: 11, from_port: 'output_1' }, { from_node_id: '10', to_node_id: '3', from_port: 'output_3' },
    { source: '10', target: '100', from_port: 'output_9' }, { from: '10', to: '', from_port: 'output_1' },
    { from: '10', to: '12', from_port: 'output_1e0' }, { from: '10', to: '13' }, { from: '1', to: '10' },
  ];
  const slugToUrl = oarr([['servicenow', 'http://localhost/servicenow/'], ['outlook_mail', 'http://localhost/outlook/'], ['123', 'http://n/']]);
  const cases: Array<[string, any, any]> = [
    ['all edges', node({}), null],
    ['known ids (out of numeric order)', node({}), ['10', '9', '2', '11', '3', '12', '13']],
    ['int known ids', node({}), [10, 9, 2, 3]],
    ['numeric slug', node({ mcp_servers: ['123'] }), null],
    ['args', node({ args: { b: 1, a: [1, 2], '5': 'five', '1': 'one' } }), null],
    ['data instead of config', { id: '10', data: { exits: ['a'], code: 'x', name: '  ' } }, null],
    ['display 0', { id: '10', config: { name: '0' } }, null],
    ['component missing', { id: '10', config: { name: 'C', code_component_missing: true, code_component_id: 7 } }, null],
    ['bad exits', node({ exits: ['Bad'] }), null],
    ['dup exits', node({ exits: ['a', 'a'] }), null],
    ['too many exits', node({ exits: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), null],
    ['empty exits', node({ exits: [] }), null],
    ['non-string exit', node({ exits: ['a', 5] }), null],
    ['unknown server', node({ mcp_servers: ['Okta/é'] }), null],
    ['server not a string', node({ mcp_servers: [5] }), null],
    ['servers not a list', node({ mcp_servers: 'ServiceNow' }), null],
    ['timeout 0', node({ timeout_s: 0 }), null],
    ['timeout string', node({ timeout_s: '20' }), null],
    ['timeout float', node({ timeout_s: new PhpFloat(20.0) }), null],
  ];
  for (const [label, n, ids] of cases) {
    sameValue(label, () => CodeNodeEmit.nodeData(n, edges, slugToUrl, ids), 'CodeNodeEmit', 'nodeData', [n, edges, slugToUrl, ids]);
  }
  for (const exits of [['job', 'no_job', 'error'], ['2', '1'], ['x', 'x'], []]) {
    for (const ids of [null, ['9', '2', '3'], []]) {
      sameValue(`exitTargets ${exits}`, () => CodeNodeEmit.exitTargets('10', exits, edges, ids), 'CodeNodeEmit', 'exitTargets', ['10', exits, edges, ids]);
    }
  }
  for (const s of ['Service Now (prod)', 'Outlook Mail', 'café', '日本 x', '', '123', 'A-B_c']) {
    sameValue(`slug ${s}`, () => CodeNodeEmit.slug(s), 'CodeNodeEmit', 'slug', [s]);
  }
  const graphs: any[] = [
    { nodes: [{ id: '5', node_type: '', config: { type: 'code' } }] }, { nodes: [{ id: '5', type: 'agent' }] }, {},
    { nodes: [{ id: '5', node_type: 'code' }] },
  ];
  for (const g of graphs) {
    sameValue('hasCodeNodes', () => CodeNodeEmit.hasCodeNodes(g), 'CodeNodeEmit', 'hasCodeNodes', [g]);
    sameValue('refuseUnsupported', () => CodeNodeEmit.refuseUnsupported(g, 'MAF'), 'CodeNodeEmit', 'refuseUnsupported', [g, 'MAF']);
  }
});

// ── StartDocumentStore ───────────────────────────────────────────────────────

test('StartDocumentStore: safeSegments', opt, () => {
  for (const p of ['', 'a', 'a/b/c.pdf', '/abs', 'a//b', 'a/./b', 'a/../b', '..', 'a\\b', 'a\0b', 'a/', 'é/日本.txt', '...']) {
    sameValue(JSON.stringify(p), () => StartDocumentStore.safeSegments(p), 'StartDocumentStore', 'safeSegments', [p]);
  }
});

test('StartDocumentStore: read() from the adapter and the local root', opt, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sds_'));
  try {
    mkdirSync(path.join(root, 'synergyaichatroot/user_3/docs'), { recursive: true });
    mkdirSync(path.join(root, 'synergyaichatroot/user_4'), { recursive: true });
    writeFileSync(path.join(root, 'synergyaichatroot/user_3/docs/a.txt'), Buffer.from([0x68, 0x69, 0xff, 0x00, 0x0a]));
    writeFileSync(path.join(root, 'synergyaichatroot/user_4/secret.txt'), 'nope');
    const adapterFiles = { '/synergyaichatroot/user_3/docs/remote.bin': Buffer.from('remote bytes ✓').toString('base64') };
    const docs: any[] = [
      { path: 'docs/a.txt' }, { path: 'docs/a.txt', storage: 'local' }, { path: 'docs/remote.bin' }, { path: '../user_4/secret.txt' },
      { path: 'docs' }, { path: '' }, { path: 'docs/missing.txt' }, { path: 'docs/a.txt', fullPath: '/etc/passwd' }, {},
    ];
    const setups: Array<[string, any[], () => StartDocumentStore]> = [
      ['local only', ['user_3', null, root], () => new StartDocumentStore('user_3', null, root)],
      ['adapter + local', ['user_3', { $closure: { $adapter: adapterFiles } }, root],
        () => new StartDocumentStore('user_3', () => ({ readStream: (p: string) => { const b = (adapterFiles as any)[p]; if (b === undefined) throw new Error('no'); return Buffer.from(b, 'base64'); } }), root)],
      ['no root', ['user_3', null, null], () => new StartDocumentStore('user_3')],
      ['bad folder', ['../user_4', null, root], () => new StartDocumentStore('../user_4', null, root)],
    ];
    for (const [label, phpArgs, mk] of setups) {
      for (const d of docs) {
        const r = runPhp(['call'], enc({ class: 'StartDocumentStore', method: '__construct_read', args: [tag(phpArgs), tag(d)] }));
        assert.ok(r.ok, r.error);
        const got = mk().read(d);
        assert.equal(got === null ? null : got.toString('base64'), r.result, `${label} ${JSON.stringify(d)}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

