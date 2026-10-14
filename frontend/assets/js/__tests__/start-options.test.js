const assert = require('assert');
global.CodeNode = require('../code-node.js');
const SO = require('../start-options.js');

// isStartDrop -- review focus 4: only a drop on a (non-ingestion) Start node
const el = (classes) => ({ closest: (sel) => (sel.split(',').some((s) => classes.includes(s.trim())) ? { classes } : null) });
assert.ok(SO.isStartDrop(el(['.workflow-node.start-node'])));
assert.strictEqual(SO.isStartDrop(el(['.workflow-node.start-node', '.ingestion-start'])), null);
assert.strictEqual(SO.isStartDrop(el(['.workflow-node.agent-node'])), null);
assert.strictEqual(SO.isStartDrop(null), null);

// tools and exits
assert.deepStrictEqual(SO.sortWaitTools(['poll_new_mail', 'wait_for_new', 'move_mail', 'wait_x']),
    ['wait_for_new', 'wait_x', 'poll_new_mail', 'move_mail']);
assert.strictEqual(SO.guessWorkExit(['no_mail', 'new_mail', 'error']), 'new_mail');
assert.strictEqual(SO.guessWorkExit(['job', 'no_job']), 'job');

// defaultTrigger: label = name, first server, first wait tool, args from the template-shaped call (empties dropped)
const poll = CodeNode.TEMPLATES.poll_outlook;
const comp = { name: 'Outlook: get new email', mcp_servers: ['Outlook'], exits: poll.exits, code: poll.code };
assert.deepStrictEqual(SO.defaultTrigger(comp, ['poll_new_mail', 'wait_for_new']), {
    label: 'Outlook: get new email',
    watch: { server: 'Outlook', tool: 'wait_for_new', args: { args: { folder: 'Inbox' } } },
    work_exit: 'new_mail',
});
// hand-written code: no literal call found -> empty args
assert.deepStrictEqual(SO.defaultTrigger({ ...comp, code: 'def run(input, call_tool):\n    return 1' }, ['wait_for_new']).watch.args, {});
// no wait tool, no server
assert.deepStrictEqual(SO.defaultTrigger({ ...comp, mcp_servers: [] }, []).watch, { server: '', tool: '', args: {} });

// tick -- review focus 5
assert.deepStrictEqual(SO.tick({ delay: true, event: null }, 7), { state: { delay: false, event: 7 }, note: 'delayOff' });
assert.deepStrictEqual(SO.tick({ delay: false, event: 7 }, 8), { state: { delay: false, event: 8 }, note: 'replaced' });
assert.deepStrictEqual(SO.tick({ delay: false, event: 7 }, 7), { state: { delay: false, event: null }, note: null });
assert.deepStrictEqual(SO.tick({ delay: false, event: 7 }, 'delay'), { state: { delay: true, event: null }, note: 'eventOff' });
assert.deepStrictEqual(SO.tick({ delay: true, event: null }, 'delay'), { state: { delay: false, event: null }, note: null });

// warning: the active form names workflows and nodes; the idle form keeps the last two lines
assert.deepStrictEqual(SO.warning('New email', [
    { workflow_name: 'AA test', node_name: 'Email processing' }, { workflow_name: 'email prototype', node_name: null },
]).map((l) => l.key), ['workflow.startOptions.warnActive', 'workflow.startOptions.warnStops',
    'workflow.startOptions.warnNodes', 'workflow.startOptions.warnEverywhere', 'workflow.startOptions.warnLibrary']);
assert.strictEqual(SO.warning('New email', [{ workflow_name: 'AA test', node_name: 'Email processing' },
    { workflow_name: 'B', node_name: null }])[0].params.names, 'AA test, B');
assert.strictEqual(SO.warning('New email', [{ workflow_name: 'AA test', node_name: 'Email processing' }])[2].params.nodes, 'Email processing');
assert.deepStrictEqual(SO.warning('New email', []).map((l) => l.key),
    ['workflow.startOptions.warnEverywhere', 'workflow.startOptions.warnLibrary']);
// no impacted workflow has a linked node: no "Their node ()" line
assert.deepStrictEqual(SO.warning('New email', [{ workflow_name: 'A', node_name: null }]).map((l) => l.key),
    ['workflow.startOptions.warnActive', 'workflow.startOptions.warnStops',
     'workflow.startOptions.warnEverywhere', 'workflow.startOptions.warnLibrary']);

console.log('start-options.test.js: OK');
