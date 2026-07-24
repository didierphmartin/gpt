import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDelegationFunctions } from '../src/AgentTeam/AgentDelegationFunctions';

const worker = (id: number, name: string) =>
  ({ id, name, agentType: 'worker', enabled: true, description: '', provider: 'claude', tools: [], canDelegateTo: [] } as any);

function fakes() {
  const repo: any = {
    findById: async (id: number) => (id === 1 ? { id: 1, name: 'Mgr', agentType: 'manager', canDelegateTo: [] } : null),
    findByName: async (n: string) => (n === 'A' ? worker(5, 'A') : n === 'B' ? worker(6, 'B') : null),
    findWorkerAgents: async () => [worker(5, 'A'), worker(6, 'B')],
  };
  const order: string[] = [];
  const runner: any = {
    // Each run resolves on a later microtask; record start/end order to prove concurrency.
    run: async (agent: any) => {
      order.push(`start:${agent.name}`);
      await new Promise((r) => setImmediate(r));
      order.push(`end:${agent.name}`);
      return { success: true, text: `${agent.name}-done`, tools_used: [], execution_id: agent.id * 10 };
    },
  };
  return { repo, runner, order };
}

test('runAgentsParallel runs delegations concurrently and maps results', async () => {
  const { repo, runner, order } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const out = await d.runAgentsParallel(
    { delegations: [ { agent_name: 'A', task: 'ta' }, { agent_name: 'B', task: 'tb' } ] },
    { user_id: 1, current_agent_id: 1 },
  );
  assert.equal(out.success, true);
  assert.equal(out.successful, 2);
  assert.equal(out.results[0].result, 'A-done');
  assert.equal(out.results[1].execution_id, 60);
  // Both started before either finished => truly concurrent, not sequential.
  assert.deepEqual(order.slice(0, 2), ['start:A', 'start:B']);
});

test('runAgentsParallel rejects an empty batch', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const out = await d.runAgentsParallel({ delegations: [] }, { user_id: 1 });
  assert.equal(out.success, false);
});

test('run_agents_parallel is a registered tool name', () => {
  assert.ok(AgentDelegationFunctions.toolNames().includes('run_agents_parallel'));
});

test('runAgentsParallel rejects a manager-type target with a full 7-key error item', async () => {
  const manager = (id: number, name: string) =>
    ({ id, name, agentType: 'manager', enabled: true, description: '', provider: 'claude', tools: [], canDelegateTo: [] } as any);
  const repo: any = {
    findById: async (_id: number) => null,
    findByName: async (n: string) => (n === 'M' ? manager(9, 'M') : null),
    findWorkerAgents: async () => [],
  };
  let ran = false;
  const runner: any = { run: async () => { ran = true; return { success: true, text: 'x', tools_used: [], execution_id: 1 }; } };
  const d = new AgentDelegationFunctions(repo, runner);
  const out = await d.runAgentsParallel({ delegations: [{ agent_name: 'M', task: 'tm' }] }, { user_id: 1, current_agent_id: 1 });

  const item = out.results[0];
  assert.equal(item.success, false);
  assert.match(item.error, /manager/i);
  // The manager is rejected pre-flight, never delegated (parity with PHP batch-path guard).
  assert.equal(ran, false);
  // All seven keys present (presence, not truthiness — explicit null must pass).
  for (const k of ['index', 'agent', 'task', 'success', 'result', 'error', 'execution_id']) {
    assert.ok(k in item, `missing key: ${k}`);
  }
});

test('runAgentsParallel caps concurrency at 6 (7th waits for the first window to drain)', async () => {
  const worker7 = (id: number, name: string) =>
    ({ id, name, agentType: 'worker', enabled: true, description: '', provider: 'claude', tools: [], canDelegateTo: [] } as any);
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const repo: any = {
    findById: async (_id: number) => null,
    findByName: async (n: string) => worker7(names.indexOf(n) + 10, n),
    findWorkerAgents: async () => [],
  };
  const order: string[] = [];
  const runner: any = {
    run: async (agent: any) => {
      order.push(`start:${agent.name}`);
      await new Promise((r) => setImmediate(r));
      order.push(`end:${agent.name}`);
      return { success: true, text: `${agent.name}-done`, tools_used: [], execution_id: agent.id };
    },
  };
  const d = new AgentDelegationFunctions(repo, runner);
  const out = await d.runAgentsParallel(
    { delegations: names.map((n) => ({ agent_name: n, task: `t${n}` })) },
    { user_id: 1, current_agent_id: 1 },
  );
  assert.equal(out.successful, 7);
  // With CAP=6, the 7th ('g') is in the second window and cannot start
  // until the first window has drained (at least one 'end:' logged).
  const firstEnd = order.findIndex((e) => e.startsWith('end:'));
  assert.ok(firstEnd >= 0, 'expected at least one end event');
  assert.ok(order.indexOf('start:g') > firstEnd, 'start:g must come after the first window drains');
});
