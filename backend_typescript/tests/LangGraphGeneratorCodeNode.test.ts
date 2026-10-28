/**
 * Port of backend/tests/Unit/LangGraphGeneratorCodeNodeTest.php. LangGraph compiler: code nodes (single file +
 * modular), refused by other packagings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';
import { execPy, lgFiles, lgGenerator, pyCompile, python3 } from './support/lgFixtures';

const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
const noVenv = !isExecutable(VENV) ? 'venv python missing' : false;
const noPy = python3() === null ? 'python3 not available' : false;

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

async function generate(graph: any, userId: string | null = '3'): Promise<string> {
  return (await generateWith(graph, {}, userId))['code'];
}

function codeGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'poll' } },
      {
        id: '2',
        node_type: 'code',
        config: {
          type: 'code',
          name: 'Poll ServiceNow',
          code: "def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n",
          exits: ['job', 'no_job'],
          mcp_servers: ['ServiceNow'],
          timeout_s: 30,
        },
      },
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

/** Writes the script to a temp dir and runs `<venv> wf.py --once go` there with RUNS_DIR set; returns [rc, text]. */
function runOnce(code: string): [number, string] {
  const dir = mkdtempSync(path.join(tmpdir(), 'lgout'));
  writeFileSync(path.join(dir, 'wf.py'), code);
  const r = execPy(VENV, ['wf.py', '--once', 'go'], { cwd: dir, env: { ...process.env, RUNS_DIR: path.join(dir, 'runs') } });
  return [r.rc, r.out.join('\n')];
}

