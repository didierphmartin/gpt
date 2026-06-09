# `run_workflow` — Author → Run → Render (dynamic workflow loop) — Design Spec

- **Date:** 2026-06-09
- **Project:** `gpt` (frontend `chat.js`)
- **Status:** Approved design → ready for implementation planning
- **Builds on:** the `workflow-compile` skill (authors the DSL) + the workflow output block / `report-pdf` (skills repo), and the existing `WorkflowController` (`create` / `runStream`) + the editor's run machinery.

## 1. Goal

Close the dynamic‑workflow loop **inside the chat**: when an LLM authors a workflow (via
`workflow-compile`), **instantiate it in the engine**, then let the user choose to **open it in the
editor** or **run it and show the result right here** — no manual "import into the editor" step. Today
the flow stops at "DSL written to `outputs/`."

## 2. Decisions (locked in brainstorming)

- **Create, then a choice dialog.** After a successful `workflow-compile` output, `chat.js` always
  **creates** the workflow (sets it in the interpreter), then shows a **dialog** with two paths:
  **(a) Open in workflow editor** — load the workflow in the editor; the user triggers the run there
  themselves; or **(b) Run & show result** — auto‑run here and render the result in chat. The dialog
  gates the agent‑call cost behind an explicit choice while keeping the one‑click dynamic path.
- **DSL source = the prior `workflow-compile` output** (chat.js holds it; the model is not re‑invoked).
- **Reuse the editor's run path** for execution — it already collects the local‑FS skill bundle
  (`_collectClientSkillsForRun`, needed so a `report-pdf`‑bound terminal agent can run), opens
  `runStream`, and handles the `client_tool_call` round‑trips. We do **not** build a new runner.
- **Render in an overlay** on top of the conversation — **reuse the existing artifact pane**
  (`_selectArtifactFromOutputs` → `openArtifactPane` / `_renderArtifact`, `blob:` URLs for PDF). Not a
  new browser tab.
- **Formats:** markdown → inline chat bubble; **HTML / PDF → the artifact overlay.** **DOCX deferred**
  (non‑goal for now).
- **Live progress:** stream the run's node events into the chat as progress (this is the real
  per‑agent feedback — via SSE, since the run is server‑side).

## 3. Non‑Goals

- DOCX or other output formats (now) — only md/html/pdf.
- A new/standalone execution engine — we reuse the editor's run path.
- A new artifact viewer — we reuse the existing artifact pane.
- Persisting workflows beyond what `WorkflowController::create` already does.
- A standalone "run an arbitrary existing workflow from chat" command (this flow is scoped to a
  just‑authored workflow).

## 4. Architecture

A small **`run_workflow` orchestrator in `chat.js`** wired after the `workflow-compile` skill returns.
It is glue over existing pieces; each unit is small and testable:

- **`detectWorkflowOutput(skillResult)`** — true when a skill output is a workflow DSL: the producing
  skill is `workflow-compile`, and the output JSON has `definition.nodes`. Returns the parsed DSL.
- **`createWorkflow(dsl)`** — `POST /api/v1/workflows` with the DSL (name/description/definition) →
  returns the new workflow `id`. (Same payload shape the editor saves.) Runs **always**, before the
  dialog — so the workflow is set in the interpreter either way.
- **`showWorkflowChoiceDialog(id, summary)`** — a modal shown after create: a one‑line graph summary
  (N agents, fan‑out/fan‑in, output format) + two actions — **Open in editor** (`openInEditor(id)`) and
  **Run & show result** (the run+render branch below).
- **`openInEditor(id)`** — load the created workflow into the editor (`workflowEditor.loadWorkflow(id)`)
  and reveal the editor panel, so the user triggers the run there themselves.
- **`runWorkflowStreamed(id, prompt)`** — a thin wrapper over the **editor's existing run**: collect
  client skills (`workflow-editor.js::_collectClientSkillsForRun`), open `runStream` with
  `{ variables: { prompt }, client_skills }`, forward **node events → `showProgress` / chat progress**,
  handle `client_tool_call` via the existing dispatcher, and resolve with the final result + its
  `outputs`.
