# Ingestion compiler → langfs + mcp_qrant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite what `IngestionCompiler` emits so the generated artifact is a 100% standalone Python script that orchestrates langfs (extract) + mcp_qrant (embed/store), with only the splitter as in-process LangChain.

**Architecture:** Replace the old emitted shape (UniversalFS `list_files`/`read_file`→base64, local pypdf/docx2txt decode, old session-based `qdrant-store`, `ProcessPoolExecutor`) with: langfs `list_files`/`read_file(format:"text")` → `RecursiveCharacterTextSplitter.split_text` → mcp_qrant `store(provider,connection,collection,items,embedding)`, parallelized with a `ThreadPoolExecutor` (pure network I/O now). Config + resolved MCP URLs baked in as Python literals.

**Tech Stack:** PHP 8 (the compiler + endpoint), the emitted Python 3 (langchain-text-splitters + stdlib urllib), langfs + mcp_qrant MCP servers.

**Repo:** gpt (`feat/rag-ingestion-full`). All paths relative to `/Applications/XAMPP/xamppfiles/htdocs/gpt/`.

## Global Constraints

- **Emitted artifact:** one standalone Python 3 script; **no PHP at runtime**; deps = `langchain-text-splitters` + stdlib `urllib`/`json` + `concurrent.futures.ThreadPoolExecutor`.
- **MCP calls only for load + store:** langfs `list_files(provider, path?)` → `{files:[{id,name,type}]}` (one level; client walks folders, `type=="folder"` → recurse); `read_file(provider, file_id, format:"text")` → `{content:"<text>"}`. mcp_qrant `store(provider, connection, collection, items:[{text,metadata}], embedding?)` → `{stored,errors}`.
- **Only the splitter is in-process LangChain:** `RecursiveCharacterTextSplitter(chunk_size, overlap).split_text(text)`.
- **MCP envelope:** a `tools/call` result is `{"result":{"content":[{"type":"text","text":"<json>"}]}}` (JSON or SSE body); the script decodes `content[0].text` as JSON. A JSON-RPC `error` raises; a `store` response lacking `{stored}` raises (no silent 0).
- **Config baked as Python literals** via `json_encode`; **MCP URLs resolved at compile time**: `langfs_url` from the loader `storage_mcp_url`; `mcpqrant_url` from `store:"mcp:<id>"` → `mcp_servers` URL lookup.
- **Empty connection → `{}`** (not `[]`); blank collection/embedding → empty string (mcp_qrant applies its server defaults); `WORKERS` blank → `None` (script falls back to 8).
- **Removed from the emit:** `qdrant-store`, `ProcessPoolExecutor`, `pypdf`/`docx2txt`/`markdownify`, base64 decode, `UFS`/UniversalFS, `langchain_community` loaders, `langchain_postgres`/`OpenAIEmbeddings` in the generated code.
- PHP tests run via `php backend/scripts/test-ingestion-compiler.php` (exit 0 = pass). `python3 -m py_compile` validates the emitted script parses.

---

### Task 1: Rewrite `compileScript` to the langfs + mcp_qrant orchestrator (+ compile endpoint URLs)

**Files:**
- Modify: `backend/src/AgentTeam/Services/IngestionCompiler.php` — `compileScript` (lines ~321-521: the var resolution + the `<<<PY … PY` heredoc + filename).
- Modify: `backend/src/AgentTeam/Controllers/IngestionController.php` — `compile()` `$ctx` keys (lines ~109-122).
- Test: `backend/scripts/test-ingestion-compiler.php` (create).

**Interfaces:**
- Consumes: `$ctx = {langfs_url, mcpqrant_url}` from the `compile` endpoint.
- Produces: `compileScript($loaderCfg, $splitterCfg, $storeCfg, $ctx): {filename, code}` emitting the orchestrator below.

- [ ] **Step 1: Write the failing test**

Create `backend/scripts/test-ingestion-compiler.php`:

