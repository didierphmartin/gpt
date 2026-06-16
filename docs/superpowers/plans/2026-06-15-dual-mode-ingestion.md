# Dual-Mode Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ingestion workflows an interpreted mode (▶ runs the pipeline live as Pyodide notebook cells, reusing the agent orange/green/red glow) alongside the existing compile mode, with the vector store backed by registered vector-DB MCP servers.

**Architecture:** One compiler (`IngestionCompiler`) emits per-node chunks; the store step branches by mode (compile → MCP-adapter/PGVector Python; interpret → a `pyfetch` cell). Interpreted mode is **frontend-driven**: a client orchestrator runs loader/splitter cells in a shared Pyodide namespace and drives the existing `highlightNode()` glow, then makes one authenticated server call for embed+store (keys stay server-side). Node forms reuse the agent modal/tab builder.

**Tech Stack:** PHP 8 (backend, no framework — front controller + `routes.php`), vanilla JS + Drawflow (`workflow-editor.js`), Pyodide (`pyodide-runner.js`), MySQL (`mcp_servers` table), MCP tools (`MCPToolsLoader`).

**Source spec:** `docs/superpowers/specs/2026-06-14-dual-mode-ingestion-spec.md` (+ `-overview.md`). Branch: continue on `feat/rag-ingestion-full` (or successor).

**Testing reality:** This repo has no JS unit harness for `workflow-editor.js`; backend is tested via PHP reflection/CLI harnesses + `php -l`, Python via the `langchain_runner/.venv` `py_compile`/`pytest`, and Pyodide via a manual `frontend/spike/` page. Tasks below adapt TDD to that: write a runnable check first (CLI harness, `node --check`, or a spike assertion), see it fail, implement, see it pass.

---

## File Structure (decomposition)

**New files**
- `frontend/spike/ingestion-pyodide-spike.html` + `frontend/spike/ingestion-pyodide-spike.worker.js` — Phase 1 de-risk page.
- `backend/src/AgentTeam/Services/VectorMcpStore.php` — server-side embed+store via a chosen vector-DB MCP server (one responsibility: chunks+config → MCP store call).
- `backend/tests/IngestionEmbedStoreTest.php` (or a CLI harness under `backend/scripts/`) — exercises `VectorMcpStore` + the controller method with a stub MCP.
- `frontend/assets/js/ingestion-interpreter.js` — the client orchestrator (`runIngestionInterpreted`) + the shared-namespace cell runners. Kept OUT of `workflow-editor.js` (already ~13k lines).

**Modified files**
- `backend/src/AgentTeam/Controllers/IngestionController.php` — add `embedStore()`; `nodeCode()` honors `$mode`.
- `backend/src/AgentTeam/Services/IngestionCompiler.php` — `compileNodeChunk($kind,$config,$mode)`; interpret store cell.
- `backend/src/routes.php` — add `POST .../ingestion/embed-store`.
- `frontend/assets/js/pyodide-runner.js` — add `runInSession(code, sessionId, deps)` (shared namespace).
- `frontend/assets/js/workflow-editor.js` — store-node MCP dropdown; route ▶ for ingestion to `runIngestionInterpreted`; migrate node forms to the shared agent modal/tab builder.
- `frontend/index.html` — load `ingestion-interpreter.js`; cache-bump.

---

## Phase 1 — De-risking spike (decides loader reuse; build nothing else until this passes)

### Task 1: Pyodide ingestion spike

