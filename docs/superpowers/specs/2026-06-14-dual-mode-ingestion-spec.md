# Dual‑Mode Ingestion — Spec (synthetic)

Source of truth for implementation. Human prose companion:
`2026-06-14-dual-mode-ingestion-overview.md`. Repo: `htdocs/gpt`. Branch off
`feat/rag-ingestion-full` (current ingestion work) or its successor.

## Goal
Ingestion workflows get two modes, mirroring agent workflows:
- **Interpreted (default):** ▶ on start node runs the pipeline live as Pyodide
  cells; per‑node orange/green/red glow; Output tabs show **executed data**.
- **Compile:** end‑node `langGraph‑Python` menu (ingestion variant, already
  exists) emits the standalone `.py` (unchanged).

## Locked decisions
1. **Codegen = Option A (one compiler, store branches).** `IngestionCompiler`
   stays single. `compileNodeChunk($kind,$config,$mode)`, `$mode∈{compile,interpret}`.
   Loader/Splitter chunks shared; **store chunk branches**: compile →
   `PGVector` / MCP adapter; interpret → `pyfetch` cell. `compileView` unchanged.
2. **Interpreted engine = frontend‑driven** (NOT backend SSE like agents). New
   client orchestrator walks pipeline order and drives the glow directly via the
   existing `highlightNode()`. Reuses glow UX, not the agent execution engine.
3. **Shared Pyodide namespace** so `docs→chunks` flow between cells. New path in
   `pyodide-runner.js`: run snippet in a kept‑alive namespace (NOT `runpy.run_path`).
4. **Store boundary = one server hop.** `POST /api/v1/workflows/{id}/ingestion/embed-store`,
   body `{chunks, vectorstore:{store,embeddings,collection}}` → embeds + writes
   to chosen vector MCP server‑side; returns `{stored:N, collection}`. Keys stay
   server‑side. Pyodide store cell calls it via `pyodide.http.pyfetch` + auth
   token from `window.authManager.token` (the `geo-content` pattern).
5. **Node forms = agent form format.** Reuse `createAgentEditModal` /
   `switchAgentModalTab` / `.agent-modal-tab` via an extracted **shared modal/tab
   builder**. Ingestion nodes: **Settings** tab (fields) + **Input/Generated
   code/Output** tabs. Save via `updateNodeDataFromId` + `autoPersistWorkflow`.
   Retire bespoke `showIngestionConfigModal`.
6. **Store node = vector‑DB MCP dropdown.** `store` field = dropdown of vector‑DB
   MCP servers from `GET /api/v1/mcp/servers`, **filtered by `description`**
   (keywords: vector, embedding, pgvector, pinecone, qdrant, chroma, weaviate,
   milvus, faiss, lancedb). Registered via existing MCP tool (`mcp-add-server-form`
   → `POST /api/v1/mcp/servers`, `mcp_servers` table, `description` column).
   Saved as `store: "mcp:<server-id>"`. Retires hardcoded `pgvector`.
7. **Spike first** (reuse `frontend/spike/`): load `pypdf` + `langchain-text-splitters`
   in Pyodide, run load→split on a sample, `pyfetch` a stub `embed-store`. Proves
   dep‑loading + shared‑namespace flow. **Decides loader reuse** (does
   `langchain-community` load in Pyodide, or standardize on light loaders both modes).

## v1 scope
Loader `pdf|word|text`, splitter `recursive`, store = a registered vector‑DB MCP.
No new loader/splitter/store kinds. Errors: red glow + traceback (Pyodide) /
error JSON (store) in that node's Output tab; run stops. Reset/abort reused.

## Grounding (verified file refs)
- Agent run (interpreted, backend SSE): `executeWorkflow()` wf-editor.js:7343;
  `POST /workflows/{id}/run-stream`; events via `handleWorkflowEvent()` :8099 —
  `node_start`→active, `node_complete`(success?completed:error), `node_error`→error.
- Glow: `highlightNode()` :8237; classes `node-active|node-completed|node-error`;
  `resetNodeStates()` :7372/:8289; abort btn :8402/`abortWorkflow()`:8482; reset
  btn :8432.
