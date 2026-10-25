import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import './support/fakeDb';
import { makeRunnerHarness } from './support/runnerHarness';
import { WorkflowGraphAnalyzer } from '../src/AgentTeam/WorkflowGraphAnalyzer';
import { WorkflowRunLog } from '../src/AgentTeam/WorkflowRunLog';
import { GraphWorkflowRunner } from '../src/AgentTeam/GraphWorkflowRunner';

/**
 * Twins of backend/tests/Unit/WorkflowGraphAnalyzerTest.php (reachableGraph),
 * GraphWorkflowRunnerTemplateNodeTest.php, and the runner fixes since 2026-09-17: only what Start
 * reaches runs, the Output takes a node once and only through the exit it took, the workflow points
 * at its current run.
 */

// ── WorkflowGraphAnalyzer.reachableGraph ────────────────────────────────────

test('reachableGraph drops nodes Start does not reach', () => {
  const graph = {
    nodes: [
      { id: 1, node_type: 'start' }, { id: 2, node_type: 'agent' },
      { id: 3, node_type: 'output' }, { id: 9, node_type: 'agent' }, // 9: kept on the canvas
    ],
    edges: [
      { from_node_id: 1, to_node_id: 2 }, { from_node_id: 2, to_node_id: 3 },
      { from_node_id: 9, to_node_id: 3 }, // a stray arrow into the flow
    ],
    workflow_id: 64,
  };
  const out = WorkflowGraphAnalyzer.reachableGraph(graph);
  assert.deepEqual(out.nodes.map((n) => n.id), [1, 2, 3]);
  assert.equal(out.edges.length, 2, 'the stray arrow goes with its node');
  assert.equal(out.workflow_id, 64);
  // The trimmed graph analyses without the "disconnected node" error.
  assert.deepEqual(WorkflowGraphAnalyzer.analyzeGraph(out).order, ['1', '2', '3']);
});

test('reachableGraph without a start is unchanged', () => {
  const graph = { nodes: [{ id: 1, node_type: 'agent' }], edges: [] };
  assert.deepEqual(WorkflowGraphAnalyzer.reachableGraph(graph), graph);
});

test('typeOf: an empty node_type column falls back to config.type', () => {
  assert.equal(WorkflowGraphAnalyzer.typeOf({ node_type: '', config: { type: 'agent-template' } }), 'agent-template');
  assert.equal(WorkflowGraphAnalyzer.typeOf({ node_type: 'code' }), 'code');
  assert.equal(WorkflowGraphAnalyzer.typeOf({}), 'agent');
});

test('analyzeGraph: two exits of one node linked to the same node are one connection', () => {
  const a = WorkflowGraphAnalyzer.analyzeGraph({
    nodes: [{ id: 1, node_type: 'start' }, { id: 2, node_type: 'code' }, { id: 3, node_type: 'output' }],
    edges: [
      { from_node_id: 1, to_node_id: 2 },
      { from_node_id: 2, to_node_id: 3, from_port: 'output_1' },
      { from_node_id: 2, to_node_id: 3, from_port: 'output_2' },
    ],
  });
  assert.deepEqual(a.order, ['1', '2', '3']);
  assert.deepEqual(a.children['2'], ['3']);
});

// ── configuredTemplatesAsAgents (GraphWorkflowRunnerTemplateNodeTest) ───────

const tnode = (type: string, config: Record<string, any>, agentId: any = null) => ({ id: '7', node_type: type, agent_id: agentId, config });

test('a canvas dispatcher runs as an agent', () => {
  const dispatcher = tnode('agent-template', {
    type: 'agent-template', agent_name: 'email dispatcher', agent_type: 'dispatcher', agent_provider: 'claude',
    isTemplate: false, settings: { routing_mode: 'jev', unclear_branch: 'Miscellaneous' },
  });
  const out = GraphWorkflowRunner.configuredTemplatesAsAgents({ nodes: [dispatcher], edges: [] });
  assert.equal(out.nodes[0].node_type, 'agent');
  assert.deepEqual(out.nodes[0].config, dispatcher.config);
});

test('a template linked to a saved agent runs that agent', () => {
  const out = GraphWorkflowRunner.configuredTemplatesAsAgents({ nodes: [tnode('agent-template', { type: 'agent-template', agent_id: 42 })], edges: [] });
  assert.equal(out.nodes[0].node_type, 'agent');
  assert.equal(out.nodes[0].agent_id, 42);
});

test('an empty column falls back to the config type', () => {
  const out = GraphWorkflowRunner.configuredTemplatesAsAgents({
    nodes: [tnode('', { type: 'agent-template', agent_name: 'triage', instructions: 'Sort it.' })], edges: [],
  });
  assert.equal(out.nodes[0].node_type, 'agent');
});

