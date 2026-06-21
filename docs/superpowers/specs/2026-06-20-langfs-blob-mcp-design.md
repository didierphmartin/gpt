# langfs — LangChain blob-provider MCP server (design)

- **Date:** 2026-06-20
- **Status:** Approved for implementation (spec)
- **Branch context:** `feat/rag-ingestion-full`

## 1. Summary

A standalone Python HTTP server that exposes **LangChain blob providers** to gpt
through a **stateless MCP (streamable-HTTP) interface**. It serves the ingestion
**read path** — enumerate a source, then return each document's **text** — and
registers in the same MCP slot the PHP `UniversalFS` server occupies today.

It replaces UniversalFS **for the read path only**. Its first (and only, at
launch) provider is the **local filesystem**, backed by LangChain's
`FileSystemBlobLoader`. The contract is designed so cloud providers and
per-request access keys slot in later without changing the tool shapes.

Two properties drive the design:

1. **Text out, not blobs.** Where the file type is parseable (pdf/docx/html/
   txt/csv), `read_file` returns extracted **text**. gpt's PHP decode layer
   (`IngestionLoader::decode`) collapses to a passthrough. A `format="base64"`
   fallback remains for non-parseable binaries.
2. **One document per call, clocked by the pipeline.** `list_files` enumerates
   the whole (filtered, recursive) tree in a single cheap call that reads no file
   contents; `read_file` then returns **one document's text per call**. The
   ingestion pipeline pulls exactly one file, processes it fully (split → embed →
   store), and only then asks for the next — the existing **store-clocks-loader**
   semantics (§5.1). The server never streams a batch; it hands back one file at
   a time, on demand.

## 2. Motivation

Today the ingestion loader reads through the PHP `UniversalFS` MCP server, which
returns **base64 blobs** that gpt then parses itself in PHP (`Smalot\PdfParser`,
`ZipArchive` for docx, `League\HTMLToMarkdown` for html). LangChain already has
mature blob loaders + parsers that:

- enumerate filesystem (and later S3/GCS/Azure/Drive) sources uniformly, and
- parse pdf/docx/html/… to clean text.

Moving the read path to a LangChain-backed server lets us (a) return text
directly, (b) delete gpt's bespoke decode code path over time, and (c) gain new
providers by swapping a single source class rather than writing a new adapter.

## 3. Scope

### In scope (launch)

- Standalone FastAPI app at `/Applications/XAMPP/xamppfiles/htdocs/langfs/`.
- Stateless MCP streamable-HTTP transport (mirrors the `vector/` Qdrant server).
- Two tools: `list_files`, `read_file`.
- **Local filesystem provider only**, via `FileSystemBlobLoader`.
- Recursive enumeration with a **document-type filter**.
- Text extraction via `MimeTypeBasedParser` for pdf/docx/html/txt/csv, with a
  `base64` fallback.
- Path-traversal guard against a configured root.
- Pytest suite over a fixture tree + one live round-trip from gpt.

### Out of scope (future phases — designed for, not built)

- **Write / copy / move / delete** and workflow-output storage — UniversalFS
  keeps these.
- **Cloud providers** (S3, Google Drive, OneDrive) — the `provider` arg is the
  extension point; only `"local"` is accepted at launch.
- **Per-request access keys / credentials** — the loader form will later supply
  an access key forwarded as a tool arg (see §9). No credential handling now.

## 4. Architecture

```
gpt PHP                                   langfs (FastAPI / MCP, stateless)
  │                                              │
  │  MCPToolsLoader->executeTool(...)            │
  ├── POST /mcp  list_files(path, types) ───────▶│  LocalBlobSource
  │                                              │    └─ FileSystemBlobLoader.yield_blobs()
  │  ◀── {files:[{id,name,type:"file"}...]} ─────┤        (drained server-side; no reads)
  │                                              │
  ├── POST /mcp  read_file(file_id, format) ────▶│  Blob.from_path → MimeTypeBasedParser
  │  ◀──────────── "<parsed text>" ──────────────┤        (bytes read + parsed HERE)
  │                                              │
  └── …one read_file call per file…             │
```

gpt's existing wiring is unchanged: `IngestionController::buildLoaderClosures`
injects `list_files` / `read_file` callables into `IngestionLoader`, dispatched
through `MCPToolsLoader->executeTool()`. We point that MCP registration at
`langfs` instead of UniversalFS.

### Component layering (one job per unit)

```
langfs/
  server.py            # FastAPI app + MCP JSON-RPC routing; thin glue only
  sources/
    base.py            # BlobSource protocol: list(path, suffixes) / open(file_id)
    local.py           # LocalBlobSource — FileSystemBlobLoader + one root guard
  parsing/
    registry.py        # MimeTypeBasedParser config + doc-type→suffix mapping
  config.py            # allowed root(s), host/port, parser registry
  tests/
    fixtures/          # small tree: pdf, docx, html, txt, csv + nested folders
    test_list.py
    test_read.py
  requirements.txt
  README.md
```

