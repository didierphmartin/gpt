# Swarm v1(a) revised — fan-out membership and the session

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A swarm is the agents fanned out from Start, and it holds a conversation — you keep typing prompts, each lands on whichever agent is active, and the swarm remembers who that is and everything said so far.

**Architecture:** Two changes to code that already ships. **Membership** moves from "the Dispatcher's children" to "Start's fan-out", which is a change inside a pure `graph → graph` function that is already implemented twice and pinned by a shared fixture. **The session** is new: a persistent active agent and transcript, and a run overlay that keeps accepting prompts instead of closing after one.

**Tech Stack:** PHP 8.4 + PHPUnit (the rewrite's server half), vanilla JS (the rewrite's editor half, the interpreter, the overlay), MySQL (no change — the `orchestration` column already exists and is applied).

**Spec:** `docs/superpowers/specs/2026-09-14-swarm-orchestration-design.md` (revised 2026-09-15, commit `08cf257`). Read §3, §3a, §3b, §5 and §8 before starting. **§3b is the one to read twice** — it is new, and it is the half of this feature that does not exist yet.

## What already works, and must keep working

This is a revision, not a rebuild. Shipped and verified, do not redo:

- the turn loop — handoff tools, `route_to` resolution, the 25-hop budget, skills only on the answering turn;
- `_runNodeAsChatUnit`'s `history` / `skipSkills` / `handoffStyle` options and the swarm-specific prompt and tool description;
- `orchestration` on the workflow row, its six editor wiring sites, and the settings-panel toggle;
- the two rewrite implementations' *shape* — pure functions, shared fixture, whole-output diff;
- 18 i18n keys across en/es/fr.

## Global Constraints

- **Workflow mode is untouched.** Every existing canvas runs exactly as today when `orchestration = "workflow"` (the default). `_runNodeAsChatUnit` is on both modes' hot path — every option added for the swarm already defaults to today's behaviour, and must continue to.
- **The two rewrite implementations are twins.** `SwarmRewriter.php` and `swarm-rewrite.js` must produce **byte-identical** output for every input. A divergence is a defect even when each side is individually defensible. Three have already happened here (truncation, trimming, sort tiebreak) — they are fixed, and the whole-output diff in Task 2 is what keeps them fixed.
- **Ordering is by node id, in both languages, never by insertion order.** PHP preserves insertion order and JS does not.
- **PHP coerces numeric-string array keys to int.** Cast ids back with `(string)` before comparing with `===`.
- **The session is the deliverable.** A single-prompt test cannot distinguish a working session from a broken one. Every behavioural test here sends at least two prompts.
- **Every call to the chat endpoint carries a non-empty message.** The backend rejects an empty message unless the last history entry is a tool result, which a swarm transcript never is. This assumption broke the first build; it now gets an explicit assertion.
- **i18n**: every `t()` key must exist in `en.json`, `es.json` and `fr.json`. A missing key renders as the raw key on screen.
- **Cache-buster**: any edit to `workflow-editor.js` requires bumping its `?v=` in `frontend/index.html` (currently `20260915-swarm4`).
- **Pre-existing failures**: `backend/tests/Unit` has 25 failures that predate this work (12 errors, 13 failures, out of 412 tests). They stay at 25, name for name. Do not fix them.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `backend/tests/fixtures/swarm/rewrite-cases.json` | **The contract.** Rewritten for fan-out membership and the five refusals | 1 |
| `backend/src/AgentTeam/Services/SwarmRewriter.php` | The rewrite, PHP | 2 |
| `backend/tests/Unit/SwarmRewriterTest.php` | Drives the fixture against PHP | 2 |
| `frontend/assets/js/swarm-rewrite.js` | The rewrite, JS — the twin | 2 |
| `frontend/assets/js/__tests__/swarm-rewrite.test.js` | Drives the fixture against JS | 2 |
| `frontend/assets/js/workflow-editor.js` | Session state, the turn, the overlay composer, the removals | 3, 4, 5 |
| `frontend/assets/i18n/{en,es,fr}.json` | Keys retired and added | 4, 5 |