test('a template never set up is left to fail', () => {
  const out = GraphWorkflowRunner.configuredTemplatesAsAgents({
    nodes: [
      tnode('agent-template', { type: 'agent-template', isTemplate: true, agent_name: 'Agent' }),
      tnode('agent-template', { type: 'agent-template', agent_name: '', instructions: '' }),
    ],
    edges: [],
  });
  assert.equal(out.nodes[0].node_type, 'agent-template');
  assert.equal(out.nodes[1].node_type, 'agent-template');
});

test('other nodes and edges are untouched', () => {
  const graph = { nodes: [tnode('code', { type: 'code', agent_name: 'x' }), tnode('output', {})], edges: [{ from_node_id: '1', to_node_id: '7' }] };
  assert.deepEqual(GraphWorkflowRunner.configuredTemplatesAsAgents(graph), graph);
});

// ── WorkflowRunLog current run ───────────────────────────────────────────────

test('the run log remembers the workflow current run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog_'));
  try {
    const log = new WorkflowRunLog(dir);
    assert.equal(log.current(44), null);
    log.markCurrent(44, 'not-a-run-id');
    assert.equal(log.current(44), null, 'an invalid id is never written');
    log.markCurrent(44, 'a'.repeat(32));
    assert.equal(log.current(44), 'a'.repeat(32));
    assert.equal(log.dir(), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── run(): only what Start reaches ───────────────────────────────────────────

test('a node Start does not reach neither runs nor holds the Output', async () => {
  const h = makeRunnerHarness({
    nodes: [
      { id: 1, node_type: 'start', config: {} },
      { id: 3, node_type: 'output', config: {} },
      { id: 9, node_type: 'agent', agent_id: null, config: { agent_name: 'Stray', instructions: 'x' } },
    ],
    edges: [{ from_node_id: 1, to_node_id: 3 }, { from_node_id: 9, to_node_id: 3 }],
  });
  try {
    const out = await h.runner.run({ id: 44, name: 'Reach' }, 0, { prompt: 'go' });
    assert.equal(out.success, true, out.error);
    assert.equal(out.output, 'go');
    assert.equal(out.node_outputs[9], undefined, 'the stray node never ran');
    const runId = new WorkflowRunLog(h.runsDir).current(44);
    assert.match(String(runId), /^[a-f0-9]{32}$/, 'the workflow points at its run');
    assert.ok(fs.existsSync(path.join(h.runsDir, `${runId}.jsonl`)));
    assert.equal(h.rows[0].status, 'completed');
    assert.equal(h.rows[0].error_message, null);
  } finally {
    h.cleanup();
  }
});

test('the Output takes a node once, and only through the exit it took', () => {
  const runner: any = new GraphWorkflowRunner({ workflow_runs_dir: os.tmpdir() });
  const edges = [
    { from_node_id: 2, to_node_id: 3, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 3, from_port: 'output_2' },
    { from_node_id: 4, to_node_id: 3, from_port: 'output_1' },
    { from_node_id: 5, to_node_id: 3, from_port: 'output_1' },
  ];
  runner.nodeOutputs = { 2: { type: 'code', output: 'stored' } };
  assert.deepEqual(runner.executeOutputNode({ id: 3 }, edges), { type: 'output', output: 'stored' });

  // Node 4 took an exit that does not lead here: it is not an input, node 5 is.
  runner.nodeOutputs = { 4: { type: 'code', output: 'package' }, 5: { type: 'code', output: 'stored' } };
  runner.routedTo = { 4: [6] };
  assert.deepEqual(runner.executeOutputNode({ id: 3 }, edges), { type: 'output', output: 'stored' });
});

test('a one-output playbook node whose playbook does not parse fails the run with the reason', async () => {
  const h = makeRunnerHarness({
    nodes: [
      { id: 1, node_type: 'start', config: {} },
      { id: 2, node_type: 'playbook', config: { playbook: '# P' } },
      { id: 3, node_type: 'output', config: {} },
    ],
    edges: [{ from_node_id: 1, to_node_id: 2 }, { from_node_id: 2, to_node_id: 3 }],
  });
  try {
    const out = await h.runner.run({ id: 45, name: 'PB' }, 0, { prompt: 'go' });
    assert.equal(out.success, false);
    assert.match(out.error, /^playbook node failed: error:Missing "Title:" and "Instructions:" section/);
    assert.equal(h.rows[0].status, 'failed');
  } finally {
    h.cleanup();
  }
});