**Files:**
- Create: `frontend/spike/ingestion-pyodide-spike.html`
- Create: `frontend/spike/ingestion-pyodide-spike.worker.js`
- Reference (read, don't modify): `frontend/spike/pyodide-spike.worker.js`, `frontend/assets/js/pyodide-runner.js:444-465` (dep loading)

- [ ] **Step 1: Write the spike worker that loads deps + runs load→split in a shared namespace**

`frontend/spike/ingestion-pyodide-spike.worker.js`:
```js
// Spike: prove (1) loader+splitter deps load in Pyodide, (2) state flows
// between two separate runs via a shared namespace, (3) a pyfetch reaches a
// same-origin backend. Logs PASS/FAIL per assertion to the page via postMessage.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
importScripts(PYODIDE_INDEX_URL + 'pyodide.js');

let pyodide;
const log = (line) => postMessage({ type: 'log', line });

async function tryLoad(name, viaMicropip) {
  try {
    if (viaMicropip) {
      await pyodide.runPythonAsync(`import micropip; await micropip.install(${JSON.stringify(name)})`);
    } else {
      await pyodide.loadPackage(name);
    }
    log(`PASS load ${name}`);
    return true;
  } catch (e) { log(`FAIL load ${name}: ${e}`); return false; }
}

onmessage = async (e) => {
  if (e.data !== 'run') return;
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  await pyodide.loadPackage('micropip');

  // A. dep matrix — record what loads. This DECIDES loader reuse.
  await tryLoad('pypdf', true);
  await tryLoad('langchain-text-splitters', true);
  await tryLoad('langchain-core', true);
  await tryLoad('langchain-community', true); // expected heavy/maybe-fail
  await tryLoad('docx2txt', true);

  // B. shared namespace: cell 1 sets `docs`, cell 2 (separate call) reads it.
  const ns = pyodide.globals.get('dict')();
  try {
    await pyodide.runPythonAsync(`docs = ["hello world. second sentence."]`, { globals: ns });
    await pyodide.runPythonAsync(`
from langchain_text_splitters import RecursiveCharacterTextSplitter
splitter = RecursiveCharacterTextSplitter(chunk_size=12, chunk_overlap=0)
chunks = splitter.split_text(docs[0])
`, { globals: ns });
    const n = ns.get('chunks').length;
    log(n > 0 ? `PASS shared-namespace docs->chunks (${n} chunks)` : 'FAIL shared-namespace: 0 chunks');
  } catch (err) { log('FAIL shared-namespace: ' + err); }
  finally { ns.destroy && ns.destroy(); }

  // C. pyfetch to a same-origin backend (health route is fine).
  try {
    const res = await pyodide.runPythonAsync(`
import pyodide.http, json
r = await pyodide.http.pyfetch("/gpt/backend/api/v1/health")
json.dumps({"status": r.status})
`);
    log(`PASS pyfetch backend (${res})`);
  } catch (err) { log('FAIL pyfetch: ' + err); }

  log('DONE');
};
```

`frontend/spike/ingestion-pyodide-spike.html`:
```html
<!doctype html><meta charset="utf-8"><title>Ingestion Pyodide Spike</title>
<pre id="out" style="font:13px monospace;white-space:pre-wrap"></pre>
<script>
  const out = document.getElementById('out');
  const w = new Worker('ingestion-pyodide-spike.worker.js');
  w.onmessage = (e) => { if (e.data.type === 'log') out.textContent += e.data.line + '\n'; };
  w.postMessage('run');
</script>
```

- [ ] **Step 2: Run the spike**

Serve via XAMPP and open `http://localhost/gpt/frontend/spike/ingestion-pyodide-spike.html`.
Expected: a `PASS load pypdf`, `PASS load langchain-text-splitters`, `PASS shared-namespace docs->chunks (N chunks)`, `PASS pyfetch backend (...)`. `langchain-community` may log `FAIL load` — that is an acceptable, informative result.

- [ ] **Step 3: Record the decision**

Append a `## Spike result (2026-06-15)` section to `docs/superpowers/specs/2026-06-14-dual-mode-ingestion-spec.md` stating, per the matrix:
- If `langchain-community` loaded → loader chunk can be shared verbatim across modes.
- If it did NOT (expected) → **both modes use light loaders**: `pypdf.PdfReader`/`docx2txt.process` + `langchain_core.documents.Document`. This is the canonical decision the later tasks reference as **DECISION-LOADER**.

- [ ] **Step 4: Commit**

```bash
git add frontend/spike/ingestion-pyodide-spike.html frontend/spike/ingestion-pyodide-spike.worker.js docs/superpowers/specs/2026-06-14-dual-mode-ingestion-spec.md
git commit -m "spike(ingestion): prove Pyodide loader/splitter deps + shared namespace + pyfetch; record DECISION-LOADER"
```

---

## Phase 2 — Backend embed/store via a vector-DB MCP server

### Task 2: `VectorMcpStore` service

**Files:**
- Create: `backend/src/AgentTeam/Services/VectorMcpStore.php`
- Create: `backend/scripts/test-vector-mcp-store.php` (CLI harness)
- Reference: `backend/src/Services/MCPToolsLoader.php` (how tools are loaded/dispatched), `backend/src/Controllers/MCPServerController.php:34` (server records)

- [ ] **Step 1: Write the failing CLI harness**

`backend/scripts/test-vector-mcp-store.php`:
```php
<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';
use AgentTeam\Services\VectorMcpStore;

// Inject a fake MCP dispatcher so the test needs no live server.
$calls = [];
$fakeDispatch = function (int $serverId, string $tool, array $args) use (&$calls) {
    $calls[] = compact('serverId', 'tool', 'args');
    return ['stored' => count($args['chunks'] ?? []), 'collection' => $args['collection'] ?? null];
};
$store = new VectorMcpStore($fakeDispatch);
$res = $store->store(7, ['a', 'b', 'c'], ['embeddings' => 'openai:text-embedding-3-small', 'collection' => 'docs']);
assert($res['stored'] === 3, 'expected 3 stored');
assert($calls[0]['serverId'] === 7, 'expected server 7');
echo "OK\n";
```

- [ ] **Step 2: Run it; verify it fails**

Run: `php backend/scripts/test-vector-mcp-store.php`
Expected: FAIL — `Class "AgentTeam\Services\VectorMcpStore" not found`.

- [ ] **Step 3: Implement `VectorMcpStore`**

`backend/src/AgentTeam/Services/VectorMcpStore.php`:
```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/**
 * Embed + store chunks into a registered vector-DB MCP server. The actual MCP
 * call is injected (a callable) so this is unit-testable and so the dispatch
 * mechanism (MCPToolsLoader / the existing tool runner) stays the single source
 * of truth for how tools are invoked.
 */
final class VectorMcpStore
{
    /** @var callable(int,string,array):array */
    private $dispatch;

    /** @param callable(int $serverId, string $tool, array $args):array $dispatch */
    public function __construct(callable $dispatch)
    {
        $this->dispatch = $dispatch;
    }

    /**
     * @param int                  $serverId  vector-DB MCP server id (from store: "mcp:<id>")
     * @param array<int,string>    $chunks    text chunks
     * @param array<string,mixed>  $cfg       {embeddings, collection}
     * @return array{stored:int,collection:?string}
     */
    public function store(int $serverId, array $chunks, array $cfg): array
    {
        if ($chunks === []) {
            return ['stored' => 0, 'collection' => $cfg['collection'] ?? null];
        }
        $args = [
            'chunks'     => array_values($chunks),
            'embeddings' => (string) ($cfg['embeddings'] ?? 'openai:text-embedding-3-small'),
            'collection' => $cfg['collection'] ?? null,
        ];
        // Tool name convention for vector-store MCP servers; documented in spec.
        $result = ($this->dispatch)($serverId, 'store_documents', $args);
        return [
            'stored'     => (int) ($result['stored'] ?? count($chunks)),
            'collection' => $result['collection'] ?? $args['collection'],
        ];
    }
}
```

- [ ] **Step 4: Run the harness; verify it passes**

Run: `php backend/scripts/test-vector-mcp-store.php`
Expected: `OK`. Also `php -l backend/src/AgentTeam/Services/VectorMcpStore.php` → no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/VectorMcpStore.php backend/scripts/test-vector-mcp-store.php
git commit -m "feat(ingestion): VectorMcpStore — embed+store chunks via an injected MCP dispatch"
```

### Task 3: `embed-store` endpoint + route

**Files:**
- Modify: `backend/src/AgentTeam/Controllers/IngestionController.php`
- Modify: `backend/src/routes.php`
- Reference: existing `IngestionController::compile()` for auth pattern (`canUserAccess`, `$request['body']`); `MCPToolsLoader.php` for the real dispatch.

- [ ] **Step 1: Add the route**

In `backend/src/routes.php`, beside the other ingestion routes:
```php
$r->post('/api/v1/workflows/{id:\d+}/ingestion/embed-store', ['AgentTeam:IngestionController', 'embedStore']);
```

- [ ] **Step 2: Implement `embedStore()`**

In `IngestionController.php`, add:
```php
/**
 * POST /api/v1/workflows/{id}/ingestion/embed-store
 * Body: { chunks: string[], vectorstore: { store: "mcp:<id>", embeddings, collection } }
 * Embeds + writes the chunks into the chosen vector-DB MCP server, server-side.
 */
public function embedStore(array $request): array
{
    $userId = $request['user_id'] ?? 0;
    $workflowId = (int) ($request['params']['id'] ?? 0);
    if (!$userId) {
        return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
    }
    if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
        return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
    }
    $body = $request['body'] ?? [];
    $chunks = array_values((array) ($body['chunks'] ?? []));
    $vs = (array) ($body['vectorstore'] ?? []);
    $store = (string) ($vs['store'] ?? '');
    if (!str_starts_with($store, 'mcp:')) {
        return ['success' => false, 'error' => 'vectorstore.store must be "mcp:<server-id>"', 'status_code' => 400];
    }
    $serverId = (int) substr($store, 4);
    try {
        // Real dispatch via the existing MCP tool runner (same mechanism the
        // agent path uses). Adapter closure keeps VectorMcpStore decoupled.
        $loader = new \AgentTeam\Services\MCPToolsLoaderAdapter($this->db, (string) $userId); // see note
        $vectorStore = new \AgentTeam\Services\VectorMcpStore(
            fn(int $sid, string $tool, array $args) => $loader->invoke($sid, $tool, $args)
        );
        $res = $vectorStore->store($serverId, $chunks, $vs);
        return ['success' => true, 'data' => $res, 'status_code' => 200];
    } catch (\Throwable $e) {
        return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
    }
}
```

> **Integration note (resolve during implementation, not a placeholder):** `MCPToolsLoaderAdapter::invoke($serverId,$tool,$args)` is the thin wrapper around however `MCPToolsLoader` actually executes a tool today. Step 3 pins it down.

- [ ] **Step 3: Pin the real MCP invocation**

Read `backend/src/Services/MCPToolsLoader.php` and the agent tool-execution path to find the existing "invoke tool N on server S with args" call. Implement `MCPToolsLoaderAdapter::invoke()` to call exactly that (no new transport). If a suitable public method already exists, use it directly in the closure and delete the adapter. Verify by grep that no second MCP transport is introduced.

- [ ] **Step 4: Smoke-test the route shape**

Run: `php -l backend/src/AgentTeam/Controllers/IngestionController.php` → no errors.
Manual: with a registered vector MCP server id `<id>`, `curl -s -X POST "http://localhost/gpt/backend/api/v1/workflows/<wf>/ingestion/embed-store" -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"chunks":["a","b"],"vectorstore":{"store":"mcp:<id>","embeddings":"openai:text-embedding-3-small","collection":"t"}}'` → JSON `{"success":true,"data":{"stored":...}}` (or a clear MCP error).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Controllers/IngestionController.php backend/src/routes.php
git commit -m "feat(ingestion): POST /ingestion/embed-store — server-side embed+store via vector MCP"
```

---

## Phase 3 — Store node: vector-DB MCP dropdown (filtered by description)

### Task 4: filter helper + dropdown population

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` (store-node form field)
- Reference: `frontend/assets/js/mcp-client.js:79` (`loadServers`, `GET /api/v1/mcp/servers` → `{servers:[{id,name,description,...}]}`)

