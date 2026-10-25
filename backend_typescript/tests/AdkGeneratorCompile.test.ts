/**
 * Port of backend/tests/Unit/AdkGeneratorCompileTest.php: emitAdk() always produces syntactically valid Python
 * (py_compile gate, skipped without python3), and the diamond workflow matches backend/'s committed golden file
 * (backend/tests/fixtures/adk_diamond.golden.py, read from there) byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { pyCompile, python3 } from './support/lgFixtures';
import { agentRecord, analyzedOf, assertSameAsPhp } from './support/adkAnalyses';

const PY_SKIP = python3() === null ? 'python3 not found on PATH — skipping py_compile gate' : undefined;
const GOLDEN = path.resolve(__dirname, '../../backend/tests/fixtures/adk_diamond.golden.py');

/** Diamond analyzed fixture (start -> [A‖B] -> output). */
function diamondAnalyzed(): any {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'A', provider: 'claude', model: 'm', selectedTools: [] } },
      { id: '3', type: 'agent', config: { type: 'agent', agent_name: 'B', systemPrompt: 'B', provider: 'gemini', model: 'g', selectedTools: [] } },
      { id: '4', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '1', to: '3' }, { from: '2', to: '4' }, { from: '3', to: '4' }],
  };
  return analyzedOf(graph, {
    workflow: { id: 1, name: 'diamond' },
    generated_at: '2026-01-01 00:00:00 UTC',
    usedCatalog: [],
    usedServers: [],
    startPrompt: 'GO',
    startDocuments: [],
    agents: { 2: agentRecord('A', 'A', 'claude', 'm'), 3: agentRecord('B', 'B', 'gemini', 'g') },
  });
}

/**
 * Full-featured analyzed fixture: agent 2 (claude) with a skill, MCP tool 'search', temperature + max_tokens;
 * agent 3 (gemini) plain; start -> 2 -> 3 -> output; usedServers + usedCatalog seeded so MCP blocks are emitted.
 */
function fullFeaturedAnalyzed(): any {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'Analyse the market' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'Researcher',
        systemPrompt: "Research and call run_skill_script with dir_name='html/create'",
        provider: 'claude', model: 'claude-sonnet-4-6', selectedTools: ['search'] } },
      { id: '3', type: 'agent', config: { type: 'agent', agent_name: 'Writer',
        systemPrompt: 'Write report', provider: 'gemini', model: 'gemini-2.5-pro', selectedTools: [] } },
      { id: '4', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }],
  };
  return analyzedOf(graph, {
    workflow: { id: 99, name: 'full_featured' },
    usedServers: { 'http://localhost:9001/mcp': { name: 'mcp-server' } },
    usedCatalog: {
      search: {
        server_url: 'http://localhost:9001/mcp',
        description: 'Web search',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
    startPrompt: 'Analyse the market',
    startDocuments: [],
    agents: {
      2: agentRecord('Researcher', "Research and call run_skill_script with dir_name='html/create'", 'claude', 'claude-sonnet-4-6',
        { temperature: 0.5, max_tokens: 2048, tools: ['search'], skills: [{ dir: 'html/create' }] }),
      3: agentRecord('Writer', 'Write report', 'gemini', 'gemini-2.5-pro'),
    },
  });
}

test('testDiamondFixtureCompiles', { skip: PY_SKIP }, () => {
  const r = pyCompile(ADKGenerator.emitAdk(diamondAnalyzed()));
  assert.equal(r.rc, 0, `Diamond fixture failed py_compile:\n${r.out.join('\n')}`);
});

test('testDiamondMatchesGolden', { skip: existsSync(GOLDEN) ? undefined : `Golden fixture not found at ${GOLDEN}` }, () => {
  assert.equal(ADKGenerator.emitAdk(diamondAnalyzed()), readFileSync(GOLDEN, 'utf8'),
    'emitAdk() output diverged from adk_diamond.golden.py');
});

test('testFullFeaturedFixtureCompiles', { skip: PY_SKIP }, () => {
  const code = ADKGenerator.emitAdk(fullFeaturedAnalyzed());
  assert.ok(code.includes('_run_skill_script'), 'Skill runtime must be emitted when an agent has a skill');
  assert.ok(code.includes('_make_skill_tool("html/create")'), 'Skill must compile to a dir-scoped skill step');
  assert.ok(code.includes('node_2 = SequentialAgent('), 'A skill node must compile to a SequentialAgent(main agent + skill steps)');
  assert.ok(code.includes('http://localhost:9001/mcp'), 'MCP server URL must be baked into output');
  assert.ok(code.includes('FunctionTool('), 'MCP FunctionTool wrappers must be emitted');
  assert.ok(code.includes('temperature=0.5'), 'temperature must be emitted in GenerateContentConfig');
  assert.ok(code.includes('max_output_tokens=2048'), 'max_output_tokens must be emitted in GenerateContentConfig');
  assert.ok(code.includes('_make_model("claude", "claude-sonnet-4-6", thinking='), 'Claude agent must use correct model factory call');
  assert.ok(code.includes('_make_model("gemini", "gemini-2.5-pro", thinking='), 'Gemini agent must use correct model factory call');
  const r = pyCompile(code);
  assert.equal(r.rc, 0, `Full-featured fixture failed py_compile:\n${r.out.join('\n')}`);
});

test('testWithStartDocumentsCompiles', { skip: PY_SKIP }, () => {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'Summarise the document' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'Summariser',
        systemPrompt: 'Summarise the attached document.', provider: 'claude', model: 'claude-sonnet-4-6', selectedTools: [] } },
      { id: '3', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  };
  const a = analyzedOf(graph, {
    workflow: { id: 42, name: 'doc_summary' },
    usedCatalog: [],
    usedServers: [],
    startPrompt: 'Summarise the document',
    startDocuments: [{ name: 'report.pdf', path: '/uploads/reports/report.pdf' }],
    agents: { 2: agentRecord('Summariser', 'Summarise the attached document.', 'claude', 'claude-sonnet-4-6') },
  });
  const code = ADKGenerator.emitAdk(a);
  assert.ok(code.includes('def _convert_doc_to_markdown('), '_convert_doc_to_markdown must be emitted');
  assert.match(code, /START_DOCUMENTS = \[/, 'START_DOCUMENTS must be a non-empty list');
  assert.ok(code.includes('"path": "/uploads/reports/report.pdf"'), 'Doc path must be baked into START_DOCUMENTS');
  assert.ok(code.includes('if START_DOCUMENTS:'), 'main() prepend guard must be emitted');
  const r = pyCompile(code);
  assert.equal(r.rc, 0, `With-start-documents fixture failed py_compile:\n${r.out.join('\n')}`);
  assertSameAsPhp(a);
});

test('the diamond and full-featured scripts are PHP\'s', () => {
  assertSameAsPhp(diamondAnalyzed());
  assertSameAsPhp(fullFeaturedAnalyzed());
});