test('testSingleFileBakesTheCodeNode', { skip: noPy }, async () => {
  const code = await generate(codeGraph());
  assert.ok(code.includes('CODE_NODES = {'));
  assert.ok(code.includes('"exit_targets": {"job":["3"],"no_job":["4"]}'));
  assert.match(code, /MCP_SLUGS = \{\s*"servicenow": "http:\/\/localhost\/servicenow\/\?profile=mock&toolset=jobs"\s*\}/);
  assert.ok(code.includes('class CodeNode(Node):'));
  assert.ok(code.includes('CODE_HARNESS = types.ModuleType("code_node_harness")'));
  assert.ok(code.includes('"2": "code"'));
  assert.ok(code.includes('{**AGENTS, **PLAYBOOKS, **CODE_NODES}'));
  // the code node is documented like an agent: a comment block before its entry, with its declared tool
  assert.match(code, /CODE_NODES = \{\n {4}# ---- node 2: Poll ServiceNow \(code\) -+\n {4}# {3}tools {10}: servicenow\.\*\n( {4}#[^\n]*\n)* {4}"2": \{/);
  const r = pyCompile(code);
  assert.equal(r.rc, 0, r.out.join('\n'));
});

test('testWorkflowsWithoutCodeNodesAreUnchanged', async () => {
  const graph = { nodes: [codeGraph().nodes[0], codeGraph().nodes[2]], edges: [{ from: '1', to: '3', from_port: 'output_1' }] };
  const code = await generate(graph);
  assert.ok(!code.includes('CODE_HARNESS'));
  assert.ok(!code.includes('class CodeNode'));
});

test('testUnsupportedPackagingsRefuse', async () => {
  for (const opts of [{ a2a: true }]) {
    await assert.rejects(generateWith(codeGraph(), opts), (e: any) => {
      assert.ok(String(e?.message).includes('Code nodes are not supported by the A2A'), String(e?.message));
      return true;
    }, 'A2A accepted a code node');
  }
});

test('testModularBakesACodeModule', async () => {
  const byPath = lgFiles(await generateWith(codeGraph(), { modular: true }));
  const module = byPath['agents/poll_servicenow.py'] ?? '';
  assert.ok(module.includes('"kind": "code"'));
  assert.ok(module.includes('run_node = make_node(NODE).run'));
  assert.ok(byPath['common.py'].includes('class CodeNode(Node):'));
  assert.ok(byPath['common.py'].includes('MCP_SLUGS = '));
  assert.ok(byPath['workflow.py'].includes('"exit_targets": {"job":["3"],"no_job":["4"]}'));
});

test('testADispatchersCodeChildIsOnItsMenu', async () => {
  // A code child of a dispatcher runs only when the dispatcher picks it (as in the editor).
  const g = codeGraph();
  g.nodes.push({
    id: '9',
    node_type: '',
    config: {
      type: 'agent-template', agent_name: 'Front desk', agent_type: 'dispatcher', instructions: 'Route.', agent_provider: 'claude',
      model: 'claude-sonnet-4-6', tools: [], settings: { temperature: 0.7, max_tokens: 4096 },
    },
  });
  g.edges = [
    { from: '1', to: '9', from_port: 'output_1' },
    { from: '9', to: '2', from_port: 'output_1' },
    { from: '2', to: '3', from_port: 'output_1' },
    { from: '2', to: '4', from_port: 'output_2' },
  ];
  const code = await generate(g);
  assert.ok(code.includes('"dispatch": [{"id": "2", "name": "Poll ServiceNow", "description": ""}]'));
  const byPath = lgFiles(await generateWith(g, { modular: true }));
  assert.ok(byPath['workflow.py'].includes('"dispatch": [{"id":"2","name":"Poll ServiceNow"}]'));
});

/** A code node's arguments (a component's settings) and a Start option's Start args reach the compiled code as ARGS. */
test('testArgumentsAreCompiledIn', async () => {
  const g = codeGraph();
  g.nodes[1].config.args = { folder: 'Didier' };
  const code = await generate(g);
  assert.ok(code.includes('"args": {"folder":"Didier"}'));

  const raw = {
    nodes: [
      { id: '17', node_type: 'start', config: { type: 'start', start_option: 5, start_args: { folder: 'To SharePoint', done_folder: 'Filed' } } },
      { id: '18', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from_node_id: '17', to_node_id: '18', from_port: 'output_1' }],
  };
  const opt = await StartOptionGraph.expand(raw, (_id: number) => ({
    name: 'Outlook: get dropped email',
    code: "def run(input, call_tool):\n    return {'route': 'mail', 'output': ARGS}\n",
    exits: ['mail', 'no_mail'],
    mcp_servers: ['ServiceNow'],
    timeout_s: 30,
    start_trigger: { label: 'Outlook: get dropped email', work_exit: 'mail' },
  }));
  assert.ok((await generate(opt)).includes('"args": {"folder":"To SharePoint","done_folder":"Filed"}'));
});

/** The compiled script hands the arguments to run() (the same ARGS the editor and the server give it). */
test('testTheCompiledCodeReadsItsArguments', { skip: noVenv, timeout: 180000 }, async () => {
  const g = codeGraph();
  g.nodes[1].config = {
    type: 'code', name: 'Echo args', exits: ['next'], mcp_servers: [], timeout_s: 30, args: { folder: 'Didier' },
    code: "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n",
  };
  g.edges = [
    { from: '1', to: '2', from_port: 'output_1' },
    { from: '2', to: '3', from_port: 'output_1' },
  ];
  g.nodes.pop();
  const [rc, text] = runOnce(await generate(g));
  assert.equal(rc, 0, text);
  assert.ok(text.includes('folder=Didier'), text);
});

/**
 * The Output takes a node once, and only through the exit it took (as the editor and the server runner do):
 * Convert(2) took done -> Store(5); its error link to the Output carries nothing, and Store's two exits
 * linked to the same Output give one answer, verbatim.
 */
test('testTheOutputTakesANodeOnceAndOnlyThroughTheExitItTook', { skip: noVenv, timeout: 180000 }, async () => {
  const code = (route: string, text: string) => ({
    type: 'code', exits: ['done', 'error'], mcp_servers: [], timeout_s: 30,
    code: `def run(input, call_tool):\n    return {'route': '${route}', 'output': '${text}'}\n`,
  });
  const g = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
      { id: '2', node_type: 'code', config: { name: 'Convert', ...code('done', 'PACKAGE') } },
      { id: '5', node_type: 'code', config: { name: 'Store', ...code('done', 'STORED') } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2', from_port: 'output_1' },
      { from: '2', to: '5', from_port: 'output_1' },
      { from: '2', to: '3', from_port: 'output_2' },
      { from: '5', to: '3', from_port: 'output_1' },
      { from: '5', to: '3', from_port: 'output_2' },
    ],
  };
  const [rc, text] = runOnce(await generate(g));
  assert.equal(rc, 0, text);
  assert.match(text, /FINAL OUTPUT\n=+\nSTORED\n/);
  assert.ok(!text.slice(text.indexOf('FINAL OUTPUT')).includes('PACKAGE'), text);
});

/**
 * A branch that was not taken is not a parent: Check(2) took no_mail straight to the Output, so File(5),
 * also linked to the Output, never ran and the answer is Check's text verbatim (no "## Check" heading).
 */
test('testABranchNotTakenIsNotAParentOfTheOutput', { skip: noVenv, timeout: 180000 }, async () => {
  const code = (exits: string[], route: string, text: string) => ({
    type: 'code', exits, mcp_servers: [], timeout_s: 30,
    code: `def run(input, call_tool):\n    return {'route': '${route}', 'output': '${text}'}\n`,
  });
  const g = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
      { id: '2', node_type: 'code', config: { name: 'Check', ...code(['new_mail', 'no_mail'], 'no_mail', 'NO MAIL') } },
      { id: '5', node_type: 'code', config: { name: 'File', ...code(['next'], 'next', 'FILED') } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2', from_port: 'output_1' },
      { from: '2', to: '5', from_port: 'output_1' },
      { from: '2', to: '3', from_port: 'output_2' },
      { from: '5', to: '3', from_port: 'output_1' },
    ],
  };
  const [rc, text] = runOnce(await generate(g));
  assert.equal(rc, 0, text);
  assert.match(text, /FINAL OUTPUT\n=+\nNO MAIL\n/);
});

