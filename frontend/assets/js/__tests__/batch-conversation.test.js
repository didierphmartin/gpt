/**
 * Batch conversation: the one-shot contract, pinned.
 *
 * Extracts the REAL executeWorkflowInBrowser (and, from Task 2, _batchTurn)
 * out of frontend/assets/js/workflow-editor.js and drives them over a stubbed
 * per-node executor. No DOM, no network, no live run.
 *
 * The assertion this file exists for is "no history, ever" (spec §8.1): a
 * batch workflow terminates, so nothing may be carried from one prompt to the
 * next. That is invisible in the UI when it breaks, which is why it is pinned
 * here rather than left to a manual test.
 *
 * Run: node frontend/assets/js/__tests__/batch-conversation.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EDITOR = path.resolve(__dirname, '../workflow-editor.js');
const file = fs.readFileSync(EDITOR, 'utf8');

// A method body ends at the first line that is exactly four spaces and a
// closing brace — the class's own indentation for a method's final line.
const END = '\n    }\n';
function extract(signature) {
    const start = file.indexOf(signature);
    if (start < 0) throw new Error('could not find: ' + signature.trim());
    const end = file.indexOf(END, start);
    if (end < 0) throw new Error('could not find the end of: ' + signature.trim());
    return file.slice(start, end + END.length).trim();
}

// 1 start → 2 dispatcher → {3 IT claims, 4 HR claims} → 5 output
const EDGES = { '1': ['2'], '2': ['3', '4'], '3': ['5'], '4': ['5'], '5': [] };
const KIND = { '1': 'start', '2': 'agent', '3': 'agent', '4': 'agent', '5': 'output' };
const NODES = {
    '1': { data: {} },
    '2': { data: { agent_type: 'dispatcher', agent_name: 'Dispatcher' } },
    '3': { data: { agent_name: 'IT claims' } },
    '4': { data: { agent_name: 'HR claims' } },
    '5': { data: {} },
};

const methodSrc = [
    extract('    async executeWorkflowInBrowser(userPrompt, { onProgress, headless = false'),
    // The REAL output-node rule: the run's answer depends on it, so a harness
    // copy would pin the harness rather than the product.
    extract('    _wfOutputValue(nodeId, nodes) {'),
].join(',\n');

global.window = {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

/**
 * @param {(nodeId: string) => object} respond  what each agent node returns
 */
function makeEditor(respond) {
    const calls = [];
    const shown = [];
    const obj = eval('({ ' + methodSrc + ' })');
    Object.assign(obj, {
        calls, shown,
        currentWorkflowId: 7,
        currentWorkflowName: 'Claims',
        lastUserPrompt: null,
        lastProducedArtifact: null,
        lastWorkflowResults: null,
        nodeExecutionData: {},
        _wfOutputs: {},
        _wfRoutedBy: {},
        editor: { drawflow: { drawflow: { Home: { data: NODES } } } },
        _isSwarm: () => false,
        _wfNodeKind: (id) => KIND[String(id)],
        _wfUpstreamIds: (id) => Object.keys(EDGES).filter(k => EDGES[k].includes(String(id))),
        _wfDownstreamIds: (id) => [...EDGES[String(id)]],
        // The real one walks reachability; a shallow set is enough here
        // because node 5 has a second parent and so is never skipped.
        _wfSkipSet: (ids) => new Set(ids.map(String)),
        _wfDispatchTargets: (id) => EDGES[String(id)].map(t => ({ id: t, name: NODES[t].data.agent_name })),
        _wfBuildContext(id) {
            return this._wfUpstreamIds(id).map(u => this._wfOutputs[u]).filter(Boolean).join('\n');
        },
        updateStartNodeIndicator() {},
        highlightNode() {},
        // Edge painting is DOM in production; here it records the calls so the
        // decision sequence can be asserted without a canvas.
        edgeMarks: [],
        _clearDispatchEdges() { this.edgeMarks.push('clear'); },
        _markDispatchCandidates(from) { this.edgeMarks.push(`candidates:${from}`); },
        _markDispatchChosen(from, to) { this.edgeMarks.push(`chosen:${from}->${to}`); },
        _wfNodeLog() {},
        _pbBubble() {},
        _runNodeAsPlaybookUnit: async () => ({ output: 'playbook', success: true }),
        async _runNodeAsChatUnit(node, inputText, opts = {}) {
            calls.push({ node: String(node.id), message: inputText, opts });
            return respond(String(node.id));
        },
        showWorkflowResults(data) { shown.push(data); },
        _saveWorkflowOutput: async () => {},
    });
    return obj;
}

