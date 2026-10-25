/**
 * Port of backend/tests/Unit/LangGraphModularGeneratorTest.php: LangGraph compiler, modular mode ("agents in
 * separate files"): workflow.py, common.py and one importable module per agent/playbook node under agents/.
 * Fixture (workflow 44, "Dispatcher demo") is shared with the A2A test (tests/support/lgFixtures.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { LangGraphGenerator } from '../src/AgentTeam/LangGraphGenerator';
import { keysOf } from '../src/AgentTeam/compiler/php';
import { a2aFacts, a2aGenerator, pyCompile, python3 } from './support/lgFixtures';

const facts = () => a2aFacts();
const generator = () => a2aGenerator();
const manifest = async (): Promise<any> => generator().generate(44, '3', { modular: true });

async function files(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await manifest()).files) out[f.path] = f.code;
  return out;
}

function assertCompiles(code: string, label: string): void {
  const r = pyCompile(code);
  assert.equal(r.rc, 0, `${label}: ` + r.out.join('\n'));
}

/** Every top-level name a module binds: definitions and names pulled in by its own imports. */
function boundNames(code: string): string[] {
  const names: string[] = [];
  for (const line of code.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:async\s+)?def\s+(\w+)/))) {
      names.push(m[1]);
    } else if ((m = line.match(/^class\s+(\w+)/))) {
      names.push(m[1]);
    } else if ((m = line.match(/^(\w+)\s*(?::[^=]+)?=[^=]/))) {
      names.push(m[1]);
    } else if ((m = line.match(/^from\s+[\w.]+\s+import\s+(.+)$/))) {
      for (let n of m[1].split(',')) {
        n = n.trim();
        if (n === '' || n === '(') continue;
        const a = n.match(/\s+as\s+(\w+)/);
        names.push(a ? a[1] : n.replace(/^[()]+|[()]+$/g, ''));
      }
    } else if ((m = line.match(/^import\s+(\w+)/))) {
      names.push(m[1]);
    }
  }
  return [...new Set(names)];
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('testLayoutNamesOneImportableModulePerAgentOrPlaybookNode', async () => {
  const layout = LangGraphGenerator.modularLayout(await facts());
  assert.equal(layout.root, 'dispatcher_demo_modular');
  assert.deepEqual(keysOf(layout.agents).map(String), ['2', '3', '4', '5'], 'ORDER order, no start/output');
  assert.equal(layout.agents['2'].file, 'agents/techbuddy.py');
  assert.equal(layout.agents['3'].file, 'agents/it_claims.py');
  assert.equal(layout.agents['4'].file, 'agents/human_resources.py');
  assert.equal(layout.agents['5'].file, 'agents/playbook_hr.py');
  assert.equal(layout.agents['3'].module, 'agents.it_claims');
  for (const k of keysOf(layout.agents)) {
    assert.match(path.basename(layout.agents[k].file, '.py'), /^[a-z_][a-z0-9_]*$/, 'valid module name');
  }
});

test('testModuleNamesFallBackWhenTheDisplayNameIsNotAnIdentifier', async () => {
  const f = await facts();
  f.agentData['3'].display = '2024 Réview!';
  f.agentData['4'].display = '2024 Review';
  const layout = LangGraphGenerator.modularLayout(f);
  assert.equal(layout.agents['3'].file, 'agents/node_3_2024_review.py');
  assert.equal(layout.agents['4'].file, 'agents/node_4_2024_review.py');
});

test('testModularOptionReturnsAManifest', { skip: python3() === null ? 'python3 not available' : false }, async () => {
  const m = await manifest();
  assert.equal(m.root, 'dispatcher_demo_modular');
  assert.deepEqual(m.files.map((f: any) => f.path), [
    'workflow.py', 'common.py', 'api.py', 'agents/__init__.py',
    'agents/techbuddy.py', 'agents/it_claims.py', 'agents/human_resources.py', 'agents/playbook_hr.py',
    'requirements.txt', '.env.example', 'README.md', 'skills/html/SKILL.md',
    'ARCHITECTURE.md',
  ]);
  for (const f of m.files) {
    if (!f.path.endsWith('.py')) continue;
    assertCompiles(f.code, f.path);
    if (f.path === 'agents/__init__.py') continue;
    assert.ok(f.code.includes('PROVENANCE'), f.path);
    if (f.path === 'common.py' || f.path === 'api.py') continue;
    assert.ok(f.code.includes('GRAPH EDGES'), f.path);
  }
});