- [ ] **Step 1: Add the vector-filter helper (write the assertion first)**

Add a temporary `node --check`-able pure function near the ingestion helpers and a one-off assertion in the same commit message context. The function:
```js
// Returns true if an MCP server looks like a vector DB, by description/name.
_isVectorMcpServer(server) {
    const hay = `${server?.name || ''} ${server?.description || ''}`.toLowerCase();
    const kw = ['vector', 'embedding', 'pgvector', 'pinecone', 'qdrant',
                'chroma', 'weaviate', 'milvus', 'faiss', 'lancedb'];
    return kw.some(k => hay.includes(k));
}
```

- [ ] **Step 2: Verify the helper compiles**

Run: `node --check frontend/assets/js/workflow-editor.js`
Expected: OK. (Quick behavioral check in devtools: `editor._isVectorMcpServer({description:'A pgvector store'})` → `true`; `{description:'weather'}` → `false`.)

- [ ] **Step 3: Populate the store dropdown from filtered servers**

In the store-node form builder (currently the `vectorstore` branch around the `#ingestion-vs-store` select), replace the hardcoded `pgvector` option set with an async population:
```js
// Build the store <select> from registered vector-DB MCP servers only.
async _populateVectorStoreSelect(selectEl, currentValue) {
    selectEl.innerHTML = '<option value="">Loading vector stores…</option>';
    let servers = [];
    try {
        const resp = await fetch(`${this.apiBase}/mcp/servers?user_id=${encodeURIComponent(this.userId)}`,
            { headers: this.getAuthHeaders(), credentials: 'include' });
        const j = await resp.json().catch(() => ({}));
        servers = (j.servers || []).filter(s => this._isVectorMcpServer(s));
    } catch (_) { /* fall through to empty */ }
    if (!servers.length) {
        selectEl.innerHTML = '<option value="">No vector-DB MCP servers — register one in Settings → MCP</option>';
        return;
    }
    selectEl.innerHTML = servers.map(s =>
        `<option value="mcp:${s.id}">${this.escapeHtml(s.name)}</option>`).join('');
    if (currentValue) selectEl.value = currentValue;
}
```
Call it when the store form renders, passing the node's saved `config.store`.