- **`BlobSource`** — protocol with two methods: `list(path, suffixes) -> [descriptor]`
  and `open(file_id) -> Blob`. One impl now (`LocalBlobSource`); cloud sources
  add new impls without touching `server.py` or `parsing/`.
- **`parsing/registry.py`** — owns the `MimeTypeBasedParser` and the
  doc-type→suffix map; the single source of truth for "what types we support."
- **`server.py`** — maps an MCP tool call to `source.list/open` + parser. No
  business logic.

## 5. Tool contract

Stateless: every call is self-contained; no session handshake. Errors are
returned as `{"error": true, "message": "..."}` (gpt already checks
`$res['error']`).

### `list_files`

Enumerate a source recursively, filtered by document type. Reads **no file
contents**.

**Arguments**

| arg        | type       | required | notes                                                        |
|------------|------------|----------|--------------------------------------------------------------|
| `provider` | string     | yes      | `"local"` only at launch; validated. Extension point.        |
| `path`     | string     | yes      | Root folder (or a single file) to enumerate.                 |
| `types`    | string[]   | no       | Doc-type checkboxes: `pdf,word,text,csv,html`. Empty/absent → all supported. |

**Result**

```json
{ "files": [ { "id": "/docs/a.pdf", "name": "a.pdf", "type": "file" },
             { "id": "/docs/sub/c.docx", "name": "c.docx", "type": "file" } ] }
```

- **Recursive, flattened, files only.** Subfolders are descended into but never
  returned as entries (a `Blob` is always a file). `id` is the absolute path
  (provenance); `name` is the basename. `type` is always `"file"` at launch.
- A single `path` that is itself a file yields one descriptor (or none if its
  type is unsupported/filtered).
- gpt's `IngestionLoader::enumerateFiles` consumes this list directly: it sees
  only `type:"file"` rows, so its PHP per-folder recursion no-ops (its
  cycle/depth guards become dead code — harmless; prune in a later cleanup).

### `read_file`

Return one document's text (preferred) or raw bytes.

**Arguments**

| arg        | type   | required | notes                                                         |
|------------|--------|----------|---------------------------------------------------------------|
| `provider` | string | yes      | `"local"` only at launch.                                     |
| `file_id`  | string | yes      | Absolute path from a `list_files` `id`.                       |
| `format`   | string | no       | `"text"` (default) → parsed text; `"base64"` → raw bytes b64. |

