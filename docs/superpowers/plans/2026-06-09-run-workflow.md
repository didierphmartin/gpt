# `run_workflow` — Author → Run → Render — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After an LLM authors a workflow via `workflow-compile`, `chat.js` creates it in the engine, shows a choice dialog (open in editor | run & show), and — for "run & show" — runs it (live node progress in chat) and renders the result in the artifact overlay.

**Architecture:** New orchestration glue in `chat.js` over existing machinery. The run reuses a new **headless run method on `workflowEditor`** (extracted from `executeWorkflow`) so the chat path gets client‑skill bundling + `client_tool_call` round‑trips for free without the editor UI. Rendering reuses the existing **artifact pane** (`_selectArtifactFromOutputs` / `openArtifactPane`).

**Tech Stack:** vanilla JS (`chat.js`, `workflow-editor.js`); backend `WorkflowController` (`create`, `run-stream`) already exists. **No frontend unit runner — verification is `node --check` + Playwright/manual.**

**Spec:** `docs/superpowers/specs/2026-06-09-run-workflow-design.md`
**Repo:** `/Applications/XAMPP/xamppfiles/htdocs/gpt` · **Branch:** create `feat/run-workflow` off `initial-import`.

---

## Key existing pieces (verified)

- `workflow-editor.js`: `async loadWorkflow(id)` (5904); `async executeWorkflow(prompt)` (6419) — POSTs `/workflows/{id}/run-stream` with `{variables:{prompt}, client_skills, inline_documents, scratch_files}`, reads the SSE via `fetch` reader, calls `this.handleWorkflowEvent(event)` per event (returns `finalResult`), then `showWorkflowResults(finalResult)`; `async _collectClientSkillsForRun()` (6589) reads the **loaded drawflow** for `bound_skill` (source `local`) → `{dir:{skill_content,scripts}}`; `_collectInlineDocumentsForRun()` (6639).
- `chat.js`: `_selectArtifactFromOutputs(outputs)` (5330) picks a renderable artifact; `openArtifactPane(...)` (5228) shows it (overlay, `blob:` for PDF); skill dispatch result available around 3566–3640 (`result.outputs`).
- Backend: `POST /api/v1/workflows` (create), `POST /api/v1/workflows/{id}/run-stream` (run).

---

## Task 1: Extract a headless run on `workflowEditor`

**Files:** Modify `frontend/assets/js/workflow-editor.js`.

Refactor so the run loop is reusable without the editor UI. **Behavior‑preserving extraction.**

- [ ] **Step 1:** Add a new method `async runHeadless(workflowId, userPrompt, { onProgress } = {})` that runs a workflow and **returns `{ result, outputs }`** without driving the editor canvas. It must:
  1. `await this.loadWorkflow(workflowId);` (populates the drawflow so `_collectClientSkillsForRun` works).
  2. `await this._ensureLocalFsPermission();`
  3. Collect: `const clientSkills = await this._collectClientSkillsForRun(); const { inlineDocuments, scratchFiles } = await this._collectInlineDocumentsForRun();`
  4. Build the same `body` as `executeWorkflow` (`{ variables:{ prompt:userPrompt }, client_skills?, inline_documents?, scratch_files? }`).
  5. `fetch` `${this.apiBase}/workflows/${workflowId}/run-stream` (POST, Bearer token, `Accept: text/event-stream`), read the stream with the same `reader`/`decoder`/`buffer` loop as `executeWorkflow` (lines 6503–6531).
  6. **Per event:** `const ev = JSON.parse(data);` then:
     - call `this.handleWorkflowEvent(ev)` to keep `client_tool_call` round‑trips + result extraction working (it returns `finalResult` when present — capture it);
     - additionally, if `onProgress` and `ev.type` is `node_start`/`node_complete`/`workflow_start`/`workflow_complete`, call `onProgress(ev)` so the caller can show progress.
  7. After `[DONE]`: `this._cleanupScratchFiles();` and `return { result: finalResult, outputs: finalResult?.outputs ?? null };`
  8. On error/abort: mirror `executeWorkflow`'s catch (cleanup, rethrow non‑abort so the caller can surface it).

Note: do **not** remove `executeWorkflow`. To avoid duplicating ~40 lines you MAY have `executeWorkflow` delegate to `runHeadless` after its UI setup, but the safe minimum is a standalone `runHeadless`; if you duplicate the stream loop, keep both copies behavior‑identical.

- [ ] **Step 2: Syntax check:** `node --check frontend/assets/js/workflow-editor.js` → no output.

