import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolsExecutor } from '../src/AgentTeam/AgentToolsExecutor';

test('routes delegation tool to the delegation handler; others to base', async () => {
  const calls: string[] = [];
  const base: any = {
    execute: async (n: string) => { calls.push('base:' + n); return { base: true }; },
    hasFunction: () => true,
    isMCPTool: () => false,
    getToolDefinitions: () => [{ name: 'x', description: '', input_schema: {} }],
  };
  // Fake delegation: real AgentDelegationFunctions.toolNames() drives routing, so we only
  // need getAllFunctions() to provide a handler for the delegation tool name.
  const delegation: any = {
    getAllFunctions: () => ({
      delegate_to_agent: { schema: {}, handler: async () => ({ delegated: true }) },
    }),
  };
  const runner: any = { getExecutionContext: () => ({ user_id: 1 }) };

  const exec = new AgentToolsExecutor(base, delegation, runner);

  const del = await exec.execute('delegate_to_agent', { task: 't' });
  assert.deepEqual(del, { delegated: true });

  const other = await exec.execute('some_mcp_tool', {});
  assert.deepEqual(other, { base: true });
  assert.deepEqual(calls, ['base:some_mcp_tool']);

  assert.equal(exec.hasFunction('delegate_to_agent'), true);
  assert.equal(exec.isMCPTool('delegate_to_agent'), false);
});
