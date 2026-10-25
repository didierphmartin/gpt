/** Port of backend/tests/Unit/LangGraphStartModeTest.php (spec 2026-10-15 langgraph standalone §2: the Start decides the default mode). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlite, makeGenerator, expectMessage, filesByPath, flatten } from './support/lgFixturesB';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';

function pdo(cron: string | null = null, paused = false): void {
  const s = [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
    "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)",
    "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
  ];
  if (cron !== null) {
    s.push(`INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '${cron}', '${paused ? 'paused' : 'pending'}', NULL)`);
  }
  sqlite(s);
}

/** installed: the caller already installed the database (PHP: $pdo ?? $this->pdo()). */
async function generate(graph: any, options: any = {}, installed = false, orchestration = 'workflow'): Promise<any> {
  if (!installed) pdo();
  const g = await graph;
  return makeGenerator({ workflow: { id: 44, name: 'Email prototype', user_id: '3', orchestration }, graph: g }).generate(44, '3', options);
}

const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
  + "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

/** Start (17) on a Start option, expanded as WorkflowGraphRepository::getGraph does. */
function optionGraph(watchServer = 'Outlook', startArgs: any = {}, passArgs: any[] = []): Promise<any> {
  const start: any = { type: 'start', start_option: 5, ...(Object.keys(startArgs).length ? { start_args: startArgs } : {}) };
  const raw = {
    nodes: [
      { id: '17', node_type: 'start', config: start },
      { id: '18', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from_node_id: '17', to_node_id: '18', from_port: 'output_1' }],
  };
  return StartOptionGraph.expand(raw, (_id: number) => ({ name: 'Outlook: get new email', code: POLL,
    exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 30,
    start_trigger: { label: 'Outlook: get new email', work_exit: 'new_mail', pass_args: passArgs,
      watch: { server: watchServer, tool: 'wait_for_new', args: { folder: 'Inbox' } } } }));
}

function promptGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'hi' } },
      { id: '2', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from_node_id: '1', to_node_id: '2', from_port: 'output_1' }],
  };
}

test('testStartOptionCompilesAsWatchWithItsOwnTrigger', async () => {
  const code = (await generate(optionGraph())).code;
  assert.ok(code.includes('START_MODE = "watch"'));
  assert.ok(code.includes('WORK_EXIT = "new_mail"'));
  assert.ok(code.includes('TRIGGER_NODE_ID = "1000000017"'));
  assert.ok(flatten(code).includes('DEFAULT_WATCH = {"server": "outlook", "tool": "wait_for_new", "args": {"folder": "Inbox"}}'));
});

/** spec 2026-10-22 §6.1: the Start's pass_args values and tag are baked into DEFAULT_WATCH; other Start args are not. */
test('testLangGraphDefaultWatchLineHasPassArgs', async () => {
  const code = (await generate(optionGraph('Outlook', { folder: 'Mail in', sharepoint_folder: 'D', tag: 't' }, ['folder']))).code;
  assert.ok(flatten(code).includes('DEFAULT_WATCH = {"server": "outlook", "tool": "wait_for_new", "args": {"folder": "Mail in", "tag": "t"}}'));
  assert.ok(!code.includes('"sharepoint_folder": "D"'));
});

test('testWatchServerNameIsSlugged', async () => {
  const code = (await generate(optionGraph('outlook'))).code;
  assert.ok(code.includes('"server": "outlook"'));
});

test('testPromptStart', async () => {
  const code = (await generate(promptGraph())).code;
  assert.ok(code.includes('START_MODE = "prompt"'));
  assert.ok(code.includes('WORK_EXIT = None'));
  assert.ok(code.includes('TRIGGER_NODE_ID = None'));
});

test('testScheduleStartAndPausedSchedule', async () => {
  pdo('*/5 * * * *');
  assert.ok((await generate(promptGraph(), {}, true)).code.includes('START_MODE = "cron"'));
  pdo('*/5 * * * *', true);
  assert.ok((await generate(promptGraph(), {}, true)).code.includes('START_MODE = "prompt"'));
});

test('testModularWorkflowCarriesTheMode', async () => {
  const files = filesByPath(await generate(optionGraph(), { modular: true }));
  assert.ok(files['workflow.py'].includes('START_MODE = "watch"'));
});

/** Final review M-j: a swarm cannot carry a Start option either (Task 1 tested only A2A). */
test('testStartOptionRefusedInASwarm', async () => {
  await expectMessage(() => generate(optionGraph(), { modular: true }, false, 'swarm'),
    'A Start option (Outlook: get new email) needs the single-file or modular format.');
});

test('testStartOptionRefusedInA2A', async () => {
  await expectMessage(() => generate(optionGraph(), { a2a: true }),
    'A Start option (Outlook: get new email) needs the single-file or modular format.');
});