**Result** — a **string**: the parsed text (default) or base64 bytes. On a parse
failure for that one file: `{"error": true, "message": "..."}` (mirrors
`readRound`'s per-file `current.error` — one bad file does not abort the batch).

### 5.1 Consumption: one file at a time into the ingestion pipeline

The server exposes *capability* (enumerate, read-one); the **pipeline owns the
clock**. The loop, driven by gpt's `IngestionLoader::readRound` and the
store-clocks-loader execution model:

```
cursor = 0
sources = list_files(provider, path, types).files     # once; cheap, no reads
while cursor < len(sources):
    text = read_file(provider, sources[cursor].id)    # ONE file's text
    pipeline.process(text, source=sources[cursor].id) # split → embed → store, to completion
    cursor += 1                                        # store advances the clock
```

- **The server is stateless and holds no cursor.** "A file at a time" is the
  *caller's* pull rhythm: one `read_file` per pipeline round. The cursor lives in
  gpt (`readRound`), exactly as today.
- `readRound` re-runs enumeration each round to report "file k of N"; because
  `list_files` reads no contents, re-enumerating is cheap. (An optional later
  optimization: cache the enumerated `sources` for a run so `list_files` is
  called once rather than per round — not required for launch.)
- This is why there is **no** "next document" iterator tool: the two-tool
  contract (`list_files` + `read_file`) already yields one file per call and
  stays a drop-in for gpt's injected `listFiles` / `readFile` closures.

## 6. Enumeration semantics (how the blob provider lists a hierarchy)

`FileSystemBlobLoader` is a thin wrapper over `pathlib.Path.glob()`:

1. `Path(root).glob("**/[!.]*")` walks the tree; `**` makes it **recursive**,
   the `[!.]` skips dotfiles.
2. Only `path.is_file()` survives — **directories are filtered out**, so folders
   are traversed but never emitted.
3. The `suffixes` filter keeps only the requested extensions.
4. It `yield`s a **lazy** `Blob` per file (a generator; bytes are not read until
   `.as_bytes()`).

`list_files` **drains that generator once** inside the call and returns the full
path list — cheap because enumeration reads no contents. The generator never
crosses the wire; gpt receives a plain JSON list.

## 7. Document-type filter

The blob loader filters by **suffix**; gpt's checkboxes speak **doc-type**. The
parser registry owns the mapping:

```python
TYPE_SUFFIXES = {
    "pdf":  [".pdf"],
    "word": [".docx", ".doc"],
    "text": [".txt"],
    "csv":  [".csv"],
    "html": [".html", ".htm"],
}
```

`list_files(types=["pdf","word"])` → `suffixes=[".pdf",".docx",".doc"]` passed to
`FileSystemBlobLoader`. Empty/absent `types` → all supported suffixes
("no restriction", matching gpt's current behavior). Filtering happens **at the
source**, so a 5,000-file folder with one pdf enumerates fast.

## 8. Text extraction

`read_file(format="text")` runs the blob through a `MimeTypeBasedParser`:

| mime / type                                   | parser              |
|-----------------------------------------------|---------------------|
| `application/pdf`                             | `PyMuPDFParser`     |
| `application/vnd.openxmlformats-…wordprocessingml.document` (docx) | `Docx2txtParser` |
| `text/html`                                   | `BS4HTMLParser`     |
| `text/plain` (txt)                            | `TextParser`        |
| `text/csv`                                    | `TextParser`        |

The parser yields `Document`s; `read_file` returns
`"\n\n".join(d.page_content for d in docs)`.

- `format="base64"` skips the parser and returns `base64(blob.as_bytes())` — the
  fallback for images / unparseable binaries.
- An unsupported mime with `format="text"` → `{"error", "message"}`.

This makes gpt's `IngestionLoader::decode` a **passthrough** for text responses:
the loader receives text, not bytes. (Decode logic stays as defensive fallback
for the `base64` path; full removal is a later cleanup, not this spec.)

## 9. Forward compatibility (designed for, not built)

- **Cloud providers.** Add a `BlobSource` impl (e.g. `S3BlobSource` wrapping
  `CloudBlobLoader`) keyed by `provider`. `server.py`, `parsing/`, and the tool
  shapes are untouched.
- **Access key from the loader form.** A later phase adds an optional
  `credentials` / `access_key` arg to both tools, supplied by the workflow
  loader form and forwarded by gpt. The server stays stateless — credentials
  ride on each request. No credential storage is introduced; `"local"` needs
  none, so launch carries zero secrets.

## 10. Error handling

- **Unknown provider / tool** → `{"error", "message"}`.
- **Path traversal** — every `path` / `file_id` is resolved and confirmed to sit
  under a configured allowed root; escapes → error (no reads outside the root).
- **Per-file parse failure** → that one `read_file` returns an error object; the
  batch continues (gpt's `readRound` already renders `current.error`).
- **Unsupported type** under `format="text"` → error; gpt's type filter normally
  prevents reaching this.

## 11. Integration with gpt

- Register `langfs` as the MCP server providing `list_files` / `read_file` (the
  slot UniversalFS holds today). No change to `buildLoaderClosures`,
  `IngestionLoader::enumerateFiles`, or `readRound`.
- `read_file` now returns **text**; the injected `readFile` closure currently
  base64-decodes — it switches to `format="text"` and returns the string as-is
  (no decode). The `format="base64"` branch is retained for binary fallback.
- `provider` continues to flow from the loader form (`"local"` for now).

## 12. Testing

1. **Unit (pytest over `tests/fixtures/`):** a tree with pdf/docx/html/txt/csv
   and nested subfolders.
   - `list_files` returns the **flattened recursive** file set; subfolders are
     not entries; dotfiles excluded.
   - `types` filter narrows to the requested suffixes; empty → all.
   - `read_file(text)` extracts non-empty text per type; `read_file(base64)`
     round-trips bytes.
   - Path-traversal attempt → error.
   - Corrupt file → per-file error, no crash.
2. **Live round-trip:** point gpt's loader MCP registration at `langfs`, run
   `IngestionController::loaderPreview` / `readRound` against the fixture tree,
   confirm text appears in the loader Output tab.

## 13. Dependencies

- `fastapi`, `uvicorn`
- `langchain-community` (`FileSystemBlobLoader`, `MimeTypeBasedParser`, parsers)
- `pymupdf` (pdf), `docx2txt` (docx), `beautifulsoup4` (html)
- Pinned in `langfs/requirements.txt`, isolated venv (separate from
  `langchain_runner`).

## 14. Open items

- Exact MCP registration mechanism in gpt's server registry (reuse the
  Qdrant/`vector` registration path) — confirm during implementation.
- Whether to prune gpt's now-redundant PHP recursion + decode immediately or in
  a follow-up cleanup — **follow-up**, to keep this change drop-in.
