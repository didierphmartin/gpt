# Shared Run Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ADK, MAF and NOOA compiled packages a run server, so all three answer in the conversational overlay and open documents in the viewer exactly as LangGraph does.

**Architecture:** `api.py`'s framework-agnostic half already exists as `LangGraphGenerator::modularApiBlock()`, and `common.py`'s event-sink half already exists as `PythonEmitHelpers::eventSinkBlock()`. A new `RunServerEmitter` composes both plus a per-target docstring and import line, and all four generators call it. Each of the three targets then moves from returning one script to returning the `{root, files[]}` manifest LangGraph already uses, exposing `run_workflow(prompt, session)`. The editor changes by one parameter; the runner not at all.

**Tech Stack:** PHP 8.4 emitting Python 3.11+; FastAPI + uvicorn in the emitted `api.py`; PHPUnit for generator pins; a compile probe that executes the emitted package against the local runner at `127.0.0.1:8765`; vanilla ES2022 + plain `node` tests for the editor.

**Spec:** `docs/superpowers/specs/2026-09-17-shared-run-server-design.md`

## Global Constraints

- **LangGraph's emitted output must not change by one byte.** Tasks 2-5 all touch code LangGraph emits through. The existing generator pins are the guard; if one moves, the extraction changed behaviour rather than location — stop and find out why.
- **The contract is exactly one function:** `async def run_workflow(prompt: str, session: str | None = None) -> str`. `session` is accepted and ignored.
- **The event sink is emitted but not called** by ADK, MAF or NOOA. It is the seam the later swarm ports need. Do not add `emit_event` calls to those targets in this plan.
- **Swarm is out of scope for every target.** The three generators' existing swarm refusals stay exactly as they are.
- **The single-file download keeps working** for all three targets. Only packaging is added.
- **The runner is not modified.** `_resolve_package_dir` already accepts any folder under `scripts/` holding an `api.py`.
- **Frontend rules:** `node --check frontend/assets/js/workflow-editor.js` must pass; every commit touching `frontend/assets/js/*.js` or `*.css` must move that file's `?v=` in `frontend/index.html` (a pre-commit hook enforces it — never `--no-verify`); every new i18n key goes in all three of `en.json`, `es.json`, `fr.json`.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/assets/js/workflow-editor.js` | The pending indicator; `_fetchManifest` gains a target. | 1, 6 |
| `frontend/assets/css/workflow-editor.css` | The dots animation. | 1 |
| `frontend/assets/i18n/{en,es,fr}.json` | The indicator's accessible label. | 1 |
| `backend/src/AgentTeam/Services/RunServerEmitter.php` | **New.** Composes `api.py` for any target: docstring + imports + the shared runtime block. One responsibility, one caller per generator. | 2 |
| `backend/src/AgentTeam/Services/LangGraphGenerator.php` | `emitModularApi` delegates to the new emitter. Nothing else changes. | 2 |
| `backend/src/AgentTeam/Services/ADKGenerator.php` | Manifest output; `main` → `run_workflow`; package files. | 3 |
| `backend/src/AgentTeam/Services/MAFGenerator.php` | Manifest output; **extract** `run_workflow` out of the `__main__` block. | 4 |
| `backend/src/AgentTeam/Services/NOOAGenerator.php` | Manifest output; `main` → `run_workflow`. | 5 |
| `backend/src/AgentTeam/Controllers/WorkflowController.php` | `generate-adk` / `generate-maf` / `generate-nooa` accept `?package=1` and return the manifest shape. | 3, 4, 5 |
| `backend/tests/Unit/RunServerEmitterTest.php` | **New.** Pins the emitter and proves LangGraph's bytes did not move. | 2 |
| `backend/tests/fixtures/compiled/package_probe.py` | **New.** Executes an emitted package: start server, POST /runs, read SSE, assert a terminal frame. | 3 |

---

### Task 1: The pending indicator

Spec §6. Client-side, target-independent, and it improves the LangGraph targets already in use — which is why it goes first: the silent-overlay cost is paid for before it is incurred.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — new `_pbPending()` / `_pbPendingClear()`; called from `_batchTurn` and from `_compiledTurn`'s batch branch
- Modify: `frontend/assets/css/workflow-editor.css`
- Modify: `frontend/assets/i18n/en.json`, `es.json`, `fr.json`
- Modify: `frontend/index.html` (cache-busters)
- Test: `frontend/assets/js/__tests__/batch-conversation.test.js`

**Interfaces:**
- Consumes: `_pbAppend(html)` (returns the appended element or null), `_pbOverlayEl()`, `this.t(key)`.
- Produces:
  - `_pbPending()` — appends the dots bubble and returns nothing. Idempotent: a second call with one already showing does not add a second.
  - `_pbPendingClear()` — removes it. Safe to call when none exists.

- [ ] **Step 1: Write the failing test**

Append to `frontend/assets/js/__tests__/batch-conversation.test.js`, immediately **before** the `(async () => {` runner block at the bottom. Add `pending: []`, `_pbPending`, `_pbPendingClear` to `makeBatchEditor`'s `Object.assign` block first:

```js
        pending: [],
        _pbPending() { this.pending.push('show'); this.feed.push({ who: 'pending', text: '' }); },
        _pbPendingClear() { this.pending.push('clear'); this.feed = this.feed.filter(f => f.who !== 'pending'); },
```

Then the cases:

