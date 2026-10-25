/**
 * Port of backend/tests/Unit/LangGraphOutputStructureTest.php: the LangGraph compiler's output as a whole --
 * single file, modular package, A2A -- checked statically (backend/tests/fixtures/lg_static_checks.py), against
 * the documentation baseline (backend/tests/fixtures/lg_doc_baseline/), and by running the emitted code against a
 * stub chat model (backend/tests/fixtures/lg_run_probe.py, in the runner venv).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { a2aGraph, a2aSql, lgGenerator, PLAYBOOK, skillsRoot as fixtureSkillsRoot } from './support/lgFixtures';
import { execLines, PHP_FIXTURES, python3 } from './support/lgFixturesB';

const DOC_BASELINE = path.join(PHP_FIXTURES, 'lg_doc_baseline');
const NO_PY = python3() === null ? 'python3 not available' : false;

let tempPaths: string[] = [];
afterEach(() => {
  for (const p of tempPaths) rmSync(p, { recursive: true, force: true });
  tempPaths = [];
});

function tempPath(prefix: string, suffix = ''): string {
  const p = path.join(tmpdir(), prefix + randomBytes(4).toString('hex') + suffix);
  tempPaths.push(p);
  return p;
}

/** name => graph: the Dispatcher demo, a plain chain (no dispatcher, no playbook), a playbook-only flow. */
function graphs(): Record<string, any> {
  const agent = (name: string) => ({
    type: 'agent-template', agent_name: name, agent_type: 'standard',
    instructions: `You are ${name}.`, agent_provider: 'claude', model: 'claude-sonnet-4-5',
    tools: [], settings: { temperature: 0.7, max_tokens: 4096 },
  });
  return {
    dispatcher_demo: a2aGraph(),
    linear: {
      nodes: [
        { id: '1', node_type: 'start', config: { type: 'start', prompt: 'write something' } },
        { id: '2', node_type: '', config: agent('Researcher') },
        { id: '3', node_type: '', config: agent('Writer') },
        { id: '4', node_type: 'output', config: { type: 'output' } },
      ],
      edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }],
    },
    playbook_only: {
      nodes: [
        { id: '1', node_type: 'start', config: { type: 'start', prompt: 'I want to take some vacations' } },
        { id: '2', node_type: 'playbook', config: { type: 'playbook', name: 'Playbook HR',
          playbook: PLAYBOOK, agent_provider: 'deepseek', model: 'deepseek-v4-flash', writes_enabled: true } },
        { id: '3', node_type: 'output', config: { type: 'output' } },
      ],
      edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
    },
  };
}

function generator(graph: any, skillsRoot: string | null = null) {
  return lgGenerator({ sql: a2aSql(), workflow: { id: 44, name: 'Dispatcher demo', user_id: '3' }, graph,
    skillsRoot: skillsRoot ?? fixtureSkillsRoot() });
}

/** path => code of one mode's Python files. api.py is left out unless asked. */
async function files(graph: any, mode: string, withApi = false, skillsRoot: string | null = null): Promise<Record<string, string>> {
  const gen = generator(graph, skillsRoot);
  if (mode === 'single') {
    const r: any = await gen.generate(44, '3');
    return { [r.filename]: r.code };
  }
  const out: Record<string, string> = {};
  for (const f of ((await gen.generate(44, '3', { [mode]: true })) as any).files) {
    if (!f.path.endsWith('.py')) continue;
    if (f.path.startsWith('skills/')) continue;
    if (withApi || f.path !== 'api.py') out[f.path] = f.code;
  }
  return out;
}

/** Writes files under <tmp>/lgos_<hex>/python/scripts/wf (the runner's layout). */
function write(fs: Record<string, string>): { root: string; paths: Record<string, string> } {
  const root = path.join(tempPath('lgos_'), 'python/scripts/wf');
  const paths: Record<string, string> = {};
  for (const [rel, code] of Object.entries(fs)) {
    paths[rel] = path.join(root, rel);
    mkdirSync(path.dirname(paths[rel]), { recursive: true });
    writeFileSync(paths[rel], code);
  }
  return { root, paths };
}