test('testCommonModuleHoldsTheSharedRuntimeAndNoGraph', async () => {
  const code = (await files())['common.py'];
  for (const needle of ['"""Shared runtime for workflow "Dispatcher demo"', 'def _make_llm(', 'class McpClient:',
    'class ToolCatalog:', 'class SkillRuntime:', 'TOOLS = ToolCatalog(TOOL_CATALOG)',
    'class Dispatcher:', 'def inject_datetime(', 'def build_context(',
    'class DocumentConverter:', 'class WFState(', 'class PlaybookToolset:',
    '    def gate(self, kind: str, name: str, args: dict) -> dict:', 'class Node(ABC):', 'def make_node(cfg: dict) -> Node:',
    'class WorkflowGraph:', 'def save_output(', 'def print_run_summary(', 'RUN SUMMARY']) {
    assert.ok(code.includes(needle), `missing: ${needle}`);
  }
  assert.ok(code.includes('"get_news"'));
  for (const needle of ['EDGES = ', 'ORDER = ', 'NODE_TYPES = ', 'NODE = {', 'AGENTS = {']) {
    assert.doesNotMatch(code, new RegExp('(?<![A-Z_])' + escRe(needle)), `common.py must not carry: ${needle}`);
  }
  assert.doesNotMatch(code, /^async def run\(/m);
});

test('testAgentModuleImportsTheRuntimeAndBakesOnlyItsOwnNode', async () => {
  const code = (await files())['agents/it_claims.py'];
  for (const needle of ['"""Agent module "IT claims" -- node 3 of workflow "Dispatcher demo"',
    'from common import', 'run_node = make_node(NODE).run', 'NODE = {', '"kind": "agent"',
    '# ---- node 3: IT claims (agent)', '<== this module']) {
    assert.ok(code.includes(needle), `missing: ${needle}`);
  }
  assert.ok(code.includes('"tool_names": ["get_news","run_skill_script"]'));
  assert.ok(code.includes('"skills": [{"dir":"html"}]'));
  for (const needle of ['class McpClient', 'class ToolCatalog', 'def _make_llm(',
    'TOOL_CATALOG = ', 'def build_agent_card', 'uvicorn']) {
    assert.ok(!code.includes(needle), `agent module must not carry: ${needle}`);
  }
});

test('testDispatcherModuleCarriesItsMenu', async () => {
  const code = (await files())['agents/techbuddy.py'];
  assert.ok(code.includes('"kind": "dispatcher"'));
  assert.ok(code.includes('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]'));
  assert.ok(code.includes('run_node = make_node(NODE).run'));
});

test('testPlaybookModuleKeepsConsoleGates', async () => {
  const fs = await files();
  const code = fs['agents/playbook_hr.py'];
  assert.ok(code.includes('"kind": "playbook"'));
  assert.ok(code.includes('"instructions": """'));
  assert.ok(fs['common.py'].includes('class PlaybookNode(Node):'));
  assert.ok(code.includes('"workday__get_pto_balance"'));
  assert.ok(!code.includes('_a2a_gate'));
  assert.ok(!code.includes('requires_input('));
});

test('testWorkflowModuleWiresTheGraphOverTheAgentModules', async () => {
  const code = (await files())['workflow.py'];
  for (const needle of ['"""LangGraph workflow: Dispatcher demo', 'from agents.techbuddy import run_node as techbuddy_run',
    'from agents.playbook_hr import run_node as playbook_hr_run', 'from common import',
    'EDGES = ', 'ORDER = ', 'NODE_TYPES = ', 'def build_graph(recorder: RunRecorder | None = None) -> WorkflowGraph:',
    'async def run(', 'save_output(', 'print_run_summary(',
    'if __name__ == "__main__":', 'AGENT MODULES']) {
    assert.ok(code.includes(needle), `missing: ${needle}`);
  }
  for (const needle of ['class PlaybookToolset:', 'class ToolCatalog', 'create_react_agent(', 'PLAYBOOK_SYSTEM_PROMPT = ']) {
    assert.ok(!code.includes(needle), `workflow.py must not carry: ${needle}`);
  }
});

/** The seam: every `from common import X` / `from agents.y import Z` resolves to a name that module binds. */
test('testEveryCrossModuleImportResolves', async () => {
  const fs = await files();
  const bound: Record<string, string[]> = {};
  for (const [p, code] of Object.entries(fs)) {
    const mod = p === 'workflow.py' ? 'workflow' : p === 'common.py' ? 'common' : 'agents.' + path.basename(p, '.py');
    bound[mod] = boundNames(code);
  }
  let checked = 0;
  for (const [p, code] of Object.entries(fs)) {
    for (const m of code.matchAll(/^from\s+(common|agents\.\w+)\s+import\s+(.+)$/gm)) {
      assert.ok(m[1] in bound, `${p} imports unknown module ${m[1]}`);
      for (let name of m[2].split(',')) {
        name = name.trim();
        const a = name.match(/^(\w+)\s+as\s+\w+$/);
        const symbol = a ? a[1] : name;
        assert.ok(bound[m[1]].includes(symbol), `${p}: ${m[1]} does not define ${symbol}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10, 'expected the modules to actually import from each other');
});

test('testSingleFileOutputUnchangedWithoutTheOption', async () => {
  const code = ((await generator().generate(44, '3')) as any).code;
  assert.ok(code.includes('"""Standalone LangGraph workflow: Dispatcher demo'));
  assert.ok(code.includes('PLAYBOOKS = {'));
  assert.ok(!code.includes('from common import'));
});
