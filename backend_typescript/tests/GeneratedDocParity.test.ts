/**
 * Port of backend/tests/Unit/GeneratedDocParityTest.php: every compile target (LangGraph, ADK, MAF, NOOA) documents
 * the generated script the same way (PROVENANCE, GRAPH NODES, GRAPH EDGES, EXECUTION ORDER, DATA FLOW, TO RUN, a
 * comment block per node), runs playbook and dispatcher nodes, and defines every global it references.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GraphAnalyzer } from '../src/AgentTeam/compiler/GraphAnalyzer';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { NOOAGenerator } from '../src/AgentTeam/NOOAGenerator';
import { execLines, makeGenerator, python3, sqlite } from './support/lgFixturesB';

const NO_PY = python3() === null ? 'python3 not available' : false;

const PLAYBOOK = 'Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n';

/** The Dispatcher-demo shape, with the '' node_type the editor really saves. */
function graph(): any {
  const agent = (name: string, type = 'standard') => ({
    type: 'agent-template', agent_name: name, agent_type: type,
    instructions: `You are ${name}.`, agent_provider: 'claude', model: 'claude-sonnet-4-5',
    tools: [], settings: { temperature: 0.7, max_tokens: 4096 },
  });
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'I want to take some vacations' } },
      { id: '2', node_type: '', config: agent('techBuddy', 'dispatcher') },
      { id: '3', node_type: '', config: agent('IT claims') },
      { id: '4', node_type: '', config: agent('Human resources') },
      { id: '5', node_type: 'playbook', config: { type: 'playbook', name: 'Playbook HR',
        playbook: PLAYBOOK, agent_provider: 'deepseek', model: 'deepseek-flash', writes_enabled: true } },
      { id: '6', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2' }, { from: '2', to: '3' }, { from: '2', to: '4' },
      { from: '3', to: '6' }, { from: '4', to: '5' }, { from: '5', to: '6' },
    ],
  };
}

function pdo(): void {
  sqlite([
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
    'INSERT INTO mcp_server_tools VALUES (1, 85, \'get_pto_balance\', \'Get balances\', \'{"type":"object","properties":{"email":{"type":"string"}}}\')',
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)",
  ]);
}

/** target => generated code. */
async function generateAll(): Promise<Record<string, string>> {
  pdo();
  const gen = makeGenerator({ workflow: { id: 44, name: 'Dispatcher demo', user_id: '3' }, graph: graph() });
  const out: Record<string, string> = { LangGraph: ((await gen.generate(44, '3')) as any).code };
  const repos = [(gen as any).workflowRepo, (gen as any).graphRepo, (gen as any).agentRepo] as const;
  for (const [label, Cls] of [['ADK', ADKGenerator], ['MAF', MAFGenerator], ['NOOA', NOOAGenerator]] as const) {
    out[label] = ((await new (Cls as any)(...repos).generate(44, '3')) as any).code;
  }
  return out;
}

function withTempPy(code: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'gen'));
  const file = path.join(dir, 'gen.py');
  writeFileSync(file, code);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('testAnalyzerReadsEmptyNodeTypeFromConfig', () => {
  assert.equal(GraphAnalyzer.typeOf({ node_type: '', config: { type: 'agent-template' } }), 'agent-template');
  assert.equal(GraphAnalyzer.typeOf({ node_type: 'playbook', config: { type: 'agent' } }), 'playbook');
  assert.equal(GraphAnalyzer.typeOf({ config: [] }), 'agent');
});

test('testEveryTargetCarriesTheSameDocumentationSections', async () => {
  for (const [target, code] of Object.entries(await generateAll())) {
    const doc = code.slice(0, code.indexOf('"""', 3));
    for (const needle of ['PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
      'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
      'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), DISPATCHER -> one of: IT claims | Human resources',
      'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
      'layer 2:  IT claims  ||  Human resources',
      'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF']) {
      assert.ok(doc.includes(needle), `${target}: docstring lacks ${needle}`);
    }
    assert.match(doc, /Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor/, target);
    assert.ok(code.includes('# ---- node 2: techBuddy (' + (target === 'LangGraph' ? 'agent' : 'agent-template') + ') '), target);
    assert.ok(code.includes('#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default'), target);
    assert.ok(code.includes('#   dispatcher     : routes to one of: IT claims | Human resources'), target);
    assert.ok(code.includes('#   children       : IT claims (3) | Human resources (4)'), target);
    assert.ok(code.includes('#   parents        : techBuddy (2)'), target);
  }
});

test('testAgentsWithEmptyDbNodeTypeCompileOnEveryTarget', async () => {
  for (const [target, code] of Object.entries(await generateAll())) {
    assert.ok(code.includes('You are Human resources.'), `${target} lost the agent node`);
  }
});