// Every agent answers; the dispatcher routes to node 3.
const answersRoutingTo3 = (id) => (id === '2'
    ? { output: 'routing', success: true, route: { id: '3', notes: 'password reset' } }
    : { output: `answer from ${NODES[id].data.agent_name}`, success: true });

let failed = 0;
const checks = [];
const asyncCheck = (name, fn) => checks.push([name, fn]);

asyncCheck('conversation mode does not pop the results modal', async () => {
    const ed = makeEditor(answersRoutingTo3);
    await ed.executeWorkflowInBrowser('reset my password', { conversation: true });
    assert.strictEqual(ed.shown.length, 0, 'showWorkflowResults was called');
});

asyncCheck('the default path still pops the results modal', async () => {
    const ed = makeEditor(answersRoutingTo3);
    await ed.executeWorkflowInBrowser('reset my password');
    assert.strictEqual(ed.shown.length, 1, 'showWorkflowResults was not called');
});

asyncCheck('conversation mode still records lastWorkflowResults for the Output node', async () => {
    const ed = makeEditor(answersRoutingTo3);
    const res = await ed.executeWorkflowInBrowser('reset my password', { conversation: true });
    assert.deepStrictEqual(ed.lastWorkflowResults, res);
});

asyncCheck('no node call ever carries history', async () => {
    const ed = makeEditor(answersRoutingTo3);
    await ed.executeWorkflowInBrowser('reset my password', { conversation: true });
    assert.ok(ed.calls.length >= 2, 'expected the dispatcher and an agent to run');
    for (const c of ed.calls) {
        assert.ok(!('history' in c.opts) || c.opts.history == null,
            `node ${c.node} was handed history: ${JSON.stringify(c.opts.history)}`);
    }
});

asyncCheck('a second prompt carries nothing from the first', async () => {
    const ed = makeEditor(answersRoutingTo3);
    await ed.executeWorkflowInBrowser('reset my password', { conversation: true });
    const firstRunCalls = ed.calls.length;
    ed.calls.length = 0;
    await ed.executeWorkflowInBrowser('make it 5 days', { conversation: true });
    assert.ok(firstRunCalls > 0 && ed.calls.length > 0);
    for (const c of ed.calls) {
        assert.ok(!('history' in c.opts) || c.opts.history == null,
            `turn 2: node ${c.node} was handed history`);
        assert.ok(!String(c.message || '').includes('password'),
            `turn 2: node ${c.node} saw turn 1's words: ${c.message}`);
    }
    // The dispatcher's own call is the one that matters most (§3a).
    const dispatcher = ed.calls.find(c => c.node === '2');
    assert.ok(dispatcher, 'the dispatcher did not run on turn 2');
    assert.strictEqual(dispatcher.message, 'make it 5 days');
});

asyncCheck('a dispatcher emits exactly one route progress event', async () => {
    const ed = makeEditor(answersRoutingTo3);
    const routes = [];
    await ed.executeWorkflowInBrowser('reset my password', {
        conversation: true,
        onProgress: (ev) => { if (ev && ev.type === 'route') routes.push(ev); },
    });
    assert.strictEqual(routes.length, 1, 'expected one route event, got ' + routes.length);
    assert.strictEqual(routes[0].node_id, '3');
    assert.strictEqual(routes[0].to, 'IT claims');
    assert.strictEqual(routes[0].from, 'Dispatcher');
    assert.strictEqual(routes[0].notes, 'password reset');
});

asyncCheck('the returned output is the output node\'s output', async () => {
    const ed = makeEditor(answersRoutingTo3);
    const res = await ed.executeWorkflowInBrowser('reset my password', { conversation: true });
    assert.strictEqual(res.output, 'answer from IT claims');
    assert.strictEqual(res.success, true);
});