Tasks 3, 4 and 5 all edit `workflow-editor.js`, so they run strictly in order.

---

### Task 1: The contract, rewritten

The fixture defines membership. Everything else follows from it, so it changes first and alone.

**Files:**
- Modify: `backend/tests/fixtures/swarm/rewrite-cases.json`

**Interfaces:**
- Produces: the case format both implementations are tested against —
  `{"cases":[{"name","graph":{"nodes","edges"},"expect":{...}}]}`, where `expect` is either
  `{"ok":true,"agents":[...],"handoffs":[[from,to],...],"entry":"<id>","guide_contains":[...]}`
  or `{"ok":false,"error":"<code>","nodes":["<id>",...]}`.
- The five error codes, and no others: `start_needs_two_agents`, `dispatcher_in_swarm`, `merge_node`, `multiple_outputs`, `playbook_unsupported`.

- [ ] **Step 1: Understand what is changing before editing**

Read the current fixture. It has 17 cases built around a Dispatcher that dissolves. The membership rule inverts: members come from Start's fan-out, not from a dispatcher's children. Two error codes disappear (`no_dispatcher`, `dispatcher_needs_two_children`, `nested_dispatchers` — three, in fact), one is new (`dispatcher_in_swarm`), one is renamed (`two_entry_points` → `start_needs_two_agents`, with the opposite meaning: Start fanning out is now *required*, not refused).

Keep every case that still tests something true. The transitive-member case, the self-edge cases, the duplicate-edge case and the merge/output/playbook refusals all survive with their graphs re-pointed at Start.

- [ ] **Step 2: Rewrite the accepting cases**

Replace the dispatcher-based accepting cases with these. Node shape is unchanged: `{"id","node_type","config":{"type","agent_name","agent_type","instructions","tools","bound_skill"}}`.

```json
{
  "name": "Start fanning out to two agents is a two-agent swarm",
  "graph": {
    "nodes": [
      {"id": "1", "node_type": "start", "config": {"type": "start", "prompt": "hello"}},
      {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "Human resources", "agent_type": "standard", "instructions": "You handle leave and payroll."}},
      {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "IT claims", "agent_type": "standard", "instructions": "You handle passwords and access."}}
    ],
    "edges": [{"from": "1", "to": "2"}, {"from": "1", "to": "3"}]
  },
  "expect": {
    "ok": true,
    "agents": ["2", "3"],
    "handoffs": [["2", "3"], ["3", "2"]],
    "entry": "2",
    "guide_contains": ["Human resources", "IT claims", "leave and payroll", "passwords and access"]
  }
}
```

Note what `guide_contains` now asserts: each colleague line carries **that colleague's own** role summary. There is no dispatcher prose to check for, and its absence is the point.

Add the three-agent full-mesh case (Start → A, B, C; six handoff pairs; entry `"2"`), and re-point these existing cases at Start, keeping their expectations:

- **the transitive member walk** — Start → A, B; A → C; C → E. All four are members; A's handoffs are `[B, C]`, C's are `[E]`, E's are `[]`. This is the case that pins the bug where a grandchild was a handoff target with no agent behind it.
- **a self-edge on a member** — Start → A, B plus A → A. A's handoffs are `[B]`, not `[A, B]`.
- **a duplicated Start edge** — Start → A twice, plus Start → B. Two members, not three, and A appears once in the mesh.
- **an agent's own tools and skills** stay on that agent; no agent inherits another's.

- [ ] **Step 3: Rewrite the refusing cases**

Five refusals, each naming the offending nodes:

