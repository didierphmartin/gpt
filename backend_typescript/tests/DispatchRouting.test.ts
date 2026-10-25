import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import './support/fakeDb';
import { DispatchRouting } from '../src/AgentTeam/DispatchRouting';
import { GraphWorkflowRunner } from '../src/AgentTeam/GraphWorkflowRunner';

/**
 * Twin of backend/tests/Unit/AgentTeam/DispatchRoutingTest.php. Dispatcher agents: outgoing edges
 * are a MENU of branches the model picks from by name (route_to), never a parallel fan-out.
 * Exactly one branch runs; the others (and anything reachable only through them) are skipped.
 */

/** Start(1) → Dispatcher(2) → {Sales(3), Billing(4)}; Sales→Followup(5); {Followup, Billing}→Output(6) */
function graph(): [Record<number, any>, any[]] {
  const nodes: Record<number, any> = {
    1: { id: 1, node_type: 'start', config: {} },
    2: { id: 2, node_type: 'agent', config: { agent_name: 'Receptionist' } },
    3: { id: 3, node_type: 'agent', config: { agent_name: 'Sales' } },
    4: { id: 4, node_type: 'agent', config: { name: 'Billing' } },
    5: { id: 5, node_type: 'agent', config: { agent_name: 'Followup' } },
    6: { id: 6, node_type: 'output', config: {} },
  };
  const e = (f: number, t: number) => ({ from_node_id: f, to_node_id: t });
  return [nodes, [e(1, 2), e(2, 3), e(2, 4), e(3, 5), e(5, 6), e(4, 6)]];
}

test('targets are downstream agent nodes by name', () => {
  const [nodes, edges] = graph();
  assert.deepEqual(DispatchRouting.targets(2, edges, nodes), [{ id: 3, name: 'Sales' }, { id: 4, name: 'Billing' }]);
  // The output node is not a target
  assert.deepEqual(DispatchRouting.targets(5, edges, nodes), []);
});

test('code nodes are targets too', () => {
  const nodes = {
    2: { id: 2, node_type: 'agent', config: { agent_name: 'Triage' } },
    3: { id: 3, node_type: 'code', config: { name: 'claims' } },
    4: { id: 4, node_type: 'agent', config: { agent_name: 'Help' } },
  };
  const edges = [{ from_node_id: 2, to_node_id: 3 }, { from_node_id: 2, to_node_id: 4 }];
  assert.deepEqual(DispatchRouting.targets(2, edges, nodes), [{ id: 3, name: 'claims' }, { id: 4, name: 'Help' }]);
});

test('the tool definition enumerates target names', () => {
  const [nodes, edges] = graph();
  const def = DispatchRouting.toolDefinition(DispatchRouting.targets(2, edges, nodes));
  assert.equal(def.name, 'route_to');
  assert.deepEqual(def.input_schema.properties.target.enum, ['Sales', 'Billing']);
  assert.deepEqual(def.input_schema.required, ['target']);
  assert.ok('notes' in def.input_schema.properties);
});

test('the prompt block names every target and the tool', () => {
  const [nodes, edges] = graph();
  const p = DispatchRouting.promptBlock(DispatchRouting.targets(2, edges, nodes));
  assert.ok(p.includes('Sales') && p.includes('Billing') && p.includes('route_to'));
});

test('resolve matches the target name case-insensitively', () => {
  const [nodes, edges] = graph();
  const targets = DispatchRouting.targets(2, edges, nodes);
  const calls = [{ name: 'route_to', input: { target: 'billing', notes: 'invoice #42' } }];
  assert.deepEqual(DispatchRouting.resolve(calls, targets), { id: 4, name: 'Billing', notes: 'invoice #42' });
  assert.equal(DispatchRouting.resolve([{ name: 'route_to', input: { target: 'Legal' } }], targets), null);
  assert.equal(DispatchRouting.resolve([], targets), null);
  assert.equal(DispatchRouting.resolve([{ name: 'run_skill_script', input: {} }], targets), null);
});