// ---- _batchTurn: one turn owns the feed --------------------------------
const batchSrc = [
    extract('    async _batchTurn(userPrompt) {'),
    extract('    _batchAnswerLabel() {'),
    // The REAL detector, not a stub — the routing decision is what these
    // cases exist to pin, so a harness copy of it would prove nothing.
    extract('    _extractDocument(text) {'),
].join(',\n');

function makeBatchEditor(respond, { throws = false } = {}) {
    const feed = [];
    const cleared = [];
    const routes = [];
    const obj = eval('({ ' + batchSrc + ' })');
    Object.assign(obj, {
        feed, cleared, routes,
        lastProducedArtifact: null,
        lastWorkflowResults: { output: 'a previous turn', success: true, node_outputs: { 5: 'x' } },
        indicator: [],
        currentWorkflowName: 'Claims',
        opened: [],
        t: (key) => key,
        updateOutputNodeIndicator(on) { this.indicator.push(on); },
        _pbClearFeed() { cleared.push(feed.length); feed.length = 0; },
        _pbBubble(who, text, opts = {}) { feed.push({ who, text, label: opts.label }); },
        _pbRouteLine(to, notes) { routes.push({ to, notes }); feed.push({ who: 'route', text: to }); },
        _openDocumentOverlay(a) { this.opened.push(a); },
        async executeWorkflowInBrowser(prompt, opts) {
            if (throws) throw new Error('runner exploded');
            opts?.onProgress?.({ type: 'route', node_id: '3', to: 'IT claims', from: 'Dispatcher', notes: 'password reset' });
            return respond(prompt);
        },
    });
    return obj;
}

asyncCheck('_batchTurn renders exactly one answer bubble, verbatim', async () => {
    const ed = makeBatchEditor(() => ({ output: 'Your password was reset.', success: true }));
    await ed._batchTurn('reset my password');
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers.length, 1, 'expected one answer bubble, got ' + answers.length);
    assert.strictEqual(answers[0].text, 'Your password was reset.');
});

asyncCheck('_batchTurn clears the feed before the turn', async () => {
    const ed = makeBatchEditor(() => ({ output: 'first', success: true }));
    await ed._batchTurn('one');
    await ed._batchTurn('two');
    assert.strictEqual(ed.cleared.length, 2, 'the feed was not cleared once per turn');
    // Turn 2 cleared a non-empty feed: turn 1's answer really was erased.
    assert.ok(ed.cleared[1] > 0, 'turn 2 cleared an already-empty feed');
    assert.deepStrictEqual(ed.feed.map(f => f.who), ['you', 'route', 'agent']);
    assert.strictEqual(ed.feed[0].text, 'two');
});

asyncCheck('_batchTurn renders the routing line', async () => {
    const ed = makeBatchEditor(() => ({ output: 'done', success: true }));
    await ed._batchTurn('reset my password');
    assert.deepStrictEqual(ed.routes, [{ to: 'IT claims', notes: 'password reset' }]);
});

asyncCheck('the answer bubble is captioned as the workflow, not as a playbook', async () => {
    const ed = makeBatchEditor(() => ({ output: 'done', success: true }));
    await ed._batchTurn('reset my password');
    const answer = ed.feed.find(f => f.who === 'agent');
    assert.ok(answer.label, 'the answer bubble carried no label, so _pbBubble captions it "📖 Playbook"');
    assert.ok(answer.label.includes('Claims'), 'the label does not name the workflow: ' + answer.label);
});

asyncCheck('a failed run still answers', async () => {
    const ed = makeBatchEditor(() => ({}), { throws: true });
    const res = await ed._batchTurn('reset my password');
    assert.strictEqual(res.success, false);
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers.length, 1, 'a failed run rendered no bubble');
    assert.ok(answers[0].text.includes('runner exploded'), 'the failure was not reported: ' + answers[0].text);
});

asyncCheck('a failed run retracts the previous turn\'s trace', async () => {
    const ed = makeBatchEditor(() => ({}), { throws: true });
    await ed._batchTurn('reset my password');
    assert.strictEqual(ed.lastWorkflowResults, null,
        'the Output node still offers the previous turn\'s successful trace');
    assert.deepStrictEqual(ed.indicator, [false]);
});

asyncCheck('a run with no output still answers', async () => {
    const ed = makeBatchEditor(() => ({ output: '', success: false }));
    await ed._batchTurn('reset my password');
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers.length, 1, 'an empty run rendered no bubble');
});