| `error` | Canvas | `nodes` |
|---|---|---|
| `start_needs_two_agents` | Start → one agent only | `[]` — the shortfall is Start's, not a node's |
| `dispatcher_in_swarm` | any node with `agent_type: "dispatcher"` | every such node, by id |
| `merge_node` | Start → A, B; A → D; B → D | `["D"]` |
| `multiple_outputs` | two nodes of type `output` | both ids |
| `playbook_unsupported` | any node of type `playbook` | every such node |

Add one case that would be easy to get wrong: **a Dispatcher node that is not connected to Start at all** must still be refused with `dispatcher_in_swarm`. The tag is illegal in swarm mode wherever it appears, not merely when it is in the way.

- [ ] **Step 4: Verify the fixture is self-consistent**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
python3 -c "
import json
d = json.load(open('backend/tests/fixtures/swarm/rewrite-cases.json'))
cases = d['cases']
ok  = [c for c in cases if c['expect'].get('ok')]
bad = [c for c in cases if not c['expect'].get('ok')]
codes = sorted({c['expect']['error'] for c in bad})
print('cases:', len(cases), '| accepting:', len(ok), '| refusing:', len(bad))
print('codes:', codes)
assert codes == ['dispatcher_in_swarm','merge_node','multiple_outputs','playbook_unsupported','start_needs_two_agents'], codes
names = [c['name'] for c in cases]
assert len(set(names)) == len(names), 'duplicate case names'
for c in cases:
    ids = {n['id'] for n in c['graph']['nodes']}
    for e in c['graph']['edges']:
        assert e['from'] in ids and e['to'] in ids, ('dangling edge in', c['name'], e)
    for a in c['expect'].get('agents', []):
        assert a in ids, ('expected agent not in graph', c['name'], a)
print('fixture OK')
"
```
Expected: the five codes exactly, and `fixture OK`. The dangling-edge check is there because a hand-edited fixture is the easiest place in this repo to typo an id.

At this point **both test suites will fail**, which is correct — the implementations still follow the old rule. Do not touch them in this task.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/fixtures/swarm/rewrite-cases.json
git commit -m "test(swarm): the contract is Start's fan-out, not a dispatcher's children"
```

---

### Task 2: The rewrite, both languages

**Files:**
- Modify: `backend/src/AgentTeam/Services/SwarmRewriter.php`
- Modify: `backend/tests/Unit/SwarmRewriterTest.php` (only where it asserts dispatcher behaviour)
- Modify: `frontend/assets/js/swarm-rewrite.js`
- Modify: `frontend/assets/js/__tests__/swarm-rewrite.test.js` (only if it names error codes)

**Interfaces:**
- Consumes: the fixture from Task 1.
- Produces, unchanged in shape so Tasks 3–5 need no adjustment:
  - `rewrite(graph)` → `{ok: true, agents: {id: {id, name, instructions, tools, skills, handoffs}}, entry}` or `{ok: false, error, nodes}`.
  - **`dropped` is removed** from the success result — it counted the dissolved dispatcher's tools and skills, and nothing is dissolved now. Remove its only consumer (the attachment/flip path) if one remains.
  - `handoffGuide(colleagues)` — **the first parameter is gone.** It took the dispatcher's instructions; there is no dispatcher and no shared routing prose (spec §3).

- [ ] **Step 1: Run both suites and watch them fail**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/swarm-rewrite.test.js; echo "exit=$?"
cd backend && php vendor/bin/phpunit tests/Unit/SwarmRewriterTest.php 2>&1 | tail -5
```
Expected: both fail, on the new cases. Read the failures before changing anything — they tell you exactly which expectations the old rule violates.

- [ ] **Step 2: Change the membership rule in PHP**

In `SwarmRewriter::rewrite`, the menu currently comes from the dispatcher's children. It now comes from Start:

```php
        // The swarm is what was drawn from Start (spec §3). No node is
        // dissolved and none is synthesised: the members are exactly the
        // agents on the other end of Start's edges.
        $menu = [];
        foreach ($ids as $id) {
            if ($typeOf($nodes[$id]) !== 'start') {
                continue;
            }
            foreach ($children($id) as $c) {
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && !in_array($c, $menu, true)) {
                    $menu[] = $c;          // a doubled edge must not double a member
                }
            }
        }
        $menu = $byId($menu);
        if (count($menu) < 2) {
            return ['ok' => false, 'error' => 'start_needs_two_agents', 'nodes' => []];
        }
