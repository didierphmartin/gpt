import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../src/AgentTeam/AgentRunner';

test('buildToolsForAgent returns the 3 delegation tools for a manager', () => {
  const runner = new AgentRunner();
  const manager = { id: 1, name: 'M', agentType: 'manager', canDelegateTo: [], enabled: true } as any;
  const mcpLoader: any = { getToolDefinitions: () => [] };
  const tools = (runner as any).buildToolsForAgent(manager, mcpLoader, null);
  const names = tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ['complete_task', 'delegate_to_agent', 'list_available_agents']);
});

test('buildToolsForAgent for a worker does not include delegation tools', () => {
  const runner = new AgentRunner();
  const worker = { id: 2, name: 'W', agentType: 'worker', enabled: true } as any;
  const mcpLoader: any = { getToolDefinitions: () => [] };
  const tools = (runner as any).buildToolsForAgent(worker, mcpLoader, null);
  assert.equal(tools.some((t: any) => t.name === 'delegate_to_agent'), false);
});