- End‑node compile menu: `data-action="langgraph-menu"` :7196 → `_showLangGraphMenu()`
  :2835 (ingestion variant: Generate/Run/Download/Display) → `downloadGeneratedPython()`
  :2692 (`POST /workflows/{id}/generate-python?download=1`).
- Pyodide: `pyodide-runner.js` (main‑thread persistent instance :51; `runSkillScript()`
  :1089; harness `RUN_HARNESS` :822 uses `runpy.run_path`; deps `loadPackage`
  prebuilt vs `micropip` :444; warm globals persist across calls but `run_path`
  namespace does not — hence decision #3). Worker pool `pyodide.worker.js`.
  Bridge: `pyodide.http.pyfetch` → same‑origin backend + `window.authManager.token`
  (example geo-content; URL prefetch `prefetchUrlArgs()` :306). No direct MCP from
  Pyodide; no raw external HTTP.
- Agent node form: `showAgentEditForm()` :9496 → `createAgentEditModal()` :9589;
  tabs `.agent-modal-tab` + `switchAgentModalTab()`; save `saveAgent()` :10941 →
  `updateNodeDataFromId` / `editor...Home.data[id].data=...` :11101 + `autoPersistWorkflow()`.
- Ingestion form (to retire/migrate): `showIngestionConfigModal()` :5806; per‑node
  code `loadIngestionNodeOutput()` (POSTs `/ingestion/node-code`), `_gatherIngestionStages()`,
  `_readIngestionFormConfig()`.
- MCP registry: UI `mcp-add-server-form` index.html:2835; `MCPClient.addServer()`
  mcp-client.js:101 → `POST /api/v1/mcp/servers` `MCPServerController::create()` :251;
  list `GET /api/v1/mcp/servers` `::list()` :34 → `{servers:[{id,name,url,description,
  enabled,tool_count,...}]}`; table `mcp_servers(... description TEXT ...)`. Tool
  descriptions: `mcp_server_tools.tool_description`; `MCPToolsLoader.php`.
- Existing ingestion compiler: `IngestionCompiler::compileNodeChunk/compileView/compileScript`;
  controller `IngestionController::nodeCode/compile`; routes `/ingestion/node-code`,
  `/ingestion/compile`.

## Components
**New**
- `runIngestionInterpreted()` (wf-editor.js): client orchestrator. resetNodeStates →
  for each stage in pipeline order: highlightNode(active) → run cell → highlightNode(
  completed|error) + populate Output tab with executed data. Loader/Splitter via
  Pyodide shared‑ns; Store via `pyfetch embed-store`. Abort/reset reused.
- Pyodide shared‑namespace exec in `pyodide-runner.js` (e.g. `runInSession(code, sessionId)`):
  persistent globals dict per workflow session; reset on structural edit.
- `IngestionController::embedStore()` + route `POST .../ingestion/embed-store`;
  invokes chosen vector MCP server (server‑side; reuse MCP tool dispatch + the
  embed logic / `langchain_runner`). Keys server‑side.
- Store‑node MCP dropdown: fetch `GET /api/v1/mcp/servers`, filter by description
  keywords (client‑side or `?filter=vector` backend param).
- `compileNodeChunk` `$mode` param + interpret store cell (`pyfetch`).
- Shared modal/tab builder extracted from agent form; ingestion nodes adopt it.
- Spike under `frontend/spike/`.

**Reused (do not rebuild):** glow state machine, agent modal/tab builder, MCP
registration+listing, Pyodide runner, `IngestionCompiler`/`compileView`, end‑node
compile menu.

## Open (spike resolves)
- Does `langchain-community` load in Pyodide? If no/heavy → both modes use light
  loaders (`pypdf`/`docx2txt` + `langchain_core.documents.Document`), maximizing
  reuse; if yes → loader chunk fully shared.

## Risks / mitigations
- Pyodide dep loading → spike + light loaders.
- Kernel memory/state → one session namespace; reset on structural edit.
- Mode drift → Option A single compiler, store‑only branch.
- Browser secret exposure → none; embed/store + keys server‑side via endpoint.