- [ ] **Step 4: Verify + manual check**

Run: `node --check frontend/assets/js/workflow-editor.js` → OK. Bump `frontend/index.html` cache `?v=`. Hard-refresh; open a store node → the Store dropdown lists only your vector-DB MCP servers (register ≥1 first), selecting one saves `store: "mcp:<id>"` into the node config.

- [ ] **Step 5: Commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(ingestion/store): store dropdown lists vector-DB MCP servers (filtered by description)"
```

---

## Phase 4 — Shared-namespace Pyodide execution

### Task 5: `runInSession` in the Pyodide runner

**Files:**
- Modify: `frontend/assets/js/pyodide-runner.js`
- Reference: `pyodide-runner.js:51-56` (instance), `:444-465` (`ensureDeps`)

- [ ] **Step 1: Add `runInSession(code, sessionId, deps)`**

```js
/**
 * Run a snippet in a persistent per-session namespace (a kept-alive globals
 * dict), so variables set by one call (e.g. `docs`) are visible to the next
 * (e.g. the splitter reading `docs`). Distinct from runSkillScript's run_path
 * harness, which uses a fresh namespace each call. Returns { ok, error }.
 */
async runInSession(code, sessionId, deps = []) {
    await this.ensureLoaded();
    if (deps.length) await this.ensureDeps(deps);
    this._sessions = this._sessions || new Map();
    let ns = this._sessions.get(sessionId);
    if (!ns) { ns = this.pyodide.globals.get('dict')(); this._sessions.set(sessionId, ns); }
    try {
        await this.pyodide.runPythonAsync(code, { globals: ns });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
    }
}

