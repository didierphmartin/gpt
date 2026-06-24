# Ingestion compiler → langfs + mcp_qrant (design)

- **Date:** 2026-06-23
- **Status:** Approved direction; spec for implementation.
- **Repo:** gpt (`feat/rag-ingestion-full`).
- **Supersedes the emitted-code shape of:** `2026-06-19-ingestion-python-compiler.md`
  (which targeted the old UniversalFS + `qdrant-store` stack with local extraction).
- **Related:** `2026-06-18-ingestion-execution-model.md` (one semantics, two
  lowerings); the gpt store-node integration + pgvector specs (the current MCP stack).

## 1. Summary

Rewrite what the ingestion **compiler emits** so the generated artifact is a
**100% standalone Python script** that orchestrates the **current** MCP stack —
**langfs** for loading (it extracts text) and **mcp_qrant** for storing (it embeds
and upserts) — with the **only in-process LangChain being the splitter**. The
script is completely independent of the PHP interpreter (runnable on a cron box
with just `langchain-text-splitters` + an HTTP client) but uses the two MCP servers
as external entities.

This replaces the old emitted shape (UniversalFS `list_files`/`read_file` → base64,
local pypdf/docx2txt/markdownify decode, old session-based `qdrant-store`). Because
extraction and embedding now happen on the servers, the generated code shrinks
dramatically and the old "PHP-vs-Python decode drift" caveat disappears.

## 2. Motivation

The node forms and the runtime moved on this session: the loader uses **langfs**
(returns extracted text), and the store node uses **mcp_qrant** with the unified
`store`/`find` contract (`provider`/`connection`/`collection`/`items`/`embedding`).
The compiler still emits code for the retired UFS + `qdrant-store` stack and does
its own extraction in Python — so it no longer matches the interpreter or the forms.
Re-pointing the compiled output at langfs + mcp_qrant makes the two lowerings
faithful **by construction** (same servers do extract + embed) and makes the
generated script smaller and dependency-light.

## 3. Scope

### In scope
- Rewrite the **emitted code** in `IngestionCompiler.php`: `compileScript` (full
  script) and the per-node fragments/views (`compileNodeChunk`/`compileNodeView`/
  `compileView`) for loader/splitter/vectorstore.
- **Compile-time URL resolution** (`$ctx`): `langfs_url` (loader `storage_mcp_url`),
  `mcpqrant_url` (`store:"mcp:<id>"` → `mcp_servers` lookup) — update the `compile`
  endpoint.
- Consume the **current** node config keys (vectorstore `provider`/`connection`/
  `embedding`/`collection`; loader `storage_mcp_url`/`provider`/`path`/`types`/
  `is_dir`/`workers`).
- Generated MCP helpers handle **langfs** `read_file` (text) and **mcp_qrant**
  envelope (`{content:[{text:json}]}`), surfacing a missing-`{stored}` response as a
  hard error (no silent `stored:0`).

### Out of scope (v1 / later)
- Non-linear / fan-out graphs — the emitted script is a **linear loop + thread pool**.
- A "portable" native-LangChain variant (no MCP: langchain loaders + embeddings +
  vector store in-process) — explicitly **not** this; v1 uses the MCP servers.
- Per-call **langfs cloud credentials** in the emitted loader (local provider first).
- The interpreter itself (unchanged).

## 4. Architecture — the emitted script

A thin MCP orchestrator. The only real in-process LangChain is the splitter:

```python
#!/usr/bin/env python3
"""Standalone RAG ingestion — generated from the workflow nodes.
Orchestrates langfs (extract) + mcp_qrant (embed/store); only the splitter runs
in-process. Deps: langchain-text-splitters + urllib (stdlib)."""
import json, urllib.request
from concurrent.futures import ThreadPoolExecutor
from langchain_text_splitters import RecursiveCharacterTextSplitter

LANGFS     = "<resolved at compile time from loader.storage_mcp_url>"
MCPQRANT   = "<resolved from vectorstore store:'mcp:<id>'>"
PROVIDER   = "local"          # loader provider
PATH       = "/path/to/src"
TYPES      = ["pdf", "html"]  # [] = all supported
IS_DIR     = True
CHUNK, OVERLAP = 1000, 150
VS_PROVIDER    = "qdrant"     # vectorstore provider
CONNECTION     = {}           # blank => mcp_qrant server env
COLLECTION     = "docs"
EMBEDDING      = ""           # "" => server default (mcp_qrant); else e.g. openai:...
WORKERS        = 4

_split = RecursiveCharacterTextSplitter(chunk_size=CHUNK, chunk_overlap=OVERLAP)

# _mcp(url, tool, args) -> decoded payload  (handles JSON / SSE body + the
#   {content:[{text:json}]} envelope; raises on JSON-RPC error or missing field)
# langfs_list_files() -> [source, ...]      via list_files(provider, path, types, is_dir)
# langfs_read_file(src) -> text             via read_file (langfs already extracted)
# mcpqrant_store(items) -> stored           via store(provider, connection, collection,
#                                                     items, embedding); raises if no {stored}

def process_file(src):
    text   = langfs_read_file(src)
    chunks = [c for c in _split.split_text(text) if c.strip()]
    if not chunks:
        return src, 0
    stored = mcpqrant_store([{"text": c, "metadata": {"source": src}} for c in chunks])
    return src, stored

if __name__ == "__main__":
    files = langfs_list_files()
    print(f"{len(files)} file(s), {WORKERS} worker(s)")
    total = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for src, n in ex.map(lambda f: _safe(process_file, f), files):
            total += n; print(f"  {src}: {n}")
    print(f"done — {total} chunk(s) stored")
```