- **`renderWorkflowResult(result)`** — the format router: if the terminal output is **markdown text**,
  add an inline assistant bubble; if the run produced an **artifact** (`_selectArtifactFromOutputs`
  finds html/pdf), open it in the **artifact overlay** (`openArtifactPane`). Falls back to showing the
  raw text if no artifact.

## 5. Data Flow

1. Model calls `workflow-compile` → DSL JSON in the skill result (`outputs`).
2. `chat.js` post‑dispatch: `detectWorkflowOutput` → DSL.
3. `createWorkflow(dsl)` → `id` (set in the interpreter); progress: `🔄 Building workflow…`.
4. `showWorkflowChoiceDialog(id, summary)`:
   - **Open in editor** → `openInEditor(id)` (load + reveal the editor); the user runs it there. *End of chat flow.*
   - **Run & show result** → continue to step 5.
5. `runWorkflowStreamed(id, userPrompt)` → node `*_start`/`*_complete` events shown as live progress;
   `client_tool_call` (e.g. the terminal `report-pdf`) runs in the browser; the bound skill writes the
   artifact to the local `outputs/` FS.
6. `renderWorkflowResult` → markdown inline, or the html/pdf artifact in the overlay.

## 6. Error / Edge Handling

- **Create fails** → show the DSL summary + an "Open in editor" fallback (don't lose the work).
- **Run fails / a node errors** → surface the node error in chat; keep the created workflow (the user
  can open it in the editor).
- **No artifact / unknown format** → render the terminal text result inline (never a blank overlay).
- **Not a workflow output** (`detectWorkflowOutput` false) → do nothing; normal skill‑output handling.
- **DSL invalid at create** → backend `validateGraph` returns errors → show them (the compiler should
  have caught these, but defend anyway).

## 7. Testing

- `detectWorkflowOutput`: true for a `workflow-compile` output with `definition.nodes`; false for other
  skills / non‑DSL JSON / plain text.
- `createWorkflow`: posts the right body; returns id; surfaces validation errors.
- `showWorkflowChoiceDialog`: "Open in editor" calls `openInEditor(id)` (and does **not** run);
  "Run & show result" triggers `runWorkflowStreamed(id, …)`. (Mock both branch fns.)
- `renderWorkflowResult`: markdown → inline bubble; an `outputs` map with a `.pdf` → `openArtifactPane`
  called with the blob; no artifact → text fallback. (Mock the pane + `_selectArtifactFromOutputs`.)
- `runWorkflowStreamed`: forwards node events to progress; resolves with the final result (mock the
  stream). Manual end‑to‑end: author the market‑report workflow → it auto‑runs → the PDF opens in the
  overlay.

## 8. Tech Stack

| Aspect | Choice |
|---|---|
| Trigger | after `workflow-compile` output: always create, then a choice dialog (open‑in‑editor \| run & show) |
| Create | `POST /api/v1/workflows` (existing) |
| Run | reuse the editor run path (`_collectClientSkillsForRun` + `runStream` + `client_tool_call`) |
| Progress | node events → `showProgress` (SSE; server‑side run) |
| Render | existing artifact pane overlay (`_selectArtifactFromOutputs` / `openArtifactPane`) |
| Formats | markdown (inline), HTML, PDF; DOCX deferred |

## 9. Decomposition (for the plan)

1. `detectWorkflowOutput` + wire it into the post‑skill‑dispatch path in `chat.js`.
2. `createWorkflow(dsl)` client (POST + error surfacing).
3. `showWorkflowChoiceDialog` + `openInEditor(id)` — the "Open in editor" branch (reuse
   `workflowEditor.loadWorkflow` + reveal the panel).
4. `runWorkflowStreamed(id, prompt)` — factor/reuse the editor's run (client skills + `runStream` +
   node‑event → progress + `client_tool_call`).
5. `renderWorkflowResult` — format router over the existing artifact pane.
6. End‑to‑end wiring (create → dialog → branch) + manual verification.

## 10. Future (out of scope)

DOCX (download or PDF‑preview); a "Run" button / confirm mode; re‑running an edited workflow from chat;
saving the result back to a context.