/** Read a variable out of a session namespace as a JS value (or undefined). */
getSessionVar(sessionId, name) {
    const ns = this._sessions && this._sessions.get(sessionId);
    if (!ns || !ns.has(name)) return undefined;
    const v = ns.get(name);
    return (v && typeof v.toJs === 'function') ? v.toJs() : v;
}

/** Drop a session namespace (call on structural edit / workflow switch). */
clearSession(sessionId) {
    const ns = this._sessions && this._sessions.get(sessionId);
    if (ns) { ns.destroy && ns.destroy(); this._sessions.delete(sessionId); }
}
```

- [ ] **Step 2: Verify it compiles + a manual session check**

Run: `node --check frontend/assets/js/pyodide-runner.js` → OK.
Manual (devtools, after cache-bump + refresh): 
```js
await pyodideRunner.runInSession('x = 21*2', 'demo');
pyodideRunner.getSessionVar('demo', 'x'); // 42
await pyodideRunner.runInSession('y = x + 1', 'demo');
pyodideRunner.getSessionVar('demo', 'y'); // 43  (proves shared namespace)
```

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/js/pyodide-runner.js frontend/index.html
git commit -m "feat(pyodide): runInSession/getSessionVar/clearSession — persistent per-session namespace"
```

---

## Phase 5 — Compiler: per-mode store cell

### Task 6: `compileNodeChunk($kind,$config,$mode)` + interpret store cell