// ---- extra: a throwing onProgress handler cannot break a run ----------
asyncCheck('a throwing onProgress handler cannot break the run', async () => {
    const ed = makeEditor(answersRoutingTo3);
    const res = await ed.executeWorkflowInBrowser('reset my password', {
        conversation: true,
        onProgress: () => { throw new Error('onProgress boom'); },
    });
    assert.strictEqual(res.output, 'answer from IT claims');
    assert.strictEqual(res.success, true);
});

asyncCheck('a produced document opens its own overlay', async () => {
    const ed = makeBatchEditor(() => ({ output: 'I produced a report.', success: true }));
    ed.lastProducedArtifact = { kind: 'html', content: '<h1>Report</h1>', relPath: 'out/r.html', dirName: 'html' };
    await ed._batchTurn('write me a report');
    assert.strictEqual(ed.opened.length, 1, 'the document overlay was not opened');
    assert.strictEqual(ed.opened[0].kind, 'html');
    // SUPERSEDED (owner, after "my newspaper journal"): this used to assert the
    // node's own words reached the bubble verbatim, per spec §4's assumption
    // that an end node producing a document would SAY so. Real workflows emit
    // the document AS the output, so the feed is text-only now and the bubble
    // carries a line about the document instead.
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers[0].text, 'workflow.batchSession.documentNamed');
    assert.ok(!answers[0].text.includes('<'), 'markup reached the feed');
});

asyncCheck('a run with no document opens nothing', async () => {
    const ed = makeBatchEditor(() => ({ output: 'no file here', success: true }));
    await ed._batchTurn('just answer');
    assert.strictEqual(ed.opened.length, 0, 'the document overlay opened with no artifact');
});

// ---- send(): which transport a prompt goes to --------------------------
//
// send() is the composer's dispatcher, and it is pure branch logic over two
// fields: _pbSessionMode and _compiledSession. Getting it wrong is invisible —
// a stale _compiledSession from an earlier COMPILED run made the interpreter
// door silently post to the run server holding the pre-edit package, so the
// browser walk never ran, no node lit up, and no document overlay opened.
// Nothing about that looks like a bug from the outside; it looks like a slow
// workflow that answers oddly. Hence this test.
//
// send() is a closure inside _pbOverlayOpen, not a method, so it cannot go
// through extract(). It is sliced out by its own `const send = async () => {`
// … `};` bounds and re-bound to a stub editor — the real source either way.
const SEND_HEAD = '            const send = async () => {';
const SEND_TAIL = '\n            };\n';
function extractSend() {
    const start = file.indexOf(SEND_HEAD);
    if (start < 0) throw new Error('could not find send() in _pbOverlayOpen');
    const end = file.indexOf(SEND_TAIL, start);
    if (end < 0) throw new Error('could not find the end of send()');
    const src = file.slice(start, end + SEND_TAIL.length).trim();
    return src.slice(src.indexOf('=') + 1).replace(/;$/, '').trim();   // the arrow function itself
}
const sendSrc = extractSend();
// A normal function so `.call(editor)` fixes what the arrow captures as `this`.
const makeSend = new Function('input', 'sendBtn',
    'return function () { const send = ' + sendSrc + '; return send; };');

const openBatchSrc = extract('    async _openBatchSession() {');

function makeSessionEditor(mode) {
    const input = { value: '', disabled: false, focus() {} };
    const obj = eval('({ ' + openBatchSrc + ' })');
    Object.assign(obj, {
        dispatched: [],
        input,
        currentWorkflowId: 7,
        currentWorkflowName: 'Claims',
        _pbSessionMode: mode,
        _compiledSession: null,
        _runTarget: null,
        _swarmBusy: false,
        opened: [],
        _persistIfDirty: async () => {},
        _hideCompiledScrim() {},
        _pbOverlayOpen(dfId, name, servers, prompt, opts) { this.opened.push({ dfId, opts }); },
        _pbClearFeed() {},
        _pbBubble() {},
        _pbUpdateSwarmStatus() {},
        async _batchTurn() { this.dispatched.push('batch'); },
        async _compiledTurn(target, text, session) { this.dispatched.push({ compiled: { target, session } }); },
        async _swarmTurn() { this.dispatched.push('swarm'); },
    });
    obj.send = makeSend(input, null).call(obj);
    return obj;
}