- **Config baked in** as Python literals; **MCP URLs resolved at compile time**.
- **ThreadPoolExecutor** (not ProcessPool): the script is pure network I/O now that
  extract + embed run on the servers. `WORKERS` = loader's "Parallel workers".
- `_safe` wraps `process_file` in try/except → per-file error line, **continue**.

## 5. Data flow

1. `langfs.list_files(provider, path, types, is_dir)` → file list (recursive walk /
   single file, type-filtered) — enumerated once. Same call the interpreter makes.
2. `langfs.read_file(src)` → extracted **text** (no local decode).
3. `RecursiveCharacterTextSplitter(chunk_size, overlap).split_text(text)` → chunks
   (blank chunks dropped).
4. `mcp_qrant.store(provider, connection, collection, items=[{text,metadata}],
   embedding)` → `{stored, errors}`.

Faithful by construction: interpreter and compiled script call the same servers for
extract + embed; only the splitter is reimplemented (same recursive algorithm).

## 6. The compiler (`IngestionCompiler.php`)

- **`compileScript($loaderCfg, $splitterCfg, $storeCfg, $ctx): {filename, code}`** —
  emit the §4 script. `$ctx = {langfs_url, mcpqrant_url}`.
- **`compileNodeChunk` / `compileNodeView` / `compileView`** — per-node fragments for
  the "Generated code" tab: loader → langfs `list_files`/`read_file`; splitter →
  `RecursiveCharacterTextSplitter`; vectorstore → `mcp_qrant.store(...)`.
- **Compile endpoint** (`IngestionController`) resolves `$ctx`: `langfs_url` from the
  loader's `storage_mcp_url`; `mcpqrant_url` from `store:"mcp:<id>"` → `mcp_servers`
  URL lookup. Emits/writes to `langchain_runner/ingestion_<collection>.py` and returns
  `{filename, code, written}` (existing delivery).
- **No PHP runtime dependency** in the emitted code; URLs + config are literals.

## 7. UI delivery (unchanged)

- Per-node **"Generated code"** tab — `node-code` endpoint → `compileView` → the
  Input/Generated/Output panes, now showing the langfs/mcp_qrant fragments.
- Full-script **download / "Generated ingestion script"** view — `compile` endpoint →
  `compileScript` → written to `langchain_runner/` + downloaded. Same buttons.

## 8. Error handling

- Per-file `try/except` in the script → record + **continue** (skip-and-continue,
  matching the interpreter); the per-file line shows the error.
- `mcpqrant_store` raises when the response lacks `{stored}` (redirect / wrong
  endpoint / non-MCP body) — same hardening as `VectorMcpStore` (no silent 0).
- langfs/mcp_qrant JSON-RPC errors raise with the server message.
- A bad `store:"mcp:<id>"` or missing `storage_mcp_url` at compile time → the compile
  endpoint returns a clear error before emitting.

## 9. Testing

- **`py_compile`** the emitted script on every compile (parses/compiles clean).
- **Unit (PHP):** `compileScript` emits the expected literals (URLs, config, the
  langfs/mcp_qrant calls) for a sample `{loader, splitter, vectorstore}`; the per-node
  views contain the right fragments; a bad store ref → compile error.
- **Parity:** run the compiled script and the interpreter on the same source (e.g.
  `cv/articles`), assert equal/near chunk counts, then `find` retrieves the stored
  chunks — proving the script wrote real vectors via mcp_qrant.
- **Live:** emit for a real folder, `python3` it against running langfs + mcp_qrant,
  confirm rows land (Qdrant or pgvector) and search returns them.

## 10. Open items

- Splitter parity: confirm `IngestionSplitter::recursiveSplit` and langchain
  `RecursiveCharacterTextSplitter` produce the same chunk boundaries for the same
  `(chunk_size, overlap)`; if they diverge, the parity test asserts "near", not exact.
- Whether to bake a non-empty `CONNECTION`/`EMBEDDING` into the script when the node
  left them blank (server-owned) — v1 bakes exactly what the node carries (blank →
  server env), keeping the script portable to a configured mcp_qrant.