**Files:**
- Modify: `backend/src/AgentTeam/Services/IngestionCompiler.php`
- Modify: `backend/src/AgentTeam/Controllers/IngestionController.php` (`nodeCode` passes `$mode`)
- Create/extend: `backend/scripts/test-ingestion-compiler-mode.php`

- [ ] **Step 1: Failing harness for the interpret store cell**

`backend/scripts/test-ingestion-compiler-mode.php`:
```php
<?php
declare(strict_types=1);
require '/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/src/AgentTeam/Services/IngestionCompiler.php';
use AgentTeam\Services\IngestionCompiler;

$cfg = ['store' => 'mcp:7', 'embeddings' => 'openai:text-embedding-3-small', 'collection' => 'docs'];
$interp = IngestionCompiler::compileNodeChunk('vectorstore', $cfg, 'interpret');
assert(str_contains($interp, 'pyfetch'), 'interpret store cell must pyfetch');
assert(str_contains($interp, 'embed-store'), 'interpret store cell must hit embed-store');
assert(!str_contains($interp, 'PGVector'), 'interpret store must NOT use PGVector');

$compile = IngestionCompiler::compileNodeChunk('vectorstore', $cfg, 'compile');
assert(str_contains($compile, 'chunks'), 'compile store cell references chunks');
echo "OK\n";
```

- [ ] **Step 2: Run; verify failure**

Run: `php backend/scripts/test-ingestion-compiler-mode.php`
Expected: FAIL — `compileNodeChunk()` arity/`$mode` not handled (currently 2 args; the interpret branch does not exist).

- [ ] **Step 3: Add `$mode` + the interpret store cell**

In `IngestionCompiler::compileNodeChunk`, change the signature to `(string $kind, array $config = [], string $mode = 'compile')`. Leave loader/splitter/start chunks unchanged for both modes (DECISION-LOADER from Task 1 governs whether the loader body uses light `pypdf` — apply that here so BOTH modes match the spike outcome). For the `vectorstore` kind, branch:
```php
if ($kind === 'vectorstore') {
    if ($mode === 'interpret') {
        // Interpreted store cell: hand chunks to the backend (keys + DB stay
        // server-side). collection/embeddings travel in the body.
        $store = self::jsonLit($config); // {store,embeddings,collection}
        return <<<PY
# Vector store — interpreted (server-side embed+store via MCP)
import json, pyodide.http
from js import window
STORE = {$store}
_payload = json.dumps({"chunks": [c.page_content if hasattr(c, "page_content") else str(c) for c in chunks], "vectorstore": STORE})
_tok = getattr(getattr(window, "authManager", None), "token", None)
_resp = await pyodide.http.pyfetch(WORKFLOW_EMBED_STORE_URL, method="POST",
    headers={"Authorization": f"Bearer {_tok}", "Content-Type": "application/json"}, body=_payload)
result = json.loads(await _resp.string())
PY;
    }
    // compile mode: existing PGVector/MCP-adapter body (unchanged).
    return self::compileStoreChunk($config); // extract current body into this helper
}
```
`WORKFLOW_EMBED_STORE_URL` is injected by the orchestrator before running the cell (Task 7), so the compiler stays workflow-id-agnostic.

- [ ] **Step 4: Thread `$mode` through `nodeCode`/`compileView`**

`compileView(array $stages, string $mode = 'compile')` passes `$mode` to each `compileNodeChunk`. `IngestionController::nodeCode()` reads `$body['mode'] ?? 'compile'` and forwards it. Compile-mode behavior is unchanged (default).

- [ ] **Step 5: Run harness; verify pass**

Run: `php backend/scripts/test-ingestion-compiler-mode.php` → `OK`. `php -l` the two backend files.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/IngestionCompiler.php backend/src/AgentTeam/Controllers/IngestionController.php backend/scripts/test-ingestion-compiler-mode.php
git commit -m "feat(ingestion/compiler): compileNodeChunk(\$mode) — interpret store cell pyfetches embed-store"
```

---

## Phase 6 — Frontend interpreted orchestrator (reuse the agent glow)

### Task 7: `ingestion-interpreter.js` orchestrator

**Files:**
- Create: `frontend/assets/js/ingestion-interpreter.js`
- Modify: `frontend/assets/js/workflow-editor.js` (route ▶ for ingestion; expose glow helpers)
- Modify: `frontend/index.html` (script tag + cache-bump)
- Reference: `workflow-editor.js` glow — `highlightNode()` :8237, `resetNodeStates()` :7372, abort/reset buttons; `_gatherIngestionStages()`, `loadIngestionNodeOutput()`; Phase 4 `runInSession`.

- [ ] **Step 1: Implement the orchestrator**

`frontend/assets/js/ingestion-interpreter.js` (attached to the editor instance):
```js
/**
 * Interpreted ingestion run: walk the pipeline in order, run each stage's cell,
 * and drive the SAME glow as agents (orange running, green ok, red error). The
 * loader/splitter cells run in Pyodide (shared session namespace); the store
 * cell pyfetches the backend embed-store endpoint. Executed data is shown in
 * each node's Output tab.
 */