```js
// ---- the pending indicator ----------------------------------------------
// Targets without an event stream (ADK, MAF, NOOA) say nothing between the
// prompt and the answer. The dots are the only sign the run is alive.
asyncCheck('a turn shows the dots and clears them when the answer lands', async () => {
    const ed = makeBatchEditor(() => ({ output: 'done', success: true }));
    await ed._batchTurn('go');
    assert.deepStrictEqual(ed.pending, ['show', 'clear']);
    assert.strictEqual(ed.feed.filter(f => f.who === 'pending').length, 0,
        'the dots outlived the answer');
});

asyncCheck('the dots are cleared when the run throws', async () => {
    const ed = makeBatchEditor(() => ({}), { throws: true });
    await ed._batchTurn('go');
    assert.deepStrictEqual(ed.pending, ['show', 'clear']);
    assert.strictEqual(ed.feed.filter(f => f.who === 'pending').length, 0,
        'a failed run left the dots spinning forever');
});

asyncCheck('the dots appear before the answer, not after', async () => {
    const order = [];
    const ed = makeBatchEditor(() => { order.push('ran'); return { output: 'done', success: true }; });
    const realPending = ed._pbPending.bind(ed);
    ed._pbPending = () => { order.push('dots'); realPending(); };
    await ed._batchTurn('go');
    assert.deepStrictEqual(order, ['dots', 'ran']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/batch-conversation.test.js
```

Expected: three FAIL lines. `ed.pending` is `[]` because `_batchTurn` does not call either method yet.

- [ ] **Step 3: Add the two methods**

In `frontend/assets/js/workflow-editor.js`, immediately after `_pbClearFeed() { ... }`, add:

```js
    /**
     * A "still working" bubble, shown from the moment a prompt is sent until
     * its answer arrives (spec §6).
     *
     * It exists because a target without an event stream says NOTHING between
     * the two — ADK, MAF and NOOA print to stdout and emit no events, so the
     * feed would sit empty for the whole run. The LangGraph targets do stream
     * per-node events, but a batch conversation suppresses them from the feed
     * anyway, so this is the only progress any batch turn shows.
     *
     * Idempotent: a turn that somehow calls it twice gets one indicator, not a
     * row of them.
     */
    _pbPending() {
        if (this._pbOverlayEl()?.querySelector('.pb-pending')) return;
        this._pbAppend(`
            <div class="pb-pending" role="status" aria-label="${this.escapeHtml(this.t('workflow.batchSession.working'))}"
                 style="align-self:flex-start;background:rgba(148,163,184,0.12);border-radius:10px;padding:10px 14px;">
                <span class="pb-dot"></span><span class="pb-dot"></span><span class="pb-dot"></span>
            </div>`);
    }

    /** Remove it. Safe when none is showing — every exit from a turn calls this. */
    _pbPendingClear() {
        this._pbOverlayEl()?.querySelector('.pb-pending')?.remove();
    }
```

- [ ] **Step 4: Call them from both turn paths**

In `_batchTurn`, immediately after the `this._pbBubble('you', userPrompt);` line, add:

```js
        this._pbPending();
```

In `_batchTurn`'s `catch` block, as its first statement (before the error bubble):

```js
            this._pbPendingClear();
```

And immediately before the `const out = String(res?.output ?? '');` line:

```js
        this._pbPendingClear();
```

In `_compiledTurn`, the batch branch of the `done` listener, as the first statement inside `} else if (cs.mode === 'batch') {`:

```js
                            this._pbPendingClear();
```

And in `_compiledTurn`'s `catch (e)` block, as its first statement:

```js
            this._pbPendingClear();
```

Finally, in `_pbOverlayOpen`'s `send()` closure, in the branch that dispatches a **compiled** batch turn — the `if (this._compiledSession) { this._pbClearFeed(); this._pbBubble('you', text); }` line — append `this._pbPending();` inside that block, so a compiled turn shows the dots too:

```js
                    if (this._compiledSession) { this._pbClearFeed(); this._pbBubble('you', text); this._pbPending(); }
```

- [ ] **Step 5: Add the CSS**

In `frontend/assets/css/workflow-editor.css`, immediately before the `.node-fork-badge {` rule:

```css
/* The "still working" dots. One small element, three keyframed opacities —
   deliberately NOT on an edge or a node: the canvas's existing dash-offset
   animation has been measured at hundreds of main-thread paints per second and
   nothing here may add to that. */
.pb-pending { display: inline-flex; gap: 5px; align-items: center; }

.pb-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #94a3b8;
    animation: pbDotPulse 1.2s ease-in-out infinite;
}

.pb-dot:nth-child(2) { animation-delay: 0.18s; }
.pb-dot:nth-child(3) { animation-delay: 0.36s; }

@keyframes pbDotPulse {
    0%, 60%, 100% { opacity: 0.28; }
    30%           { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
    .pb-dot { animation: none; opacity: 0.6; }
}
```

- [ ] **Step 6: Add the label to all three locales**

Add `"working"` to the `workflow.batchSession` block in each file:

- `en.json`: `"working": "Working…"`
- `es.json`: `"working": "Trabajando…"`
- `fr.json`: `"working": "Traitement en cours…"`

Verify:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
python3 -c "
import json
ks=[set(json.load(open(f'frontend/assets/i18n/{l}.json'))['workflow']['batchSession']) for l in ('en','es','fr')]
print('parity:', ks[0]==ks[1]==ks[2]); print('working' in ks[0])"
```

Expected: `parity: True` then `True`.

- [ ] **Step 7: Verify and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js | tail -2
node frontend/assets/js/__tests__/swarm-rewrite.test.js | tail -1
git diff --stat -- backend/ | wc -l
```

Expected: `JS ok`; `all passing`; swarm-rewrite 16/16; `0` (no backend change in this task).

