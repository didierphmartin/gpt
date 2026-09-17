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

const methodSrc = [extract('    async executeWorkflowInBrowser(userPrompt, { onProgress, headless = false')].join(',\n');

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
    // The bubble is the node's own words, not a composed sentence about a file.
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers[0].text, 'I produced a report.');
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

(async () => {
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); }
        catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + (e && e.message)); }
    }
    console.log(failed ? `\n${failed} failing` : '\nall passing');
    process.exit(failed ? 1 : 0);
})();