const STALE = { target: { base: 'http://127.0.0.1:9001' }, session: 'old-session', mode: 'batch', workflowId: 7 };

asyncCheck('the interpreter door drops a stale compiled session', async () => {
    const ed = makeSessionEditor('batch');
    ed._compiledSession = { ...STALE };
    ed._runTarget = { base: 'http://127.0.0.1:9001', runId: 'r-1' };
    await ed._openBatchSession();
    assert.strictEqual(ed._compiledSession, null, '_openBatchSession left a compiled session behind');
    assert.strictEqual(ed._runTarget, null,
        '_openBatchSession left _runTarget set — a playbook gate would post its answer to a dead run server');
});

asyncCheck('a prompt typed at the interpreter door runs the browser walk', async () => {
    const ed = makeSessionEditor('batch');
    ed._compiledSession = { ...STALE };        // left over from an earlier compiled run
    ed._runTarget = { base: 'http://127.0.0.1:9001', runId: 'r-1' };
    await ed._openBatchSession();
    ed.input.value = 'reset my password';
    await ed.send();
    assert.deepStrictEqual(ed.dispatched, ['batch'],
        'the prompt went to the compiled run server instead of the browser walk');
});

asyncCheck('the compiled door still posts to its run server', async () => {
    const ed = makeSessionEditor('batch');
    ed._compiledSession = { ...STALE };        // set by _runCompiled, overlay opened by it
    ed.input.value = 'reset my password';
    await ed.send();
    assert.strictEqual(ed.dispatched.length, 1);
    assert.strictEqual(ed.dispatched[0].compiled.session, 'old-session');
    assert.strictEqual(ed.dispatched[0].compiled.target.base, 'http://127.0.0.1:9001');
});

asyncCheck('a swarm prompt is unaffected by either field', async () => {
    const live = makeSessionEditor('swarm');
    live.input.value = 'hello';
    await live.send();
    assert.deepStrictEqual(live.dispatched, ['swarm']);

    const compiled = makeSessionEditor('swarm');
    compiled._compiledSession = { ...STALE, mode: 'swarm', transcript: [] };
    compiled.input.value = 'hello';
    await compiled.send();
    assert.strictEqual(compiled.dispatched[0].compiled.session, 'old-session');
});

// ---- the feed whitelist (spec §3c) -------------------------------------
//
// §3c lists FOUR things a batch feed shows: the turn's reply, a document
// produced, gate requests, errors. Per-node trace is explicitly excluded —
// "it is simply not the answer". A playbook node inside a batch graph runs
// against the live conversation now, so its events arrive here, and without
// the whitelist the user sees the answer twice: once as the turn's bubble and
// once as a 📖 Playbook bubble, with the tool lines in between.
const eventSrc = extract('    async _handlePlaybookEvent(dfId, ev) {');

function makeEventEditor({ mode = null, compiled = null } = {}) {
    const obj = eval('({ ' + eventSrc + ' })');
    Object.assign(obj, {
        feed: [], logs: [], gates: [],
        _pbSessionMode: mode,
        _compiledSession: compiled,
        nodeExecutionData: { '3': { pbEvents: [] } },
        _wfNodeLog(dfId, kind, text) { this.logs.push({ kind, text }); },
        _pbActivity(name) { this.feed.push({ kind: 'activity', name }); },
        _pbActivityDone(name, ok) { this.feed.push({ kind: 'activityDone', name, ok }); },
        _pbBubble(who, text) { this.feed.push({ kind: 'bubble', who, text }); },
        async _handlePlaybookGate(dfId, ev) { this.gates.push(ev); },
    });
    return obj;
}

const PLAYBOOK_TURN = [
    { type: 'round', round: 1 },
    { type: 'tool_call', name: 'jira.create', args: {} },
    { type: 'tool_result', name: 'jira.create', result: { ok: true } },
    { type: 'message', text: 'I opened ticket INC-42.' },
];