/**
 * The argument declarations are compiled in as Python (a "required": true declaration imports: no NameError
 * on true), in both packagings, and the node's run fills ARGS from its parents' meta and the declared default.
 */
test('testNodeLiteralHasArgDeclsAndExecutePassesMeta', { skip: noPy }, async () => {
  const g = codeGraph();
  g.nodes[1].config.arg_decls = [{ name: 'folder', required: true }, { name: 'note', default: null }];
  g.nodes[1].config.args = { flag: false };
  const code = await generate(g);
  assert.ok(code.includes('"arg_decls": [{"name":"folder","required":True},{"name":"note","default":None}]'));
  assert.ok(code.includes('"args": {"flag":False}'));
  assert.ok(code.includes('meta=CODE_HARNESS.received_meta('));
  assert.ok((await generate(codeGraph())).includes('"arg_decls": []'));
  const files: Record<string, string> = { 'single/wf.py': code };
  for (const [p, c] of Object.entries(lgFiles(await generateWith(g, { modular: true })))) {
    if (p.endsWith('.py')) files['modular/' + p] = c;
  }
  for (const [p, c] of Object.entries(files)) {
    const r = pyCompile(c);
    assert.equal(r.rc, 0, p + '\n' + r.out.join('\n'));
  }
  // the NODE literal evaluates: the declarations come back as Python values
  const m = code.match(/"arg_decls": (\[.*\]),   #/);
  assert.ok(m);
  const ev = execPy(python3() as string, ['-c', 'import sys; print(eval(sys.argv[1]))', m![1]]);
  assert.equal(ev.rc, 0, ev.text);
  assert.equal(ev.text.trim(), "[{'name': 'folder', 'required': True}, {'name': 'note', 'default': None}]");
});

/** A compiled node whose argument is required and declared with a default runs with that default in ARGS. */
test('testTheCompiledRunAppliesADeclaredDefault', { skip: noVenv, timeout: 180000 }, async () => {
  const g = codeGraph();
  g.nodes[1].config = {
    type: 'code', name: 'Echo args', exits: ['next'], mcp_servers: [], timeout_s: 30, args: {},
    arg_decls: [{ name: 'folder', default: 'Inbox', required: true }],
    code: "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n",
  };
  g.edges = [
    { from: '1', to: '2', from_port: 'output_1' },
    { from: '2', to: '3', from_port: 'output_1' },
  ];
  g.nodes.pop();
  const [rc, text] = runOnce(await generate(g));
  assert.equal(rc, 0, text);
  assert.ok(text.includes('folder=Inbox'), text);
});