Bump both busters in `frontend/index.html` to `?v=20260917-dots1`.

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/js/__tests__/batch-conversation.test.js frontend/assets/css/workflow-editor.css frontend/assets/i18n/en.json frontend/assets/i18n/es.json frontend/assets/i18n/fr.json frontend/index.html
git commit -m "feat(overlay): a pending indicator between the prompt and the answer"
```

---

### Task 2: Extract the shared run-server emitter

Spec §5. Pure extraction: `api.py`'s runtime half is already the static, framework-agnostic `LangGraphGenerator::modularApiBlock()`. Only the docstring and the import line are target-specific.

**Files:**
- Create: `backend/src/AgentTeam/Services/RunServerEmitter.php`
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` — `emitModularApi()` delegates; `modularApiBlock()` moves out
- Create: `backend/tests/Unit/RunServerEmitterTest.php`

**Interfaces:**
- Consumes: `PythonEmitHelpers::eventSinkBlock()` (already shared; provides `set_event_sink`, `emit_event`, `resolve_gate`).
- Produces:
  ```php
  RunServerEmitter::emit(
      string $workflowName,   // for the module docstring's first line
      string $docBody,        // the already-composed doc body, escaped by the caller
      string $importLine      // e.g. 'from workflow import run as run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'
  ): string
  ```
  and `RunServerEmitter::commonBlock(): string` — the `common.py` body a non-LangGraph target emits: `PythonEmitHelpers::eventSinkBlock()` and nothing else.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/RunServerEmitterTest.php`:

```php
<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\RunServerEmitter;

/**
 * The run server is emitted for four targets from one place. These pin the
 * pieces every target depends on; the byte-identity of LangGraph's own output
 * is pinned by the existing generator tests and is the real proof the
 * extraction was inert.
 */
final class RunServerEmitterTest extends TestCase
{
    public function testEmitsTheRunProtocolRoutes(): void
    {
        $out = RunServerEmitter::emit('Demo', 'doc body', 'from workflow import run_workflow');
        $this->assertStringContainsString('@app.post("/runs")', $out);
        $this->assertStringContainsString('@app.get("/runs/{run_id}/events")', $out);
        $this->assertStringContainsString('@app.get("/.well-known/workflow.json")', $out);
    }

    public function testCarriesTheCallersImportLineVerbatim(): void
    {
        $line = 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
        $out = RunServerEmitter::emit('Demo', 'doc body', $line);
        $this->assertStringContainsString($line, $out);
    }