- [ ] **Step 3: Manual sanity** (note for the reviewer; can't unit‑test): confirm `runHeadless` is defined and references existing methods only:
`grep -nE "runHeadless|handleWorkflowEvent|_collectClientSkillsForRun|run-stream" frontend/assets/js/workflow-editor.js | head`

- [ ] **Step 4: Commit:**
```bash
git add frontend/assets/js/workflow-editor.js
git commit -m "feat(workflow-editor): runHeadless(id, prompt, {onProgress}) — reusable run returning {result, outputs}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `detectWorkflowOutput` + `createWorkflow` in chat.js

**Files:** Modify `frontend/assets/js/chat.js`.

- [ ] **Step 1:** Add two helpers to the chat class:
```javascript
// True iff a skill result is a workflow DSL produced by workflow-compile.
// Returns the parsed DSL ({name, description, definition:{nodes,edges}}) or null.
_detectWorkflowOutput(dirName, outputs) {
    if (dirName !== 'workflow-compile' || !outputs) return null;
    for (const [path, content] of Object.entries(outputs)) {
        if (!/\.json$/i.test(path) || typeof content !== 'string') continue;
        try {
            const dsl = JSON.parse(content);
            if (dsl && dsl.definition && Array.isArray(dsl.definition.nodes)) return dsl;
        } catch (_) { /* not the DSL */ }
    }
    return null;
}

// Create the workflow in the engine. Returns the new id, or throws with the
// backend's validation errors surfaced.
async _createWorkflowFromDsl(dsl) {
    const token = window.authManager?.token || window.authManager?.getToken?.();
    const resp = await fetch(`${this.apiBase || '/gpt/backend/api/v1'}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
            name: dsl.name || 'Untitled workflow',
            description: dsl.description || '',
            definition: dsl.definition,
        }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.success === false) {
        const errs = data?.validation_errors || data?.message || `HTTP ${resp.status}`;
        throw new Error(Array.isArray(errs) ? errs.join('; ') : String(errs));
    }
    return data?.data?.id ?? data?.id;
}
```
(Confirm `this.apiBase` exists on the chat class — it's used elsewhere; if the property name differs, match the existing one.)

- [ ] **Step 2: Syntax check:** `node --check frontend/assets/js/chat.js` → no output.
- [ ] **Step 3: Commit:**
```bash
git add frontend/assets/js/chat.js
git commit -m "feat(chat): _detectWorkflowOutput + _createWorkflowFromDsl helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Choice dialog + render helper + the orchestrator

**Files:** Modify `frontend/assets/js/chat.js`.

- [ ] **Step 1:** Add the render helper (reuses the artifact pane):
```javascript
// Render a finished workflow run. Markdown → inline bubble; html/pdf → artifact overlay.
_renderWorkflowResult(run) {
    const artifact = this._selectArtifactFromOutputs(run?.outputs);
    if (artifact) { this.openArtifactPane(artifact); return; }
    const text = run?.result?.output ?? run?.result ?? '';
    if (typeof text === 'string' && text.trim()) {
        this.addMessage('assistant', text); // inline markdown bubble
    } else {
        this.showProgress('Workflow finished (no displayable output).');
    }
}
```
(Match `addMessage`/`openArtifactPane`/`_selectArtifactFromOutputs` to their real signatures — verify by grep before writing.)

- [ ] **Step 2:** Add the choice dialog + orchestrator:
```javascript
// After workflow-compile authored a DSL: create it, then ask the user.
async _onWorkflowAuthored(dsl) {
    let id;
    try { this.showProgress('🔄 Building workflow…'); id = await this._createWorkflowFromDsl(dsl); }
    catch (e) { this.addMessage('assistant', `⚠️ Could not create the workflow: ${e.message}`); return; }

    const agentCount = dsl.definition.nodes.filter(n => n.node_type === 'agent').length;
    const summary = `Workflow “${dsl.name}” created — ${agentCount} agent(s).`;
    const choice = await this._showWorkflowChoiceDialog(summary); // 'editor' | 'run' | null

    if (choice === 'editor') {
        if (window.workflowEditor) { await window.workflowEditor.loadWorkflow(id); }
        if (window.agentTeamsPanel?.show) window.agentTeamsPanel.show();
        return;
    }
    if (choice !== 'run') return; // dismissed

    try {
        this.showProgress('▶ Running workflow…');
        const run = await window.workflowEditor.runHeadless(id, this.lastUserPrompt || '', {
            onProgress: (ev) => {
                const name = ev.node?.agent_name || ev.agent_name || ev.node_id || '';
                if (ev.type === 'node_start') this.showProgress(`▶ ${name}…`);
                else if (ev.type === 'node_complete') this.showProgress(`✓ ${name}`);
            },
        });
        this._renderWorkflowResult(run);
    } catch (e) {
        this.addMessage('assistant', `⚠️ Workflow run failed: ${e.message}. It's saved — open it in the editor to retry.`);
    }
}

// Minimal modal: returns 'editor' | 'run' | null (dismissed).
_showWorkflowChoiceDialog(summary) {
    return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40';
        ov.innerHTML = `
          <div class="bg-white rounded-xl shadow-xl p-5 max-w-sm w-full">
            <p class="text-sm text-gray-800 mb-4">${summary}<br>What would you like to do?</p>
            <div class="flex flex-col gap-2">
              <button data-act="run"    class="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm">▶ Run &amp; show the result</button>
              <button data-act="editor" class="px-3 py-2 rounded-md border border-gray-300 text-sm">✏️ Open in the workflow editor</button>
            </div>
          </div>`;
        ov.addEventListener('click', (e) => {
            const act = e.target?.dataset?.act;
            if (act || e.target === ov) { ov.remove(); resolve(act || null); }
        });
        document.body.appendChild(ov);
    });
}
```

- [ ] **Step 3: Syntax check:** `node --check frontend/assets/js/chat.js` → no output.
- [ ] **Step 4: Commit:**
```bash
git add frontend/assets/js/chat.js
git commit -m "feat(chat): workflow choice dialog + run orchestrator + result render

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the orchestrator into the skill‑dispatch result path

**Files:** Modify `frontend/assets/js/chat.js`.

- [ ] **Step 1:** In the primary skill dispatch, **after** the skill result + its `outputs` are available (right after the `const result = await (... runSkillScript ...)` block near line 3568 — i.e. after the `isWorkflowBuild` success `showProgress`), detect + branch. Add:
```javascript
        // Dynamic-workflow loop: if workflow-compile produced a DSL, create it
        // and let the user open it in the editor or run-and-show here.
        try {
            const wfDsl = this._detectWorkflowOutput(dirName, result?.outputs);
            if (wfDsl) { await this._onWorkflowAuthored(wfDsl); }
        } catch (e) {
            console.warn('[workflow] post-author orchestration failed:', e);
        }
```
(`dirName` is in scope here per the existing dispatch; if not, derive it from the resolved skill the same way the dispatch does.)

- [ ] **Step 2: Syntax check:** `node --check frontend/assets/js/chat.js` → no output.
- [ ] **Step 3: Commit:**
```bash
git add frontend/assets/js/chat.js
git commit -m "feat(chat): trigger the workflow author→run→render flow on workflow-compile output

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: End‑to‑end verification (Playwright/manual) + final review

- [ ] **Step 1: Static checks:**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/chat.js && node --check frontend/assets/js/workflow-editor.js && echo "syntax OK"
grep -nE "_onWorkflowAuthored|_showWorkflowChoiceDialog|runHeadless|_renderWorkflowResult|_detectWorkflowOutput|_createWorkflowFromDsl" frontend/assets/js/chat.js frontend/assets/js/workflow-editor.js | head
```
Expected: `syntax OK` and all six symbols present and referenced.

- [ ] **Step 2: Manual end‑to‑end** (in Chrome, capable chat model e.g. Grok/GPT): drag the `workflow-compile` skill in and ask for the *"research metals/cryptos/stocks/finance in parallel → PDF report"* workflow. Verify:
  1. Progress shows `🔄 Building workflow…`, then the **choice dialog** appears.
  2. **Open in editor** → the workflow loads in the editor; you can run it there.
  3. **Run & show** → live `▶ <agent>…` / `✓ <agent>` progress, then the **PDF opens in the artifact overlay** (and a markdown workflow would render inline).
  4. Editor's own **Run button still works** (regression on the `executeWorkflow` refactor).

- [ ] **Step 3: Commit** any fixes from manual testing:
```bash
git add -A && git commit -m "test(run-workflow): manual e2e fixes"
```

---

## Done — outcome

`workflow-compile` authors a DSL → chat **creates** it → a **dialog** lets the user **open it in the editor** or **run it and see the result** (live node progress + the PDF/HTML in the artifact overlay, or markdown inline). The editor's run is now reusable headless; the render reuses the artifact pane. No manual import step.