```php
<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';
use AgentTeam\Services\IngestionCompiler;

$failures = 0; $checks = 0;
function check(string $label, bool $cond): void {
    global $failures, $checks; $checks++;
    echo ($cond ? "  PASS  " : "  FAIL  ") . $label . "\n";
    if (!$cond) $failures++;
}

$loader = ['provider' => 'local', 'path' => '/srv/docs', 'is_dir' => true,
           'types' => ['pdf', 'html'], 'workers' => 4,
           'storage_mcp_url' => 'http://127.0.0.1:8077/mcp'];
$splitter = ['chunk_size' => 800, 'overlap' => 120];
$store = ['store' => 'mcp:45', 'provider' => 'qdrant', 'connection' => [],
          'collection' => 'docs', 'embedding' => ''];
$ctx = ['langfs_url' => 'http://127.0.0.1:8077/mcp', 'mcpqrant_url' => 'http://127.0.0.1:8008/mcp'];

$r = IngestionCompiler::compileScript($loader, $splitter, $store, $ctx);
$code = $r['code'];

// --- the new stack is present ---
check('filename slug from collection', $r['filename'] === 'ingestion_docs.py');
check('langfs url baked in', str_contains($code, 'http://127.0.0.1:8077/mcp'));
check('mcp_qrant url baked in', str_contains($code, 'http://127.0.0.1:8008/mcp'));
check('calls langfs list_files', str_contains($code, '"list_files"') || str_contains($code, "'list_files'"));
check('reads via format text', str_contains($code, '"format": "text"') || str_contains($code, '"format":"text"'));
check('calls mcp_qrant store', str_contains($code, '"store"'));
check('passes provider/connection/collection/items', str_contains($code, '"items"') && str_contains($code, 'VS_PROVIDER') && str_contains($code, 'CONNECTION') && str_contains($code, 'COLLECTION'));
check('in-process splitter only', str_contains($code, 'RecursiveCharacterTextSplitter') && str_contains($code, 'split_text'));
check('ThreadPoolExecutor (network-bound)', str_contains($code, 'ThreadPoolExecutor'));
check('config literals: chunk/overlap', str_contains($code, '800') && str_contains($code, '120'));
check('empty connection -> {} not []', str_contains($code, 'CONNECTION = {}'));
check('store missing-{stored} guard', str_contains($code, 'stored'));

// --- the old stack is GONE ---
check('no qdrant-store', !str_contains($code, 'qdrant-store'));
check('no ProcessPoolExecutor', !str_contains($code, 'ProcessPoolExecutor'));
check('no local decoders', !str_contains($code, 'pypdf') && !str_contains($code, 'docx2txt') && !str_contains($code, 'markdownify'));
check('no UniversalFS/base64 read', !str_contains($code, 'base64') && !str_contains($code, 'UFS'));
check('no langchain_community / pgvector emit', !str_contains($code, 'langchain_community') && !str_contains($code, 'langchain_postgres'));

// --- the emitted script actually compiles ---
$tmp = sys_get_temp_dir() . '/ingest_compile_test_' . getmypid() . '.py';
file_put_contents($tmp, $code);
exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
@unlink($tmp);
check('emitted script py_compiles', $rc === 0);

echo "\n$checks checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `php backend/scripts/test-ingestion-compiler.php`
Expected: FAIL — the current `compileScript` emits the old UFS/qdrant-store shape (ThreadPoolExecutor/list_files/store assertions fail; old-stack assertions fail).

- [ ] **Step 3: Rewrite `compileScript`**

In `backend/src/AgentTeam/Services/IngestionCompiler.php`, replace the entire `compileScript` method body (the var resolution block through the returned heredoc, lines ~321-521) with:

```php
    public static function compileScript(array $loaderCfg, array $splitterCfg, array $storeCfg, array $ctx = []): array
    {
        $js = static fn($v): string => (string) json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $langfsUrl  = (string) ($ctx['langfs_url'] ?? $loaderCfg['storage_mcp_url'] ?? '');
        $mcpqUrl    = (string) ($ctx['mcpqrant_url'] ?? '');
        $provider   = ((string) ($loaderCfg['provider'] ?? 'local')) ?: 'local';
        $path       = (string) ($loaderCfg['path'] ?? '');
        $isDir      = !empty($loaderCfg['is_dir']) ? 'True' : 'False';
        $types      = array_values(array_filter((array) ($loaderCfg['types'] ?? []), 'is_string'));
        $chunk      = max(1, (int) ($splitterCfg['chunk_size'] ?? 1000));
        $overlap    = max(0, (int) ($splitterCfg['overlap'] ?? 150));
        $vsProvider = ((string) ($storeCfg['provider'] ?? 'qdrant')) ?: 'qdrant';
        $connection = (array) ($storeCfg['connection'] ?? []);
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $embedding  = trim((string) ($storeCfg['embedding'] ?? ''));
        $workersInt = (int) ($loaderCfg['workers'] ?? 0);

        $pyLangfs  = $js($langfsUrl);
        $pyMcpq    = $js($mcpqUrl);
        $pyProv    = $js($provider);
        $pyPath    = $js($path);
        $pyTypes   = $types === [] ? '[]' : $js($types);
        $pyVsProv  = $js($vsProvider);
        $pyConn    = $connection === [] ? '{}' : $js($connection);
        $pyColl    = $js($collection);
        $pyEmb     = $js($embedding);
        $pyWorkers = $workersInt > 0 ? (string) $workersInt : 'None';

        $code = <<<PY
#!/usr/bin/env python3
"""Standalone RAG ingestion — generated from the workflow nodes.
Orchestrates langfs (extract) + mcp_qrant (embed/store); the only in-process
LangChain is the recursive splitter. Independent of the PHP interpreter.
Deps: langchain-text-splitters (+ Python stdlib)."""
import json, urllib.request
from concurrent.futures import ThreadPoolExecutor
from langchain_text_splitters import RecursiveCharacterTextSplitter

LANGFS      = {$pyLangfs}
MCPQRANT    = {$pyMcpq}
PROVIDER    = {$pyProv}
PATH        = {$pyPath}
IS_DIR      = {$isDir}
TYPES       = {$pyTypes}
CHUNK       = {$chunk}
OVERLAP     = {$overlap}
VS_PROVIDER = {$pyVsProv}
CONNECTION  = {$pyConn}
COLLECTION  = {$pyColl}
EMBEDDING   = {$pyEmb}
WORKERS     = {$pyWorkers}

EXT_TYPE = {"pdf": "pdf", "docx": "word", "doc": "word", "txt": "text", "csv": "csv", "html": "html", "htm": "html"}

_split = RecursiveCharacterTextSplitter(chunk_size=CHUNK, chunk_overlap=OVERLAP)


def _parse(raw):
    try:
        return json.loads(raw)
    except Exception:
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                d = line[5:].strip()
                if d:
                    try:
                        return json.loads(d)
                    except Exception:
                        pass
    return {}


def _payload(url, tool, args):
    """Call an MCP tool and return the decoded payload from the
    {content:[{text:json}]} envelope. Raises on JSON-RPC error."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        obj = _parse(resp.read().decode("utf-8", "replace"))
    if isinstance(obj, dict) and obj.get("error"):
        raise RuntimeError(f"{tool}: {(obj['error'] or {}).get('message', 'MCP error')}")
    result = obj.get("result") if isinstance(obj, dict) else None
    result = result if result is not None else obj
    text = None
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content and isinstance(content[0], dict):
            text = content[0].get("text")
    if isinstance(text, str):
        try:
            return json.loads(text)
        except Exception:
            return {"content": text}
    return result if isinstance(result, dict) else {}


def detect(name):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return EXT_TYPE.get(ext)


def list_files():
    """Recursive walk via langfs list_files (one level per call)."""
    out, seen = [], set()

    def walk(folder, depth):
        if depth > 64 or folder in seen:
            return
        seen.add(folder)
        args = {"provider": PROVIDER}
        if folder:
            args["path"] = folder
        data = _payload(LANGFS, "list_files", args)
        for it in (data.get("files") or []):
            if not isinstance(it, dict):
                continue
            fid = it.get("id") or it.get("source")
            nm = it.get("name") or (fid or "")
            if it.get("type") == "folder":
                if fid:
                    walk(fid, depth + 1)
            else:
                t = detect(nm)
                if t and (not TYPES or t in TYPES) and fid:
                    out.append(fid)

    if IS_DIR:
        walk(PATH, 0)
    else:
        nm = PATH.rsplit("/", 1)[-1]
        t = detect(nm)
        if t and (not TYPES or t in TYPES):
            out.append(PATH)
    return out


def read_text(src):
    """langfs read_file with format=text — langfs returns extracted text."""
    data = _payload(LANGFS, "read_file", {"provider": PROVIDER, "file_id": src, "format": "text"})
    return str((data.get("content") if isinstance(data, dict) else "") or "")


def store(items):
    args = {"provider": VS_PROVIDER, "connection": CONNECTION, "collection": COLLECTION, "items": items}
    if EMBEDDING:
        args["embedding"] = EMBEDDING
    data = _payload(MCPQRANT, "store", args)
    if not isinstance(data, dict) or "stored" not in data:
        raise RuntimeError("store: response had no {stored} field (transport/endpoint problem)")
    if data.get("error"):
        raise RuntimeError(f"store: {data.get('message', 'store failed')}")
    return int(data.get("stored", 0))


def process_file(src):
    try:
        chunks = [c for c in _split.split_text(read_text(src)) if c.strip()]
        if not chunks:
            return src, 0, None
        n = store([{"text": c, "metadata": {"source": src}} for c in chunks])
        return src, n, None
    except Exception as e:
        return src, 0, str(e)


if __name__ == "__main__":
    files = list_files()
    workers = WORKERS or 8
    print(f"{len(files)} file(s) to ingest with {workers} worker(s)")
    total = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for src, n, err in ex.map(process_file, files):
            total += n
            print(f"  {src}: {n} chunk(s)" + (f"  ERROR: {err}" if err else ""))
    print(f"done -- {total} chunk(s) stored")
PY;

        $slug = self::slugify($collection);
        $filename = 'ingestion_' . ($slug !== '' ? $slug : 'pipeline') . '.py';

        return ['filename' => $filename, 'code' => $code];
    }
```

- [ ] **Step 4: Update the `compile` endpoint to resolve the new `$ctx` keys**

In `backend/src/AgentTeam/Controllers/IngestionController.php`, replace the `$ctx` resolution block (lines ~109-122):

```php
        // Resolve the runtime URLs the emitted script needs: UniversalFS (from
        // the loader's storage MCP) and the vector-DB MCP (from store:"mcp:<id>").
        $ctx = [];
        if (!empty($loader['storage_mcp_url'])) {
            $ctx['ufs_url'] = (string) $loader['storage_mcp_url'];
        }
        if (preg_match('/^mcp:(\d+)$/', (string) ($store['store'] ?? ''), $m)) {
            $stmt = $this->db->prepare("SELECT url FROM mcp_servers WHERE id = ? AND enabled = 1");
            $stmt->execute([(int) $m[1]]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            if ($row) {
                $ctx['qdrant_url'] = (string) $row['url'];
            }
        }
```
with:
```php
        // Resolve the runtime URLs the emitted script needs: langfs (from the
        // loader's storage MCP) and mcp_qrant (from store:"mcp:<id>").
        $ctx = [];
        if (!empty($loader['storage_mcp_url'])) {
            $ctx['langfs_url'] = (string) $loader['storage_mcp_url'];
        }
        if (preg_match('/^mcp:(\d+)$/', (string) ($store['store'] ?? ''), $m)) {
            $stmt = $this->db->prepare("SELECT url FROM mcp_servers WHERE id = ? AND enabled = 1");
            $stmt->execute([(int) $m[1]]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            if ($row) {
                $ctx['mcpqrant_url'] = (string) $row['url'];
            }
        }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `php backend/scripts/test-ingestion-compiler.php`
Expected: PASS — final line `N checks, 0 failures`, including `emitted script py_compiles` (requires `python3` + `langchain-text-splitters` importable only at runtime, not for py_compile — py_compile just parses, so no deps needed).

Run: `php -l backend/src/AgentTeam/Services/IngestionCompiler.php && php -l backend/src/AgentTeam/Controllers/IngestionController.php`
Expected: `No syntax errors detected` (both).

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/IngestionCompiler.php backend/src/AgentTeam/Controllers/IngestionController.php backend/scripts/test-ingestion-compiler.php
git commit -m "feat(ingestion): compiler emits langfs+mcp_qrant Python orchestrator (drop UFS/qdrant-store/local-decode)"
```

---

### Task 2: Rewrite the per-node fragments (`compileNodeChunk`) + drop the old dispatch tables

**Files:**
- Modify: `backend/src/AgentTeam/Services/IngestionCompiler.php` — `compileNodeChunk` (loader/splitter/vectorstore cases, ~179-239); delete `loaderDispatch`/`loaderFragment`/`embeddingsDispatch`/`storeDispatch` (now unused); keep `splitterDispatch` but switch its body to `split_text`.
- Test: extend `backend/scripts/test-ingestion-compiler.php`.

**Interfaces:**
- Consumes: nothing new.
- Produces: per-node "Generated code" fragments consistent with the full script (loader → langfs calls; splitter → `RecursiveCharacterTextSplitter.split_text`; vectorstore → mcp_qrant `store`). `compileNodeView`/`compileView` are unchanged (they only concatenate `compileNodeChunk`).

- [ ] **Step 1: Add failing per-node assertions to the test**

Append to `backend/scripts/test-ingestion-compiler.php` (before the final summary `echo`):

```php
// --- per-node fragments (editor "Generated code" tab) match the new stack ---
$ld = IngestionCompiler::compileNodeChunk('loader', ['provider' => 'local', 'path' => '/srv/docs', 'is_dir' => true, 'types' => ['pdf']]);
check('loader fragment calls langfs list_files/read_file', str_contains($ld, 'list_files') && str_contains($ld, 'read_file'));
check('loader fragment has no langchain_community', !str_contains($ld, 'langchain_community') && !str_contains($ld, 'PyPDFLoader'));

$sp = IngestionCompiler::compileNodeChunk('splitter', ['chunk_size' => 800, 'overlap' => 120]);
check('splitter fragment uses split_text', str_contains($sp, 'RecursiveCharacterTextSplitter') && str_contains($sp, 'split_text'));

$vs = IngestionCompiler::compileNodeChunk('vectorstore', ['store' => 'mcp:45', 'provider' => 'qdrant', 'connection' => [], 'collection' => 'docs', 'embedding' => '']);
check('vectorstore fragment calls mcp_qrant store', str_contains($vs, '"store"') && str_contains($vs, 'items'));
check('vectorstore fragment has no pgvector/OpenAIEmbeddings', !str_contains($vs, 'PGVector') && !str_contains($vs, 'OpenAIEmbeddings'));

$view = IngestionCompiler::compileView([
    ['node_type' => 'start', 'config' => []],
    ['node_type' => 'loader', 'config' => ['provider' => 'local', 'path' => '/srv/docs', 'is_dir' => true]],
    ['node_type' => 'splitter', 'config' => ['chunk_size' => 800, 'overlap' => 120]],
]);
check('compileView output = upstream + target', str_contains($view['output'], 'list_files') && str_contains($view['generated'], 'split_text'));
```

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `php backend/scripts/test-ingestion-compiler.php`
Expected: FAIL on the per-node fragment checks (current fragments still emit `PyPDFLoader`/`PGVector`).

- [ ] **Step 3: Rewrite the `compileNodeChunk` loader/splitter/vectorstore cases**

In `compileNodeChunk`, replace the `loader`, `splitter`, and `vectorstore` cases (lines ~179-239) with:

```php
            case 'loader':
                $provider = (string) ($config['provider'] ?? 'local') ?: 'local';
                $isDir = !empty($config['is_dir']);
                $types = array_values(array_filter((array) ($config['types'] ?? []), 'is_string'));
                $json = self::jsonLit([
                    'provider' => $provider,
                    'path'     => $config['path'] ?? '',
                    'is_dir'   => $isDir,
                    'types'    => $types,
                ]);
                return "# Loader — langfs (provider: {$provider}" . ($isDir ? ', recursive folder' : '') . ")\n"
                    . "# langfs enumerates + EXTRACTS text; no local decoders here.\n"
                    . "LOADER = {$json}\n"
                    . "# files  = list_files(provider, path, types)        -> [source, ...]\n"
                    . "# text   = read_file(provider, file_id, format='text')  -> extracted text\n"
                    . "# (text per file) -> handed to the Splitter";

            case 'splitter':
                $strategy = (string) ($config['strategy'] ?? 'recursive');
                $table = self::splitterDispatch();
                if (!isset($table[$strategy])) {
                    throw new \RuntimeException(
                        "IngestionCompiler: no fragment for splitter strategy '{$strategy}' yet — add it to the splitter dispatch table."
                    );
                }
                $S = $table[$strategy];
                $json = self::jsonLit([
                    'strategy'   => $strategy,
                    'chunk_size' => $config['chunk_size'] ?? 1000,
                    'overlap'    => $config['overlap'] ?? 150,
                ]);
                return "# Splitter — strategy: {$strategy}\n"
                    . "{$S['import']}\n\n"
                    . "SPLITTER = {$json}\n"
                    . "{$S['body']}\n"
                    . "# chunks : list[str]  -> handed to the Vector store";

            case 'vectorstore':
                $vsProvider = (string) ($config['provider'] ?? 'qdrant') ?: 'qdrant';
                $json = self::jsonLit([
                    'provider'   => $vsProvider,
                    'connection' => (object) ((array) ($config['connection'] ?? [])),
                    'collection' => (string) ($config['collection'] ?? ''),
                    'embedding'  => (string) ($config['embedding'] ?? ''),
                ]);
                return "# Vector store — mcp_qrant store (provider: {$vsProvider})\n"
                    . "# mcp_qrant EMBEDS + upserts; no embeddings/vector-store libs here.\n"
                    . "STORE = {$json}\n"
                    . "# store(provider, connection, collection,\n"
                    . "#       items=[{\"text\": c, \"metadata\": {\"source\": src}} for c in chunks],\n"
                    . "#       embedding) -> {\"stored\": int, \"errors\": int}";
```

- [ ] **Step 4: Switch the splitter dispatch body to `split_text` and delete the dead dispatch tables**

In `splitterDispatch`, replace the `'body'` so it operates on text (the loader now yields text strings, not Documents):

```php
            'recursive' => [
                'import' => 'from langchain_text_splitters import RecursiveCharacterTextSplitter',
                'body'   => "splitter = RecursiveCharacterTextSplitter(\n"
                    . "    chunk_size=int(SPLITTER.get(\"chunk_size\", 1000)),\n"
                    . "    chunk_overlap=int(SPLITTER.get(\"overlap\", 150)),\n"
                    . ")\n"
                    . "chunks = [c for c in splitter.split_text(text) if c.strip()]",
            ],
```

Delete the now-unused methods entirely: `loaderDispatch` (~33-53), `loaderFragment` (~64-86), `embeddingsDispatch` (~113-122), and `storeDispatch` (~130-149). Keep `splitterDispatch`, `jsonLit`, `compileNodeView`, `compileView`, `slugify`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `php backend/scripts/test-ingestion-compiler.php`
Expected: PASS (all Task 1 + Task 2 checks).

Run: `grep -n "PyPDFLoader\|langchain_community\|PGVector\|loaderDispatch\|storeDispatch\|embeddingsDispatch\|loaderFragment" backend/src/AgentTeam/Services/IngestionCompiler.php`
Expected: no matches (old dispatch + langchain-loader/pgvector emit fully gone).

Run: `php -l backend/src/AgentTeam/Services/IngestionCompiler.php`
Expected: `No syntax errors detected`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/IngestionCompiler.php backend/scripts/test-ingestion-compiler.php
git commit -m "feat(ingestion): per-node Generated-code fragments match the langfs+mcp_qrant emit; drop dead dispatch tables"
```

---

### Task 3: Live acceptance — emit, py_compile, run end-to-end

**Files:** none (operational). Requires running langfs (:8077) + mcp_qrant (:8008), the `mcp_qrant` server registered in the gpt catalog, and a source folder (e.g. `cv/articles`).

**Interfaces:** consumes Tasks 1-2 (the emitted script + the compile endpoint).

- [ ] **Step 1: Generate the script from a real workflow**

In the editor's ingestion workflow (loader → langfs source folder, e.g. `/Applications/XAMPP/xamppfiles/htdocs/cv/articles`, types as desired; splitter; store → the mcp_qrant server, a test collection e.g. `compiled_test`), click the **download / Generate ingestion script** action. It POSTs to `/ingestion/compile`.
Expected: a script `ingestion_compiled_test.py` is returned + written to `langchain_runner/`.

- [ ] **Step 2: Confirm it parses**

Run: `python3 -m py_compile langchain_runner/ingestion_compiled_test.py && echo OK`
Expected: `OK`.

- [ ] **Step 3: Run it standalone against the live MCP servers**

Run: `python3 langchain_runner/ingestion_compiled_test.py`
Expected: per-file `… : N chunk(s)` lines (N>0) and a final `done -- <total> chunk(s) stored`, with no `ERROR:` lines (langfs + mcp_qrant reachable).

- [ ] **Step 4: Verify the chunks landed (independent of the script)**

Run (Qdrant local store, adjust collection):
```bash
curl -s -X POST http://127.0.0.1:8008/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find","arguments":{"provider":"qdrant","connection":{},"collection":"compiled_test","query":"context","limit":3}}}' \
  | sed 's/.*"text":"//;s/"}].*//'
```
Expected: a `results` array with the ingested chunks + scores — proving the compiled script wrote real vectors via mcp_qrant.

- [ ] **Step 5: Parity sanity vs the interpreter**

Run the same workflow through ▶ Start (the interpreter) into a *different* collection, and compare the per-file chunk counts the script printed against the interpreter's `[store] … wrote N chunk(s)` logs. They should match or be near (same langfs extraction + same recursive splitter; any small gap is the PHP-vs-langchain splitter boundary, acceptable).

- [ ] **Step 6: Record the outcome**

If the live run surfaces a real langfs `list_files`/`read_file` shape difference (e.g. entry keys), fix the emitted `list_files`/`read_text` parsing in `compileScript` (Task 1) and re-run; otherwise no commit.

---

## Self-Review

**1. Spec coverage:**
- §3 rewrite `compileScript` → Task 1. ✓
- §3 rewrite per-node fragments → Task 2. ✓
- §3 compile-time URL resolution (`langfs_url`/`mcpqrant_url`) → Task 1 (endpoint step). ✓
- §3 consume current config keys (vectorstore provider/connection/embedding/collection; loader storage_mcp_url/provider/path/types/is_dir/workers) → Task 1 (var resolution). ✓
- §3 MCP helpers handle langfs text + mcp_qrant envelope + missing-`{stored}` guard → Task 1 (`_payload`/`store`). ✓
- §4 thin orchestrator, ThreadPool, literals → Task 1. ✓
- §5 data flow (list_files→read_file→split→store) → Task 1. ✓
- §6 compiler methods + endpoint → Tasks 1-2. ✓
- §7 UI delivery unchanged → no code change (nodeCode/compile endpoints reused; Task 1 keeps `compile`'s write+return). ✓
- §8 error handling (per-file continue, missing-stored raise, JSON-RPC raise) → Task 1 (`process_file`/`store`/`_payload`). ✓
- §9 testing (py_compile + PHP unit + parity/live) → Task 1 (unit+py_compile), Task 3 (live+parity). ✓
- §10 open items: splitter parity asserted "near" → Task 3 step 5; blank connection/embedding baked as-is → Task 1 (`{}`/`""`). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The live-test paths (`cv/articles`, `compiled_test`) are concrete operator inputs.

**3. Type consistency:** `compileScript($loaderCfg,$splitterCfg,$storeCfg,$ctx)` signature unchanged; `$ctx` keys `langfs_url`/`mcpqrant_url` set by the endpoint (Task 1 step 4) and read by `compileScript` (Task 1 step 3) — matched. The emitted Python: `list_files()`/`read_text(src)`/`store(items)`/`process_file(src)`/`_payload(url,tool,args)` are internally consistent. `compileNodeChunk` cases (Task 2) emit `LOADER`/`SPLITTER`/`STORE` config blocks; `splitterDispatch` body uses `split_text(text)` consistent with the loader yielding text. Old methods deleted in Task 2 are not referenced elsewhere (verified by the grep in Task 2 step 5).
