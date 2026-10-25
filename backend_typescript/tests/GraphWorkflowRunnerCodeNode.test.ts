import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { makeRunnerHarness } from './support/runnerHarness';
import { WorkflowRunLog } from '../src/AgentTeam/WorkflowRunLog';

/**
 * Twin of backend/tests/Unit/GraphWorkflowRunnerCodeNodeTest.php. The server runner executes code
 * nodes (real python3 harness, in-memory executions table, temp run-log dir): it follows the exit
 * taken, records exit/success per code node, and a poll that found nothing (quiet) leaves no
 * execution row and no run log. Errors are never quiet.
 * Graph: Start(1) -> Code(2) ; exit 'work' (output_1) -> Output(3).
 */

const python = () => process.env.CODE_NODE_PYTHON || (fs.existsSync('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3');

async function run(code: string, exits: string[], opts: { config?: Record<string, any>; nodeConfig?: Record<string, any>; edges?: any[]; extraNodes?: any[] } = {}) {
  const nodes = [
    { id: 1, node_type: 'start', config: {} },
    { id: 2, node_type: 'code', config: { name: 'Poll', code, exits, mcp_servers: [], timeout_s: 10, ...(opts.nodeConfig ?? {}) } },
    { id: 3, node_type: 'output', config: {} },
    ...(opts.extraNodes ?? []),
  ];
  const edges = opts.edges ?? [
    { from_node_id: 1, to_node_id: 2, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 3, from_port: 'output_1' },
  ];
  const h = makeRunnerHarness({
    nodes, edges,
    config: { code_nodes: { python: python(), ...(opts.config?.code_nodes ?? {}) } },
  });
  const archived: any[] = [];
  h.runner.archiveRunToConversationContexts = async (...a: any[]) => {
    archived.push(a);
  };
  const out = await h.runner.run({ id: 44, name: 'Poll test' }, 3, { prompt: 'go' });
  const logs = h.runLogs().map((f) => fs.readFileSync(path.join(h.runsDir, f), 'utf8'));
  const current = new WorkflowRunLog(h.runsDir).current(44);
  const runLogExists = current !== null && fs.existsSync(path.join(h.runsDir, `${current}.jsonl`));
  h.cleanup();
  return { out, rows: h.rows, logs, archived, current, runLogExists };
}

const pyOld = (out: any) => String(out.error ?? out.node_outputs?.[2]?.output ?? '').includes('needs Python 3.10+');

test('a poll that found nothing leaves no trace', async (t) => {
  const { out, rows, logs } = await run("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'none'}\n", ['work', 'idle']);
  if (pyOld(out)) return t.skip('python too old');
  assert.equal(out.success, true, out.error);
  assert.equal(out.quiet, true);
  assert.equal(out.drain, false);
  assert.equal(out.execution_id, null);
  assert.deepEqual(rows, [], 'a quiet run deletes its execution row');
  assert.deepEqual(logs, [], 'a quiet run deletes its run log');
  assert.ok(!(3 in out.node_outputs), 'the work branch was skipped');
});

test('a poll that found work runs the exit and asks to drain', async () => {
  const { out, rows, logs, current, runLogExists } = await run("def run(input, call_tool):\n    return {'route': 'work', 'output': 'job 1'}\n", ['work', 'idle']);
  assert.equal(out.success, true, out.error);
  assert.equal(out.quiet, false);
  assert.equal(out.drain, true);
  assert.equal(out.output, 'job 1');
  assert.deepEqual(out.node_outputs[2], { type: 'code', output: 'job 1', exit: 'work', success: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'completed');
  assert.equal(logs.length, 1);
  assert.match(String(current), /^[a-f0-9]{32}$/, 'the workflow points at its run');
  assert.ok(runLogExists);
});

test('work beside the poll does not drain', async () => {
  // Start -> Code(2) and Start -> Output(3) in parallel: the Output runs every tick, the poll found nothing.
  const edges = [
    { from_node_id: 1, to_node_id: 2, from_port: 'output_1' },
    { from_node_id: 1, to_node_id: 3, from_port: 'output_1' },
  ];
  const { out } = await run("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'none'}\n", ['work', 'idle'], { edges });
  assert.equal(out.success, true, out.error);
  assert.ok(3 in out.node_outputs, 'the Output beside the poll ran');
  assert.equal(out.quiet, false);
  assert.equal(out.drain, false, 'work beside the poll must not make the scheduler re-run the workflow');
});

test('the Output takes a node once and only through the exit it took', async () => {
  // Both exits of Code(2) link to Output(3): the Output shows the result once, not once per link.
  const edges = [
    { from_node_id: 1, to_node_id: 2, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 3, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 3, from_port: 'output_2' },
  ];
  const { out } = await run("def run(input, call_tool):\n    return {'route': 'ok', 'output': 'stored'}\n", ['ok', 'no'], { edges });
  assert.equal(out.success, true, out.error);
  assert.equal(out.output, 'stored');
});

test("the Output ignores an earlier node's untaken error exit", async () => {
  // Convert(2): done -> Store(4), error -> Output(3); Store(4): ok -> Output(3). Convert took done, so
  // the Output is Store's message alone -- not Convert's package next to it.
  const store = { id: 4, node_type: 'code', config: { name: 'Store', exits: ['ok', 'no'],
    code: "def run(input, call_tool):\n    return {'route': 'ok', 'output': 'stored'}\n", mcp_servers: [], timeout_s: 10 } };
  const edges = [
    { from_node_id: 1, to_node_id: 2, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 4, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 3, from_port: 'output_2' },
    { from_node_id: 4, to_node_id: 3, from_port: 'output_1' },
    { from_node_id: 4, to_node_id: 3, from_port: 'output_2' },
  ];
  const { out } = await run("def run(input, call_tool):\n    return {'route': 'done', 'output': 'package'}\n", ['done', 'error'], { edges, extraNodes: [store] });
  assert.equal(out.success, true, out.error);
  assert.equal(out.output, 'stored');
  assert.equal(out.node_outputs[4].exit, 'ok');
});

test('an unwired error exit is kept and never quiet', async () => {
  const { out, rows, logs } = await run("def run(input, call_tool):\n    raise ValueError('mailbox down')\n", ['work', 'idle', 'error']);
  assert.equal(out.success, true, out.error);
  assert.equal(out.quiet, false);
  assert.equal(out.drain, false);
  assert.equal(out.node_outputs[2].exit, 'error');
  assert.ok(out.node_outputs[2].output.includes('mailbox down'));
  assert.equal(rows.length, 1);
  assert.ok(String(rows[0].output).includes('mailbox down'));
  assert.ok(logs[0].includes('took its error exit'));
});

test('an error-exit run is recorded but neither saved nor archived', async () => {
  const { out, rows, archived } = await run("def run(input, call_tool):\n    return {'route': 'error', 'output': 'mailbox down'}\n", ['work', 'idle', 'error']);
  assert.equal(out.success, true, out.error);
  assert.equal(out.storage, null, 'no output storage for an error exit');
  assert.deepEqual(archived, [], 'no archive attempt');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error_message, "code node 'Poll' took its error exit: mailbox down");
});

test('a normal run is saved and archived', async () => {
  const { out, rows, archived } = await run("def run(input, call_tool):\n    return {'route': 'work', 'output': 'job 1'}\n", ['work', 'idle', 'error']);
  assert.equal(out.success, true, out.error);
  assert.equal(typeof out.storage, 'object');
  assert.notEqual(out.storage, null, 'output storage was attempted');
  assert.equal(archived.length, 1);
  assert.equal(rows[0].error_message, null);
});

test('the error exit reason is logged as one bounded line', async () => {
  const { out, logs } = await run("def run(input, call_tool):\n    return {'route': 'error', 'output': 'tool page\\n\\n  says ' + 'x' * 300}\n",
    ['work', 'idle', 'error']);
  assert.equal(out.success, true, out.error);
  assert.match(logs[0], /took its error exit: tool page says x{185}…"/u);
});

test('a failed code node fails the run and keeps the row', async () => {
  const { out, rows } = await run("def run(input, call_tool):\n    raise ValueError('mailbox down')\n", ['work', 'idle']);
  assert.equal(out.success, false);
  assert.ok(!('quiet' in out), 'a failed run is never reported quiet');
  assert.ok(!('drain' in out), 'a failed run never drains');
  assert.ok(out.error.includes('mailbox down'));
  assert.equal(out.partial_outputs[2].success, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.ok(String(rows[0].error_message).includes('mailbox down'));
});

test('a disabled code node neither drains nor goes quiet', async () => {
  const { out, rows, logs } = await run("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'x'}\n", ['work', 'idle'],
    { nodeConfig: { disabled: true } });
  assert.equal(out.success, true, out.error);
  assert.equal(out.quiet, false);
  assert.equal(out.drain, false, 'a disabled code node must not make the scheduler re-run the workflow');
  assert.ok(3 in out.node_outputs, 'the downstream Output ran');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'completed');
  assert.equal(logs.length, 1);
});

test('switched-off code nodes fail the run', async () => {
  const { out, rows } = await run("def run(input, call_tool):\n    return {'route': 'idle', 'output': 'x'}\n", ['work', 'idle'],
    { config: { code_nodes: { server_side: false } } });
  assert.equal(out.success, false);
  assert.ok(out.error.includes('CODE_NODES_SERVER_SIDE'));
  assert.equal(rows.length, 1);
});
