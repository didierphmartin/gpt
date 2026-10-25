/** Port of backend/tests/Unit/LangGraphNodeRulesTest.php (spec 2026-10-15 langgraph standalone §7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlite, makeGenerator, expectMessage } from './support/lgFixturesB';

async function generate(mid: any): Promise<any> {
  sqlite([
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
  ]);
  const graph = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'hi' } },
      mid,
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from_node_id: '1', to_node_id: '2', from_port: 'output_1' },
      { from_node_id: '2', to_node_id: '3', from_port: 'output_1' },
    ],
  };
  return makeGenerator({ workflow: { id: 44, name: 'Rules', user_id: '3' }, graph }).generate(44, '3', {});
}

test('testUnconfiguredTemplateIsRefused', async () => {
  await expectMessage(
    () => generate({ id: '2', node_type: 'agent-template', config: { type: 'agent-template', name: 'Claims', isTemplate: true } }),
    'Unconfigured agent template node found: Claims — pick an agent or fill in its instructions.',
  );
});

test('testConfiguredTemplateCompilesAsAgent', async () => {
  const code = (await generate({ id: '2', node_type: 'agent-template', config: { type: 'agent-template', name: 'Claims',
    agent_name: 'Claims', instructions: 'Summarize the claim.', provider: 'claude' } })).code;
  assert.ok(code.includes('Summarize the claim.'));
});

/** Final review M-i: a node with no type at all is an agent, as WorkflowGraphAnalyzer::typeOf reads it. */
test('testAnUntypedNodeCompilesAsAnAgent', async () => {
  const code = (await generate({ id: '2', node_type: '', config: { name: 'Claims',
    agent_name: 'Claims', instructions: 'Summarize the claim.', provider: 'claude' } })).code;
  assert.ok(code.includes('Summarize the claim.'));
});

test('testUnknownTypeIsRefused', async () => {
  await expectMessage(
    () => generate({ id: '2', node_type: 'loop', config: { type: 'loop', name: 'Loop' } }),
    'Node "Loop" (loop) cannot be compiled: LangGraph runs start, agent, playbook, code and output nodes.',
  );
});