async function runIngestionInterpreted(editor) {
  if (!editor.currentWorkflowId) { await editor.saveWorkflow(); if (!editor.currentWorkflowId) return; }
  editor.resetNodeStates();
  editor.showAbortButton && editor.showAbortButton();
  const session = `wf-${editor.currentWorkflowId}`;
  editor.pyodideRunner ? null : (editor.pyodideRunner = window.pyodideRunner);
  editor.pyodideRunner.clearSession(session);

  // Inject the embed-store URL the interpret store cell expects.
  await editor.pyodideRunner.runInSession(
    `WORKFLOW_EMBED_STORE_URL = ${JSON.stringify(`${editor.apiBase}/workflows/${editor.currentWorkflowId}/ingestion/embed-store`)}`,
    session);

  // Ordered stages (start carries no cell). Map node_type -> drawflow node id.
  const order = ['loader', 'splitter', 'vectorstore'];
  const nodeIdByType = editor._ingestionNodeIdsByType(); // {loader: id, ...}
  const deps = editor._ingestionInterpretDeps();          // e.g. ['pypdf','langchain-text-splitters'] per DECISION-LOADER

  for (const kind of order) {
    const nodeId = nodeIdByType[kind];
    if (!nodeId) continue;
    editor.highlightNode(nodeId, 'active');               // orange
    // Fetch this stage's interpret cell from the compiler (mode=interpret).
    const cell = await editor._fetchInterpretCell(kind);  // returns generated python string
    const r = await editor.pyodideRunner.runInSession(cell, session, deps);
    if (!r.ok) {
      editor.highlightNode(nodeId, 'error');              // red
      editor._showNodeOutput(nodeId, r.error);
      editor.hideAbortButton && editor.hideAbortButton();
      editor.showResetButton && editor.showResetButton();
      return;
    }
    editor.highlightNode(nodeId, 'completed');            // green
    editor._showNodeExecutedData(nodeId, kind, session);  // docs/chunks/result into Output tab
  }
  editor.hideAbortButton && editor.hideAbortButton();
  editor.showResetButton && editor.showResetButton();
}
window.runIngestionInterpreted = runIngestionInterpreted;
```

- [ ] **Step 2: Add the small editor helpers referenced above**

In `workflow-editor.js`, add `_ingestionNodeIdsByType()` (scan `this.editor.drawflow.drawflow.Home.data` for `data.node_type`), `_ingestionInterpretDeps()` (return the dep list from DECISION-LOADER), `_fetchInterpretCell(kind)` (POST `/ingestion/node-code` with `{stages:_gatherIngestionStages(kind, liveCfg), mode:'interpret'}`, return `data.generated`), `_showNodeOutput(nodeId, text)` and `_showNodeExecutedData(nodeId, kind, session)` (read `pyodideRunner.getSessionVar(session, kind==='loader'?'docs':'chunks')` or `result`, render into that node's Output tab — reuse the tab the per-node viewer already renders).

- [ ] **Step 3: Route ▶ for ingestion to the orchestrator**

In the start-node ▶ handler, where it currently branches `if (this._isIngestionWorkflow())`, call `await window.runIngestionInterpreted(this)` instead of the old per-node-viewer open.

- [ ] **Step 4: Load the script + cache-bump**

Add `<script src="assets/js/ingestion-interpreter.js?v=20260615-interp"></script>` to `frontend/index.html` (after `pyodide-runner.js`, before `workflow-editor.js`), and bump `workflow-editor.js`/`pyodide-runner.js` `?v=`.

- [ ] **Step 5: Verify + manual end-to-end (interpreted)**

Run: `node --check frontend/assets/js/ingestion-interpreter.js` and `node --check frontend/assets/js/workflow-editor.js` → OK.
Manual: build loader(pdf)→splitter→store(mcp:<id>), press ▶. Expect: loader orange→green (Output shows real `docs`), splitter orange→green (Output shows real `chunks`), store orange→green (Output shows `{stored:N}`); a deliberately bad PDF path → loader red + traceback in its Output.

- [ ] **Step 6: Commit**

```bash
git add frontend/assets/js/ingestion-interpreter.js frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(ingestion): interpreted run — frontend orchestrator runs cells in Pyodide, reuses agent glow"
```

---

## Phase 7 — Migrate ingestion node forms to the agent form/tab builder

### Task 8: extract a shared modal/tab builder

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Reference: `createAgentEditModal()` :9589, `switchAgentModalTab()`, `.agent-modal-tab`; ingestion `showIngestionConfigModal()` :5806.

- [ ] **Step 1: Extract `_buildNodeModal({title, tabs, footer})`**

Factor the agent modal's chrome (overlay, header, `.agent-modal-tab` bar, `.tab-content` switching via `switchAgentModalTab`, footer with Cancel/Save) into a reusable `_buildNodeModal()` that returns the modal element + a `showTab(name)` function. Re-point `createAgentEditModal()` to use it (no behavioral change to agents).

- [ ] **Step 2: Verify agents still open/save**

Run: `node --check frontend/assets/js/workflow-editor.js` → OK. Manual: edit an agent node → modal opens with all tabs, Save persists (unchanged).

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/js/workflow-editor.js
git commit -m "refactor(workflow-editor): extract _buildNodeModal shared chrome from the agent form"
```

