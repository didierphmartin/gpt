# Batch workflows in the conversation overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give batch (DAG) workflows the swarm's conversation overlay as a one-shot surface — each prompt clears the previous answer and re-runs the whole graph — plus a standalone document overlay and the compiled-mode scrim.

**Architecture:** Entirely client-side, in `frontend/assets/js/workflow-editor.js`. The existing session overlay (`_pbOverlayOpen`) gains a **mode** — `'swarm'` or `'batch'` — which selects what the composer says, whether the feed is cleared on send, and which turn function `send()` calls. A new `_batchTurn()` owns one batch turn end to end: clear the feed, render the prompt, run the whole graph via the existing `executeWorkflowInBrowser()`, render exactly one answer bubble. Documents move out of the results modal into their own overlay, rendered by one extracted function both surfaces call. Compiled mode reuses the swarm's scrim, phases and `_compiledTurn` — **no generator change of any kind**.

**Tech Stack:** Vanilla ES2022 class methods, Drawflow canvas, EventSource/SSE, JSON i18n (`frontend/assets/i18n/{en,es,fr}.json`), plain `node`+`assert` test scripts under `frontend/assets/js/__tests__/`.

**Spec:** `docs/superpowers/specs/2026-09-17-batch-workflow-conversation-design.md`

## Global Constraints

- **No generator change.** No file under `backend/src/AgentTeam/Services/` is touched. The emitted DAG `run()` keeps accepting and ignoring `session` (spec §5a). If a task makes you want to edit `LangGraphGenerator.php`, you have misread the task — stop and re-read the spec.
- **Nothing is carried between prompts.** No transcript, no `history`, no session state for batch. A batch turn's node calls receive only what the graph routes them (spec §1, §8.1).
- **The end node's output is rendered verbatim.** The UI composes no sentence about documents, files or success — the node speaks for itself (spec §4).
- **Swarm mode is untouched.** Every branch you add is guarded so that `_isSwarm()` workflows take exactly the path they take today (spec §7).
- **Every new i18n key is added to all three of `en.json`, `es.json`, `fr.json`.** `t()` returns the raw key when a key is missing and `||` fallbacks never fire, so a missing locale shows `workflow.batchSession.placeholder` to the user.
- **Every commit touching `frontend/assets/js/*.js` must move that file's `?v=` in `frontend/index.html`.** `scripts/check-cache-busters.sh` runs as a pre-commit hook and will reject the commit otherwise. `workflow-editor.js` is currently at `?v=20260917-height4` (`frontend/index.html:4237`).
- **`node --check frontend/assets/js/workflow-editor.js` must pass before every commit.** It is a 19,760-line file with no build step; a syntax error takes the whole editor down.

## Ruling: the compiled one-shot has no door left, and that is deliberate

The spec's §5 ("compiled mode reuses the overlay") and §5b ("the one-shot compiled DAG run stays exactly as it is — the results modal remains its terminus") cannot both hold, and the code says so plainly: `_runCompiled` has exactly **three** callers — the normal compile Run (`:5590`), the "Run against a URL…" override (`:3507`) and the runner-down retry (`:5726`) — and all three are compiled runs of the current workflow. Once any of them opens a conversation, they all do, and the one-shot tail below the branch becomes unreachable from every door in the editor.

**Ruling:** compiled batch Run opens the conversation, exactly as the owner asked ("When in compile mode we implement the same mechanism as for swarms"), and Task 4 **deletes** the ~20 unreachable lines rather than leaving them. Unreachable code in a 19,760-line file is worse than no code: the next reader spends their afternoon working out which of two paths runs. Git holds it if the call was wrong.

**What is NOT deleted:** `_compiledTurn`'s `if (!cs)` branch, which renders the run-finished banner. That function takes `session = null` by default, and a caller reaching it without a session should still get its answer somewhere — that is a defensive default, not a stranded path.

**The results modal keeps a real reader:** clicking the **Output node** re-opens it (`workflow-editor.js:2661-2663`), which is why Task 1 keeps `this.lastWorkflowResults` populated in conversation mode. The bubble is the answer; the Output node still holds the full per-node trace.

**Cost if wrong:** the owner wanted the old prompt-modal-plus-results-modal reachable from a compiled Run. Restoring it is `git revert` of one hunk. Flag this to the owner before Task 4 rather than after.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/assets/js/workflow-editor.js` | All behaviour. Already 19,760 lines; follow the file's existing convention of explaining *why* above each non-obvious branch. Do **not** restructure it. | 1, 2, 3, 4 |
| `frontend/assets/js/__tests__/batch-conversation.test.js` | **New, committed.** Extracts the real methods out of `workflow-editor.js` and drives them over stubs. This is the ratchet the spec asks for: it is what stops a transcript reappearing later. | 1, 2 |
| `frontend/assets/i18n/en.json`, `es.json`, `fr.json` | The `workflow.batchSession.*` copy. | 2 |
| `frontend/index.html` | The `?v=` cache-buster on line 4237. | 1, 2, 3, 4 |

### How the test file extracts real code

`frontend/assets/js/workflow-editor.js` is a single class with no module exports, so the test reads the file as text, slices out one method by its exact signature, and `eval`s the slices into an object literal whose remaining members are stubs. The existing `frontend/assets/js/__tests__/swarm-rewrite.test.js` is the style to match (plain `require('assert')`, run with `node`, non-zero exit on failure).

The slice ends at the first occurrence of `"\n    }\n"` — a line that is exactly four spaces and a closing brace. Both methods this plan extracts have been verified to end there and to contain no such line inside them.

---

### Task 1: `executeWorkflowInBrowser` learns conversation mode

Adds two things to the existing DAG walk: an option that suppresses the results modal, and a progress event when a dispatcher routes. Nothing else about the walk changes.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js:14187` (the method signature), `:14267` (the dispatcher-routed branch), `:14316-14322` (the results-modal call)
- Modify: `frontend/index.html:4237` (cache-buster)
- Create: `frontend/assets/js/__tests__/batch-conversation.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `executeWorkflowInBrowser(userPrompt, { onProgress, headless = false, conversation = false })` — when `conversation` is true, `showWorkflowResults()` is **not** called; `this.lastWorkflowResults` is still set. Return shape is unchanged: `{ output, node_outputs, success, nodes_executed, response_time_ms }`.
  - A new `onProgress` event: `{ type: 'route', node_id: <chosen id string>, to: <chosen node's display name>, from: <dispatcher's display name>, notes: <string> }`, emitted once per dispatcher that routes.

- [ ] **Step 1: Write the failing test**

Create `frontend/assets/js/__tests__/batch-conversation.test.js` with exactly this content:

```js
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

