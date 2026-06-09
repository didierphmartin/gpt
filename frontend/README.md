# AI Service Frontend

This is the frontend web application for the AI Portfolio Assistant.

## Table of Contents

- [Structure](#structure)
- [Setup](#setup)
- [Features](#features)
- [Usage](#usage)
- [Technologies](#technologies)
- [Configuration](#configuration)
- [Streaming & SSE events](#streaming--sse-events)
  - [How the chat stream is consumed](#how-the-chat-stream-is-consumed)
  - [SSE event reference](#sse-event-reference)
  - [Progress messages](#progress-messages)
  - [Verifier and Compare events](#verifier-and-compare-events)
- [Browser-side Python execution (Skills)](#browser-side-python-execution-skills)
  - [TL;DR](#tldr)
  - [What is Pyodide / WebAssembly?](#what-is-pyodide--webassembly)
  - [The runtime contract — `window.pyodideRunner`](#the-runtime-contract--windowpyodiderunner)
  - [How a Skill script gets executed end-to-end](#how-a-skill-script-gets-executed-end-to-end)
  - [Multi-tool-call rounds (N `tool_use` blocks per assistant turn)](#multi-tool-call-rounds-n-tool_use-blocks-per-assistant-turn)
  - [Dependency declaration](#dependency-declaration)
  - [Filesystem architecture](#filesystem-architecture)
  - [Group folders (one level of nesting)](#group-folders-one-level-of-nesting)
  - [Performance characteristics](#performance-characteristics)
  - [Constraints and limits](#constraints-and-limits)
  - [Failure modes worth knowing](#failure-modes-worth-knowing)
  - [What would be different in future iterations](#what-would-be-different-in-future-iterations)
- [Workflow editor — storage and wire format](#workflow-editor--storage-and-wire-format)
  - [Storage architecture](#storage-architecture)
  - [REST surface](#rest-surface)
  - [Save payload (frontend → backend)](#save-payload-frontend--backend)
  - [Node and edge shapes](#node-and-edge-shapes)
  - [Validation constraints](#validation-constraints)
  - [Compile to LangGraph](#compile-to-langgraph)
  - [Notes for an LLM-builds-workflow integration](#notes-for-an-llm-builds-workflow-integration)
  - [LLM-driven workflow authoring (workflow-builder skill)](#llm-driven-workflow-authoring-workflow-builder-skill)

## Structure

```
frontend/
├── index.html         # Main chat interface
├── login.html         # Login page
├── assets/
│   └── js/
│       ├── chat.js              # Main chat UI + send/SSE consumption + B3 client-tool dispatch
│       ├── local-fs.js          # FSA root-handle bootstrap (window.localFs)
│       ├── skills-fs.js         # Folder-backed Skills service (window.skillsFs)
│       ├── skills-manager.js    # Skills sidebar / drag-drop / editor
│       ├── pyodide-runner.js    # Browser-side Python interpreter (window.pyodideRunner)
│       ├── workflow-editor.js   # Drawflow-based visual workflow editor + save/load
│       ├── workflow-realtime-runner.js  # Realtime (audio) workflow execution
│       └── ...
└── test-*.html        # Test pages
```

## Setup

The frontend connects to the backend API at:
```
http://localhost/gpt/backend/api/v1/
```

## Features

- Real-time chat with AI assistant
- Server-Sent Events (SSE) streaming
- Markdown rendering
- Code syntax highlighting
- Multiple AI provider selection
- Conversation history
- User authentication
- **Folder-backed Skills with in-browser Python execution** (see [Browser-side Python execution (Skills)](#browser-side-python-execution-skills))
- **Visual workflow editor** with compile-to-LangGraph (see [Workflow editor — storage and wire format](#workflow-editor--storage-and-wire-format))

## Usage

1. Open `index.html` in your browser
2. (Optional) Login via `login.html`
3. Start chatting with the AI assistant

## Technologies

- HTML5
- Tailwind CSS
- JavaScript (Vanilla)
- Marked.js (Markdown parsing)
- Highlight.js (Code highlighting)
- Server-Sent Events (SSE)
- **Pyodide** (CPython compiled to WebAssembly) — for in-browser execution of Skill scripts
- **File System Access API** (FSA) — for direct read/write to the user's local Skills folder

## Configuration

Update the API base URL in the JavaScript code if your backend is hosted elsewhere:

```javascript
const API_BASE_URL = 'http://localhost/gpt/backend/api/v1';
```

---

## Streaming & SSE events

Chat responses are streamed from the backend over **Server-Sent Events (SSE)** rather than returned as a single JSON blob. This lets the UI render the LLM's answer as it's generated, surface progress updates while the model is "thinking," and handle features like dual-pane verification and B3 client-side tool dispatch in one connection.

### How the chat stream is consumed

`POST /gpt/backend/api/v1/chat` (when `streaming: true`) returns a `text/event-stream` response. The frontend reads it via the `fetch` Response body's `getReader()`, decodes incrementally, and splits on the SSE block separator (`\n\n`). Each block has an `event:` line and one or more `data:` lines:

```
event: chunk
data: Hello

event: chunk
data:  world

event: response
data: {"success":true,"text":"Hello world","usage":{...}}

event: complete
data: {"status":"done"}
```

The reader code lives in `chat.js::sendMessage`. It maintains:
- `this.fullContent` — the running accumulator of streamed text, rendered live into the assistant bubble
- `finalResponse` — captured from the `response` event, used for usage metrics
- `verifierMsgId`, `compareMsgId` — bubble IDs for the side panels (when those features are on)
- `pendingClientToolCall` — captured from the `client_tool_call` event, dispatched after the stream ends

When the stream ends (server emits `complete` and closes the connection), the bubble is finalized with full markdown rendering and the exchange is persisted to `this.conversationHistory`.

### SSE event reference

| Event | Payload | Purpose | Frontend handler |
|---|---|---|---|
| `progress` | plain string | Status update while the LLM is loading / thinking. Surfaced in the progress bar. | `chat.js::handleSSEEvent` (`case 'progress'`) → `showProgress` |
| `chunk` | plain string | One token (or token group) of streaming response text. Appended to the active bubble. | `handleSSEEvent` (`case 'chunk'`) → `appendChunk` |
| `response` | JSON: `{ success, text, usage, provider, pending_client_tool_call?, pending_tool_calls? }` | Final response metadata. `text` is the full accumulated answer; `usage` carries token counts. | `handleSSEEvent` (`case 'response'`) → `updateMessage` (final render) |
| `error` | JSON: `{ message }` or plain string | An error during the LLM call. Replaces the assistant bubble with the error text. | `handleSSEEvent` (`case 'error'`) |
| `complete` | JSON: `{ status: 'done' }` | Marker that the stream has finished. Triggers final markdown render and history push. | `handleSSEEvent` (`case 'complete'`) |
| `mcp_ui` | JSON: `{ tool, args, ui_info, ... }` | An MCP tool returned an interactive UI (HTML to render in an iframe). Triggers `displayMCPUI`. | `handleSSEEvent` (`case 'mcp_ui'`) |
| `usage_warning` | JSON: `{ reason: 'output_truncated' \| 'context_high', percent?, model, ... }` | Backend warning that the model's output was truncated by `max_tokens`, or the input is using >75% of the context window. Surfaced as a small notice in the bubble. | `handleSSEEvent` (`case 'usage_warning'`) → `showUsageWarning` |
| `client_tool_call` | JSON: `{ assistant_text, tool_calls: [{ id, name, input }] }` | The LLM invoked a client-side tool (currently only `run_skill_script`). The frontend captures this, lets the stream finish, then dispatches via `pyodideRunner` and re-issues `/chat`. See [Browser-side Python execution](#browser-side-python-execution-skills). | `chat.js::dispatchClientToolCall` |

### Progress messages

`progress` events are **plain strings**, not JSON. They're emitted by the backend's `sendProgress` helper during phases the user might wait through:

- `"Connecting to Claude API..."` (and equivalents per provider)
- `"Preparing Claude streaming request..."`
- `"Processing tool calls..."` — when the LLM emits a `tool_use` block and the backend starts the recursive tool-handling loop
- `"Executing function: <name>"` — for each tool invocation
- `"Response ready."` — just before the final `complete`
- `"Running scripts/transform.py…"` — emitted **client-side** (in `chat.js::dispatchClientToolCall`) when the B3 dispatcher is running a Pyodide script; this one doesn't come from the server.

These short strings are written to the progress bar via `showProgress(text)` and disappear when the next `chunk`/`response`/`complete` event arrives or when the loading state clears. They're informational only — there's no payload schema to validate. If you add a new long-running phase on the backend, just call `$this->sendProgress("...")` and the UI will pick it up automatically.

### Verifier and Compare events

When `verification_enabled: true` (or `compare_enabled: true`) is in the request, the backend runs an additional LLM call against the user's choice of *verifier* (a second model that fact-checks the primary response) or *comparer* (a second model whose answer is shown in a side-by-side pane). These flows emit their own SSE event families so the frontend can route them into separate bubbles without disrupting the primary stream.

| Event | Purpose |
|---|---|
| `verification_start` | Verifier is starting. Frontend creates the verifier bubble. |
| `verification_progress` | Plain string — status update for the verifier. |
| `verifier_chunk` | One chunk of the verifier's streaming answer. |
| `verification_response` | Final verifier text + metadata. |
| `verification_complete` | Verifier is done. |
| `verification_error` | Error during verification (separate from the primary `error`). |
| `compare_start` / `compare_progress` / `compare_chunk` / `compare_response` / `compare_complete` / `compare_error` | Same shape, for the compare pane. |

The two flows are independent of the primary stream — they can fire at any point after the primary `response` event and don't block the primary `complete`. Cancellation (user clicks Stop) aborts all three.

---

## Browser-side Python execution (Skills)

Folder-backed Skills can ship executable Python scripts under their `scripts/` subdirectory (Anthropic's Skills spec). When the LLM decides to invoke one, the **script runs in the user's browser** — not on the server. This page is everything the next person needs to know about that subsystem.

### TL;DR

- **Runtime**: [Pyodide](https://pyodide.org/) `v0.27.7` (CPython 3.12 compiled to WebAssembly, served from `cdn.jsdelivr.net`).
- **Trigger**: backend emits `event: client_tool_call` over SSE; `chat.js::dispatchClientToolCall` reacts.
- **Filesystem**: the Skill's folder is mounted into Pyodide's virtual FS via `pyodide.mountNativeFS(...)` against an FSA `FileSystemDirectoryHandle`. Reads/writes go through to the user's real disk.
- **Dependencies**: declared in `SKILL.md` frontmatter as `dependencies: [pkg, ...]` — pre-built Pyodide packages load via `loadPackage`, the rest fall through to `micropip`.
- **Browser support**: Chromium only (Chrome / Edge / Brave / Arc) — the constraint comes from FSA, not Pyodide.

### What is Pyodide / WebAssembly?

[Pyodide](https://pyodide.org/) is the CPython interpreter compiled to **WebAssembly (wasm32-emscripten)**, packaged with a sizeable subset of the scientific Python stack. WebAssembly is a sandboxed bytecode that runs in browsers (and `wasmtime`-style runtimes outside the browser) at near-native speed. From the user's point of view, Python is *interpreted* in the browser; under the hood, the interpreter itself is wasm and the Python code it interprets is regular `.py` source.

Concretely:

- **Real CPython**, not a Python-shaped subset. ~99% of the standard library works.
- **Single-threaded.** The JS event loop is the only execution thread; Python threading mostly degenerates to cooperative concurrency.
- **No OS process model.** `subprocess`, `os.fork`, `multiprocessing` don't work. Anything that wants to spawn a child process fails.
- **No raw sockets.** `socket`, `requests`, `urllib3` over real TCP don't work; HTTP requests must go through the browser's `fetch` (Pyodide ships `pyodide.http` and adapters).
- **Memory is bounded.** Typically a few hundred MB per tab; large datasets exhaust the heap.
- **Filesystem is virtual** by default (`MEMFS`, in-memory), with optional mounts: `IDBFS` (IndexedDB-backed, persists across reloads), `NODEFS` (Node only), and **`NativeFS`** (the one we use — backed by an FSA directory handle).

### The runtime contract — `window.pyodideRunner`

`assets/js/pyodide-runner.js` exposes a single public method:

```js
const result = await window.pyodideRunner.runSkillScript({
    dirName,        // "medium-format" — folder under <root>/skills/
    script,         // "scripts/transform.py" — path within the skill
    argv,           // ["examples/sample_input.html", "-o", "out.html", ...]
    inputFiles,     // optional { "scratch/input.html": "<html>...</html>" }
    readOutputs,    // optional ["out.html", ...]
    dependencies,   // optional ["beautifulsoup4", "cssutils"] — overrides SKILL.md
    persist,        // default true: syncfs writes back to host disk after the run
});
// → { stdout, stderr, exitCode, outputs, durationMs }
```

`outputs` is a map: each `readOutputs` path becomes a key whose value is the file's UTF-8 string content (or a `Uint8Array` if the bytes aren't valid UTF-8 — protects binary outputs from silent corruption).

Two utility methods exist for tests / introspection:

- `window.pyodideRunner.ensureLoaded()` — preload the runtime without running anything.
- `window.pyodideRunner.reset()` — drop the warm runtime so the next call cold-starts. Doesn't unmount the host FSA handle.
- `window.pyodideRunner._state()` — `{ loaded, mounts, deps }` for debugging.

### Runner → script environment variables

The runner sets three `os.environ` variables in the Pyodide Python process **before** invoking `runpy.run_path(...)`, and **restores** their prior values in `finally`. These are part of the runner-to-script contract — **not** a user-environment dependency. Users **do not** set, configure, or even see these variables. Nothing is added to the user's shell, `.zshrc`, system Environment, or any OS-level setting. The zero-install posture of the project is preserved.

| Variable | Example value | Purpose |
|---|---|---|
| `SYNERGYAI_SKILL_DIR_NAME` | `GEO/geo-audit` | Full path of the currently-running skill relative to `<root>/skills/`. Includes the group prefix when the skill lives inside a group folder. |
| `SYNERGYAI_SKILL_GROUP` | `GEO` | Just the group prefix (empty string for skills directly under `skills/`). Useful when a script needs to behave slightly differently per bundle. |
| `SYNERGYAI_OUTPUT_DIR` | `/outputs/GEO` | Pre-bucketed absolute path under the host-mounted outputs folder. Equals `/outputs/<group>` when the skill is grouped, `/outputs` otherwise. The runner pre-creates the directory before the script starts so an `open(..., 'w')` succeeds without a manual `mkdir`. |

**Skill scripts MAY opt in** by reading `os.environ['SYNERGYAI_OUTPUT_DIR']` (with a `'/outputs'` fallback). Recommended pattern, in use across the `geo-*` / `seo-*` skills:

```python
import os, sys
from pathlib import Path

DEFAULT_OUTPUT_DIR = (
    Path(os.environ.get("SYNERGYAI_OUTPUT_DIR", "/outputs"))
    if sys.platform == "emscripten"
    else Path.home() / "Documents" / "synergyAI" / "outputs"
)
```

Result: a script in `skills/GEO/geo-audit/` automatically writes to `/outputs/GEO/<report>.md` on the host, while a root-level skill in `skills/skill-creator/` keeps writing to `/outputs/<report>.md`. **Scripts that ignore these vars continue to work unchanged** — they just keep writing flat to `/outputs/`.

This is a **runner-to-script contract**, equivalent semantically to a hidden positional argument the runner passes via `os.environ` instead of `sys.argv`. There is no installation step, no user-side config, and no portability cost — moving the project to a new machine still requires only what it always did (clone the repo, drop skills into `~/Documents/synergyAI/skills/`, grant the FSA folder once via the install wizard).

### How a Skill script gets executed end-to-end

The execution sits between two `POST /chat` round-trips. See the backend README for the full two-shot protocol; here we focus on what the frontend does in the gap.

```
1. Backend emits SSE event:
   event: client_tool_call
   data: {
     "assistant_text": "I'll run the transform now.",
     "tool_calls": [{
       "id": "toolu_01...",
       "name": "run_skill_script",
       "input": { "script": "scripts/transform.py", "argv": [...],
                  "input_files": {...}, "read_outputs": [...] }
     }]
   }

2. chat.js::dispatchClientToolCall captures the payload, then:

   ┌──────────────────────────────────────────────────────────────────┐
   │ window.pyodideRunner.runSkillScript({...})                       │
   │                                                                  │
   │   if (first call this tab) {                                     │
   │     ensureLoaded() → fetch & boot Pyodide (~7 MB, ~3 s)          │
   │   }                                                              │
   │                                                                  │
   │   ensureMounted(dirName)                                         │
   │     ├─ window.localFs.resolvePath('skills/<dirName>')            │
   │     │  → returns an FSA FileSystemDirectoryHandle                │
   │     ├─ verify queryPermission/requestPermission readwrite        │
   │     └─ pyodide.mountNativeFS('/skill/<dirName>', handle)         │
   │       (mount cached per dirName for the rest of the session;     │
   │        NativeFS won't allow remount on the same path)            │
   │                                                                  │
   │   ensureDeps(deps)                                               │
   │     ├─ deps come from SKILL.md frontmatter (or per-call override)│
   │     ├─ pre-built names (beautifulsoup4, lxml, numpy, …)          │
   │     │   → pyodide.loadPackage(...)                               │
   │     └─ everything else → micropip.install(...)                   │
   │       installedDeps Set caches what's been installed this session│
   │                                                                  │
   │   write inputFiles into the mount (writes go to MEMFS first)     │
   │                                                                  │
   │   pyodide.runPythonAsync(<harness>):                             │
   │     - swaps sys.stdout/sys.stderr for io.StringIO                │
   │     - sets sys.argv = [script_path, ...argv]                     │
   │     - os.chdir(mount_path)                                       │
   │     - runpy.run_path(script_path, run_name='__main__')           │
   │       (works for any standard argparse-CLI Anthropic skill —     │
   │        no per-skill `import x; x.main(argv)` plumbing needed)    │
   │     - catches SystemExit → exit_code; catches Exception → 1      │
   │     - restores sys/cwd state in finally                          │
   │                                                                  │
   │   read each readOutputs path back from the mount                 │
   │                                                                  │
   │   if (persist) {                                                 │
   │     pyodide.FS.syncfs(false, ...)  // push MEMFS → host FSA      │
   │   }                                                              │
   │                                                                  │
   │   returns { stdout, stderr, exitCode, outputs, durationMs }      │
   └──────────────────────────────────────────────────────────────────┘

3. dispatchClientToolCall trims oversized output (16 KB cap per field) and
   builds the continuation request body, then POSTs /chat again with the
   tool result inside conversation_history.
```

### Multi-tool-call rounds (N `tool_use` blocks per assistant turn)

The diagram above describes a single `tool_use`, but the LLM may emit **N** `tool_use` blocks in one assistant response — e.g. an orchestrator skill that discovers multiple sub-skills in parallel, or a multi-step audit that batches calls. The dispatcher handles this natively, mirroring the standard Anthropic/OpenAI tool-use contract: N `tool_use` blocks in one assistant message → N `tool_result` blocks paired by `tool_use_id` in one user-role response.

Three functions cooperate:

| Function | Role |
|---|---|
| `dispatchClientToolCall(payload, ctx, depth)` | Outer loop. Iterates `payload.tool_calls` in order, calls `_executeSingleClientToolCall` for each, accumulates results, then makes **one** continuation via `_continueAfterClientToolResults`. |
| `_executeSingleClientToolCall(call, ctx, depth, isLastCallInRound)` | Per-call body (Task / discover_skill / run_skill_script). Returns `{ toolResultPayload, followUpExtras }` — pure execution, no continuation. `isLastCallInRound` gates UI-finalization side effects so they fire once per round, not once per call. |
| `_continueAfterClientToolResults(payload, results, ctx, depth, followUpExtras)` | Builds the continuation `POST /chat`: assistant turn with N `tool_calls`, user turn with N `role: "tool"` entries paired by `tool_use_id`. Owns the SSE consumption + nested-recursion loop on the response. |

#### Sequential execution, semantically parallel result

Pyodide is a **single shared instance** — concurrent runs would trample `sys.argv` / `cwd` / `sys.stdout`. The N calls run sequentially (`for (let i = 0; i < total; i++) { await ... }` — no `Promise.all`). The N `tool_result` blocks are returned to the LLM together in the next round, so from the model's perspective the round remains semantically parallel even though execution wasn't.

#### Depth counter

`MAX_DEPTH = 6` bounds **continuation rounds**, not individual calls. N calls in one round = depth+1, not depth+N. Five rounds of single calls and one round of ten calls both count as 6 toward the cap.

#### `discover_skill` follow-up extras and the multi-discover guard

A `discover_skill` call returns the skill's `SKILL.md` body, and its `followUpExtras` (carrying `skill_content` + `skill_metadata`) tells the backend to treat the *next* round as **chip-equivalent for that skill** — single-skill tool schema, no `dir_name` parameter exposed to the LLM. Correct behaviour for one discover.

For N > 1 discovers in one round, a naïve last-wins merge of `followUpExtras` would lock the next round to whichever skill was discovered last, and every subsequent `run_skill_script` would dispatch against that one skill (the model couldn't pick by `dir_name` because the schema wouldn't expose it). The dispatcher therefore counts `discover_skill` calls in the round and, if more than one, **clears `mergedFollowUpExtras`**, keeping the multi-skill catalog active for the next round. Each discovered SKILL.md body is already in the per-call `tool_result` history, so the model still has the contracts it needs.

#### Pre-refactor behaviour (historical)

Before 2026-05-24 the dispatcher hard-threw on `payload.tool_calls.length > 1` with `"V1 supports one per turn"`, killing every multi-step orchestration with a console-only error. The backend already shipped `pending_tool_calls` as an array — the cap was a frontend-only artifact and is now gone.

### Dependency declaration

The runner reads the Skill's `SKILL.md` frontmatter for a `dependencies:` line:

```yaml
---
name: medium-format
description: "Use this skill whenever ..."
dependencies: [beautifulsoup4, cssutils]
---
```

Both inline-list (`[a, b]`) and comma-separated (`a, b`) forms are accepted. The `dependencies` key is an extension we add; Anthropic's spec ignores unknown keys, so SKILL.md files stay spec-compatible.

Resolution rules (in `pyodide-runner.js`):

| Package name listed | Loaded via |
|---|---|
| In `PREBUILT_PACKAGES` set (e.g. `beautifulsoup4`, `lxml`, `numpy`, `pandas`, `scipy`, `matplotlib`, `pillow`, `pyyaml`, `regex`, `requests`, `pytz`, `sqlite3`, `soupsieve`, `markupsafe`, `jinja2`) | `pyodide.loadPackage(name)` — fast, WASM-compiled |
| Anything else | `micropip.install(name)` — pure-Python wheels from PyPI, with deps |

If a Skill needs a package that's neither pre-built nor available as a pure-Python wheel on PyPI, it can't run in Pyodide as-is. Most of the stdlib + the scientific Python core + 95% of pure-Python PyPI packages work out of the box.

A caller can override the SKILL.md value by passing `dependencies: [...]` directly to `runSkillScript` — useful for testing, not used in normal flow.

### Filesystem architecture

Each active Skill is mounted at `/skill/<dirName>` inside Pyodide's virtual FS. The mount point is backed by `NativeFS`, which is itself backed by an FSA `FileSystemDirectoryHandle` obtained via `window.localFs`.

- **Reads** lazily fall through to the host folder (lazy-loaded into MEMFS as accessed).
- **Writes** go to MEMFS only, until `pyodide.FS.syncfs(false, cb)` is called — at which point the changes (including deletions) are flushed back through to the user's real folder.
- **`persist: true`** in the runner options is the default and triggers `syncfs` after every successful run. Set it to `false` for read-only / sandbox-style invocations where outputs should not pollute the user's folder.

The Skill's working directory is set to its mount point before the script runs, so plain CLI scripts that do `open("examples/sample_input.html")` Just Work.

### Group folders (one level of nesting)

Skills can live either directly under `<root>/skills/` or one level inside a *group folder* — a directory under `<root>/skills/` that has no `SKILL.md` of its own and just holds other skills:

```
~/Documents/synergyAI/skills/
  pubmed-research/SKILL.md           ← root-level skill
  SEO/                               ← group folder (no SKILL.md)
    ai-search-audit/SKILL.md         ← grouped skill
    sitemap-audit/SKILL.md
    image-audit/SKILL.md
```

#### `dirName` carries the group prefix

`dirName` is always **the path relative to `<root>/skills/`** — the bare folder name for a root skill (`pubmed-research`), or `<group>/<folder>` for a grouped one (`SEO/ai-search-audit`). Every API in the runner and dispatcher (`runSkillScript`, `getSkillDependencies`, `getSkillFetchesUrls`, `dispatchClientToolCall`, the Task subagent branch) takes the full relative path, and the available-skills catalog the model receives carries the same path-prefixed value in its `dir_name` field. There is no separate "group" parameter.

#### Uniform path resolution via `resolvePath`

All four skill-resolution paths use `window.localFs.resolvePath(path)`, which traverses slash-separated segments through chained `getDirectoryHandle` / `getFileHandle` calls. A single-segment `getDirectoryHandle(dirName)` cannot traverse a nested path and is **not** used anywhere skill-related.

| Reader | Resolves | Symptom when previously broken |
|---|---|---|
| `pyodide-runner.js::ensureMounted` | `skills/<dirName>` → `mountNativeFS('/skill/<dirName>', handle)` | Grouped skill couldn't be mounted at all. |
| `pyodide-runner.js::getSkillDependencies` | `skills/<dirName>/SKILL.md` | Declared `dependencies:` was silently empty for grouped skills → `No module named 'X'` at runtime. |
| `pyodide-runner.js::getSkillFetchesUrls` | `skills/<dirName>/SKILL.md` | URL pre-fetch bridge didn't fire for grouped skills. |
| `chat.js::dispatchClientToolCall` Task branch | `skills/<dirName>/agents/<subagent_type>.md` | Agent file wouldn't resolve for grouped skills. |

#### Sidebar manipulation

The skills sidebar (`skills-manager.js`) treats group folders as first-class:

- Each group renders as a collapsible row with a skill count, above the root-level skills.
- A folder context menu offers Rename / Delete (recursive); a skill context menu offers "Move to folder…".
- Skills are draggable onto a folder block to move them (`skillsFs.moveSkill(path, targetGroup)`).
- All mutations go through the `skillsFs` API — `createFolder`, `deleteFolder`, `renameFolder`, `moveSkill`, `deleteSkill`, `renameSkill`. The manager never touches `getDirectoryHandle` directly.

#### Constraint: one level only

A group folder cannot contain other group folders. `listSkills` recurses exactly one level into folders that lack a `SKILL.md`. The intent is folders-as-categories, not a generic hierarchical FS — keeps `dirName` semantics flat (`group/leaf`, never `a/b/c/leaf`).

### Performance characteristics

| Phase | Cost (typical) |
|---|---|
| First-ever load (Pyodide CDN bundle) | ~7 MB download, ~2-3 s on a fast link |
| First call into runtime | additional ~1 s for Python initialization |
| First dep install (`beautifulsoup4` + `cssutils`) | ~3 s (loadPackage parallel + micropip) |
| Cold-start total for a new tab | ~9 s |
| Warm rerun of the same script | < 100 ms |

Once Pyodide is loaded it stays in memory for the whole tab session. Mounts are cached per `dirName`. Installed deps are cached in an `installedDeps` Set. Concurrent calls are serialized through a `runQueue` (the runtime is shared and we mutate `sys.argv`/`cwd`/`sys.stdout` per call — queueing is simpler than per-call isolation).

### Constraints and limits

| # | Constraint | Why / Where |
|---|---|---|
| 1 | **Chromium-only** (Chrome / Edge / Brave / Arc) | We need `showDirectoryPicker` (FSA). Firefox / Safari don't support it. Pyodide itself works in any modern browser; this is a host FS limitation. |
| 2 | **Skill folder must NOT live under `/Applications/`** on macOS | macOS TCC (Transparency, Consent and Control) silently blocks the directory picker for paths under `/Applications/`. Use `~/Documents/...` instead. The user's configured root (e.g. `~/Documents/synergyAI/`) is what matters. |
| 3 | **One run at a time per tab** | A serialized `runQueue` ensures concurrent calls don't trample each other's `sys.argv` / `cwd` / `sys.stdout`. Two tabs are independent. |
| 4 | **No subprocess / no raw sockets** | Pyodide WebAssembly limit. Scripts that shell out (`subprocess.run`, `os.system`) or open raw TCP/UDP fail. HTTP through `pyodide.http.pyfetch` works. |
| 5 | **Memory ceiling** | Hundreds of MB per tab, OS-dependent. Don't load multi-GB datasets. |
| 6 | **Single-threaded** | Pure Python `threading` works (cooperative); CPU-bound parallelism doesn't speed up. |
| 7 | **Pure-Python or pre-built deps only** | If a package needs C compilation and no pre-built wheel exists on PyPI or in Pyodide's bundle, it can't be installed at runtime. |
| 8 | **Tool-result body capped at 16 KB** | `chat.js::dispatchClientToolCall` truncates per-field (stdout, stderr, each output file) before re-issuing pass 2 — protects the model's context window. Adjust `MAX_OUTPUT_CHARS` if a real Skill needs more. |
| 9 | **B3 dispatch recursion bounded** | `MAX_DEPTH = 6` continuation rounds per turn. N tool_uses in one round = depth+1, not depth+N. If the model loops, the user gets a clear error. |
| 10 | **Output truncation does NOT affect the file on disk** | The truncation only applies to what we forward to the LLM. The full output remains on the user's filesystem after `syncfs`. |
| 11 | **B3 is currently Claude-only** | `ChatController` only declares `run_skill_script` when `provider === 'claude'`. The other providers (OpenAI / Gemini / Grok / Kimi / DeepSeek) need matching client-side dispatch wiring before that gate is relaxed. |

### Failure modes worth knowing

- **`No module named 'X'`** in `stderr`: package not declared in `SKILL.md` `dependencies`, or the package isn't pre-built and has no pure-Python wheel.
- **Picker silently fails to open**: macOS TCC blocking. Move the storage folder out of `/Applications/`.
- **Permission revoked between sessions**: handled gracefully by `local-fs.js::getStatus`. The user gets a UI prompt to re-grant.
- **`mountNativeFS` throws on second mount of same path**: handled — the runner caches mounts per `dirName`.
- **`pyodide.asm.js` 404 / network error**: CDN unreachable. There's currently no offline mirror; future work could host a local copy.

### What would be different in future iterations

- **Multi-provider support**: porting B3 to OpenAI / Gemini / Grok / Kimi / DeepSeek requires interception in each provider's tool-dispatch loop on the backend; the frontend dispatcher is provider-agnostic and won't change. The `LLMManager::normalizeConversationHistory` pass-through is already in place. (See backend README's *Client-side Tool Execution* section.)
- **Worker isolation**: today the Pyodide instance lives on the main thread. Moving it to a Web Worker would unlock real concurrency (multiple scripts in flight) and prevent long-running scripts from blocking the UI. Not necessary today — typical scripts run < 1 s warm.
- **Self-hosted Pyodide bundle**: the CDN URL is hardcoded; bundling Pyodide as a static asset would remove the external dependency and let the runtime work offline. Cost: +7 MB on the initial app payload.
- **Streaming script stdout**: currently captured and returned as a final string. A future iteration could stream stdout to the chat UI in real time for long-running scripts.
- **Mixed client/server tool turns**: currently fail-closed in the backend. A real flow that needs e.g. an MCP web search alongside a `run_skill_script` call in one assistant turn would need partial server execution + partial client surface.
- **Tool-result truncation policy**: 16 KB hardcoded. A future iteration could let the LLM ask for "next chunk" instead of receiving a single truncated blob.

---

## Workflow editor — storage and wire format

The visual workflow editor in `workflow-editor.js` (built on [Drawflow](https://github.com/jerosoler/Drawflow)) lets users compose multi-agent workflows on a canvas and save them. This section documents the storage backend, the REST surface, and the exact JSON shape the editor exchanges with the server — useful both for working on the editor itself and for any external system (e.g. an LLM-driven workflow builder, an importer, a CLI) that needs to read or write workflows.

### Storage architecture

Workflows are persisted to **three MariaDB/MySQL tables** — there is no JSON-file fallback and no localStorage path. The graph is exploded into rows; each save deletes and rewrites the whole graph in a single transaction (`WorkflowGraphRepository::saveGraph`).

```sql
-- Parent row
agent_workflows (
  id, user_id, workspace_id, name, description,
  steps        JSON,   -- legacy; empty for graph-based workflows (graph is source of truth)
  triggers     JSON,   -- e.g. { "schedule": { "enabled": true, "cron": "..." } }
  variables    JSON,
  enabled      TINYINT,
  output_storage_enabled TINYINT,
  output_folder VARCHAR,
  created_at, updated_at
)

-- One row per node
workflow_nodes (
  id, workflow_id,
  node_type ENUM('start','output','agent','parallel'),
  agent_id  INT NULL,           -- FK → agents.id ON DELETE SET NULL
  config    JSON,               -- free-form bag; always includes "type"
  pos_x, pos_y INT,             -- canvas pixel coordinates (Drawflow)
  drawflow_node_id VARCHAR,     -- the frontend's string ID at the time of save
  created_at
)

-- One row per connection
workflow_edges (
  id, workflow_id,
  from_node_id INT,             -- FK → workflow_nodes.id ON DELETE CASCADE
  to_node_id   INT,             -- FK → workflow_nodes.id ON DELETE CASCADE
  from_port VARCHAR DEFAULT 'output_1',
  to_port   VARCHAR DEFAULT 'input_1',
  condition_expr TEXT NULL,     -- optional expression evaluated at runtime
  created_at
)
```

Migration: `backend/database/migrations/create_workflow_graph_tables.sql`.

Backend code paths:

| Concern | File |
|---|---|
| Parent row model | `backend/src/AgentTeam/Models/Workflow.php` |
| Node/edge CRUD + graph save/load | `backend/src/AgentTeam/Services/WorkflowGraphRepository.php` |
| Parent CRUD + JSON column handling | `backend/src/AgentTeam/Services/WorkflowRepository.php` |
| REST controller (create/update/run) | `backend/src/AgentTeam/Controllers/WorkflowController.php` |
| Compile graph → Python LangGraph | `backend/src/AgentTeam/Services/LangGraphGenerator.php` (~1,570 LOC) |
| Run a graph workflow (with SSE) | `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` |

### REST surface

```
GET    /api/v1/workflows                          list (user-scoped)
POST   /api/v1/workflows                          create (body: see "Save payload")
GET    /api/v1/workflows/{id}                     read (include_graph=true by default)
PUT    /api/v1/workflows/{id}                     update (replaces graph)
DELETE /api/v1/workflows/{id}                     delete (CASCADE drops nodes/edges)
POST   /api/v1/workflows/{id}/run                 run synchronously
POST   /api/v1/workflows/{id}/run-stream          run with SSE event stream
GET    /api/v1/workflows/{id}/generate-python     compile to LangGraph Python source
GET    /api/v1/workflows/{id}/executions          list past runs
POST   /api/v1/workflows/{id}/toggle              enable/disable
POST   /api/v1/workflows/{id}/duplicate           clone
GET    /api/v1/workflows/{id}/outputs             list output files
GET    /api/v1/workflows/{id}/outputs/{filename}  read one output file

GET    /api/v1/workflows/{id}/nodes/{nodeId}/documents              list per-node attachments
POST   /api/v1/workflows/{id}/nodes/{nodeId}/documents              upload
POST   /api/v1/workflows/{id}/nodes/{nodeId}/documents/metadata     update metadata
DELETE /api/v1/workflows/{id}/nodes/{nodeId}/documents/{docId}      remove
```

All routes are JWT-gated (same auth middleware as the rest of `/api/v1/*`). Pass `Authorization: Bearer <token>` — `workflow-editor.js::getAuthHeaders` is the reference helper.

### Save payload (frontend → backend)

`workflow-editor.js::saveWorkflow` POSTs this body when the user clicks **Save Workflow**:

```json
{
  "name": "My Newspaper Journal",
  "description": "",
  "definition": {
    "runtime_mode": "batch",
    "llm_provider": "grok",
    "nodes": [ /* see "Node and edge shapes" */ ],
    "edges": [ /* see "Node and edge shapes" */ ]
  },
  "triggers": {
    "schedule": { "enabled": false }
  },
  "output_storage_enabled": 0,
  "output_folder": null
}
```

| Field | Notes |
|---|---|
| `name` | Required. Free-form string. |
| `description` | Optional. |
| `definition.runtime_mode` | `"batch"` (default) or `"realtime"` — `realtime` is the audio/voice flow that runs through `workflow-realtime-runner.js`. |
| `definition.llm_provider` | Only set when `runtime_mode === "realtime"`. Identifies which provider drives the audio session. |
| `definition.nodes` / `definition.edges` | The graph. The backend also accepts the alias `graph.nodes` / `graph.edges` for backwards compatibility. |
| `triggers.schedule.enabled` | When true, the workflow can be cron-scheduled; document attachments must use remote storage. The full cron config lives in `triggers.schedule.*` (see `Workflow::getScheduleConfig`). |
| `output_storage_enabled` | `0`/`1` (TINYINT). When true, the workflow's outputs are written to disk. |
| `output_folder` | Subfolder under the user's output root; `null` means root. |

The backend response is the saved workflow including the rehydrated graph (with real DB IDs replacing the frontend's temp IDs):

```json
{
  "data": {
    "id": 42,
    "name": "My Newspaper Journal",
    "graph": { "nodes": [...], "edges": [...] },
    "schedule_enabled": false,
    "runtime_mode": "batch",
    ...
  }
}
```

### Node and edge shapes

A **node** as emitted by `exportWorkflow` (`workflow-editor.js:5152`):

```json
{
  "id": "2",
  "node_type": "agent",
  "type": "agent",
  "agent_id": 17,
  "agent_name": "Crypto Researcher",
  "config": {
    "type": "agent",
    "agent_type": "researcher",
    "mode": "async"
  },
  "position": { "x": 380, "y": 120 },
  "pos_x": 380,
  "pos_y": 120
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Frontend (Drawflow) ID. Used to wire edges. Backend remaps to a real `workflow_nodes.id` during `saveGraph`. |
| `node_type` | enum | `start` \| `output` \| `agent` \| `parallel`. Stored in the DB ENUM column. Legacy `condition` / `switch` are explicitly rejected. |
| `type` | enum | Duplicate of `node_type` for the validator (`Workflow::validateSteps`). |
| `agent_id` | int \| null | FK to `agents.id`. Must be **numeric**; non-numeric strings (e.g. `"node_3"`) are silently coerced to `null` and the agent reference is lost. |
| `agent_name` | string \| null | Display label only — not authoritative. |
| `config` | object | Free-form. `config.type` is always written for redundancy. Realtime nodes carry `runtime_mode: "realtime"` and prefixed types (`realtime-*`); see `Workflow::detectRuntimeMode`. |
| `position` / `pos_x` / `pos_y` | int | Canvas pixel coordinates. Required for storage. The editor preserves them on round-trip; without them, all nodes render at (0, 0). |

An **edge**:

```json
{
  "from": "1",
  "to": "2",
  "from_port": "output_1",
  "to_port": "input_1",
  "condition": null
}
```

| Field | Notes |
|---|---|
| `from` / `to` | The frontend node IDs. The backend's `saveGraph` builds a temp-id → db-id map and rewrites edges. If a `from`/`to` doesn't appear in the node map, **the edge is dropped silently**. |
| `from_port` / `to_port` | Default `output_1` / `input_1`. Multi-port nodes use `output_2`, `input_2`, etc. |
| `condition` / `condition_expr` | Optional. Evaluated by `GraphWorkflowRunner` at runtime to skip edges. |

### Validation constraints

`WorkflowGraphRepository::validateGraph` runs on save. Violations are returned as `validation_errors` in the 400 response.

| Rule | Failure message |
|---|---|
| Exactly **one** `start` node | "Workflow must have a Start node" / "Workflow can only have one Start node" |
| ≥1 `output` node | "Workflow must have at least one Output node" |
| Start has outgoing edges | "Start node must be connected to at least one other node" |
| Output has incoming edges | "Output node must have at least one incoming connection" |
| All other nodes are connected | "Node 'X' (ID: N) is not connected" |
| `node_type` ≠ `condition` / `switch` | `InvalidArgumentException` thrown by `createNode` |

Empty workflows (no nodes at all) are **allowed** on create — the user can add nodes later.

### Compile to LangGraph

`GET /api/v1/workflows/{id}/generate-python` returns Python source that uses LangGraph to recreate the workflow as a `StateGraph`. The generator (`LangGraphGenerator.php`) walks the graph, emits per-node functions (agent calls, branch logic, fan-out via parallel nodes), and wires edges. This is the "compile" target referenced by the **End → Compile to LangGraph** action in the editor. The graph editor remains the source of truth; the emitted Python is a downstream artifact, never re-parsed back.

### Notes for an LLM-builds-workflow integration

If you're building an interface that lets an LLM produce a workflow (e.g. an MCP server, a chat-driven builder), emit the same `definition` object the editor sends — no new DSL needed. The "compiler" the user sees is already there: `WorkflowController::create` → `WorkflowGraphRepository::saveGraph` → re-fetch → `editor.import()` redraws.

Three friction points worth hiding from the model:

1. **`pos_x` / `pos_y` are required but the LLM shouldn't pick them.** Run an auto-layout pass (e.g. `dagre`, `elk.js`) on the client before opening the canvas — or have the LLM emit `0, 0` everywhere and lay out on load.
2. **`agent_id` must reference an existing row in `agents`.** Before the LLM emits a node, `GET /api/v1/agents`, match by `agent_name`, substitute the ID. If you want to create missing agents on the fly, do it before posting the workflow — don't make the model invent IDs.
3. **`config` is a free-form bag with node-type-specific keys.** `output` nodes carry `storage` / `language`; `agent` nodes carry `agent_type`, `mode` (`async` for parallel branches), tool/skill bindings. Pull a real saved workflow from the DB before locking down a JSON Schema for the model.

### LLM-driven workflow authoring (workflow-builder skill)

The "LLM produces a workflow" flow lands as a **folder-backed Pyodide skill**: `~/Documents/synergyAI/skills/workflow-builder/`. The skill mechanism is already in place — the only new code is the skill itself plus a small input-injection hook in `chat.js::dispatchClientToolCall`. There is no new server, no new endpoint, no new DSL.

#### Why a skill (not an MCP server, not a new endpoint)

- **It is already sandboxed.** Pyodide enforces the no-filesystem / no-network guarantees the runtime relies on. The skill cannot do anything other tools cannot do.
- **The two-shot client-tool protocol already routes natural-language → tool call → result.** Adding a workflow-authoring tool reuses every existing piece: `run_skill_script` declaration, `client_tool_call` SSE, B3 dispatch, result truncation, history rewriting on pass 2.
- **No new round-trips to design.** The skill writes a JSON file to `/outputs/`, the user opens it in the editor, the editor uses the existing `POST /api/v1/workflows`. The "compiler" is the editor's import path, already battle-tested.
- **Validation stays in one place** (the backend's `validateGraph`). The skill can do a soft local pre-check but the authoritative pass happens at save time.

#### Architecture

```
1. User → Claude: "Build me a workflow that crawls PubMed and the crypto feed
                   and publishes a daily newspaper."

2. Claude → tool_use { name: "run_skill_script",
                       input: { script: "scripts/build.py",
                                argv: ["--stdin"],
                                input_files: { "in/prompt.txt": "<the user's brief>" },
                                read_outputs: ["out/workflow.json"] } }

3. chat.js::dispatchClientToolCall, BEFORE invoking pyodideRunner:
     ┌─────────────────────────────────────────────────────────────┐
     │  if (dirName === 'workflow-builder' /* or has provides_data */)│
     │  {                                                           │
     │      const agents = await fetch('/api/v1/agents', auth);     │
     │      inputFiles['in/agents.json'] = await agents.text();     │
     │      // optional:                                            │
     │      const schemas = await fetch('/api/v1/workflow-schemas');│
     │      inputFiles['in/schemas.json'] = await schemas.text();   │
     │  }                                                           │
     └─────────────────────────────────────────────────────────────┘

4. window.pyodideRunner.runSkillScript(...) executes scripts/build.py, which:
     - reads in/prompt.txt + in/agents.json
     - resolves agent names → agent_id
     - emits a layered auto-layout (BFS depth × 240px = pos_x; sibling × 120px = pos_y)
     - writes out/workflow.json
     - prints a one-line summary to stdout

5. chat.js receives outputs.["out/workflow.json"] in the tool result, detects
   the *.workflow.json convention, and renders a button: "Open in editor".

6. User clicks → workflow-editor.js::loadFromJson(definition) populates the
   canvas (no DB hit yet). User reviews, hits Save → POST /api/v1/workflows
   runs the normal validation + persistence path.
```

#### What the skill folder looks like

```
~/Documents/synergyAI/skills/workflow-builder/
├── SKILL.md           # frontmatter + prose: when to use the skill
├── scripts/
│   └── build.py       # CLI: --stdin reads the prompt, writes out/workflow.json
└── examples/
    └── newspaper-journal.json   # reference output the model can learn from
```

Indicative `SKILL.md` frontmatter:

```yaml
---
name: workflow-builder
description: "Use this skill when the user asks to design, sketch, or scaffold
              a multi-agent workflow. Produces a JSON definition compatible with
              the AI Assistant's visual workflow editor."
dependencies: [pyyaml]
provides_data: [/api/v1/agents]    # see below — hook for chat.js injection
---
```

#### Input-injection mechanism

The skill needs the agent catalog at runtime, but **the skill's Python cannot reliably fetch it** — the URL-fetch bridge (`pyodide-runner.js::prefetchUrlArgs`) is built around `argv`-level URL interception, and forcing the LLM to put `/api/v1/agents` in its argv is ugly. The cleaner pattern is to declare data dependencies in the SKILL.md frontmatter and have `chat.js::dispatchClientToolCall` materialize them as `input_files` entries before invoking `pyodideRunner.runSkillScript()`.

For **v1**, this can be a hardcoded check in `dispatchClientToolCall`:

```javascript
if (skillMetadata.dir_name === 'workflow-builder') {
    const agentsResp = await fetch(`${API_BASE}/agents`, { headers: getAuthHeaders() });
    inputFiles['in/agents.json'] = await agentsResp.text();
}
```

For v2, generalize via the `provides_data:` frontmatter key — a list of backend endpoints the harness should GET (with auth) and inject as `in/<basename>.json`. The same hook would serve any future skill that needs a backend catalog (a chat-history summarizer reading `/api/v1/contexts`, a memory inspector reading `/api/v1/me/memory`, etc.).

#### "Open in editor" entry point

The editor today only loads workflows by ID — `loadWorkflow(id)` fetches from `/api/v1/workflows/{id}`. To open a freshly-generated JSON definition without a database hit, add:

```javascript
// workflow-editor.js
async loadFromJson(definition, { name = 'Untitled', description = '' } = {}) {
    this.currentWorkflowId = null;             // unsaved
    this.currentWorkflowName = name;
    this.currentWorkflowDescription = description;
    this.editor.import(this._definitionToDrawflow(definition));
    // optional: run an auto-layout pass if all positions are (0, 0)
}
```

`chat.js` then exposes the button on tool results that contain a `*.workflow.json` output:

```javascript
if (output.endsWith('.workflow.json')) {
    appendToolBubbleButton('Open in editor', () => {
        switchTab('workflows');
        window.workflowEditor.loadFromJson(JSON.parse(outputs[output]));
    });
}
```

#### What exists vs. what's missing

| Piece | Status |
|---|---|
| Pyodide skill runtime + B3 dispatch | ✅ live |
| URL-fetch bridge (lets a skill GET arbitrary public pages) | ✅ live |
| `GET /api/v1/agents` returning the catalog | ✅ live |
| `POST /api/v1/workflows` accepting a graph `definition` | ✅ live |
| `validateGraph` server-side validation on save | ✅ live |
| `workflow-builder` skill folder | ❌ not yet drafted |
| Input-file injection from chat.js (catalog → `input_files`) | ❌ — needs ~10 lines in `dispatchClientToolCall` |
| `editor.loadFromJson()` entry point | ❌ — needs a method on `WorkflowEditor` |
| "Open in editor" button on `*.workflow.json` outputs | ❌ — needs a hook in the tool-result rendering path |
| Auto-layout pass (if the skill emits zeros) | ❌ — either dagre/elk.js on the frontend or BFS positions in the skill |

#### Open design choices (record before coding)

1. **Prompt delivery to the skill.** `--stdin` is preferred — argv-quoting long natural-language briefs is painful and the LLM's tool call is cleaner when `argv` is short.
2. **Hardcode vs. generalize the data-injection.** Hardcoding `if (dirName === 'workflow-builder')` is fine for v1. Generalize to the `provides_data:` frontmatter key the moment a second skill needs the same hook.
3. **One-shot vs. iterative.** v1 emits a new workflow. v2 can accept an existing workflow JSON via `input_files` and emit an *edited* version ("add a verification step before the publisher") — same skill, new argv mode.