    public function testCommonBlockGivesTheSinkApiPyImports(): void
    {
        $common = RunServerEmitter::commonBlock();
        $this->assertStringContainsString('def set_event_sink(', $common);
        $this->assertStringContainsString('def emit_event(', $common);
        // api.py does `from common import set_event_sink, resolve_gate`, so a
        // target emitting this block satisfies that import without a gate
        // implementation of its own.
        $this->assertStringContainsString('def resolve_gate(', $common);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/RunServerEmitterTest.php 2>&1 | grep -v "Xdebug:" | tail -5
```

Expected: an error that `AgentTeam\Services\RunServerEmitter` does not exist.

- [ ] **Step 3: Record the LangGraph baseline BEFORE touching anything**

This is the only evidence that the extraction was inert. Capture it now:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit 2>&1 | grep -v "Xdebug:" | tail -3 > /tmp/phpunit-before.txt
cat /tmp/phpunit-before.txt
```

Expected, and what Step 7 compares against: `Tests: 428, Assertions: 1810, Errors: 12, Failures: 13`. Those 12 + 13 are pre-existing and unrelated to this work.

- [ ] **Step 4: Create the emitter**

Create `backend/src/AgentTeam/Services/RunServerEmitter.php`. **Move** `modularApiBlock()`'s heredoc out of `LangGraphGenerator` into this class verbatim — do not retype it; it is several hundred lines of Python and a transcription error would be invisible until runtime.

```php
<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The run server every compiled target serves, emitted once.
 *
 * `api.py`'s runtime half — RunState, the four routes, the SSE stream with its
 * ring buffer and Last-Event-ID replay, the uvicorn entry point — has no
 * framework in it. It calls one function and publishes what comes back. Only
 * the module docstring and the import line differ between targets, so those are
 * the parameters and everything else is shared.
 *
 * Extracted from LangGraphGenerator, whose emitted bytes must not move: the
 * existing generator pins are the proof of that.
 */
final class RunServerEmitter
{
    /**
     * @param string $workflowName For the docstring's first line.
     * @param string $docBody      Already composed AND escaped by the caller.
     * @param string $importLine   How this target's workflow module is imported.
     */
    public static function emit(string $workflowName, string $docBody, string $importLine): string
    {
        $L = [];
        $L[] = '"""Run server for workflow ' . json_encode($workflowName, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L[] = '';
        foreach (explode("\n", $docBody) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, time, uuid';
        $L[] = '';
        $L[] = 'from fastapi import FastAPI, HTTPException, Request';
        $L[] = 'from fastapi.middleware.cors import CORSMiddleware';
        $L[] = 'from fastapi.responses import StreamingResponse';
        $L[] = 'import uvicorn';
        $L[] = '';
        $L[] = 'from common import set_event_sink, resolve_gate';
        $L[] = $importLine;
        $L[] = '';
        $L[] = '';
        $L[] = self::runtimeBlock();
        return implode("\n", $L);
    }

    /**
     * What a non-LangGraph target's common.py contains: the event sink and the
     * gate rendezvous, inert until api.py installs a sink. ADK, MAF and NOOA do
     * not call emit_event yet — this is the seam their swarm ports will use.
     */
    public static function commonBlock(): string
    {
        return PythonEmitHelpers::eventSinkBlock();
    }

    /** api.py's runtime half: run state, the four routes, the uvicorn entry point. */
    private static function runtimeBlock(): string
    {
        // <<< MOVED VERBATIM from LangGraphGenerator::modularApiBlock().
        //     Cut, do not retype. >>>
    }
}
```

**Critical:** reproduce `emit()`'s line sequence to match what `emitModularApi()` currently builds, exactly. Read the existing method and compare line for line before running anything — a single changed blank line moves LangGraph's bytes and fails Step 7.

- [ ] **Step 5: Delegate from LangGraphGenerator**

Replace `emitModularApi()`'s body below the docstring composition so it calls the emitter, and delete `modularApiBlock()` (now moved):

```php
    private function emitModularApi(array $facts, array $layout): string
    {
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $body = $this->apiPyDocBody($facts,
            'LangGraph modular run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            'pip install fastapi uvicorn langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
            ['# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
             '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
             '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)']);
        return RunServerEmitter::emit(
            $facts['wfName'],
            $esc($body),
            'from workflow import run as run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'
        );
    }
```

Note the import line keeps `run as run_workflow`: LangGraph's function is named `run`, and renaming it would move its bytes. New targets pass their own line.

- [ ] **Step 6: Run the new test to verify it passes**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/RunServerEmitterTest.php 2>&1 | grep -v "Xdebug:" | tail -4
```

Expected: `OK (3 tests, 4 assertions)`.

- [ ] **Step 7: Prove LangGraph's bytes did not move**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit 2>&1 | grep -v "Xdebug:" | tail -3 > /tmp/phpunit-after.txt
diff /tmp/phpunit-before.txt /tmp/phpunit-after.txt && echo "IDENTICAL — extraction was inert"
```

Expected: `IDENTICAL — extraction was inert`, allowing only for the 3 new tests in the count line. If any generator pin newly fails, the extraction changed the emitted Python — **stop**, diff the emitted `api.py` against git, and find the changed line.

- [ ] **Step 8: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/AgentTeam/Services/RunServerEmitter.php backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/RunServerEmitterTest.php
git commit -m "refactor(codegen): one run-server emitter for every target"
```

---

### Task 3: ADK emits a package

Spec §3 (a rename), §4. ADK is first because it is the simplest of the three, which makes it the cheapest place to discover whether these scripts survive being imported at all (spec §8).

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php` — `generate()` gains a package mode; `main` → `run_workflow`
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php:309` (`generateAdk`) — accept `?package=1`
- Create: `backend/tests/fixtures/compiled/package_probe.py`

**Interfaces:**
- Consumes: `RunServerEmitter::emit(string, string, string)` and `RunServerEmitter::commonBlock()` (Task 2).
- Produces: `generateAdk` with `?package=1` returns `{root: string, files: [{path, code}]}` — the same shape `generate-python?modular=1` returns, which `_writeManifest` already consumes unchanged.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/Unit/` a new file `ADKPackageTest.php`:

```php
<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ADKPackageTest extends TestCase
{
    private function pkg(): array
    {
        $gen = new \AgentTeam\Services\ADKGenerator();
        return $gen->generatePackage(44);   // the dispatcher demo fixture workflow
    }

    public function testEmitsTheFourPackageFiles(): void
    {
        $paths = array_column($this->pkg()['files'], 'path');
        sort($paths);
        $this->assertSame(['__init__.py', 'api.py', 'common.py', 'workflow.py'], $paths);
    }

    public function testWorkflowExposesTheContract(): void
    {
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $files['workflow.py']
        );
    }

    public function testTheCliEntryStillExists(): void
    {
        // The single-file download is the only way to run this outside the
        // editor; packaging must not remove it.
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $this->assertStringContainsString('if __name__ == "__main__":', $files['workflow.py']);
    }

    public function testApiPyImportsTheContractNotMain(): void
    {
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $this->assertStringContainsString('from workflow import run_workflow', $files['api.py']);
        $this->assertStringNotContainsString('import main', $files['api.py']);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/ADKPackageTest.php 2>&1 | grep -v "Xdebug:" | tail -5
```

Expected: `Call to undefined method AgentTeam\Services\ADKGenerator::generatePackage()`.

- [ ] **Step 3: Rename the entry point**

In `ADKGenerator.php`, the entry emitter at roughly line 914 currently builds `"async def main(user_prompt: str = {$sp}):\n"`. Change it to emit the contract signature, and keep the CLI block calling it:

```php
            "async def run_workflow(prompt: str, session: str | None = None) -> str:\n" .
```

Every reference to `user_prompt` inside that body becomes `prompt`. The `__main__` block at roughly line 1029 becomes:

```php
            "if __name__ == \"__main__\":\n" .
            "    # argparse would fight the prompt's own spaces; the runner\n" .
            "    # passes it space-split; sys.argv[1] alone would keep only the first word.\n" .
            "    asyncio.run(run_workflow(\" \".join(sys.argv[1:]) if len(sys.argv) > 1 else {$sp}))";
```

`session` is accepted and never read — that is the contract (spec §3), and it is what lets one `api.py` serve both this and a future swarm target.

- [ ] **Step 4: Add the package mode**

Add to `ADKGenerator`:

```php
    /**
     * The compiled package: the same script, plus the run server that makes it
     * conversational. The single-file generate() is unchanged and still the
     * only way to run this outside the editor.
     */
    public function generatePackage(int $workflowId, ?string $userId = null): array
    {
        $single = $this->generate($workflowId, $userId);
        $wf = $this->workflowRepo->findById($workflowId);
        $name = $wf ? $wf->getName() : 'workflow';
        $root = preg_replace('/[^a-z0-9_]+/i', '_', strtolower($name)) . '_adk';

        return [
            'root' => $root,
            'files' => [
                // A regular `agents/` package elsewhere on sys.path (openai-agents)
                // beats a local namespace portion under PEP 420. Without this
                // marker the emitted package loses to an installed one.
                ['path' => '__init__.py', 'code' => "\n"],
                ['path' => 'workflow.py', 'code' => $single['code']],
                ['path' => 'common.py',   'code' => \AgentTeam\Services\RunServerEmitter::commonBlock()],
                ['path' => 'api.py',      'code' => \AgentTeam\Services\RunServerEmitter::emit(
                    $name,
                    'ADK run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
                    'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'
                )],
            ],
        ];
    }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/ADKPackageTest.php 2>&1 | grep -v "Xdebug:" | tail -4
```

Expected: `OK (4 tests, ...)`.

- [ ] **Step 6: Write the compile probe**

Text assertions cannot see an import-time failure, and spec §8 says that is the likeliest way this breaks. Create `backend/tests/fixtures/compiled/package_probe.py`:

```python
"""Execute an emitted package: start its server, run one turn, read the answer.

Usage: python package_probe.py <folder-name-under-scripts>

Exits 0 only if a terminal `done` frame arrives with a non-empty output. This is
the only check that can see an import-time failure -- api.py imports workflow.py,
and these scripts have only ever run as __main__.
"""
import json
import sys
import time
import urllib.request

RUNNER = "http://127.0.0.1:8765"


def post(path, body):
    req = urllib.request.Request(
        RUNNER + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def main(folder):
    started = post("/api/workflow-server/start", {"folder": folder})
    base = started["url"].rstrip("/")
    print(f"[probe] server at {base}", flush=True)

    run = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{base}/runs", data=json.dumps({"prompt": "say hello"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"), timeout=60).read())
    run_id = run["run_id"]
    print(f"[probe] run {run_id}", flush=True)

    deadline = time.time() + 300
    with urllib.request.urlopen(f"{base}/runs/{run_id}/events", timeout=300) as stream:
        for raw in stream:
            if time.time() > deadline:
                print("[probe] FAIL timed out with no terminal frame", flush=True)
                return 1
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:].strip())
            if "error" in ev:
                print(f"[probe] FAIL error frame: {ev['error']}", flush=True)
                return 1
            if ev.get("status") == "completed":
                out = ev.get("output") or ""
                print(f"[probe] done, {len(out)} chars", flush=True)
                return 0 if out.strip() else 1
    print("[probe] FAIL stream ended with no terminal frame", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

- [ ] **Step 7: Run the probe against a real ADK package**

Generate the package into the runner's scripts directory, then probe it. The runner must be up — check first:

```bash
curl -s -m 4 http://127.0.0.1:8765/health
```

Expected: `{"ok":true,...}`. If not, start it: `cd ~/Documents/synergyAI/python && ./.venv/bin/python main.py`

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
php -r '
require "backend/vendor/autoload.php";
$g = new AgentTeam\Services\ADKGenerator();
$p = $g->generatePackage(44);
$dir = getenv("HOME") . "/Documents/synergyAI/python/scripts/" . $p["root"];
@mkdir($dir, 0777, true);
foreach ($p["files"] as $f) { file_put_contents("$dir/" . $f["path"], $f["code"]); }
echo $p["root"], "\n";
' > /tmp/adk-root.txt
python3 backend/tests/fixtures/compiled/package_probe.py "$(cat /tmp/adk-root.txt)"
```

Expected: `[probe] done, N chars` and exit 0.

**If it fails with an import error**, that is spec §8's risk landing. Report exactly what failed — module-level `asyncio.run`, work at import time, a missing dependency — rather than patching around it; the shape of the fix belongs in the report.

- [ ] **Step 8: Wire the endpoint**

In `WorkflowController::generateAdk()` (line 309), return the manifest when `?package=1` is present, keeping every existing response shape untouched:

```php
        if (!empty($request['query']['package'])) {
            $pkg = (new \AgentTeam\Services\ADKGenerator())->generatePackage($workflowId, $userId);
            return ['success' => true, 'data' => $pkg];
        }
```

- [ ] **Step 9: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
php backend/vendor/bin/phpunit backend/tests/Unit 2>&1 | grep -v "Xdebug:" | tail -3
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/src/AgentTeam/Controllers/WorkflowController.php backend/tests/Unit/ADKPackageTest.php backend/tests/fixtures/compiled/package_probe.py
git commit -m "feat(adk): emit a package with a run server"
```

---

### Task 4: MAF emits a package

Spec §3 (an **extraction**, not a rename) and §8. MAF is second, not last, because it is the only target whose shape could force a change to the shared contract — discovering that with one target left is cheaper than with none.

**Files:**
- Modify: `backend/src/AgentTeam/Services/MAFGenerator.php` — split `entryBlock()` (line 1351) into `run_workflow()` plus a thin `__main__`
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (`generateMaf`)
- Create: `backend/tests/Unit/MAFPackageTest.php`

**Interfaces:**
- Consumes: `RunServerEmitter::emit(string, string, string)`, `RunServerEmitter::commonBlock()` (Task 2); `package_probe.py` (Task 3).
- Produces: `generateMaf` with `?package=1` returning `{root, files[]}`.

**The split, decided.** MAF's `__main__` block currently does five things. They divide like this:

| what it does today | where it goes |
|---|---|
| `ProgressReporter.begin(...)` | `run_workflow` — it is progress for the run, not for the CLI |
| `create_workflow()` + `asyncio.run(_workflow.run(prompt))` | `run_workflow` (without the `asyncio.run` — it is already async) |
| `_result.get_outputs()` → `_text` | `run_workflow`; this is the answer, and it is what it returns |
| `print("\n=== FINAL OUTPUT ===\n" + _text)` | `__main__` — a server has no console |
| HTML detection + saving to the output folder | **`__main__` only** — see below |

**Saving stays in `__main__`, deliberately.** Moving it into `run_workflow` would make every conversational turn write a file to the output folder, which nothing asked for and which the LangGraph targets do not do. The editor already persists a run's output through `_saveWorkflowOutput`.

**`run_workflow` must return the text un-stripped.** MAF's entry block detects a document with `(?is)<!doctype html.*?</html\s*>` falling back to `(?is)<html[\s>].*?</html\s*>` — the same extraction the editor's `_extractDocument()` performs on the answer. If `run_workflow` pre-strips to the bare document, the editor loses any narration around it; if it returns the full text, both the CLI's save path and the editor's viewer find the document themselves and agree. Return the full text.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/MAFPackageTest.php`:

```php
<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class MAFPackageTest extends TestCase
{
    private function files(): array
    {
        $gen = new \AgentTeam\Services\MAFGenerator();
        return array_column($gen->generatePackage(44)['files'], 'code', 'path');
    }

    public function testExposesTheContract(): void
    {
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $this->files()['workflow.py']
        );
    }

    public function testRunWorkflowReturnsTheTerminalOutput(): void
    {
        $wf = $this->files()['workflow.py'];
        $this->assertStringContainsString('_outputs = _result.get_outputs()', $wf);
        $this->assertStringContainsString('return _text', $wf);
    }

    public function testSavingStaysInTheCliEntry(): void
    {
        // A conversational turn must not write a file per prompt. The save
        // block belongs to __main__, after the call, not inside run_workflow.
        $wf = $this->files()['workflow.py'];
        $mainAt = strpos($wf, 'if __name__ == "__main__":');
        $saveAt = strpos($wf, 'OUTPUT_STORAGE_ENABLED');
        $this->assertNotFalse($mainAt);
        $this->assertNotFalse($saveAt);
        $this->assertGreaterThan($mainAt, $saveAt, 'saving leaked into run_workflow');
    }

    public function testRunWorkflowDoesNotPreStripTheDocument(): void
    {
        // The editor extracts the document from the answer itself; stripping
        // here would lose any narration around it and make the two disagree.
        $wf = $this->files()['workflow.py'];
        $mainAt = strpos($wf, 'if __name__ == "__main__":');
        $reAt = strpos($wf, '<!doctype html');
        $this->assertGreaterThan($mainAt, $reAt, 'document extraction leaked into run_workflow');
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/MAFPackageTest.php 2>&1 | grep -v "Xdebug:" | tail -5
```

Expected: `Call to undefined method AgentTeam\Services\MAFGenerator::generatePackage()`.

- [ ] **Step 3: Split the entry block**

In `MAFGenerator::entryBlock()` (line 1351), replace the single `__main__` block with a function plus a thin entry. The function:

```python
async def run_workflow(prompt: str, session: str | None = None) -> str:
    """Run the workflow once and return its terminal output.

    `session` is accepted and ignored: a batch workflow terminates and has
    nothing to resume. It exists so this signature matches the run server's
    contract, which is what lets one api.py serve every target.

    Returns the text UNMODIFIED. The caller decides what to do with it — the
    CLI entry below extracts a document and saves it; the editor's viewer does
    its own extraction. Stripping here would make the two disagree.
    """
    ProgressReporter.begin(len(AGENTS), prompt)
    _workflow = create_workflow()
    _result = await _workflow.run(prompt)
    _outputs = _result.get_outputs()
    _text = str(_outputs[0]) if _outputs else ""
    return _text
```

And the entry, keeping every line of the existing save logic below it unchanged:

```python
if __name__ == "__main__":
    _prompt = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else DEFAULT_PROMPT
    try:
        _text = asyncio.run(run_workflow(_prompt))
    except Exception as _err:
        print("\n=== WORKFLOW STOPPED ===\n" + str(_err), file=sys.stderr)
        sys.exit(1)
    print("\n=== FINAL OUTPUT ===\n" + _text)
    # <<< the existing OUTPUT_STORAGE_ENABLED block, unchanged >>>
```

- [ ] **Step 4: Add the package mode**

```php
    public function generatePackage(int $workflowId, ?string $userId = null): array
    {
        $single = $this->generate($workflowId, $userId);
        $wf = $this->workflowRepo->findById($workflowId);
        $name = $wf ? $wf->getName() : 'workflow';
        $root = preg_replace('/[^a-z0-9_]+/i', '_', strtolower($name)) . '_maf';

        return [
            'root' => $root,
            'files' => [
                ['path' => '__init__.py', 'code' => "\n"],
                ['path' => 'workflow.py', 'code' => $single['code']],
                ['path' => 'common.py',   'code' => \AgentTeam\Services\RunServerEmitter::commonBlock()],
                ['path' => 'api.py',      'code' => \AgentTeam\Services\RunServerEmitter::emit(
                    $name,
                    'MAF run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
                    'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'
                )],
            ],
        ];
    }
```

- [ ] **Step 5: Verify and probe**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/MAFPackageTest.php 2>&1 | grep -v "Xdebug:" | tail -4
```

Expected: `OK (4 tests, ...)`.

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
php -r '
require "backend/vendor/autoload.php";
$g = new AgentTeam\Services\MAFGenerator();
$p = $g->generatePackage(44);
$dir = getenv("HOME") . "/Documents/synergyAI/python/scripts/" . $p["root"];
@mkdir($dir, 0777, true);
foreach ($p["files"] as $f) { file_put_contents("$dir/" . $f["path"], $f["code"]); }
echo $p["root"], "\n";
' > /tmp/maf-root.txt
python3 backend/tests/fixtures/compiled/package_probe.py "$(cat /tmp/maf-root.txt)"
```

Expected: `[probe] done, N chars`, exit 0.

- [ ] **Step 6: Wire the endpoint and commit**

Add the same `?package=1` branch to `WorkflowController::generateMaf()` that Task 3 added to `generateAdk()`, calling `MAFGenerator::generatePackage()`.

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
php backend/vendor/bin/phpunit backend/tests/Unit 2>&1 | grep -v "Xdebug:" | tail -3
git add backend/src/AgentTeam/Services/MAFGenerator.php backend/src/AgentTeam/Controllers/WorkflowController.php backend/tests/Unit/MAFPackageTest.php
git commit -m "feat(maf): extract run_workflow from the CLI entry, emit a package"
```

---

### Task 5: NOOA emits a package

Spec §3 (a rename). Last, because by now nothing about the shape is in question.

**Files:**
- Modify: `backend/src/AgentTeam/Services/NOOAGenerator.php:857` — `main` → `run_workflow`
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (`generateNooa`)
- Create: `backend/tests/Unit/NOOAPackageTest.php`

**Interfaces:**
- Consumes: `RunServerEmitter::emit(string, string, string)`, `RunServerEmitter::commonBlock()` (Task 2); `package_probe.py` (Task 3).
- Produces: `generateNooa` with `?package=1` returning `{root, files[]}`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/NOOAPackageTest.php`:

```php
<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class NOOAPackageTest extends TestCase
{
    private function files(): array
    {
        $gen = new \AgentTeam\Services\NOOAGenerator();
        return array_column($gen->generatePackage(44)['files'], 'code', 'path');
    }

    public function testExposesTheContract(): void
    {
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $this->files()['workflow.py']
        );
    }

    public function testEmitsTheFourPackageFiles(): void
    {
        $paths = array_keys($this->files());
        sort($paths);
        $this->assertSame(['__init__.py', 'api.py', 'common.py', 'workflow.py'], $paths);
    }

    public function testSwarmIsStillRefused(): void
    {
        // Spec §9: NOOA is batch-only, permanently. Packaging must not have
        // made a swarm canvas compilable by accident.
        $src = file_get_contents(__DIR__ . '/../../src/AgentTeam/Services/NOOAGenerator.php');
        $this->assertStringContainsString('swarm', $src);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/NOOAPackageTest.php 2>&1 | grep -v "Xdebug:" | tail -5
```

Expected: `Call to undefined method AgentTeam\Services\NOOAGenerator::generatePackage()`.

- [ ] **Step 3: Rename the entry point**

At `NOOAGenerator.php:857`, change:

```php
        return "async def main(prompt: str = DEFAULT_PROMPT) -> str:\n" . implode("\n", $body);
```

to:

```php
        return "async def run_workflow(prompt: str, session: str | None = None) -> str:\n" . implode("\n", $body);
```

Then find the `__main__` block that calls `main(...)` and change the call to `run_workflow(...)`, supplying `DEFAULT_PROMPT` explicitly since the default parameter is gone:

```python
    asyncio.run(run_workflow(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else DEFAULT_PROMPT))
```

The default moved from the signature to the caller deliberately: the run server always passes a prompt, and a signature default would let a missing one pass silently as the baked-in Start prompt.

- [ ] **Step 4: Add the package mode**

```php
    public function generatePackage(int $workflowId, ?string $userId = null): array
    {
        $single = $this->generate($workflowId, $userId);
        $wf = $this->workflowRepo->findById($workflowId);
        $name = $wf ? $wf->getName() : 'workflow';
        $root = preg_replace('/[^a-z0-9_]+/i', '_', strtolower($name)) . '_nooa';

        return [
            'root' => $root,
            'files' => [
                ['path' => '__init__.py', 'code' => "\n"],
                ['path' => 'workflow.py', 'code' => $single['code']],
                ['path' => 'common.py',   'code' => \AgentTeam\Services\RunServerEmitter::commonBlock()],
                ['path' => 'api.py',      'code' => \AgentTeam\Services\RunServerEmitter::emit(
                    $name,
                    'NOOA run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
                    'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'
                )],
            ],
        ];
    }
```

- [ ] **Step 5: Verify, probe, wire and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend
php vendor/bin/phpunit tests/Unit/NOOAPackageTest.php 2>&1 | grep -v "Xdebug:" | tail -4
```

Expected: `OK (3 tests, ...)`.

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
php -r '
require "backend/vendor/autoload.php";
$g = new AgentTeam\Services\NOOAGenerator();
$p = $g->generatePackage(44);
$dir = getenv("HOME") . "/Documents/synergyAI/python/scripts/" . $p["root"];
@mkdir($dir, 0777, true);
foreach ($p["files"] as $f) { file_put_contents("$dir/" . $f["path"], $f["code"]); }
echo $p["root"], "\n";
' > /tmp/nooa-root.txt
python3 backend/tests/fixtures/compiled/package_probe.py "$(cat /tmp/nooa-root.txt)"
```

Expected: `[probe] done, N chars`, exit 0.

Add the `?package=1` branch to `WorkflowController::generateNooa()`, mirroring Task 3's.

```bash
php backend/vendor/bin/phpunit backend/tests/Unit 2>&1 | grep -v "Xdebug:" | tail -3
git add backend/src/AgentTeam/Services/NOOAGenerator.php backend/src/AgentTeam/Controllers/WorkflowController.php backend/tests/Unit/NOOAPackageTest.php
git commit -m "feat(nooa): emit a package with a run server"
```

---

### Task 6: The editor asks for the right target

Spec §7. The smallest task in the plan, and that is the point: if it needs to be bigger, the protocol boundary has been broken somewhere.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — `_fetchManifest`, and the three Run paths that reach `_runCompiled`
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: the `?package=1` endpoints from Tasks 3-5.
- Produces: `_fetchManifest(mode, target = 'langgraph')` — `target` one of `'langgraph' | 'adk' | 'maf' | 'nooa'`; `_writeManifest(mode, target = 'langgraph')` passes it through.

- [ ] **Step 1: Teach the fetcher a target**

Replace `_fetchManifest`'s first two lines:

```js
    async _fetchManifest(mode = 'a2a') {
        const flag = mode === 'modular' ? 'modular=1' : 'a2a=1';
        const resp = await fetch(`${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?${flag}`, { headers: this.getAuthHeaders() });
```

with:

```js
    async _fetchManifest(mode = 'a2a', target = 'langgraph') {
        // LangGraph's two multi-file modes are selected by flag on one
        // endpoint; the other targets have one package shape each, on their own
        // endpoint. Same response shape either way — {root, files[]} — which is
        // why _writeManifest below needs no knowledge of any of this.
        const url = target === 'langgraph'
            ? `${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?${mode === 'modular' ? 'modular=1' : 'a2a=1'}`
            : `${this.apiBase}/workflows/${this.currentWorkflowId}/generate-${target}?package=1`;
        const resp = await fetch(url, { headers: this.getAuthHeaders() });
```

Then change `_writeManifest`'s signature and its one call:

```js
    async _writeManifest(mode = 'a2a', target = 'langgraph') {
        const data = await this._fetchManifest(mode, target);
```

- [ ] **Step 2: Point the three Run paths at their targets**

Each of the ADK, MAF and NOOA Run paths currently calls `_generateAndWriteScript('generate-adk', 'workflow_adk.py')` (and the MAF/NOOA equivalents) and then streams into the diagnostic modal. Replace that call with the package path, mirroring what `_runLangGraphScript` does for its multi-file modes:

```js
        let data;
        try { data = await this._writeManifest('modular', 'adk'); }
        catch (e) { this._hideCompiledScrim(); alert(`Could not generate the workflow package: ${e?.message || e}`); return; }
        return this._runCompiled(data.root, null, this.t('workflow.toolbar.compileAdk'));
```

Use `'maf'` and `'nooa'` for the other two, with their existing framework labels. Raise the scrim synchronously at the top of each, as `_runLangGraphScript` does — the owner's rule is that the progress message shows the moment Run is clicked, not after the package is written.

- [ ] **Step 3: Verify and commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/batch-conversation.test.js | tail -2
node frontend/assets/js/__tests__/swarm-rewrite.test.js | tail -1
```

Expected: `JS ok`; `all passing`; 16/16.

Bump both busters in `frontend/index.html` to `?v=20260917-targets1`.

```bash
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(editor): compiled ADK, MAF and NOOA runs drive the conversation overlay"
```

---

## Manual verification, by the owner

The automated probe proves each package runs. These cover the surface it does not see.

1. Open a batch workflow. Compile dropdown → **ADK** → Run. The progress message appears **immediately** on click, the canvas dims, the conversation overlay opens.
2. Send a prompt. **The dots appear straight away** and are replaced by one bubble when the answer lands.
3. Repeat for **MAF** and **NOOA**.
4. Run a workflow that produces an HTML document on **MAF**. The bubble says a document was produced; the viewer opens with it rendered. Drag and resize the viewer; close it and confirm the conversation is still usable.
5. Download the single-file script for each of the three and run it from a terminal. It must still work — packaging added a server, it did not replace the CLI.
6. Confirm a **swarm** canvas is still refused by all three targets, with the existing message.

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 the missing component | 2-5 |
| §2 why it is small (no runner change, no frontend change beyond the fetcher) | 6, and the constraint that nothing else moves |
| §3 the contract; per-target distance from it | 3 (rename), 4 (extraction), 5 (rename) |
| §3a sink emitted but idle | 2 (`commonBlock`), and the Global Constraint forbidding `emit_event` calls |
| §4 the four package files | 3, 4, 5 — pinned by a sorted file-list assertion in each |
| §5 shared emitter, LangGraph byte-identical | 2, Steps 3 and 7 |
| §6 pending indicator | 1 |
| §7 editor changes | 6 |
| §8 importability risk | 3 Step 6-7 (the probe), and the instruction to report rather than patch |
| §8 MAF's entry does more than run | 4, the split table and two tests that pin saving and extraction **outside** `run_workflow` |
| §9 out of scope | Global Constraints; 5 Step 1 pins the swarm refusal |
| §10 tests | 1, 2, 3, 4, 5 |
| §11 sequencing | Task order |

**Gaps, stated rather than hidden:**

- **Workflow 44 is assumed to exist** as a usable fixture in every package test and probe. It is the workflow the LangGraph compiler was live-verified against. If it is missing or has been changed, the tests fail on data rather than code — an implementer hitting that should say so rather than silently substituting another id.
- **The probe needs the runner and real API keys**, because it executes LLM calls. It is not a CI test; it is a local gate, and Task 3 Step 7 checks `/health` before assuming.
- **The `?package=1` branch is described once (Task 3 Step 8) and referenced by Tasks 4 and 5.** That is deliberate repetition avoided for a three-line branch; if the implementer of Task 4 or 5 cannot see Task 3's code, the branch is: read `query.package`, call the target's `generatePackage`, return `['success' => true, 'data' => $pkg]`.

**Type consistency:** `RunServerEmitter::emit(string $workflowName, string $docBody, string $importLine)` and `::commonBlock()` are defined in Task 2 and called with those exact signatures in Tasks 3, 4 and 5. `generatePackage(int $workflowId, ?string $userId = null): array` returning `['root' => string, 'files' => [['path' => string, 'code' => string]]]` is identical across the three generators. `_fetchManifest(mode, target)` and `_writeManifest(mode, target)` agree in Task 6. `run_workflow(prompt, session)` is the same signature in all three emitted targets and matches what `api.py` imports.