/** Output lines of lg_static_checks.py <check> over paths. */
function staticCheck(check: string, paths: Record<string, string>): string[] {
  const [rc, out] = execLines(['python3', path.join(PHP_FIXTURES, 'lg_static_checks.py'), check, ...Object.values(paths)]);
  assert.equal(rc, 0, out.join('\n'));
  return out.filter((l) => l !== '');
}

/** strict PHP assertSame on decoded arrays: equal values and the same key order. */
function same(actual: any, expected: any, msg?: string): void {
  assert.deepEqual(actual, expected, msg);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

const VENV_PY = process.env.LANGGRAPH_TEST_PYTHON || path.join(process.env.HOME ?? '', 'Documents/synergyAI/python/.venv/bin/python');
const NO_VENV = (() => {
  const [rc] = execLines([VENV_PY, '-c', 'import langchain_core, langgraph']);
  return rc !== 0 ? `runner venv python not usable: ${VENV_PY}` : false;
})();

/** Runs lg_run_probe.py; returns [decoded RESULT, full console]. */
function probe(args: string[], env: Record<string, string> = {}): [any, string] {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ['TYPESAFE_API_KEY', 'MODEL_NAME', 'PLAYBOOK_GATE_MODE']) delete base[k];
  const [rc, out] = execLines(['env', ...['TYPESAFE_API_KEY', 'MODEL_NAME', 'PLAYBOOK_GATE_MODE'].flatMap((k) => ['-u', k]),
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`), VENV_PY, path.join(PHP_FIXTURES, 'lg_run_probe.py'), ...args], {}, { timeoutMs: 300000 });
  const console = out.join('\n');
  assert.equal(rc, 0, console);
  const line = out.length ? out[out.length - 1] : '';
  assert.ok(line.startsWith('RESULT '), console);
  return [JSON.parse(line.slice(7)), console];
}

test('testEveryBaselineDocumentationLineSurvives', { skip: NO_PY }, async (t) => {
  let reworded: any = {};
  try {
    reworded = JSON.parse(readFileSync(path.join(DOC_BASELINE, 'reworded.json'), 'utf8')) ?? {};
  } catch {
    reworded = {};
  }
  for (const mode of ['single', 'modular', 'a2a']) {
    const now = staticCheck('docs', write(await files(graphs().dispatcher_demo, mode)).paths);
    const file = path.join(DOC_BASELINE, `${mode}.txt`);
    if (process.env.LG_DOC_BASELINE_WRITE === '1') {
      t.skip('baseline writing is the PHP test\'s job (LG_DOC_BASELINE_WRITE); not done from TypeScript');
      return;
    }
    assert.ok(existsSync(file), `${mode}: documentation baseline missing`);
    const baseline = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
    assert.ok(baseline.length > 0, `${mode}: documentation baseline is empty, so it would pass vacuously`);
    const have = new Set(now);
    const lost: string[] = [];
    for (const line of baseline) {
      const r = Object.prototype.hasOwnProperty.call(reworded, line) ? reworded[line] : null;
      const ok = have.has(line)
        || (r !== null && typeof r === 'object' && 'now' in r
          && (r.now === null ? String(r.why ?? '').trim() !== '' : have.has(r.now)));
      if (!ok) lost.push(line);
    }
    assert.deepEqual(lost, [], `${mode}: documentation lost -- move it with its code, or record the rewording in reworded.json`);
  }
});

test('testNoLangGraphFileReferencesAnUndefinedGlobal', { skip: NO_PY }, async () => {
  const allowed = ['__file__'];
  for (const [name, graph] of Object.entries(graphs())) {
    for (const mode of ['single', 'modular', 'a2a']) {
      const w = write(await files(graph, mode, true));
      const found = staticCheck('undefined', w.paths).filter((l) => !allowed.includes(l.slice(l.lastIndexOf(' ') + 1)));
      assert.deepEqual(found, [], `${name}/${mode}`);
    }
  }
});

test('testNoLangGraphFileImportsAnUnusedName', { skip: NO_PY }, async () => {
  for (const [name, graph] of Object.entries(graphs())) {
    for (const mode of ['single', 'modular', 'a2a']) {
      assert.deepEqual(staticCheck('unused', write(await files(graph, mode)).paths), [], `${name}/${mode}`);
    }
  }
});

/** Every class and public function the LangGraph target emits says why it exists. */
test('testEveryLangGraphClassAndPublicFunctionHasADocstring', { skip: NO_PY }, async () => {
  const allowed: string[] = [];
  for (const [name, graph] of Object.entries(graphs())) {
    for (const mode of ['single', 'modular', 'a2a']) {
      const found = staticCheck('docstrings', write(await files(graph, mode)).paths)
        .filter((l) => !allowed.includes(l.slice(l.indexOf(': ') + 2)));
      assert.deepEqual(found, [], `${name}/${mode}`);
    }
  }
});

/** Same-variable if/elif chains on ntype and routing mode are match statements (spec step 2). */
test('testNodeTypeAndRoutingModeAreMatchStatements', async () => {
  for (const mode of ['single', 'modular', 'a2a']) {
    const all = Object.values(await files(graphs().dispatcher_demo, mode)).join('\n');
    assert.ok(all.includes('match ntype:'), mode);
    assert.ok(!all.includes('if ntype == "start":'), mode);
    assert.ok(all.includes('        match self.mode():'), mode);
    assert.ok(!all.includes('    if mode == "jev":'), mode);
  }
});

test('testEveryNodeKindRunsThroughMakeNode', { skip: NO_VENV }, async () => {
  const fs = await files(graphs().dispatcher_demo, 'modular');
  assert.ok(fs['common.py'].includes('class Node(ABC):'));
  assert.ok(fs['common.py'].includes('def make_node(cfg: dict) -> Node:'));
  for (const p of ['agents/techbuddy.py', 'agents/it_claims.py', 'agents/playbook_hr.py']) {
    assert.ok(fs[p].includes('run_node = make_node(NODE).run'), p);
    assert.ok(!fs[p].includes('async def '), `${p}: node logic lives in common.py`);
  }
  const root = write(fs).root;
  let [r] = probe(['node', 'module', root, 'agents.techbuddy', 'my laptop will not boot'], { STUB_ROUTE_TO: 'IT claims' });
  same(r, { text: 'my laptop will not boot', route: '3', notes: '', status: 'ok' });
  let log: string;
  [r, log] = probe(['node', 'module', root, 'agents.human_resources', 'two days off']);
  assert.equal(r.status, 'ok');
  assert.ok(r.text.includes('answer to: two days off'));
  assert.ok(log.includes('inputs: system='));
  [r] = probe(['node', 'module', root, 'agents.playbook_hr', 'two days off'], { PLAYBOOK_GATE_MODE: 'auto' });
  assert.ok(r.text.startsWith('# Playbook: Time Off ('));
});

test('testPlaybookOnlyWorkflowRunsInEveryMode', { skip: NO_VENV }, async () => {
  const graph = graphs().playbook_only;
  const single = write(await files(graph, 'single'));
  let [r] = probe(['workflow', 'single', Object.values(single.paths)[0], 'I want two days off'], { PLAYBOOK_GATE_MODE: 'auto' });
  assert.ok(r.output.startsWith('# Playbook: Time Off ('));
  [r] = probe(['workflow', 'modular', write(await files(graph, 'modular')).root, 'I want two days off'], { PLAYBOOK_GATE_MODE: 'auto' });
  assert.ok(r.output.startsWith('# Playbook: Time Off ('));
  const a2a = write(await files(graph, 'a2a'));
  [r] = probe(['node', 'a2a', a2a.paths['agents/2_playbook-hr.py'], 'I want two days off'], { PLAYBOOK_GATE_MODE: 'auto' });
  assert.ok(r.text.startsWith('# Playbook: Time Off ('));
});

test('testMissingProviderPackageFailsOnlyThatNode', { skip: NO_VENV }, async () => {
  const p = Object.values(write(await files(graphs().linear, 'single')).paths)[0];
  const cfg = JSON.stringify({ id: '9', kind: 'agent', display: 'G', provider: 'gemini', model: 'gemini-x',
    temperature: 0.7, max_tokens: 100, thinking: null, system_prompt: 'x', tool_names: [], skills: [] });
  let [r] = probe(['llm', p, cfg], { STUB_BLOCK_IMPORT: 'langchain_google_genai' });
  assert.ok(String(r.error).startsWith('ImportError'), 'import and make_node() succeed; only .llm fails');
  assert.ok(String(r.error).includes("node 9 'G'"));
  assert.ok(String(r.error).includes("'gemini'"));
  [r] = probe(['llm', p, cfg.replace('"gemini-x"', '""')]);
  assert.ok(String(r.error).startsWith('RuntimeError'));
  assert.ok(String(r.error).includes("node 9 'G'"));
  assert.ok(String(r.error).includes("'gemini'"));
});

test('testA2AAgentFilesRunTheirNodeThroughMakeNode', { skip: NO_VENV }, async () => {
  const a2a = write(await files(graphs().dispatcher_demo, 'a2a'));
  let [r] = probe(['node', 'a2a', a2a.paths['agents/2_techbuddy.py'], 'I need vacation'], { STUB_ROUTE_TO: 'Human resources' });
  assert.equal(r.route, '4');
  [r] = probe(['node', 'a2a', a2a.paths['agents/4_human-resources.py'], 'I need vacation']);
  const { text: _t, ...rest } = r;
  same(rest, { route: '', notes: '', status: 'ok' });
  [r] = probe(['node', 'a2a', a2a.paths['agents/5_playbook-hr.py'], 'I need vacation'], { PLAYBOOK_GATE_MODE: 'auto' });
  assert.ok(r.text.startsWith('# Playbook: Time Off ('));
});

/** The emitted classes follow the spec's readability rule. */
test('testEmittedClassesFollowTheReadabilityRule', { skip: NO_PY }, async () => {
  for (const [name, graph] of Object.entries(graphs())) {
    for (const mode of ['single', 'modular', 'a2a']) {
      assert.deepEqual(staticCheck('readability', write(await files(graph, mode)).paths), [], `${name}/${mode}`);
    }
  }
});

/** The dispatcher runtime is JevRouter + Dispatcher; the parents() stubs and the fake graph state are gone (analysis D6). */
test('testDispatcherIsAClassAndTheFakeStateIsGone', async () => {
  for (const mode of ['single', 'modular', 'a2a']) {
    const all = Object.values(await files(graphs().dispatcher_demo, mode)).join('\n');
    assert.ok(all.includes('class JevRouter:'), mode);
    assert.ok(all.includes('class Dispatcher:'), mode);
    for (const gone of ['def parents(_n)', 'state = {"node_outputs": {}, "user_prompt": request}', 'def _jev_route(']) {
      assert.ok(!all.includes(gone), `${mode}: ${gone}`);
    }
  }
});

test('testSingleFileAndPackageSendTheSamePromptsAndSaveUnderTheSameName', { skip: NO_VENV }, async () => {
  const graph = graphs().dispatcher_demo;
  const long = 'Always answer politely and route vacation requests to Human resources. '.repeat(3);
  graph.nodes[2].config.instructions = long;
  graph.nodes[0].config.prompt = long;
  const single = Object.values(await files(graph, 'single')).join('\n');
  const pkg = await files(graph, 'modular');
  assert.ok(single.includes(long.replace(/\s+$/, '')), 'single file: system prompt and DEFAULT_PROMPT verbatim');
  assert.ok(pkg['agents/it_claims.py'].includes(long.replace(/\s+$/, '')));
  assert.ok(single.includes('def save_output('));
  assert.ok(pkg['common.py'].includes('def save_output('));
  const root = tempPath('lgsave_');
  const names: Record<string, string> = {};
  const targets: Record<string, string> = {
    single: Object.values(write(await files(graph, 'single')).paths)[0],
    modular: write(pkg).root,
  };
  for (const [mode, target] of Object.entries(targets)) {
    const [r] = probe(['save', target, 'hello'], { SYNERGYAI_OUTPUT_ROOT: root });
    names[mode] = path.basename(String(r.path)).replace(/_\d{8}-\d{6}\./, '_<ts>.');
  }
  same(names, { single: '44-dispatcher-demo_<ts>.md', modular: '44-dispatcher-demo_<ts>.md' });
});

test('testLinearWorkflowRunsTheSameInSingleAndModular', { skip: NO_VENV }, async () => {
  const graph = graphs().linear;
  const single = await files(graph, 'single');
  assert.ok(Object.values(single).join('\n').includes('class WorkflowGraph:'));
  const [a, logA] = probe(['workflow', 'single', Object.values(write(single).paths)[0], 'write something']);
  const [b] = probe(['workflow', 'modular', write(await files(graph, 'modular')).root, 'write something']);
  assert.equal(a.output, b.output);
  assert.ok(a.output.startsWith('answer to:'));
  assert.ok(logA.includes('[node] [4] output -- '));
});

test('testOneGraphImplementationInEveryMode', async () => {
  const count = (s: string, n: string) => s.split(n).length - 1;
  for (const mode of ['single', 'modular', 'a2a']) {
    const all = Object.values(await files(graphs().dispatcher_demo, mode)).join('\n');
    assert.equal(count(all, 'class WorkflowGraph:'), 1, mode);
    assert.equal(count(all, 'def make_start('), 0, mode);
    assert.equal(count(all, 'def _save_output('), 0, mode);
  }
});

test('testSkillStepOutputBecomesTheNodeOutput', { skip: NO_VENV }, async () => {
  const base = tempPath('lgskill_');
  mkdirSync(`${base}/skills/lgtest/scripts`, { recursive: true });
  writeFileSync(`${base}/skills/lgtest/SKILL.md`, '---\nname: lgtest\n---\nRender the input with scripts/make.py.\n');
  writeFileSync(`${base}/skills/lgtest/scripts/make.py`,
    "import sys\nopen(sys.argv[1], 'w', encoding='utf-8').write('<html>made by the skill</html>')\nprint('ok')\n");
  const graph = graphs().linear;
  graph.nodes[2].config.bound_skill = { dir_name: 'lgtest' };
  const root = write(await files(graph, 'modular', false, `${base}/skills`)).root;
  const [r, log] = probe(['node', 'module', root, 'agents.writer', 'write something'], {
    SYNERGYAI_SKILLS_DIR: `${base}/skills`, SYNERGYAI_OUTPUT_ROOT: `${base}/outputs`,
    STUB_SKILL_CALL: JSON.stringify({ script: 'scripts/make.py', argv: ['/outputs/report.html'], read_outputs: ['/outputs/report.html'] }),
  });
  assert.equal(r.text, '<html>made by the skill</html>', log);
  assert.ok(log.includes("after skill 'lgtest'"));
});

test('testToolsAndSkillsAreLangGraphOwnedClasses', async () => {
  const count = (s: string, n: string) => s.split(n).length - 1;
  for (const mode of ['single', 'modular', 'a2a']) {
    const fs = await files(graphs().dispatcher_demo, mode);
    const all = Object.values(fs).join('\n');
    for (const n of ['class ToolCatalog:', 'class SkillRuntime:', 'TOOLS = ToolCatalog(TOOL_CATALOG)', 'SKILLS = SkillRuntime(']) {
      assert.ok(all.includes(n), `${mode}: ${n}`);
    }
    for (const gone of ['def build_tools_from_catalog', 'def _run_skill_script(', 'RUN_SKILL_SCRIPT_TOOL', 'def _summarize_tool_result']) {
      assert.ok(!all.includes(gone), `${mode}: ${gone}`);
    }
    for (const [p, code] of Object.entries(fs)) {
      if (code.includes('class ToolCatalog:')) {
        assert.equal(count(code, 'type_map = ') + count(code, 'TYPE_MAP = '), 1, `${mode} ${p}: one schema->pydantic helper`);
      }
    }
  }
});

test('testPlaybookRuntimeIsLangGraphsOwnClasses', async () => {
  for (const mode of ['single', 'modular', 'a2a']) {
    const all = Object.values(await files(graphs().dispatcher_demo, mode)).join('\n');
    for (const n of ['class RunEvents:', 'class PlaybookRun:', 'class PlaybookToolset:', 'EVENTS = RunEvents()']) {
      assert.ok(all.includes(n), `${mode}: ${n}`);
    }
    for (const gone of ['_pb_sink_active', 'except NameError', 'globals().get(', 'def build_playbook_tools(']) {
      assert.ok(!all.includes(gone), `${mode}: ${gone}`);
    }
  }
});

test('testMcpClientIsLangGraphsOwnClass', async () => {
  for (const mode of ['single', 'modular', 'a2a']) {
    const all = Object.values(await files(graphs().dispatcher_demo, mode)).join('\n');
    assert.ok(all.includes('class McpClient:'), mode);
    assert.ok(all.includes('MCP = McpClient()'), mode);
    assert.ok(!all.includes('def _init_mcp_session('), mode);
    assert.ok(!all.includes('import json as _json'), mode);
  }
});

test('testMcpClientTalksJsonRpcAndSse', { skip: NO_VENV }, async () => {
  const p = Object.values(write(await files(graphs().linear, 'single')).paths)[0];
  const [r] = probe(['mcp', p]);
  same(r, { texts: ['news ok', 'news ok'], initialize: 2 }, 'SSE parsed; one handshake per call, as today');
});

test('testAttachmentsGoThroughTheDocumentConverter', { skip: NO_VENV }, async () => {
  const graph = graphs().linear;
  const doc = tempPath('lgdoc_', '.md');
  writeFileSync(doc, '# Brief\nWrite about tides.');
  graph.nodes[0].config.documents = [{ name: 'brief.md', path: doc }, { name: 'lost.pdf', path: '' }];
  const pkg = await files(graph, 'modular');
  assert.ok(pkg['common.py'].includes('class DocumentConverter:'));
  assert.ok(!Object.values(pkg).join('\n').includes('_convert_doc_to_markdown'));
  assert.ok(pkg['workflow.py'].includes('"path": "' + doc + '"'));
  const [, log] = probe(['workflow', 'modular', write(pkg).root, 'go']);
  const start = '## Attached Documents\n\n### brief.md\n\n# Brief\nWrite about tides.\n\n---\n\n'
    + '### lost.pdf\n\n_(no path on attachment record)_\n\n---\n\ngo';
  assert.ok(log.includes('[node] [1] start -- ' + Buffer.byteLength(start) + ' chars'));
});

test('testLlmFactoryIsLangGraphsOwnFunction', async () => {
  for (const mode of ['single', 'modular', 'a2a']) {
    const all = Object.values(await files(graphs().dispatcher_demo, mode)).join('\n');
    for (const n of ['def _claude(', 'def _deepseek(', 'def _kimi(', 'def _glm(']) {
      assert.ok(all.includes(n), `${mode}: ${n}`);
    }
    assert.ok(all.includes('            return _deepseek(model, temperature, max_tokens, thinking)'), mode);
  }
});

test('testLlmFactoryPassesTheSameProviderArguments', { skip: NO_VENV }, async () => {
  const p = Object.values(write(await files(graphs().linear, 'single')).paths)[0];
  const [r] = probe(['llm-args', p]);
  same(r[0].model_kwargs.extra_body.thinking, { type: 'enabled' });
  assert.ok(!('temperature' in r[0]), 'deepseek v4 in thinking mode drops temperature');
  same(r[1].model_kwargs.extra_body.thinking, { type: 'disabled' });
  assert.equal(r[1].temperature, 0.7);
  assert.equal(r[2].temperature, 0.6, 'kimi k2, thinking off -> 0.6 (provider constraint)');
  same(r[3], { model: 'claude-x', temperature: 0.5, max_tokens: 100 });
});