asyncCheck('a playbook node in a batch conversation writes nothing to the feed', async () => {
    const ed = makeEventEditor({ mode: 'batch' });
    for (const ev of PLAYBOOK_TURN) await ed._handlePlaybookEvent('3', ev);
    assert.deepStrictEqual(ed.feed, [],
        'the trace/answer leaked into the batch feed: ' + JSON.stringify(ed.feed));
    // Excluded from the FEED, never from the node's own Activity/Logs pane.
    assert.ok(ed.logs.length >= 4, 'the trace stopped reaching the node log');
    assert.ok(ed.logs.some(l => l.text.includes('INC-42')), 'the answer was not logged');
});

asyncCheck('a gate request still reaches a batch conversation', async () => {
    const ed = makeEventEditor({ mode: 'batch' });
    await ed._handlePlaybookEvent('3', { type: 'gate_request', kind: 'approval', tool_call_id: 't1' });
    assert.strictEqual(ed.gates.length, 1, 'the gate was swallowed — the run would deadlock');
});

asyncCheck('a compiled batch conversation is unchanged', async () => {
    const ed = makeEventEditor({ mode: 'batch', compiled: { mode: 'batch' } });
    for (const ev of PLAYBOOK_TURN) await ed._handlePlaybookEvent('3', ev);
    assert.deepStrictEqual(ed.feed, []);
    // …including after the overlay is hidden mid-run, which drops _pbSessionMode.
    const hidden = makeEventEditor({ mode: null, compiled: { mode: 'batch' } });
    for (const ev of PLAYBOOK_TURN) await hidden._handlePlaybookEvent('3', ev);
    assert.deepStrictEqual(hidden.feed, []);
});

asyncCheck('a standalone playbook run still shows its trace and its answer', async () => {
    const ed = makeEventEditor();                       // no session at all
    for (const ev of PLAYBOOK_TURN) await ed._handlePlaybookEvent('3', ev);
    assert.deepStrictEqual(ed.feed.map(f => f.kind), ['activity', 'activityDone', 'bubble']);
    assert.strictEqual(ed.feed[2].text, 'I opened ticket INC-42.');
});

asyncCheck('a swarm conversation is unaffected by the batch term', async () => {
    const live = makeEventEditor({ mode: 'swarm' });     // interpreter swarm
    for (const ev of PLAYBOOK_TURN) await live._handlePlaybookEvent('3', ev);
    assert.deepStrictEqual(live.feed.map(f => f.kind), ['activity', 'activityDone', 'bubble']);

    const compiled = makeEventEditor({ mode: 'swarm', compiled: { mode: 'swarm' } });
    for (const ev of PLAYBOOK_TURN) await compiled._handlePlaybookEvent('3', ev);
    // Trace suppressed, answer shown — exactly what a compiled swarm did before.
    assert.deepStrictEqual(compiled.feed.map(f => f.kind), ['bubble']);
});

// ---- the fork badge: what a fan-out says about itself ------------------
// Users asked for a marker at every split, so the badge is the one place the
// canvas states how many of the drawn branches actually run. Pure logic, so
// it is pinned here; the rendering itself is DOM and is verified by hand.
const forkSrc = extract('    _forkBadgeFor(nodeId, nodes) {');

function makeForkEditor({ swarm = false } = {}) {
    const obj = eval('({ ' + forkSrc + ' })');
    Object.assign(obj, {
        _isSwarm: () => swarm,
        _wfDownstreamIds(nodeId) { return [...(EDGES[String(nodeId)] || [])]; },
    });
    return obj;
}

asyncCheck('a plain fan-out says all of its branches run', () => {
    const ed = makeForkEditor();
    // node 2 fans out to 3 and 4; NODES['2'] is the dispatcher, so use a clone.
    const plain = { ...NODES, '2': { data: { agent_name: 'Triage' } } };
    assert.deepStrictEqual(ed._forkBadgeFor('2', plain), { dispatcher: false, total: 2 });
});

asyncCheck('a dispatcher fan-out says one of them runs', () => {
    const ed = makeForkEditor();
    assert.deepStrictEqual(ed._forkBadgeFor('2', NODES), { dispatcher: true, total: 2 });
});

asyncCheck('a single outgoing edge is not a fork', () => {
    const ed = makeForkEditor();
    // node 1 (start) has exactly one child.
    assert.strictEqual(ed._forkBadgeFor('1', NODES), null);
});