```

Replace the dispatcher refusals with the dispatcher-tag refusal, and keep it early — it is the one a user converting an old canvas will hit:

```php
        // The Dispatcher tag belongs to workflow mode. In a swarm every member
        // routes, so the tag has no meaning here wherever it appears — including
        // on a node nothing connects to.
        $tagged = [];
        foreach ($ids as $id) {
            if ($isAgent($nodes[$id]) && ($nodes[$id]['config']['agent_type'] ?? '') === 'dispatcher') {
                $tagged[] = $id;
            }
        }
        if ($tagged !== []) {
            return ['ok' => false, 'error' => 'dispatcher_in_swarm', 'nodes' => $byId($tagged)];
        }
```

Delete `$dispatcherId` and every guard that referenced it — the `$c !== $dispatcherId` conditions in the member walk and the handoff loop exist only to keep a dissolved node out, and there is no longer such a node. **Keep the transitive member walk exactly as it is**, including its re-read of `count($members)`: it is what stops a grandchild becoming a handoff target with no agent behind it.

Change `handoffGuide` to drop its first parameter and the `## When to hand off` block it produced. The colleague list and the three closing lines stay.

- [ ] **Step 3: Make the same change in JS**

`swarm-rewrite.js` must mirror Step 2 exactly — same refusal order, same `byId` sorting, same guide text. Do not improve one side while you are in it.

- [ ] **Step 4: Update the two test files**

Only where they name dispatcher behaviour. `SwarmRewriterTest`'s standalone guide test asserts the dispatcher's routing prose is carried and its persona is not; that test is now meaningless — replace it with one asserting the guide lists each colleague with that colleague's own role summary, and that the volley guard (`Do not hand back`) is present.

- [ ] **Step 5: Verify — the contract, then the twins**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/swarm-rewrite.test.js; echo "exit=$?"
cd backend && php vendor/bin/phpunit tests/Unit/SwarmRewriterTest.php 2>&1 | tail -3
cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3
```
Expected: all cases match with exit 0; the SwarmRewriter suite green; the full suite at exactly `Errors: 12, Failures: 13`.

Then the check that matters more than either suite — the two implementations diffed **whole**, including the composed instruction text the fixture only spot-checks:

```bash
S=/private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/47f582f7-db98-4a9e-ba15-40ba8224a9eb/scratchpad
php $S/dump.php 2>/dev/null > $S/php.json && node $S/dump.js > $S/js.json
python3 -c "
import json;a=json.load(open('$S/php.json'));b=json.load(open('$S/js.json'))
print('cases:',len(a),'|','IDENTICAL' if a==b else 'DIVERGES: '+str([k for k in a if a[k]!=b[k]]))"
```
Must print `IDENTICAL`. Those two scratch scripts already exist and dump every fixture case through each implementation.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/SwarmRewriter.php backend/tests/Unit/SwarmRewriterTest.php \
        frontend/assets/js/swarm-rewrite.js frontend/assets/js/__tests__/swarm-rewrite.test.js
git commit -m "feat(swarm): members are Start's fan-out; the dispatcher tag is refused"
```

---

### Task 3: The session

