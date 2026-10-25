/**
 * The hand-built analyses backend/tests/Unit/Adk*Test.php compile (AdkCodeNodeTest::mcpAnalyzed(), codeAnalyzed(),
 * wf64Analyzed(), ...), built the same way in TypeScript: GraphAnalyzer.analyzeGraph() over the graph, array_merge'd
 * with the test's keys, code nodes through CodeNodeEmit.nodeData(). Also the PHP side of the differential checks:
 * ADKGenerator::emitAdk() (or any static) of the same array, through tests/fixtures/compiler/php_compile.php.
 */
import { asPhpArg } from './phpCmp';
import assert from 'node:assert/strict';
import { maskStamps, phpCall, phpSkipReason } from './phpCompiler';
import { ADKGenerator } from '../../src/AgentTeam/ADKGenerator';
import { entries, oarr, values } from '../../src/AgentTeam/compiler/php';
import { GraphAnalyzer } from '../../src/AgentTeam/compiler/GraphAnalyzer';
import { CodeNodeEmit } from '../../src/AgentTeam/CodeNodeEmit';

/** array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), $extra): the graph as PHP's json_decode(..., true) holds it. */
export function analyzedOf(graph: any, extra: Record<string, any>): any {
  const base = GraphAnalyzer.analyzeGraph(asPhpArg(graph));
  return oarr([...entries(base), ...entries(asPhpArg(extra))]);
}

/** $a['code'][$cid] = CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], $slugToUrl, $ids) for each of $cids. */
export function withCode(a: any, graph: any, cids: string[], slugToUrl: Record<string, string> = {}, ids: string[] | null = null): any {
  const g = asPhpArg(graph);
  const byId = new Map<string, any>();   // array_column($graph['nodes'], null, 'id'): insertion order, numeric-looking ids too
  for (const n of values(g.nodes)) byId.set(String(n.id), n);
  const code = oarr();
  for (const cid of cids) {
    code[cid] = CodeNodeEmit.nodeData(byId.get(cid), g.edges, slugToUrl, ids ?? [...byId.keys()]);
  }
  a['code'] = code;
  return a;
}

/** An agent record of the analysis, as the tests write it. */
export function agentRecord(name: string, systemPrompt: string, provider: string, model: string, extra: Record<string, any> = {}): any {
  return { name, systemPrompt, provider, model, temperature: null, max_tokens: null, tools: [], skill_content: '', output_schema_id: null, documents: [], ...extra };
}

/** AdkCodeNodeTest::mcpAnalyzed(): Start -> agent A (one MCP tool on server "Outlook") -> Output. */
export function mcpAnalyzed(): any {
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
    { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'A', provider: 'claude', model: 'm', selectedTools: ['list_mail'] } },
    { id: '3', type: 'output', config: { type: 'output' } },
  ], edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }] };
  return analyzedOf(graph, {
    workflow: { id: 7, name: 'mcp' }, generated_at: '2026-01-01 00:00:00 UTC',
    usedCatalog: { list_mail: { server_url: 'http://localhost:8770', description: 'List', input_schema: { type: 'object', properties: [] } } },
    usedServers: { 'http://localhost:8770': { name: 'Outlook' } },
    serverSlugs: { 'http://localhost:8770': 'outlook' },
    startPrompt: 'GO', startDocuments: [],
    agents: { 2: agentRecord('A', 'A', 'claude', 'm', { tools: ['list_mail'] }) },
  });
}

export const CODE_SRC = "def run(input, call_tool):\n    return {'output': {'got': input}}\n";

/** AdkCodeNodeTest::codeAnalyzed(): Start -> code C (exits next, server Outlook) -> Output. */
export function codeAnalyzed(src: string = CODE_SRC): any {
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
    { id: '2', type: 'code', config: { type: 'code', name: 'C', code: src, exits: ['next'], mcp_servers: ['Outlook'], timeout_s: 30 } },
    { id: '3', type: 'output', config: { type: 'output' } },
  ], edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }] };
  const a = analyzedOf(graph, {
    workflow: { id: 8, name: 'code' }, generated_at: '2026-01-01 00:00:00 UTC',
    usedCatalog: [], usedServers: [], serverSlugs: { 'http://localhost:8770': 'outlook' },
    startPrompt: 'GO', startDocuments: [], agents: [], playbooks: [],
  });
  return withCode(a, graph, ['2'], { outlook: 'http://localhost:8770' }, ['1', '2', '3']);
}

/** AdkCodeNodeTest::wf64Analyzed(): Start -> trigger T (new_mail, no_mail) -> dispatcher D -> code A | code B -> Output O. */
export function wf64Analyzed(): any {
  const code = "def run(input, call_tool):\n    return {'output': input}\n";
  const graph = { nodes: [
    { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
    { id: '10', type: 'code', config: { type: 'code', name: 'T', code: "def run(input, call_tool):\n    return {'route': 'new_mail', 'output': {'subject': 'hi'}}\n", exits: ['new_mail', 'no_mail'], mcp_servers: [] } },
    { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'D', agent_type: 'dispatcher', provider: 'claude', model: 'm' } },
    { id: '3', type: 'code', config: { type: 'code', name: 'A', code, exits: ['next'], mcp_servers: [] } },
    { id: '4', type: 'code', config: { type: 'code', name: 'B', code, exits: ['next'], mcp_servers: [] } },
    { id: '5', type: 'output', config: { type: 'output' } },
  ], edges: [
    { from: '1', to: '10', from_port: 'output_1' },
    { from: '10', to: '2', from_port: 'output_1' },
    { from: '2', to: '3' }, { from: '2', to: '4' },
    { from: '3', to: '5' }, { from: '4', to: '5' },
  ] };
  const a = analyzedOf(graph, {
    workflow: { id: 64, name: 'wf64' }, generated_at: '2026-01-01 00:00:00 UTC',
    usedCatalog: [], usedServers: [], serverSlugs: [],
    startPrompt: 'GO', startDocuments: [], playbooks: [],
    agents: { 2: agentRecord('D', 'Route the email.', 'claude', 'm') },
  });
  return withCode(a, graph, ['10', '3', '4'], {}, ['1', '10', '2', '3', '4', '5']);
}

/** PHP's ADKGenerator::emitAdk() of the same analysis. */
export function phpEmitAdk(a: any): string {
  return phpCall('ADKGenerator', 'emitAdk', [a]);
}

/** TypeScript's emitAdk() equals PHP's for the same analysis (the doc's generation stamp masked); a no-op without PHP. */
export function assertSameAsPhp(a: any): void {
  if (phpSkipReason()) return;
  assert.equal(maskStamps(ADKGenerator.emitAdk(a)), maskStamps(phpEmitAdk(a)), "TypeScript emitAdk() equals PHP's");
}