asyncCheck('a node with no outgoing edges is not a fork', () => {
    const ed = makeForkEditor();
    assert.strictEqual(ed._forkBadgeFor('5', NODES), null);
});

asyncCheck('a swarm has no fork badges', () => {
    // Start's fan-out in a swarm is the mesh, not a fan-out — "ALL 3" would be
    // a lie there, since one agent takes the prompt.
    const ed = makeForkEditor({ swarm: true });
    assert.strictEqual(ed._forkBadgeFor('2', NODES), null);
});

asyncCheck('a dispatcher run marks its branches candidates, then marks the winner', async () => {
    const ed = makeEditor(answersRoutingTo3);
    await ed.executeWorkflowInBrowser('reset my password', { conversation: true });
    assert.deepStrictEqual(ed.edgeMarks, ['clear', 'candidates:2', 'chosen:2->3'],
        'got: ' + JSON.stringify(ed.edgeMarks));
});

asyncCheck('a run with no dispatcher marks no edges', async () => {
    const ed = makeEditor(() => ({ output: 'plain', success: true }));
    // Node 2 stops routing, so nothing downstream is a menu.
    await ed.executeWorkflowInBrowser('hello', { conversation: true });
    assert.deepStrictEqual(ed.edgeMarks.filter(m => m !== 'clear' && !m.startsWith('candidates')), [],
        'no edge should be chosen without a route: ' + JSON.stringify(ed.edgeMarks));
});

asyncCheck('each turn clears the previous turn\'s edge marks first', async () => {
    const ed = makeEditor(answersRoutingTo3);
    await ed.executeWorkflowInBrowser('one', { conversation: true });
    await ed.executeWorkflowInBrowser('two', { conversation: true });
    assert.strictEqual(ed.edgeMarks.filter(m => m === 'clear').length, 2);
    assert.strictEqual(ed.edgeMarks[0], 'clear');
});

// ---- only text reaches the feed -----------------------------------------
// Owner's rule after "my newspaper journal" rendered its HTML into a bubble:
// a document goes to the viewer, never into the conversation.
asyncCheck('an HTML document answer goes to the viewer, not the bubble', async () => {
    const html = '<!DOCTYPE html>\n<html><body><h1>The Journal</h1></body></html>';
    const ed = makeBatchEditor(() => ({ output: html, success: true }));
    await ed._batchTurn('write my newspaper');
    assert.strictEqual(ed.opened.length, 1, 'the document viewer did not open');
    assert.strictEqual(ed.opened[0].kind, 'html');
    assert.strictEqual(ed.opened[0].content, html, 'the viewer got the wrong content');
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers.length, 1);
    assert.ok(!answers[0].text.includes('<html'), 'raw HTML reached the feed: ' + answers[0].text);
    assert.strictEqual(answers[0].text, 'workflow.batchSession.document');
});

asyncCheck('a captured artifact is not echoed into the bubble as well', async () => {
    const ed = makeBatchEditor(() => ({ output: '<html><body>report</body></html>', success: true }));
    ed.lastProducedArtifact = { kind: 'html', content: '<h1>report</h1>', relPath: 'out/r.html', dirName: 'html' };
    await ed._batchTurn('write it');
    assert.strictEqual(ed.opened.length, 1);
    // The captured artifact wins over the raw output text.
    assert.strictEqual(ed.opened[0].relPath, 'out/r.html');
    assert.strictEqual(ed.feed.filter(f => f.who === 'agent')[0].text, 'workflow.batchSession.documentNamed');
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.ok(!answers[0].text.includes('<html'), 'raw HTML reached the feed: ' + answers[0].text);
});

asyncCheck('an ordinary text answer is still rendered verbatim', async () => {
    const ed = makeBatchEditor(() => ({ output: 'Your password was reset.', success: true }));
    await ed._batchTurn('reset it');
    assert.strictEqual(ed.opened.length, 0, 'the viewer opened for a text answer');
    assert.strictEqual(ed.feed.filter(f => f.who === 'agent')[0].text, 'Your password was reset.');
});