The turn loop works. What does not exist is anything that outlives it. This task adds the state; Task 4 gives it a surface.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`

**Interfaces:**
- Consumes: `window.swarmRewrite`, `this._isSwarm()`, `this._currentGraphForRewrite()`, and the existing turn loop.
- Produces:
  - `this._swarmSession` — `{workflowId, rewrite, activeAgent, transcript}` or `null`.
  - `_swarmSessionStart()` → `{ok: true}` or the refusal from the rewrite; computes the rewrite **once** per session.
  - `_swarmTurn(prompt, onProgress)` → the run-result contract plus `{handoffs, status, answered}`.
  - `_swarmSessionEnd()` — discards the session.

- [ ] **Step 1: Rename the loop to what it is**

`_runSwarm` runs one turn, not a run. Rename it `_swarmTurn` and change its two responsibilities:

- it no longer starts at `rw.entry` — it starts at the session's active agent;
- it no longer starts with an empty transcript — it continues the session's.

Its inner loop, hop budget, skill handling and run-result construction are all correct and stay. The `const rw = window.swarmRewrite(...)` at the top moves out: a session computes the rewrite once, not once per prompt.

- [ ] **Step 2: Add the session**

```js
    /**
     * A swarm is a session, not a run (spec §3b). Between prompts it holds who
     * is active and everything said so far — that pair is what makes a
     * follow-up like "make it 5 days" land on the right agent with the context
     * it needs. Both live in memory for as long as the overlay is open;
     * persisting them across a reload is the checkpointer question in §5.
     */
    _swarmSessionStart() {
        const rw = window.swarmRewrite(this._currentGraphForRewrite());
        if (!rw.ok) return rw;
        this._swarmSession = {
            workflowId: this.currentWorkflowId,
            rewrite: rw,
            // No prompt has been handled yet, so nobody is active. The first
            // prompt goes to the first agent connected to Start.
            activeAgent: null,
            transcript: [],
        };
        return { ok: true };
    }

    _swarmSessionEnd() {
        this._swarmSession = null;
    }
```

In `_swarmTurn`, take the starting agent and transcript from the session, and write both back when the turn ends:

```js
        const s = this._swarmSession;
        const rw = s.rewrite;
        let active = s.activeAgent || rw.entry;   // first prompt: the first agent from Start
        let transcript = s.transcript;
```

and, before returning:

```js
        // The agent that ended this turn holds the next prompt. On a hop-budget
        // exhaustion nobody answered, so the turn's last holder keeps it rather
        // than silently resetting the session to the top.
        s.activeAgent = answered || active;
        s.transcript = transcript;
```

- [ ] **Step 3: Invalidate the session when the workflow changes**

A session belongs to one workflow. Add `this._swarmSessionEnd()` beside the existing `this.orchestration = 'workflow'` reset in `clearWorkflow` (search for it — the six wiring sites are already in place), and guard against a stale session in `_swarmTurn`:

```js
        if (this._swarmSession && this._swarmSession.workflowId !== this.currentWorkflowId) {
            this._swarmSessionEnd();
        }
```

- [ ] **Step 4: Prove the session with a stub harness**

No live run is possible without LLM calls, and the session is exactly what a single-prompt test cannot check. A harness already exists at
`/private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/47f582f7-db98-4a9e-ba15-40ba8224a9eb/scratchpad/swarm-transcript-harness.js`
— it extracts the real function and drives it over a stubbed per-node executor. Extend it to cover the session, asserting:

1. **Two prompts, one session.** Prompt 1 goes to the first agent from Start; that agent hands to B; prompt 2's first call is to **B**, not to the entry agent.
2. **The transcript accumulates across prompts.** Prompt 2's call carries entries from prompt 1 — this is the *"make it 5 days"* case.
3. **Every call carries a non-empty message**, on both prompts. Assert it explicitly; this is the assumption that broke the first build.
4. **The hop budget still terminates** a stub that hands off forever, and leaves the session usable for a further prompt.
5. **Ending the session** clears the active agent, so the next prompt starts at the entry agent with an empty transcript.

Run it and put its output in your report. Do not commit the harness.

- [ ] **Step 5: Verify and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node /private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/47f582f7-db98-4a9e-ba15-40ba8224a9eb/scratchpad/swarm-transcript-harness.js 2>&1 | tail -6
```