(async () => {
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); }
        catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + (e && e.message)); }
    }
    console.log(failed ? `\n${failed} failing` : '\nall passing');
    process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/batch-conversation.test.js
```

Expected: FAIL on `conversation mode does not pop the results modal` (the option does not exist yet, so the modal is shown) and on `a dispatcher emits exactly one route progress event` (`routes.length` is 0). The remaining checks should already pass — they describe behaviour the DAG walk already has, and that is the point: they are guards, not new features.

- [ ] **Step 3: Add the `conversation` option**

In `frontend/assets/js/workflow-editor.js`, change the signature at line 14187:

```js
    async executeWorkflowInBrowser(userPrompt, { onProgress, headless = false } = {}) {
```

to:

```js
    /**
     * `conversation` (spec §3a): the run's answer is going into the
     * conversation overlay as one bubble, so the results modal must not also
     * pop. Everything else about the walk is identical — a batch turn IS an
     * ordinary batch run; the only difference is where its answer is rendered.
     *
     * lastWorkflowResults is still set either way: clicking the Output node
     * re-opens the full per-node trace in the modal, and that door stays open
     * in conversation mode (the bubble is the answer, not the trace).
     */
    async executeWorkflowInBrowser(userPrompt, { onProgress, headless = false, conversation = false } = {}) {
```

Then change the results-modal block at lines 14316-14322:

```js
        if (typeof this.showWorkflowResults === 'function' && finalOutput) {
```

to:

```js
        this.lastWorkflowResults = runResult;
        if (!conversation && typeof this.showWorkflowResults === 'function' && finalOutput) {
```

Note: `showWorkflowResults()` sets `this.lastWorkflowResults` itself as its first statement, so the assignment above is redundant on the modal path and load-bearing on the conversation path. Leave both — removing the one inside `showWorkflowResults` would break the Output-node re-view for the compiled path, which never goes through `executeWorkflowInBrowser` at all.

- [ ] **Step 4: Add the `route` progress event**

At line 14267, inside the `if (res?.route && dispatchTargets?.length) {` branch, immediately after the existing `this._wfRoutedBy[...] = ...` assignment, add:

```js
                            // §3c — a dispatcher choosing a branch is why this
                            // answer and not another. The conversation overlay
                            // renders it as one thin line; every other caller
                            // ignores an event type it does not know.
                            try {
                                onProgress?.({
                                    type: 'route',
                                    node_id: String(res.route.id),
                                    to: nodes[res.route.id]?.data?.agent_name
                                        || nodes[res.route.id]?.data?.name
                                        || `node ${res.route.id}`,
                                    from: agentName,
                                    notes: res.route.notes || '',
                                });
                            } catch (_) {}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js
```

Expected: `node --check` prints `JS ok`; the test prints seven `ok` lines and `all passing`, exit code 0.

- [ ] **Step 6: Commit**

Bump the cache-buster in `frontend/index.html` line 4237 from `?v=20260917-height4` to `?v=20260917-batch1`.

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/workflow-editor.js frontend/assets/js/__tests__/batch-conversation.test.js frontend/index.html
git commit -m "feat(batch): conversation mode for the DAG walk + a route progress event"
```

---

### Task 2: The batch conversation overlay

The overlay learns a mode. In batch mode the composer says the workflow runs fresh each time, the feed is cleared at the start of every turn, and `send()` calls a new `_batchTurn()` instead of `_swarmTurn()`. Run and the Start node open it.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — `_pbOverlayOpen` (`:12860`), its `send()` closure (`:12993`), `_pbUpdateSwarmStatus` (`:13229`), `runWorkflow` (`:12002`), the Start-node play button (`:2691-2700`), the Start-node click (`:2715-2721`). New methods `_pbClearFeed`, `_pbRouteLine`, `_batchTurn`, `_openBatchSession`.
- Modify: `frontend/assets/i18n/en.json`, `frontend/assets/i18n/es.json`, `frontend/assets/i18n/fr.json`
- Modify: `frontend/index.html:4237`
- Test: `frontend/assets/js/__tests__/batch-conversation.test.js` (extend)

**Interfaces:**
- Consumes: `executeWorkflowInBrowser(prompt, { conversation: true, onProgress })` and the `{ type: 'route', node_id, to, from, notes }` progress event (Task 1).
- Produces:
  - `this._pbSessionMode` — `'swarm'` | `'batch'` | `null`. Set by `_pbOverlayOpen`, cleared by its `hide()`.
  - `_pbClearFeed()` — empties `#pb-ov-feed`.
  - `_pbRouteLine(to, notes)` — appends one thin inline line to the feed.
  - `async _batchTurn(userPrompt)` — clears the feed, renders the prompt bubble, runs the whole graph, renders exactly one answer bubble. Returns `executeWorkflowInBrowser`'s result object, or `{ output: '', success: false, node_outputs: {}, nodes_executed: 0, response_time_ms: 0 }` when the run threw.
  - `async _openBatchSession()` — persists pending edits and opens the overlay in batch mode.

- [ ] **Step 1: Write the failing test**

Append to `frontend/assets/js/__tests__/batch-conversation.test.js`, immediately **before** the `(async () => {` runner block at the bottom:

```js
// ---- _batchTurn: one turn owns the feed --------------------------------
const batchSrc = extract('    async _batchTurn(userPrompt) {');

function makeBatchEditor(respond, { throws = false } = {}) {
    const feed = [];
    const cleared = [];
    const routes = [];
    const obj = eval('({ ' + batchSrc + ' })');
    Object.assign(obj, {
        feed, cleared, routes,
        lastProducedArtifact: null,
        t: (key) => key,
        _pbClearFeed() { cleared.push(feed.length); feed.length = 0; },
        _pbBubble(who, text) { feed.push({ who, text }); },
        _pbRouteLine(to, notes) { routes.push({ to, notes }); feed.push({ who: 'route', text: to }); },
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

asyncCheck('a failed run still answers', async () => {
    const ed = makeBatchEditor(() => ({}), { throws: true });
    const res = await ed._batchTurn('reset my password');
    assert.strictEqual(res.success, false);
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers.length, 1, 'a failed run rendered no bubble');
    assert.ok(answers[0].text.includes('runner exploded'), 'the failure was not reported: ' + answers[0].text);
});

asyncCheck('a run with no output still answers', async () => {
    const ed = makeBatchEditor(() => ({ output: '', success: false }));
    await ed._batchTurn('reset my password');
    const answers = ed.feed.filter(f => f.who === 'agent');
    assert.strictEqual(answers.length, 1, 'an empty run rendered no bubble');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/batch-conversation.test.js
```

Expected: the process throws `Error: could not find: async _batchTurn(userPrompt) {` from `extract()`, because the method does not exist yet.

- [ ] **Step 3: Add the i18n copy**

Add a `batchSession` block beside the existing `swarmSession` block under `workflow` in each locale file.

`frontend/assets/i18n/en.json`:

```json
    "batchSession": {
      "overlayTitle": "workflow run",
      "placeholder": "Type a prompt — each one runs the workflow fresh…",
      "status": "One prompt at a time — sending a new one replaces this answer.",
      "running": "Running the workflow…",
      "routed": "routed to {{name}}",
      "failed": "The workflow did not finish."
    },
```

`frontend/assets/i18n/es.json`:

```json
    "batchSession": {
      "overlayTitle": "ejecución del flujo",
      "placeholder": "Escribe una consulta: cada una ejecuta el flujo desde cero…",
      "status": "Una consulta a la vez: enviar otra sustituye esta respuesta.",
      "running": "Ejecutando el flujo…",
      "routed": "dirigido a {{name}}",
      "failed": "El flujo no se completó."
    },
```

`frontend/assets/i18n/fr.json`:

```json
    "batchSession": {
      "overlayTitle": "exécution du flux",
      "placeholder": "Saisissez une demande — chacune relance le flux à zéro…",
      "status": "Une demande à la fois — en envoyer une autre remplace cette réponse.",
      "running": "Exécution du flux…",
      "routed": "dirigé vers {{name}}",
      "failed": "Le flux ne s'est pas terminé."
    },
```

Verify all three files still parse:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
for f in en es fr; do python3 -c "
import json; d=json.load(open('frontend/assets/i18n/$f.json'))
print('$f', sorted(d['workflow']['batchSession']))"; done
```

Expected: three lines, each `['failed', 'overlayTitle', 'placeholder', 'routed', 'running', 'status']`.

- [ ] **Step 4: Add `_pbClearFeed` and `_pbRouteLine`**

In `frontend/assets/js/workflow-editor.js`, immediately after `_pbAppend(html) { ... }` (which ends at line 13256), add:

```js
    /**
     * Spec §3a — a batch turn starts by erasing the previous one. The erase is
     * deliberate and must be VISIBLE: this overlay looks exactly like the
     * swarm's conversation, and a user who assumes continuity will type a
     * follow-up the dispatcher cannot understand. Emptying the feed is the
     * cheapest honest signal that the previous turn is gone.
     */
    _pbClearFeed() {
        const feed = this._pbOverlayEl();
        if (feed) feed.replaceChildren();
    }

    /**
     * Spec §3c — one thin line saying which branch a dispatcher chose. Not a
     * bubble: it is the reason for the answer, not part of it.
     */
    _pbRouteLine(to, notes) {
        const label = this.t('workflow.batchSession.routed', { name: to });
        const tail = notes ? ` — ${notes}` : '';
        return this._pbAppend(`
            <div style="align-self:flex-start;font-size:11px;color:#9ca3af;padding:0 4px;">↳ ${this.escapeHtml(label + tail)}</div>`);
    }
```

- [ ] **Step 5: Add `_batchTurn` and `_openBatchSession`**

Add both methods immediately after `_swarmSessionEnd() { ... }` (which ends at line 13903, just before the `_openSwarmSession` doc comment). Placing them beside the swarm's session code keeps the two conversation modes readable side by side.

```js
    /**
     * ONE batch turn (spec §3a). A batch workflow terminates, so a turn is a
     * whole run: clear the previous answer, run the entire graph on this
     * prompt and nothing else, render exactly one bubble.
     *
     * This method owns the feed for the duration of the turn — including the
     * user's own bubble, which is why _pbOverlayOpen's send() does NOT render
     * one in batch mode. Rendering it there and clearing here would erase the
     * prompt the user just typed.
     *
     * Nothing is carried from the previous turn: no transcript, no history, no
     * session. The dispatcher routes on these words alone. That is not an
     * omission — it is the contract, pinned by
     * frontend/assets/js/__tests__/batch-conversation.test.js.
     */
    async _batchTurn(userPrompt) {
        this._pbClearFeed();
        this._pbBubble('you', userPrompt);
        const st = document.getElementById('pb-ov-status');
        if (st) { st.textContent = this.t('workflow.batchSession.running'); st.style.color = '#9ca3af'; }
        let res;
        try {
            res = await this.executeWorkflowInBrowser(userPrompt, {
                conversation: true,
                onProgress: (ev) => {
                    if (ev?.type === 'route') this._pbRouteLine(ev.to, ev.notes);
                },
            });
        } catch (e) {
            this._pbBubble('agent', `${this.t('workflow.batchSession.failed')} ${e?.message || e}`);
            return { output: '', node_outputs: {}, success: false, nodes_executed: 0, response_time_ms: 0 };
        }
        // One bubble, the end node's output, VERBATIM (§4). When the run
        // produced a document the end node says so in its own words — the UI
        // composes no sentence of its own about files.
        this._pbBubble('agent', res?.output || this.t('workflow.batchSession.failed'));
        return res;
    }

    /**
     * Open the batch conversation. Unlike a swarm there is no session to mint
     * and no canvas rewrite to refuse — a batch workflow is validated by the
     * ordinary Run checks — so this only flushes pending node edits (the
     * overlay bypasses the Generate/Run path that normally does it) and shows
     * the window.
     */
    async _openBatchSession() {
        await this._persistIfDirty();
        this._pbOverlayOpen('batch', this.currentWorkflowName || 'Workflow', [], null,
            { session: true, mode: 'batch' });
    }
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js
```

Expected: `JS ok`, then twelve `ok` lines and `all passing`, exit code 0.

- [ ] **Step 7: Teach the overlay the mode**

Change `_pbOverlayOpen`'s signature at line 12860:

```js
    _pbOverlayOpen(dfId, name, servers, prompt, { session = false, replay = null } = {}) {
```

to:

```js
    _pbOverlayOpen(dfId, name, servers, prompt, { session = false, replay = null, mode = 'swarm' } = {}) {
```

Immediately after the existing `this._pbCurrentName = name || 'Playbook';` line, add:

```js
        // Which conversation this is (spec §6). Both modes share this window;
        // they differ in what a turn means, so the mode selects the composer
        // copy, whether the feed is cleared on send, and which turn function
        // send() calls. Null for a non-session overlay (a playbook node's run,
        // a one-shot compiled run) so nothing below can mistake it for either.
        this._pbSessionMode = session ? mode : null;
```

Change the `titleSuffix` line (line ~12881):

```js
        const titleSuffix = session ? ` — ${this.t('workflow.swarmSession.overlayTitle')}` : ' — running…';
```

to:

```js
        const titleSuffix = session
            ? ` — ${this.t(mode === 'batch' ? 'workflow.batchSession.overlayTitle' : 'workflow.swarmSession.overlayTitle')}`
            : ' — running…';
```

Change the composer's placeholder in `composerHtml` — replace `this.t('workflow.swarmSession.placeholder')` with:

```js
this.t(mode === 'batch' ? 'workflow.batchSession.placeholder' : 'workflow.swarmSession.placeholder')
```

In `hide()`, immediately after the existing `this._hideCompiledScrim();` line, add:

```js
            this._pbSessionMode = null;
```

- [ ] **Step 8: Route `send()` by mode**

In the `send` closure (starts line 12993), replace this block:

```js
                this._pbBubble('you', text);
                // The compiled session's client-side copy: without it a hidden
                // and reopened conversation shows an empty feed while the server
                // happily continues the thread.
                this._compiledSession?.transcript?.push({ role: 'user', content: text });
                try {
                    const cs = this._compiledSession;
                    if (cs) {
                        await this._compiledTurn(cs.target, text, cs.session);
                    } else {
                        await this._swarmTurn(text, null);
                    }
                } finally {
```

with:

```js
                // In batch mode the TURN owns the feed: _batchTurn clears it
                // and renders the prompt itself, so rendering one here would
                // be erased a moment later (spec §3a).
                if (this._pbSessionMode !== 'batch') this._pbBubble('you', text);
                // The compiled session's client-side copy: without it a hidden
                // and reopened conversation shows an empty feed while the server
                // happily continues the thread. A batch conversation has no
                // transcript at all — nothing survives a turn — so it never
                // reaches this push (its session is created without one).
                this._compiledSession?.transcript?.push({ role: 'user', content: text });
                try {
                    const cs = this._compiledSession;
                    if (this._pbSessionMode === 'batch' && !cs) {
                        await this._batchTurn(text);
                    } else if (cs) {
                        await this._compiledTurn(cs.target, text, cs.session);
                    } else {
                        await this._swarmTurn(text, null);
                    }
                } finally {
```

- [ ] **Step 9: Give the status line a batch branch**

In `_pbUpdateSwarmStatus` (line 13229), immediately after `if (!st) return;`, add:

```js
        // A batch conversation has no active agent and no session — the one
        // thing worth saying here is the rule the surface otherwise hides
        // (spec §3b): the next prompt replaces this answer. Checked before the
        // compiled branch so a COMPILED batch conversation says it too.
        if (this._pbSessionMode === 'batch') {
            st.textContent = this.t('workflow.batchSession.status');
            st.style.color = '#9ca3af';
            return;
        }
```

- [ ] **Step 10: Wire Run and the Start node**

In `runWorkflow()` (line 12002), replace the tail:

```js
        // Show prompt form and execute when submitted
        this.showPromptForm((userPrompt) => {
            this.executeWorkflow(userPrompt);
        });
    }
```

with:

```js
        // Ingestion graphs are not agent workflows — they compile to Python and
        // run a loader/splitter/vectorstore pipeline with no conversational
        // answer to show. They keep the prompt form and their own runner.
        if (this._isIngestionWorkflow()) {
            this.showPromptForm((userPrompt) => {
                this.executeWorkflow(userPrompt);
            });
            return;
        }

        // Spec §1 — Run opens the conversation for a batch workflow too. It is
        // still a one-shot: each prompt clears the last answer and re-runs the
        // whole graph. The prompt form is gone from this path because the
        // composer IS the prompt form now, in the surface that shows the reply.
        await this._openBatchSession();
    }
```

In the Start-node play button (line 2691-2700), replace:

```js
                } else if (this.lastUserPrompt) {
                    this.executeWorkflow(this.lastUserPrompt);
                } else {
                    // No prompt yet - show prompt form
                    this.showPromptForm();
                }
```

with:

```js
                } else {
                    // Spec §1 — one door. The Start node's ▶ opens the same
                    // conversation Run does; a stored prompt is no longer
                    // replayed silently, because the composer is where a
                    // prompt is typed now and the feed is where its answer
                    // appears.
                    this._openBatchSession().catch(err =>
                        console.error('[WorkflowEditor] could not open the workflow conversation:', err));
                }
```

In the Start-node click handler (line 2715-2721), replace:

```js
                if (this._isSwarm()) {
                    // Start is the door into a swarm, not a prompt to fill in
                    // once: clicking it opens the conversation (spec §3b).
                    this._openSwarmSession().catch(err => console.error('[WorkflowEditor] could not open the swarm session:', err));
                } else {
                    this.showPromptForm();
                }
```

with:

```js
                if (this._isSwarm()) {
                    // Start is the door into a swarm, not a prompt to fill in
                    // once: clicking it opens the conversation (spec §3b).
                    this._openSwarmSession().catch(err => console.error('[WorkflowEditor] could not open the swarm session:', err));
                } else if (this._isIngestionWorkflow()) {
                    // Ingestion keeps its stored prompt and its own form.
                    this.showPromptForm();
                } else {
                    this._openBatchSession().catch(err =>
                        console.error('[WorkflowEditor] could not open the workflow conversation:', err));
                }
```

- [ ] **Step 11: Verify and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js
node frontend/assets/js/__tests__/swarm-rewrite.test.js
for f in en es fr; do python3 -c "import json; json.load(open('frontend/assets/i18n/$f.json')); print('$f ok')"; done
```

Expected: `JS ok`; twelve `ok` lines and `all passing`; the swarm rewrite suite still passing; three `ok` locale lines.

Bump `frontend/index.html:4237` to `?v=20260917-batch2`.

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/js/__tests__/batch-conversation.test.js frontend/assets/i18n/en.json frontend/assets/i18n/es.json frontend/assets/i18n/fr.json frontend/index.html
git commit -m "feat(batch): the conversation overlay, one-shot — a new prompt replaces the last answer"
```

---

### Task 3: The document overlay

A document produced by a run opens in its own overlay instead of a column inside the results modal. One renderer serves both surfaces — the existing modal keeps its column, rendered by the extracted function.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js:15427-15501` (extract the artifact render), `_batchTurn` (add two lines). New methods `_renderArtifactInto`, `_openDocumentOverlay`.
- Modify: `frontend/index.html:4237`

**Interfaces:**
- Consumes: `_batchTurn(userPrompt)` (Task 2); `this.lastProducedArtifact`, an object shaped `{ dirName, kind: 'html'|'markdown'|'binary', content?, bytes?, relPath?, size? }` set by the skill path in `_runNodeAsChatUnit`.
- Produces:
  - `_renderArtifactInto(hostEl, artifact)` — renders one artifact into any host element. Returns nothing.
  - `_openDocumentOverlay(artifact)` — creates/replaces `#workflow-document-overlay` and renders the artifact into it.

- [ ] **Step 1: Extract the renderer**

In `frontend/assets/js/workflow-editor.js`, the block at lines 15427-15501 currently reads:

```js
        if (artifact) {
            const artifactHost = document.getElementById('workflow-artifact-content');
            if (artifactHost) {
                if (artifact.kind === 'html') {
                    ...
                }
            }
        }
```

Replace those 75 lines with:

```js
        if (artifact) {
            const artifactHost = document.getElementById('workflow-artifact-content');
            if (artifactHost) this._renderArtifactInto(artifactHost, artifact);
        }
```

Then add a new method immediately **before** `showWorkflowResults(data) {` (line 14891), containing the extracted body verbatim — the same three `kind` branches, the same iframe sandbox, the same download handler, the same attachment-converter preview — with the outer `if (artifact) { const artifactHost = ...; if (artifactHost) {` wrapper replaced by the parameters:

```js
    /**
     * Render one produced artifact into `host`. Extracted from
     * showWorkflowResults so the results modal's column and the standalone
     * document overlay (spec §4) are the SAME renderer rather than two that
     * drift. Nothing about the rendering changed in the extraction: the HTML
     * branch keeps sandbox="allow-scripts" WITHOUT allow-same-origin, so a
     * generated report runs its own JS in an opaque origin and still cannot
     * read this page, its cookies or its localStorage.
     */
    _renderArtifactInto(host, artifact) {
        if (!host || !artifact) return;
        host.replaceChildren();
        if (artifact.kind === 'html') {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.style.cssText = 'width:100%; height:100%; border:0; background:white;';
            iframe.srcdoc = artifact.content || '';
            host.appendChild(iframe);
        } else if (artifact.kind === 'markdown') {
            const wrap = document.createElement('div');
            wrap.className = 'markdown-content';
            wrap.style.cssText = 'padding:16px; height:100%; overflow:auto; background:white;';
            wrap.innerHTML = this.formatMarkdown(artifact.content || '');
            host.appendChild(wrap);
        } else if (artifact.kind === 'binary') {
            // <<< the existing binary branch, moved verbatim from
            //     showWorkflowResults: fileName/ext/dispPath/sizeStr, the
            //     PREVIEWABLE set, the container markup, the [data-dl]
            //     download handler and the attachmentConverter preview. >>>
        }
    }
```

**Do not retype the binary branch — move it.** It is ~55 lines including a Blob download and an async markdown preview; retyping it is how a detail gets lost. Cut lines 15450-15498 of the original block and paste them into the `binary` branch, changing only `artifactHost.appendChild(container)` to `host.appendChild(container)`.

- [ ] **Step 2: Verify the extraction changed nothing**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
git diff --stat frontend/assets/js/workflow-editor.js
```

Expected: `JS ok`. The diff should be roughly balanced — about 75 lines removed from `showWorkflowResults` and about 80 added as the new method. A diff that *adds* 75 lines without removing them means the original block was copied rather than moved; go back and delete it.

- [ ] **Step 3: Add the document overlay**

Add immediately after `_renderArtifactInto`:

```js
    /**
     * Spec §4 — a produced document opens in its OWN overlay, not as a column
     * inside the results modal. The column exists because the chat layout's
     * artifact pane is not visible from the editor; a conversation has no
     * results modal to put a column in, so the viewer becomes its own window.
     *
     * One document at a time, by design: a later turn replaces what this shows.
     * Closing it does not end anything — the conversation keeps going.
     */
    _openDocumentOverlay(artifact) {
        if (!artifact) return;
        document.getElementById('workflow-document-overlay')?.remove();
        const rootName = window.chatApp?._fsaRootName || 'storage';
        const rel = artifact.relPath || '';
        const shownPath = rel.startsWith('/')
            ? `${rootName}${rel}`
            : `${rootName}/skills/${artifact.dirName}/${rel}`;
        document.body.insertAdjacentHTML('beforeend', `
            <div id="workflow-document-overlay" class="storage-config-overlay">
                <div class="storage-config-modal" style="max-width:900px;width:92%;height:88vh;display:flex;flex-direction:column;">
                    <div class="storage-config-header">
                        <h3 style="margin:0;"><span>📄</span> <span>${this.escapeHtml(this.t('workflow.output.documentTitle') || 'Document')}</span>
                            <span class="text-xs text-gray-400" title="${this.escapeHtml(shownPath)}">${this.escapeHtml(shownPath)}</span></h3>
                        <button class="storage-config-close" id="workflow-document-close">×</button>
                    </div>
                    <div class="storage-config-body" id="workflow-document-content" style="flex:1 1 auto;min-height:0;overflow:auto;padding:0;"></div>
                </div>
            </div>`);
        const host = document.getElementById('workflow-document-content');
        this._renderArtifactInto(host, artifact);
        document.getElementById('workflow-document-close')?.addEventListener('click', () => {
            document.getElementById('workflow-document-overlay')?.remove();
        });
    }
```

Add the title key to all three locales, under `workflow.output` beside the existing `runTargetCompiled`:

- `en.json`: `"documentTitle": "Document",`
- `es.json`: `"documentTitle": "Documento",`
- `fr.json`: `"documentTitle": "Document",`

- [ ] **Step 4: Open it from a batch turn**

In `_batchTurn`, immediately after the `this._pbBubble('agent', res?.output || ...)` line and before `return res;`, add:

```js
        // The document goes to its own overlay (§4) — never into the bubble,
        // and never as a line of UI prose about a file. A run that produced
        // none leaves whatever is open alone.
        if (this.lastProducedArtifact) this._openDocumentOverlay(this.lastProducedArtifact);
```

Note for the implementer: `executeWorkflowInBrowser` resets `this.lastProducedArtifact = null` at the top of every run (line 14220), so a turn that produces nothing cannot show the previous turn's document.

- [ ] **Step 5: Extend the test**

Append to `frontend/assets/js/__tests__/batch-conversation.test.js`, before the runner block. Also add `opened: []` and an `_openDocumentOverlay` stub to `makeBatchEditor`'s `Object.assign` block:

```js
        opened: [],
        _openDocumentOverlay(a) { this.opened.push(a); },
```

```js
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
```

- [ ] **Step 6: Verify and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js
for f in en es fr; do python3 -c "import json; json.load(open('frontend/assets/i18n/$f.json')); print('$f ok')"; done
```

Expected: `JS ok`; fourteen `ok` lines and `all passing`; three `ok` locale lines.

Bump `frontend/index.html:4237` to `?v=20260917-batch3`.

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/js/__tests__/batch-conversation.test.js frontend/assets/i18n/en.json frontend/assets/i18n/es.json frontend/assets/i18n/fr.json frontend/index.html
git commit -m "feat(batch): documents open in their own overlay, one renderer for both surfaces"
```

---

### Task 4: Compiled batch mode

The compiled batch run uses the same overlay, the same scrim and the same three progress phases as the compiled swarm, over the SSE run server `api.py` already provides. **No generator change.**

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — `_runLangGraphScript` (`:5572`), `_runCompiled` (`:5177` branch made unconditional, `:5253-5277` deleted), `_compiledTurn`'s `done` listener (`:5320-5327`), `_handlePlaybookEvent`'s `message` case (`:13571`), `send()`'s batch clear (added in Task 2)
- Modify: `frontend/index.html:4237`

**Interfaces:**
- Consumes: `this._pbSessionMode` and `_pbOverlayOpen(..., { session, mode })` (Task 2); `_pbClearFeed()` (Task 2); `_openDocumentOverlay(artifact)` (Task 3, not called here — see the note in Step 4).
- Produces: `this._compiledSession` gains a `mode` field, `'swarm'` or `'batch'`. A batch compiled session is created **without** a `transcript` field, which is what stops `send()`'s existing optional-chained push from recording anything.

Background the implementer needs, already verified — do not re-derive it:

- `api.py` is emitted for the modular DAG package exactly as for the swarm (`LangGraphGenerator.php:3038` and `:2539` both call `emitModularApi`). It serves `POST /runs` and `GET /runs/{run_id}/events` with a 500-frame ring and `Last-Event-ID` replay. Nothing needs adding.
- The emitted DAG `run()` accepts `session` and ignores it, deliberately, so its signature matches the swarm's (`LangGraphGenerator.php:3682`). Keep passing `null`.
- The DAG's `done` frame carries `{run_id, status, output, seconds}` where `output` is `run_workflow()`'s return — the end node's output (`LangGraphGenerator.php:3961-3963`).
- The DAG emits a `message` event **per node** (`LangGraphGenerator.php:3670`). That is right for the one-shot trace and wrong for a conversation, where §3c allows one bubble. The fix is a client-side filter, below.

- [ ] **Step 1: Raise the scrim for a batch compile**

In `_runLangGraphScript` (line 5572), change:

```js
        if (this._isSwarm()) this._showCompiledScrim(this.t('workflow.toolbar.compileLangGraph'), 'preparing');
```

to:

```js
        // Both conversational modes get the wait on screen from the click.
        // Everything below — persisting, regenerating the whole package,
        // writing it to disk, probing the runner — happens before _runCompiled
        // is even called, and none of it used to be visible.
        this._showCompiledScrim(this.t('workflow.toolbar.compileLangGraph'), 'preparing');
```

Then confirm every early return below it already calls `this._hideCompiledScrim()` — the `!this.currentWorkflowId` branch and the `_writeManifest` catch both do (lines 5574 and 5589). Add it to the two that do not:

```js
        if (!filename) return;
```

becomes:

```js
        if (!filename) { this._hideCompiledScrim(); return; }
```

and in the `/health` probe's catch:

```js
        } catch (e) {
            this._showRunnerNotRunningModal();
            return;
```

becomes:

```js
        } catch (e) {
            this._hideCompiledScrim();
            this._showRunnerNotRunningModal();
            return;
```

- [ ] **Step 2: Open a compiled batch conversation**

In `_runCompiled`, the swarm branch begins at line 5177 with `if (this._isSwarm()) {`. Every compiled run is a conversation now, so the branch becomes unconditional. Replace:

```js
        // A swarm's prompts are typed into the overlay's composer, one per
        // turn — there is no single up-front prompt to ask for. Everything
        // below this branch (_showRunPromptModal onward) is the DAG path,
        // untouched, so a compiled DAG run stays byte-for-byte what it was.
        if (this._isSwarm()) {
```

with:

```js
        // Every compiled run is a conversation (spec §5): a compiled swarm and
        // a compiled batch workflow open the same window over the same scrim
        // and talk to the same POST /runs + SSE server. What differs is one
        // field on the session (`mode`), read by the feed filter and by the
        // turn's terminal frame. There is no second path below any more — see
        // the plan's ruling; the prompt modal is the composer now.
        {
```

Inside that block, change the session-creation block so a batch session carries `mode` and no `transcript`:

```js
            const live = this._compiledSession;
            if (!live || live.workflowId !== this.currentWorkflowId) {
                this._compiledSession = {
                    target, session: sessionId, framework: frameworkLabel,
                    workflowId: this.currentWorkflowId,
                    transcript: [],
                };
            } else {
                live.target = target;          // the port can change between runs
            }
            this._pbOverlayOpen(dfId, this.currentWorkflowName || 'Workflow', [], null,
                { session: true, replay: this._compiledSession.transcript });
            return;
```

becomes:

```js
            const convMode = this._isSwarm() ? 'swarm' : 'batch';
            const live = this._compiledSession;
            if (!live || live.workflowId !== this.currentWorkflowId) {
                this._compiledSession = {
                    target, session: sessionId, framework: frameworkLabel,
                    workflowId: this.currentWorkflowId, mode: convMode,
                    // Swarm only: the server owns the conversation and this is
                    // the client's copy, kept so a reopened overlay shows what
                    // was already said. A batch conversation has NO transcript
                    // — nothing survives a turn (spec §1) — so the field is
                    // absent, and send()'s optional-chained push records
                    // nothing rather than needing a second branch.
                    ...(convMode === 'swarm' ? { transcript: [] } : {}),
                };
            } else {
                live.target = target;          // the port can change between runs
            }
            this._pbOverlayOpen(dfId, this.currentWorkflowName || 'Workflow', [], null,
                { session: true, mode: convMode, replay: this._compiledSession.transcript || null });
            return;
```

The `sessionId` minted above needs no change: a batch conversation still mints one and still sends it, and the emitted `run()` ignores it. That is exactly §5a — one request shape, three modes, no generator change.

- [ ] **Step 3: Delete the unreachable one-shot tail**

The block that followed the old `if (this._isSwarm()) { ... }` is now unreachable from every door in the editor (see the plan's ruling). Delete it — from the line

```js
        const prompt = await this._showRunPromptModal(this._startNodePrompt());
```

down to and including the closing of the method's final `try/finally`:

```js
        this._pbOverlayOpen(dfId, this.currentWorkflowName || 'Workflow', [], prompt);
        try {
            await this._compiledTurn(target, prompt);
        } finally {
            this._runTarget = null;
        }
```

That is roughly 25 lines (originally `workflow-editor.js:5253-5277`). The `return;` that ended the old swarm branch becomes the method's last statement — check with `node --check` immediately, because deleting a block that ended in `}` is the easiest way to unbalance this file.

Confirm nothing else called into it:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
grep -n "_showRunPromptModal" frontend/assets/js/workflow-editor.js
```

Expected: only the method's own definition remains. If another caller appears, **stop** — the ruling assumed there was none, and a surviving caller means the one-shot still has a door and should keep its code.

- [ ] **Step 4: One bubble per compiled batch turn**

In `_handlePlaybookEvent`'s `message` case (line 13571), immediately after the existing `this._wfNodeLog(dfId, 'llm', ...)` call and before `let text = ...`, add:

```js
                // Spec §3c — a compiled DAG emits one `message` per node
                // (the generated workflow.py does this for the one-shot
                // trace). In a batch CONVERSATION the feed shows one bubble:
                // the end node's output, rendered from the terminal frame in
                // _compiledTurn. The per-node text is still logged above, so
                // nothing is lost — only the feed is quiet.
                if (this._compiledSession?.mode === 'batch') return;
```

- [ ] **Step 5: Render the answer from the terminal frame**

In `_compiledTurn`'s `done` listener (line 5320), change:

```js
                        if (!this._compiledSession) {
                            this._pbOverlayFinish(true, `run ${ev.run_id} ${ev.status} — ${String(ev.output || '').slice(0, 300)}`);
                        }
                        resolve();
```

to:

```js
                        const cs = this._compiledSession;
                        if (!cs) {
                            this._pbOverlayFinish(true, `run ${ev.run_id} ${ev.status} — ${String(ev.output || '').slice(0, 300)}`);
                        } else if (cs.mode === 'batch') {
                            // The whole answer, verbatim, in one bubble — this
                            // frame's `output` is run_workflow()'s return, i.e.
                            // the end node's output (spec §3c). A compiled
                            // swarm instead got its answer as a labelled
                            // `message` bubble on the way past, so it wants
                            // nothing here.
                            this._pbBubble('agent', String(ev.output || this.t('workflow.batchSession.failed')));
                        }
                        resolve();
```

Note: a compiled run produces no browser-side artifact — `this.lastProducedArtifact` is set only by the browser skill path in `_runNodeAsChatUnit` (line 12615), which compiled code never reaches. So there is deliberately **no** `_openDocumentOverlay` call here. Do not add one; it would open the previous interpreter run's document over a compiled answer.

- [ ] **Step 6: Clear the feed on a compiled batch turn**

`_batchTurn` owns the clear for the interpreter path, but a compiled turn goes through `_compiledTurn`, which does not. In `send()`, change the line added in Task 2:

```js
                if (this._pbSessionMode !== 'batch') this._pbBubble('you', text);
```

to:

```js
                if (this._pbSessionMode === 'batch') {
                    // The interpreter's _batchTurn clears and renders the
                    // prompt itself; a COMPILED batch turn goes through
                    // _compiledTurn, which does not — so do it here for that
                    // path only. Both end up with the same feed: the prompt,
                    // then one answer (spec §3a).
                    if (this._compiledSession) { this._pbClearFeed(); this._pbBubble('you', text); }
                } else {
                    this._pbBubble('you', text);
                }
```

- [ ] **Step 7: Verify**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js
node frontend/assets/js/__tests__/swarm-rewrite.test.js
git diff --stat backend/
```

Expected: `JS ok`; fourteen `ok` lines and `all passing`; the swarm suite passing; and **`git diff --stat backend/` must print nothing** — this task changes no generator, and an empty backend diff is the proof.

Then confirm the generator output really is untouched, using whichever generator test suite the repo runs:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
./vendor/bin/phpunit tests/Unit 2>&1 | tail -5
```

Expected: the same pass/fail counts as before this plan started. If a generated-output pin moves, someone edited a shared emit path — stop and find out who.

- [ ] **Step 8: Commit**

Bump `frontend/index.html:4237` to `?v=20260917-batch4`.

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(batch): compiled batch runs drive the overlay over SSE — no generator change"
```

---

## Manual verification, by the owner (spec §8.4)

Automated tests cover the contract; these cover the surface, which no harness here sees.

1. Open a dispatcher workflow. Click **Run**. The conversation overlay opens with an empty feed and a composer reading *"Type a prompt — each one runs the workflow fresh…"*.
2. Send a prompt. One thin `↳ routed to …` line appears, then **one** bubble with the end node's answer. Node colours light up on the canvas behind the window — drag the window aside and watch.
3. Send a second prompt on a **different** subject. The feed visibly empties first. The dispatcher routes elsewhere, and the first answer is gone.
4. Click the **Output node**. The old results modal opens with the full per-node trace of the last run.
5. Run a workflow that produces a document (HTML or `.docx`). The bubble is the end node's own words; the document opens in its own overlay. Close it — the conversation is still there.
6. Switch the compile dropdown to LangGraph and click the compile **Run**. The progress message appears **immediately** on click ("Generating the LangGraph package…"), then "Starting the … run server…", then the canvas dims behind the scrim with the toolbar still clickable above it. The overlay opens; a prompt returns one bubble.
7. Tick **Run as a swarm** on a swarm canvas and confirm the swarm conversation is unchanged: multi-turn, the turn-holder chip, a follow-up like *"make it 5 days"* still understood.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 one-shot, no transcript | 1 (the `no history` / `second prompt carries nothing` pins), 2 (`_batchTurn`), 4 (no `transcript` on a batch session) |
| §2 why the overlay | 2 (overlay reuse), 4 (scrim, phases) |
| §3a clear, run, one bubble | 2 (`_pbClearFeed`, `_batchTurn`), 4 (the compiled clear) |
| §3b say so in the surface | 2 (`batchSession.placeholder`, `batchSession.status`) |
| §3c the feed whitelist + routing line | 1 (`route` event), 2 (`_pbRouteLine`), 4 (`message` suppression) |
| §4 documents in their own overlay, bubble verbatim | 3 |
| §5 compiled reuses the scrim/phases/overlay | 4 |
| §5a no generator change | Global Constraints; Task 4 Step 6 proves it with an empty `backend/` diff |
| §5b the one-shot compiled run | **Overridden by the owner's newer instruction** — see the plan's Ruling. Task 4 Step 3 deletes the now-unreachable tail; `_compiledTurn`'s `if (!cs)` default survives. Flag this to the owner before Task 4. |
| §6 shared code, not copies | 2 (one `_pbOverlayOpen`), 3 (one `_renderArtifactInto`) |
| §8.1–8.3 tests | 1, 2, 3 (harness), 4 Step 6 (generator pins) |
| §8.4 manual | The Manual verification section |

**Gaps, stated rather than hidden:**

- **§8.1's "hiding the overlay and reopening does not resurrect a previous answer"** is satisfied structurally — a batch session holds no transcript and `replay` is null — but is not asserted by a test, because hide/reopen lives in DOM code the harness does not drive. It is step 5 of the owner's manual check.
- **§8.2's "a later run replaces the viewer's content"** is covered by `_openDocumentOverlay` removing any existing `#workflow-document-overlay` first; the test asserts the call, not the DOM replacement.
- **§4's document overlay applies to interpreter runs only.** Compiled runs produce no browser-side artifact (`lastProducedArtifact` is set only in the browser skill path), so a compiled batch turn shows an answer and no document. This is today's behaviour, not a regression, and Task 4 Step 4 says explicitly not to paper over it.

**Type/name consistency:** `_pbSessionMode` (Task 2) is read in Tasks 2 and 4. `_batchTurn` (Task 2) is modified in Task 3. `_renderArtifactInto(host, artifact)` (Task 3) is called by `showWorkflowResults` and `_openDocumentOverlay`. `_compiledSession.mode` (Task 4) is written in `_runCompiled` and read in `_handlePlaybookEvent` and `_compiledTurn`. The `route` progress event's fields (`type, node_id, to, from, notes`) are emitted in Task 1 and consumed in Task 2.