asyncCheck('an answer that merely mentions html is not treated as a document', async () => {
    const prose = 'To embed it, wrap the fragment in `<html>` tags and serve it.';
    const ed = makeBatchEditor(() => ({ output: prose, success: true }));
    await ed._batchTurn('how do I embed it');
    assert.strictEqual(ed.opened.length, 0, 'prose about HTML opened the viewer');
    assert.strictEqual(ed.feed.filter(f => f.who === 'agent')[0].text, prose);
});

// The shape a REAL run produces: the Output node's value is
// _wfBuildContext(), which prefixes every agent parent with "## <name>\n".
// The first fix anchored its test at the start of the string, so it never
// matched and "my newspaper journal" kept rendering HTML into the feed.
const REAL_OUTPUT = '## Journal\n<!DOCTYPE html>\n<html><body><h1>The Journal</h1></body></html>';

asyncCheck('an HTML document behind a node heading still reaches the viewer', async () => {
    const ed = makeBatchEditor(() => ({ output: REAL_OUTPUT, success: true }));
    await ed._batchTurn('write my newspaper');
    assert.strictEqual(ed.opened.length, 1, 'the viewer did not open for a real output shape');
    assert.ok(ed.opened[0].content.startsWith('<!DOCTYPE html>'),
        'the viewer got the heading too: ' + ed.opened[0].content.slice(0, 40));
    assert.ok(ed.opened[0].content.trim().endsWith('</html>'), 'the document was truncated');
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.ok(!answers[0].text.includes('<'), 'markup reached the feed: ' + answers[0].text);
});

asyncCheck('an HTML document inside a markdown fence reaches the viewer', async () => {
    const fenced = '## Journal\n```html\n<html><body>hi</body></html>\n```';
    const ed = makeBatchEditor(() => ({ output: fenced, success: true }));
    await ed._batchTurn('write it');
    assert.strictEqual(ed.opened.length, 1, 'a fenced document did not reach the viewer');
    assert.ok(ed.opened[0].content.startsWith('<html'), ed.opened[0].content.slice(0, 40));
});

asyncCheck('prose naming an html tag is still an answer, not a document', async () => {
    const prose = '## Helper\nTo embed it, wrap the fragment in `<html>` tags and serve it.';
    const ed = makeBatchEditor(() => ({ output: prose, success: true }));
    await ed._batchTurn('how do I embed it');
    assert.strictEqual(ed.opened.length, 0, 'prose opened the viewer');
    assert.strictEqual(ed.feed.filter(f => f.who === 'agent')[0].text, prose);
});

// ---- the Output node aggregates; it does not label a lone parent --------
// The compiled engine has always done this (LangGraphGenerator: one parent ->
// verbatim, several -> "## source" blocks joined by ---). The interpreter used
// _wfBuildContext for the output node too, which labels EVERY agent parent —
// so every single-agent workflow's answer carried a spurious "## Name"
// heading the compiled build did not, and an HTML document arrived behind it.
const outSrc = extract('    _wfOutputValue(nodeId, nodes) {');

function makeOutputEditor(outputs) {
    const obj = eval('({ ' + outSrc + ' })');
    Object.assign(obj, {
        _wfOutputs: outputs,
        _wfUpstreamIds(id) { return Object.keys(EDGES).filter(k => EDGES[k].includes(String(id))); },
        _wfNodeKind: (id) => KIND[String(id)],
    });
    return obj;
}

asyncCheck('one parent reaches the output verbatim, unlabelled', () => {
    const html = '<!DOCTYPE html>\n<html><body>hi</body></html>';
    // Node 5 (output) has parents 3 and 4; give only 3 an output.
    const ed = makeOutputEditor({ '3': html });
    assert.strictEqual(ed._wfOutputValue('5', NODES), html);
});

asyncCheck('several parents are labelled and separated, as the compiler does', () => {
    const ed = makeOutputEditor({ '3': 'alpha', '4': 'beta' });
    assert.strictEqual(ed._wfOutputValue('5', NODES),
        '## IT claims\n\nalpha\n\n---\n\n## HR claims\n\nbeta');
});

asyncCheck('no parent produced anything', () => {
    const ed = makeOutputEditor({});
    assert.strictEqual(ed._wfOutputValue('5', NODES), '');
});

(async () => {
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); }
        catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + (e && e.message)); }
    }
    console.log(failed ? `\n${failed} failing` : '\nall passing');
    process.exit(failed ? 1 : 0);
})();