Bump the cache-buster to `?v=20260915-swarm5`.

```bash
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(swarm): a session that keeps its active agent and transcript between prompts"
```

---

### Task 4: The surface — the overlay keeps asking

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/assets/i18n/{en,es,fr}.json`

**Interfaces:**
- Consumes: `_swarmSessionStart`, `_swarmTurn`, `_swarmSessionEnd` (Task 3); the existing `_pbOverlayOpen(dfId, name, servers, prompt)`, `_pbBubble(who, text)`, `_pbOverlayEl()`.
- Produces: a composer in the run overlay, active only in swarm mode.

- [ ] **Step 1: Read the surface you are extending**

`_pbOverlayOpen` builds `#playbook-run-overlay` as a flex column: a header, a scrolling feed `#pb-ov-feed`, and a footer holding `#pb-ov-status` and a Hide button. It already calls `this._pbBubble('you', prompt)` — the overlay is conversational in shape already. **Reuse it. Do not build a second pane.**

- [ ] **Step 2: Add the composer**

Give `_pbOverlayOpen` an option, e.g. `{ session = false }`. When set, render into the footer a text input and a send button, and wire submit (and Enter) to:

```js
        // Each prompt is a turn. The overlay stays open; the session decides
        // which agent receives this one (spec §3b).
        const send = async () => {
            const text = input.value.trim();
            if (!text || this._swarmBusy) return;
            input.value = '';
            this._swarmBusy = true;
            this._pbBubble('you', text);
            try {
                await this._swarmTurn(text, null);
            } finally {
                this._swarmBusy = false;
                input.focus();
            }
        };
```

Requirements:
- the input is **disabled while a turn is running** and re-enabled after, so two prompts cannot interleave into one transcript;
- the status line names the agent now holding the turn — that is the one question a swarm raises that a DAG never does;
- closing the overlay calls `_swarmSessionEnd()`, because a closed session starts fresh (spec §3b). The existing `hide` handler is where this goes.

- [ ] **Step 3: Open a session instead of running once**

In `executeWorkflowInBrowser`, the swarm branch currently runs one turn and returns. It now starts a session, opens the overlay with the composer, runs the first turn, and leaves the overlay accepting prompts:

```js
        if (this._isSwarm()) {
            const started = this._swarmSessionStart();
            if (!started.ok) { this._showSwarmRefusalModal(started); return { output: '', success: false, node_outputs: {}, nodes_executed: 0, response_time_ms: 0 }; }
            this._pbOverlayOpen('swarm', this.currentWorkflowName || 'Swarm', [], userPrompt, { session: true });
            return await this._swarmTurn(userPrompt, onProgress);
        }
```

- [ ] **Step 4: Name the control honestly**

In swarm mode the Run item opens a session rather than performing a run (spec §10). Update the label where the Run menu item is built, and add the i18n keys for it.

- [ ] **Step 5: Verify**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
for f in en es fr; do python3 -c "import json;json.load(open('frontend/assets/i18n/$f.json'));print('$f ok')"; done
```
Then list every `t()` key you added and grep each out of all three locale files. A missing key is the likeliest defect in this task.

Bump the cache-buster to `?v=20260915-swarm6` and commit.

---

### Task 5: Remove what the dispatcher left behind

The dissolution UI now describes something that cannot happen. Left in place it is worse than clutter — it tells the user a node behaves in a way it does not.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/assets/i18n/{en,es,fr}.json`

- [ ] **Step 1: Delete the dissolution UI**

- **`_applyOrchestrationToAgentForm`** — delete the method and both call sites. Nothing is hidden on a dispatcher's form any more, because a dispatcher cannot be in a swarm.
- **Revert the tab consolidation.** `tab-mcp-servers` goes back to `toggle('hidden', !isPb)` in the `agent-type-select` handler, and `tab-skills` back to `toggle('hidden', pb)` in `_wirePlaybookFacet`'s `applyVisibility`. Both currently carry a `dissolved` term that can no longer be true. Check all three agent types in both modes after the change.
- **`_applyOrchestrationToCanvas`** — keep the method, drop the greying: no `swarm-dissolved` class and no `.swarm-dissolved-note`. Remove the `.workflow-node.swarm-dissolved` CSS from `index.html`.