### Task 9: ingestion nodes adopt the shared builder

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`

- [ ] **Step 1: Rebuild ingestion forms on `_buildNodeModal`**

Replace `showIngestionConfigModal()`'s bespoke chrome with `_buildNodeModal({ title, tabs: ['Settings','Input','Generated code','Output'], ... })`. The **Settings** tab holds the existing per-type fields (loader Source/Path; splitter Strategy/Chunk/Overlap; store = the Task 4 vector-MCP dropdown). Input/Generated code/Output tabs reuse the existing per-node viewer rendering. Save path stays `updateNodeDataFromId` (+ structural auto-save unchanged).

- [ ] **Step 2: Verify + manual**

Run: `node --check frontend/assets/js/workflow-editor.js` → OK. Cache-bump. Manual: each ingestion node opens with the **same chrome as agents**, Settings shows the right fields, the three code tabs work, the store dropdown is the vector-MCP list.

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(ingestion): node forms use the shared agent modal/tab builder"
```

---

## Self-Review

**Spec coverage:** §1 interpreted engine → Tasks 5+7; §2 store endpoint + Option A codegen → Tasks 2,3,6; node forms = agent format → Tasks 8,9; store = vector-MCP dropdown → Task 4; MCP registration reused → Task 3 (no new registration); spike-first → Task 1; v1 scope (pdf/word/text, recursive, mcp store) → respected throughout; errors (red + Output) → Task 7 Step 5. No spec requirement is unmapped.

**Placeholder scan:** The two "integration notes" (Task 3 MCP invoke adapter; DECISION-LOADER) are explicit *resolve-by-reading* steps with a concrete instruction, not vague placeholders — each has its own step that pins it down. No "TBD/handle edge cases/etc."

**Type/name consistency:** `runInSession`/`getSessionVar`/`clearSession` (Task 5) are used verbatim in Task 7. `VectorMcpStore.store(serverId,chunks,cfg)` (Task 2) matches Task 3's call. `compileNodeChunk($kind,$config,$mode)` (Task 6) matches `_fetchInterpretCell` body (Task 7) sending `mode:'interpret'`. `store: "mcp:<id>"` format is produced in Task 4 and parsed in Task 3. Glow states `'active'|'completed'|'error'` match the agent `highlightNode` contract.

**Sequencing risk:** Task 1 (spike) gates DECISION-LOADER used by Tasks 6 & 7 — must run first. Phases 2–5 are independent of the frontend and can land in any order; Phase 6 depends on 2,4,5; Phase 7 depends on 4.
