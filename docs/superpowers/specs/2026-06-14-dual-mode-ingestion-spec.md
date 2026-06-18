# Dual‑Mode Ingestion — Spec (synthetic)

Source of truth for implementation. Human prose companion:
`2026-06-14-dual-mode-ingestion-overview.md`. **Execution model** (event router +
`triggerEvent`, loader iterator, store‑clocks‑loader, silence‑terminates, the
interpreted/compiled lowerings): `2026-06-18-ingestion-execution-model.md`. Repo: `htdocs/gpt`. Branch off
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

## Spike result — RESOLVED 2026-06-15 (DECISION-LOADER / DECISION-SPLITTER)
Spike (`frontend/spike/ingestion-pyodide-spike.*`) findings:
- ✅ `pypdf`, `docx2txt` load in Pyodide (pure‑Python). pyfetch reaches backend
  (status 401 = reached).
- ❌ `langchain-text-splitters` / `langchain-core` / `langchain-community` do NOT
  load: they pull `uuid-utils` (Rust, no pure‑Python wheel). langchain is
  unusable in Pyodide.

**DECISION = Unified + vendored splitter (Option A):**
- **Loaders:** pure‑Python BOTH modes — `pypdf.PdfReader` (pdf), `docx2txt.process`
  (word), plain read (text). NO langchain loaders anywhere.
- **Splitter:** **vendor langchain's `RecursiveCharacterTextSplitter` split
  algorithm** (MIT, with attribution) as a standalone pure‑Python module operating
  on `str` — no `langchain_core`/`uuid-utils` import. Canonical source =
  `langchain_runner/ingestion_splitter.py`, unit‑tested to match langchain's
  `split_text` output. The compiler **inlines** this module into the splitter
  chunk so both the Pyodide cell and the standalone compiled script are
  self‑contained. Used in BOTH modes → preview chunks == compiled chunks.
- **Store:** branches by mode (compile → MCP‑adapter; interpret → `pyfetch`).
- Net: loader + splitter chunks are **shared** across modes; only store branches.
- Pyodide deps for interpreted cells: `pypdf`, `docx2txt` (via micropip). No
  langchain in the browser.
- ⚠️ The spike's shared‑namespace assertion failed only because it imported
  `langchain_text_splitters`; the namespace mechanism itself is unverified —
  re‑test with pure Python before building the orchestrator (Task 7).

## Qdrant MCP + adaptive store strategy — RESOLVED 2026-06-15
Concrete vector store = **`mcp-server-qdrant` 0.8.1** over **Streamable HTTP**.
- Endpoint **`http://127.0.0.1:8000/mcp/`** (TRAILING SLASH required; `/mcp`
  307-redirects). Session flow: POST `initialize` → response header
  `Mcp-Session-Id` → POST `notifications/initialized` → `tools/call` (all carry
  the session id). Responses are `text/event-stream` (`event: message\ndata:{…}`).
- Tools (verified via tools/list): `qdrant-store` props `{information, metadata}`
  required `[information]`; `qdrant-find` props `{query}`. **No vector arg → the
  server embeds (FastEmbed `all-MiniLM-L6-v2`).** Collection fixed via
  `COLLECTION_NAME` env (dev = `learn_docs`); not a per-call arg here.
- **Adapt to both (user req):** the embed-store endpoint **detects strategy from
  the chosen store tool's cached `input_schema`** — a text field
  (`information`/`text`/`content`/`document`) & no vector → **SELF** (send text,
  server embeds, e.g. Qdrant); a `vector`/`embedding` field → **EXTERNAL** (we
  embed via OpenAI using the store-node embeddings field, send vectors, e.g. a
  future pgvector MCP). v1 builds SELF concretely; EXTERNAL is the detected seam,
  implemented against a real pgvector MCP's contract when available. Store node
  **keeps the embeddings field** (used only by EXTERNAL stores).
- **Transport (RESOLVED — stateless):** run the server with
  `FASTMCP_STATELESS_HTTP=true` + `FASTMCP_SERVER_STATELESS_HTTP=true`. Verified: a
  `tools/list`/`tools/call` POST with **NO `Mcp-Session-Id` and NO `initialize`**
  succeeds. So the existing **stateless** `MCPToolsLoader::executeTool()` (HTTP
  POST JSON-RPC + SSE parse) works **directly** — no session handshake to add.
  Only caveat: register the URL **with the trailing slash** `…/mcp/` (the gpt MCP
  registration tool's Test Connection handles the connectivity check). Per the
  user, MCP interaction MUST stay stateless — do not add per-call session state.
- **VectorMcpStore (revise Task 2):** `store($storeTool, $chunks, $cfg, $strategy,
  ?$embedder)` — SELF: loop chunks → `executeTool($storeTool, {information:chunk,
  metadata:{chunk_index:i}})`; EXTERNAL: `$vec=$embedder(chunk)` then send the
  server's vector arg. Returns `{stored:N, collection}`.
- **Dev server:** `~/qdrant-mcp/` (venv + `storage/`), run
  `~/qdrant-mcp/venv/bin/mcp-server-qdrant --transport streamable-http` with
  `QDRANT_LOCAL_PATH`/`COLLECTION_NAME`/`FASTMCP_HOST=127.0.0.1`/`FASTMCP_PORT=8000`;
  swap to `QDRANT_URL`+`QDRANT_API_KEY` for Qdrant Cloud. Log `~/qdrant-mcp/server.log`.

## Risks / mitigations
- Pyodide dep loading → spike + light loaders.
- Kernel memory/state → one session namespace; reset on structural edit.
- Mode drift → Option A single compiler, store‑only branch.
- Browser secret exposure → none; embed/store + keys server‑side via endpoint.