- [ ] **Step 2: Mark the active agent instead**

The canvas now has something more useful to say. In `_applyOrchestrationToCanvas`, mark the session's active agent while a session is open — "where does my next prompt go" is the question the mode actually raises. Add a class and a CSS rule alongside the one you removed, and call the method when a turn ends.

- [ ] **Step 3: Update the refusal modal**

Its reason map still keys on the old error codes. Replace them with the five from Task 1, and redraw the example so it teaches the new shape:

```
      Start
     ╱  │  ╲
    ▼   ▼   ▼
   HR  IT  Devices      ← the swarm: each can hand to the others
```

Add a line for `dispatcher_in_swarm` that says what to do, not only what is wrong: *"Remove the Dispatcher tag and connect the agents to Start directly."* That is the error a converted canvas hits, so it is the one that most needs to teach.

- [ ] **Step 4: Retire the dead i18n keys, in all three locales**

Retire: `workflow.swarmCanvas.dissolved`, `workflow.swarmForm.guideLabel`, `workflow.swarmForm.guideTab`, `workflow.swarmError.noDispatcher`, `workflow.swarmError.oneChild`, `workflow.swarmError.nested`, `workflow.swarmError.twoEntries`.

Add whatever the new refusals and the active-agent marker need. Then prove the two sets agree:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
python3 -c "
import json, re
src = open('frontend/assets/js/workflow-editor.js').read()
used = set(re.findall(r\"this\.t\('((?:workflow\.(?:swarm|orchestration))[A-Za-z.]*)'\)\", src))
def get(d,k):
    cur=d
    for p in k.split('.'):
        if isinstance(cur,dict) and p in cur: cur=cur[p]
        else: return None
    return cur
for f in ('en','es','fr'):
    d=json.load(open(f'frontend/assets/i18n/{f}.json'))
    missing=[k for k in sorted(used) if not isinstance(get(d,k),str) or not get(d,k).strip()]
    print(f, '->', 'all present' if not missing else 'MISSING: '+str(missing))
print('keys used:', len(used))
"
```
Every locale must print `all present`.

- [ ] **Step 5: Full verification and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/swarm-rewrite.test.js; echo "exit=$?"
cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3
```
Expected: `JS ok`; all cases match, exit 0; `Errors: 12, Failures: 13`.

Bump the cache-buster to `?v=20260915-swarm7` and commit.

- [ ] **Step 6: The owner's pass — report it as outstanding, do not tick it**

Needs a person, a real workflow and real LLM calls (spec §8.5):

1. Draw: Start → two agents with distinct roles. **No Dispatcher, no playbook.**
2. Run it in `workflow` mode first: both agents run concurrently, one prompt, one result.
3. Switch to `swarm` in the settings panel and run: the overlay opens with a prompt box, and the **first agent connected to Start** takes the first prompt.
4. Ask something belonging to the other agent — a handoff appears, naming both agents and the reason.
5. **Send a second prompt that only makes sense given the first** (*"make it 5 days"*). It must land on the agent that just answered, and that agent must understand it without being told the context again. **If this step fails nothing else passing matters.**
6. Close and reopen: the session starts fresh, at the first agent, with no memory.
7. Add a Dispatcher tag to any node and flip to swarm: refused, with an error that says to remove the tag.

---

## What this plan does not build

No compiler changes, no run server, no checkpointer, no persistence across reloads, no multi-user, no ADK/MAF/NOOA, no attachment delivery to agents (§6b, still an open item), no summarisation of a long session (§5). Playbook nodes stay refused in swarm mode.
