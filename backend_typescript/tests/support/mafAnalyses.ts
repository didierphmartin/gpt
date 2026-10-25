/**
 * The hand-built analyses backend/tests/Unit's MAF tests compile (MafGeneratorEmitTest::analyzed(),
 * MafGeneratorCompileTest::diamondAnalyzed(), AdkCodeNodeTest::codeAnalyzed()), as plain JS literals: pass one
 * through asPhpArg() for the TypeScript emitters, or as it is to php_cmp.php (json_decode'd there, as PHP builds it).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GraphAnalyzer } from '../../src/AgentTeam/compiler/GraphAnalyzer';
import { CodeNodeEmit } from '../../src/AgentTeam/CodeNodeEmit';
import { entries, oarr } from '../../src/AgentTeam/compiler/php';
import { python3 } from './lgFixturesB';

/** MafGeneratorEmitTest::analyzed(): start -> A(claude) -> output. */
export function emitAnalyzed(): any {
  return {
    workflow: { id: 7, name: 'Demo Flow' },
    byId: {
      '1': { id: '1', type: 'start', config: [] },
      '2': { id: '2', type: 'agent', config: [] },
      '3': { id: '3', type: 'output', config: [] },
    },
    layers: [['1'], ['2'], ['3']],
    parents: { '2': ['1'], '3': ['2'] },
    startNodeId: '1',
    agents: {
      '2': {
        name: 'A', systemPrompt: 'You are A.', provider: 'claude', model: 'claude-sonnet-4-6', temperature: null, max_tokens: null,
        tools: [], skill_content: '', skills: [], documents: [],
      },
    },
    usedCatalog: [], usedServers: [],
    startPrompt: 'Analyze example.com', startDocuments: [],
    outputStorageEnabled: false, outputFolder: null,
  };
}

/** MafGeneratorCompileTest::diamondAnalyzed(): start -> A, B -> C -> output. */
export function diamondAnalyzed(): any {
  const agent = (name: string, provider: string, model: string) => ({
    name, systemPrompt: name, provider, model, temperature: null, max_tokens: null, tools: [], skill_content: '', skills: [], documents: [],
  });
  return {
    workflow: { id: 9, name: 'Diamond' },
    byId: {
      '1': { id: '1', type: 'start', config: [] },
      '2': { id: '2', type: 'agent', config: [] },
      '3': { id: '3', type: 'agent', config: [] },
      '4': { id: '4', type: 'agent', config: [] },
      '5': { id: '5', type: 'output', config: [] },
    },
    layers: [['1'], ['2', '3'], ['4'], ['5']],
    parents: { '2': ['1'], '3': ['1'], '4': ['2', '3'], '5': ['4'] },
    startNodeId: '1',
    agents: { '2': agent('A', 'claude', 'm'), '3': agent('B', 'openai', 'gpt-4o'), '4': agent('C', 'gemini', 'gemini-2.5-flash') },
    usedCatalog: [], usedServers: [], startPrompt: 'go', startDocuments: [],
    outputStorageEnabled: true, outputFolder: null,
  };
}

/** The MCP fixture both MAF test classes add: one web_search tool on one server, used by agent 2. */
export function withMcp(a: any): any {
  a.usedServers = { 'https://mcp.example/mcp': { url: 'https://mcp.example/mcp' } };
  a.usedCatalog = {
    web_search: {
      server_url: 'https://mcp.example/mcp', tool_name: 'web_search',
      input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  };
  a.agents['2'].tools = ['web_search'];
  return a;
}

/** AdkCodeNodeTest::codeAnalyzed(): start -> code node C (calls the Outlook server) -> output, as a PHP-shaped array. */
export function codeAnalyzed(src = "def run(input, call_tool):\n    return {'output': {'got': input}}\n"): any {
  const graph: any = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'code', config: { type: 'code', name: 'C', code: src, exits: ['next'], mcp_servers: ['Outlook'], timeout_s: 30 } },
      { id: '3', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }],
  };
  const a: any = oarr(entries(GraphAnalyzer.analyzeGraph(graph)));
  for (const [k, v] of Object.entries<any>({
    workflow: oarr([['id', 8], ['name', 'code']]), generated_at: '2026-01-01 00:00:00 UTC',
    usedCatalog: [], usedServers: [], serverSlugs: oarr([['http://localhost:8770', 'outlook']]),
    startPrompt: 'GO', startDocuments: [], agents: [], playbooks: [],
  })) a[k] = v;
  a.code = oarr([['2', CodeNodeEmit.nodeData(graph.nodes[1], graph.edges, { outlook: 'http://localhost:8770' }, ['1', '2', '3'])]]);
  return a;
}

/** MafParityTest::pyCompile(): [exit code, output] of `python3 -m py_compile` on the code. */
export function pyCompile(code: string): [number, string] {
  const dir = mkdtempSync(path.join(tmpdir(), 'mafp_'));
  const f = path.join(dir, 'gen.py');
  writeFileSync(f, code);
  try {
    const r = spawnSync(python3() ?? 'python3', ['-m', 'py_compile', f], { encoding: 'utf8' });
    return [r.status ?? -1, (r.stdout ?? '') + (r.stderr ?? '')];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Why a python3 test skips ('' = it runs), as PHP's markTestSkipped('python3 not on PATH'). */
export function noPython(): string | false {
  return python3() === null ? 'python3 not on PATH' : false;
}
