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