test('testPlaybookAndDispatcherSupportIsStatedHonestly', async () => {
  const all = await generateAll();
  const lg = all.LangGraph;
  assert.ok(lg.includes('playbook "Time Off", 1 bound / 0 unbound action(s), writes ON'));
  assert.ok(lg.includes('(dispatcher: only the chosen one runs)'));
  // Both node kinds now run on every target, and none of them may still claim otherwise.
  for (const t of ['LangGraph', 'ADK', 'MAF', 'NOOA']) {
    const code = all[t];
    assert.ok(!code.includes('NOT RUN BY THIS TARGET'), t);
    assert.ok(!code.includes('menu NOT honoured by this target'), t);
    assert.ok(!code.includes('dispatcher menu not honoured by this target'), t);
    assert.ok(code.includes('PLAYBOOK_GATE_MODE'), `${t}: the playbook gates must be reachable`);
    assert.ok(code.includes('DEEPSEEK_API_KEY'), `${t}: the playbook node's provider key belongs in the run notes`);
  }
  // The three ported targets carry the shared interpreter verbatim; LangGraph calls it through its own node machinery.
  for (const t of ['ADK', 'MAF', 'NOOA']) {
    assert.ok(all[t].includes('async def run_playbook_node('), t);
    assert.ok(all[t].includes('PLAYBOOKS = {'), t);
    assert.match(all[t], /^  pip install .*"langchain-core>=0\.3\.0" .*"langgraph>=0\.2\.50"/m, `${t}: the interpreter's requirement must be stated`);
  }
});

test('testEveryTargetRoutesTheDispatcherMenu', async () => {
  const all = await generateAll();
  assert.ok(all.LangGraph.includes('add_conditional_edges'));
  // ADK: the menu is nested under the dispatcher, so the children are NOT layer members.
  const adk = all.ADK;
  assert.ok(adk.includes('_DispatcherAgent('));
  assert.ok(adk.includes('IT claims'));
  assert.ok(!adk.includes('ParallelAgent(name="layer_2"'));
  // MAF: the edges stay drawn; the choice travels in the message.
  assert.ok(all.MAF.includes('DispatcherNodeExecutor('));
  assert.ok(all.MAF.includes('route_to'));
  // NOOA: the dispatcher's choice is the only child its routes let run (GRAPH driver).
  assert.ok(all.NOOA.includes('run_dispatcher('));
  assert.ok(all.NOOA.includes('routes[nid] = {chosen} if chosen else set()'));
});

/** No target may reference a module global it never defines (a NameError py_compile does not catch). */
test('testNoTargetReferencesAnUndefinedGlobal', { skip: NO_PY }, async () => {
  const allowed = ['SkillRuntime', '_CURRENT_NODE', '_SINK', '__file__'];
  const checker = `import ast, builtins, sys
tree = ast.parse(open(sys.argv[1]).read())
known = set(dir(builtins))
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        known.add(node.name)
    elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
        known.add(node.id)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        for a in node.names:
            known.add((a.asname or a.name).split(".")[0])
    elif isinstance(node, ast.ExceptHandler) and node.name:
        known.add(node.name)
    elif isinstance(node, ast.arg):
        known.add(node.arg)
    elif isinstance(node, ast.Global):
        known.update(node.names)
    elif isinstance(node, ast.MatchAs) and node.name:        # \`case {"k": list() as x}\` binds x
        known.add(node.name)
    elif isinstance(node, ast.MatchStar) and node.name:
        known.add(node.name)
    elif isinstance(node, ast.MatchMapping) and node.rest:
        known.add(node.rest)
used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
print(" ".join(sorted(used - known)))`;
  for (const [target, code] of Object.entries(await generateAll())) {
    withTempPy(checker, (checkerPath) => {
      withTempPy(code, (file) => {
        const [rc, out] = execLines(['python3', checkerPath, file]);
        assert.equal(rc, 0, `${target}: checker failed: ` + out.join('\n'));
        const names = out.join(' ').trim().split(/\s+/).filter((n) => n !== '' && !allowed.includes(n));
        assert.deepEqual(names, [], `${target} references globals it never defines: ` + names.join(', '));
      });
    });
  }
});

test('testEveryTargetStillEmitsValidPython', { skip: NO_PY }, async () => {
  for (const [target, code] of Object.entries(await generateAll())) {
    withTempPy(code, (file) => {
      const [rc, out] = execLines(['python3', '-m', 'py_compile', file]);
      assert.equal(rc, 0, `${target}: ` + out.join('\n'));
    });
  }
});
