import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDelegateToAgent } from '../src/AgentTeam/AgentRepository';

const mk = (over: any) => ({
  id: 1, userId: 1, teamId: null, category: null, name: 'M', description: '',
  agentType: 'manager', parentAgentId: null, canDelegateTo: [], displayOrder: 0,
  provider: 'claude', model: null, instructions: '', tools: [], visibility: 'personal',
  enabled: true, settings: {}, createdAt: null, updatedAt: null, ...over,
});

test('non-manager cannot delegate', () => {
  assert.equal(canDelegateToAgent(mk({ agentType: 'worker' }), 5), false);
});
test('manager with empty canDelegateTo can delegate to any', () => {
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: [] }), 5), true);
});
test('manager delegates only to listed ids', () => {
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: [5, 7] }), 5), true);
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: [7] }), 5), false);
});
test('id list compared numerically', () => {
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: ['5'] }), 5), true);
});
