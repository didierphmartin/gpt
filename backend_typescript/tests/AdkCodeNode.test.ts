/**
 * Port of backend/tests/Unit/AdkCodeNodeTest.php: the ADK target's MCP client (per-server headers, URL override)
 * and its code nodes (the editor's harness, the _CodeAgent, the gates of a wf 64-shaped workflow). Each emitted
 * script is also compared with PHP's ADKGenerator::emitAdk() of the same analysis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { GraphAnalyzer } from '../src/AgentTeam/compiler/GraphAnalyzer';
import { asPhpArg, asText, cmpWf64 } from './support/phpCmp';
import { maskStamps, phpSkipReason } from './support/phpCompiler';
import { execPy, pyCompile, python3 } from './support/lgFixtures';
import { assertSameAsPhp, codeAnalyzed, mcpAnalyzed, wf64Analyzed } from './support/adkAnalyses';

const PHP_SKIP = phpSkipReason() || undefined;
const PY_SKIP = python3() === null ? 'python3 not found on PATH' : undefined;

/** Runs a snippet against the emitted module's MCP helpers (no network). */
function runPy(code: string, snippet: string, env: Record<string, string> = {}): [number, string] {
  const dir = mkdtempSync(path.join(tmpdir(), 'adkcn_'));
  // Only the MCP CLIENT section: from its banner to the next banner.
  const start = code.indexOf('MCP_SERVER_SLUGS = ');
  const end = code.indexOf('# =====', start);
  writeFileSync(path.join(dir, 'm.py'), 'import json, os, time\nimport httpx\n' + code.slice(start, end) + '\n' + snippet);
  const r = execPy('python3', ['m.py'], { cwd: dir, env: { ...process.env, ...env } });
  return [r.rc, r.out.join('\n')];
}

test('testMcpClientBakesSlugsAndReadsHeadersFromEnv', () => {
  const code = ADKGenerator.emitAdk(mcpAnalyzed());
  assert.ok(code.includes('MCP_SERVER_SLUGS = {\n    "http://localhost:8770": "outlook"'));
  assert.ok(code.includes('MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}'));
  assert.ok(code.includes('var = f"MCP_HEADERS_{slug.upper()}"'));
  assert.ok(code.includes('def _call_mcp_tool_raw(server_url: str, tool_name: str, arguments: dict) -> dict:'));
  // ADK no longer emits the shared client
  assert.ok(!code.includes('def _init_mcp_session(url: str, headers: dict)'));
  assertSameAsPhp(mcpAnalyzed());
});

test('testDotenvLookupCoversSingleFileAndPackage', () => {
  const code = ADKGenerator.emitAdk(mcpAnalyzed());
  assert.ok(code.includes('for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):'));
});

test('testHeadersMergeAndBadJsonNamesTheVariable', { skip: PY_SKIP }, () => {
  const code = ADKGenerator.emitAdk(mcpAnalyzed());
  let [rc, out] = runPy(code, 'print(_mcp_headers("http://localhost:8770")["X-Outlook-Account"])',
    { MCP_HEADERS_OUTLOOK: '{"X-Outlook-Account":"acc-1"}' });
  assert.equal(rc, 0, out);
  assert.equal(out.trim(), 'acc-1');
  [rc, out] = runPy(code, '_mcp_headers("http://localhost:8770")', { MCP_HEADERS_OUTLOOK: '{oops' });
  assert.notEqual(rc, 0);
  assert.ok(out.includes('MCP_HEADERS_OUTLOOK in .env is not valid JSON'), out);
});

test('testUrlOverrideFromEnv', { skip: PY_SKIP }, () => {
  const code = ADKGenerator.emitAdk(mcpAnalyzed());
  const [rc, out] = runPy(code, 'print(_mcp_live_url("http://localhost:8770"))', { MCP_URL_OUTLOOK: 'http://h:1' });
  assert.equal(rc, 0, out);
  assert.equal(out.trim(), 'http://h:1');
});

test('testCodeNodeEmitsCodeAgentWithHarness', () => {
  const code = ADKGenerator.emitAdk(codeAnalyzed());
  // the single file embeds the editor's harness, as LangGraph's single file does
  assert.ok(code.includes('CODE_HARNESS = types_module.ModuleType("code_node_harness")'));
  assert.ok(code.includes('class _CodeAgent(BaseAgent):'));
  assert.ok(code.includes('node_2 = _CodeAgent('));
  assert.ok(code.includes('parents=[["user_prompt", "Start", True]]'));
  assert.ok(code.includes('node_name=self.display'));
  assert.match(code, /sub_agents=\[\s*node_2,\s*node_3\s*\]/);
  if (!PY_SKIP) {
    const r = pyCompile(code);
    assert.equal(r.rc, 0, r.out.join('\n'));
  }
  assertSameAsPhp(codeAnalyzed());
});

test('testCodeParentsSubstituteDispatcher', () => {
  // Start -> code T -> dispatcher D (agent with menu) -> code B
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start' } },
    { id: '2', type: 'code', config: { type: 'code', name: 'T', code: 'def run(input, call_tool):\n    return 1\n', exits: ['next'], mcp_servers: [] } },
    { id: '3', type: 'agent', config: { type: 'agent', agent_name: 'D', agent_type: 'dispatcher' } },
    { id: '4', type: 'code', config: { type: 'code', name: 'B', code: 'def run(input, call_tool):\n    return 1\n', exits: ['next'], mcp_servers: [] } },
  ], edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }] };
  const a = GraphAnalyzer.analyzeGraph(asPhpArg(graph));
  assert.deepEqual(ADKGenerator.codeParents(a, '2'), [['user_prompt', 'Start', true]]);
  assert.deepEqual(ADKGenerator.codeParents(a, '4'), [['node_2', 'T', false]]);
});

test('testWf64ShapeRoutesThroughGatesAndNestsCodeInDispatcher', () => {
  const code = ADKGenerator.emitAdk(wf64Analyzed());
  // dispatcher menu nests the code branches
  assert.match(code, /node_2__dispatch = _DispatcherAgent\(.*?sub_agents=\[node_2, node_3, node_4\]/s);
  // dispatcher reads the trigger's output as its task and in its instruction
  assert.ok(code.includes('task_keys=["node_10"]'));
  assert.match(code, /_agent_instruction\(.*?\["node_10"\]\)/s);
  // the dispatcher runs only on the work exit
  assert.ok(code.includes('_Gate(name="gate_2", when=[["node_10", "route_10", "new_mail"]], sub_agents=[node_2__dispatch])'));
  // Output runs when one branch ran
  assert.ok(code.includes('_Gate(name="gate_5", when=[["node_3", "", ""], ["node_4", "", ""]], sub_agents=[node_5])'));
  // branch code nodes read the trigger's output, not the dispatcher's text
  assert.ok(code.includes('parents=[["node_10", "T", False]]'));
  if (!PY_SKIP) assert.equal(pyCompile(code).rc, 0);
  assertSameAsPhp(wf64Analyzed());
});

test('testUngatedWorkflowUnchanged', () => {
  assert.ok(!ADKGenerator.emitAdk(mcpAnalyzed()).includes('_Gate('));
});

test('wf64Analyzed() is the analysis PHP builds (AdkCodeNodeTest::wf64Analyzed)', { skip: PHP_SKIP }, () => {
  assert.equal(asText(wf64Analyzed()), asText(cmpWf64()));
  assert.equal(maskStamps(ADKGenerator.emitAdk(cmpWf64())), maskStamps(ADKGenerator.emitAdk(wf64Analyzed())));
});
