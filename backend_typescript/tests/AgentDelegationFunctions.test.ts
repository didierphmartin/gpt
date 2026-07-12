import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDelegationFunctions } from '../src/AgentTeam/AgentDelegationFunctions';

const worker = { id: 5, name: 'Researcher', agentType: 'worker', enabled: true, description: 'r', provider: 'claude', tools: [], canDelegateTo: [] } as any;
const manager = { id: 1, name: 'Mgr', agentType: 'manager', enabled: true, canDelegateTo: [] } as any;

function fakes(overrides: any = {}) {
  const repo: any = {
    findById: async (id: number) => (id === 5 ? worker : id === 1 ? manager : null),
    findByName: async (n: string) => (n === 'Researcher' ? worker : null),
    findWorkerAgents: async () => [worker],
    findAccessibleByUser: async () => [worker],
    ...overrides.repo,
  };
  const runner: any = {
    run: async () => ({ success: true, text: 'done', tools_used: [], execution_id: 99 }),
    getExecutionContext: () => ({ user_id: 1, current_agent_id: 1, stream_context: null }),
    ...overrides.runner,
  };
  return { repo, runner };
}

test('delegateToAgent by name returns PHP-shaped success payload', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.delegateToAgent({ agent_name: 'Researcher', task: 'find X' }, runner.getExecutionContext());
  assert.equal(r.success, true);
  assert.equal(r.delegated_to, 'Researcher');
  assert.equal(r.result, 'done');
  assert.equal(r.execution_id, 99);
});

test('delegateToAgent requires a task', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.delegateToAgent({ agent_name: 'Researcher' }, {});
  assert.equal(r.success, false);
});

test('delegateToAgent denies a non-delegable agent', async () => {
  const managerLimited = { id: 1, name: 'Mgr', agentType: 'manager', enabled: true, canDelegateTo: [7] } as any;
  const { runner } = fakes();
  const repo: any = {
    findById: async (id: number) => (id === 5 ? worker : id === 1 ? managerLimited : null),
    findByName: async () => worker,
    findWorkerAgents: async () => [],
  };
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.delegateToAgent({ agent_id: 5, task: 't' }, { user_id: 1, current_agent_id: 1 });
  assert.equal(r.success, false);
  assert.match(r.error, /cannot delegate/i);
});

test('listAvailableAgents returns workers with count', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.listAvailableAgents({}, { user_id: 1, current_agent_id: 1 });
  assert.equal(r.success, true);
  assert.equal(r.count, 1);
  assert.equal(r.agents[0].name, 'Researcher');
});

test('completeTask returns an acknowledgment', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.completeTask({ reason: 'done' }, {});
  assert.equal(r.success, true);
  assert.equal(r.status, 'workflow_complete');
});

test('toolNames lists exactly the 3 wired tools', () => {
  assert.deepEqual(AgentDelegationFunctions.toolNames(), ['delegate_to_agent', 'list_available_agents', 'complete_task']);
});