test('skipSet cascades through branches reachable only via skipped nodes', () => {
  const [, edges] = graph();
  // Chose Billing(4): Sales(3) skipped, Followup(5) only reachable via Sales → skipped; Output(6) also fed by Billing.
  assert.deepEqual(DispatchRouting.skipSet([3], edges), [3, 5]);
  // Chose Sales(3): only Billing(4) skipped; Output(6) still fed by Followup.
  assert.deepEqual(DispatchRouting.skipSet([4], edges), [4]);
});

test('skipSet keeps an unchosen target that another live node still feeds', () => {
  const edges = [
    { from_node_id: 1, to_node_id: 2 }, { from_node_id: 2, to_node_id: 3 },
    { from_node_id: 2, to_node_id: 4 }, { from_node_id: 3, to_node_id: 4 },
  ];
  assert.deepEqual(DispatchRouting.skipSet([4], edges, 2), []);
  assert.deepEqual(DispatchRouting.skipSet([], edges, 3), []);
  assert.deepEqual(DispatchRouting.skipSet([3], edges, 2), [3]);
  edges.push({ from_node_id: 2, to_node_id: 5 }, { from_node_id: 5, to_node_id: 6 });
  assert.deepEqual(DispatchRouting.skipSet([5], edges, 2), [5, 6]);
});

test('default instructions name the agent instead of inheriting a persona', () => {
  const p = DispatchRouting.defaultInstructions('Human resources', 'HR desk', 'Dispatcher demo');
  assert.ok(p.includes('You are "Human resources"') && p.includes('HR desk') && p.includes('Dispatcher demo'));
  assert.ok(DispatchRouting.defaultInstructions('IT claims', '', 'wf').includes('You are "IT claims"'));
});

test('the routed prompt tells the target who sent it and not to re-route', () => {
  const p = DispatchRouting.routedPrompt('Human resources', 'techBuddy', 'vacation question');
  assert.ok(p.includes('## Routed request') && p.includes('techBuddy') && p.includes('vacation question') && p.includes('Do not redirect'));
  assert.ok(!DispatchRouting.routedPrompt('X', 'Y', '').includes('Notes'));
});

test('routedBy finds the dispatcher that chose this node', () => {
  const [, edges] = graph();
  const outputs = { 2: { agent_name: 'Receptionist', route: { id: 4, name: 'Billing', notes: 'invoice' } } };
  assert.deepEqual(DispatchRouting.routedBy(4, edges, outputs), { from: 'Receptionist', notes: 'invoice' });
  assert.equal(DispatchRouting.routedBy(3, edges, outputs), null); // Sales was not chosen
  assert.equal(DispatchRouting.routedBy(4, edges, {}), null); // no dispatcher ran
});

test('unclearBranch: only for a not-classified outcome, and only while on the menu', () => {
  const targets = [{ id: 3, name: 'Sales' }, { id: 4, name: 'Billing' }];
  assert.deepEqual(DispatchRouting.unclearBranch({ unclear_branch: ' Sales ' }, targets, 'unclear'), { id: 3, name: 'Sales' });
  assert.deepEqual(DispatchRouting.unclearBranch({ unclear_branch: 'Sales' }, targets, 'low_confidence'), { id: 3, name: 'Sales' });
  assert.equal(DispatchRouting.unclearBranch({ unclear_branch: 'Sales' }, targets, 'unavailable'), null);
  assert.equal(DispatchRouting.unclearBranch({ unclear_branch: 'Gone' }, targets, 'unclear'), null);
  assert.equal(DispatchRouting.unclearBranch({}, targets, 'unclear'), null);
});

test('the runner applyRoute queues only the chosen and marks skipped as done', () => {
  const [, edges] = graph();
  const runner: any = new GraphWorkflowRunner({ workflow_runs_dir: os.tmpdir() });
  const queue: number[] = [];
  const executed = [1, 2];
  const routed = runner.applyRoute(2, { type: 'agent', route: { id: 4, name: 'Billing', notes: '' } }, edges, queue, executed);
  assert.equal(routed, true);
  assert.deepEqual(queue, [4]);
  // Skipped nodes count as done so the merge at Output(6) is not blocked.
  assert.deepEqual(executed, [1, 2, 3, 5]);

  // A plain agent output is not a route.
  const q2: number[] = [];
  assert.equal(runner.applyRoute(2, { type: 'agent', output: 'hi' }, edges, q2, [1, 2]), false);
  assert.deepEqual(q2, []);
});
