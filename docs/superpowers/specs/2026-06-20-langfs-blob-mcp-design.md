# langfs — LangChain blob-provider MCP server (design)

- **Date:** 2026-06-20 (rev. 2026-06-22)
- **Status:** Part I (filesystem provider) **shipped** — langfs `master`, 45 tests
  passing. Part II (multi-provider extension, Phase 1) **designed**, pending
  implementation plan.
- **Branch context:** `feat/rag-ingestion-full`

> **Reading guide:** Part I (§§1–16) is the shipped single-provider (local
> filesystem) design — it remains the baseline and is unchanged. Part II
> (§§17–25) is the multi-provider extension scoped to **Phase 1** (object stores
> with key/connection-string auth), with OAuth and package-install noted as
> future phases (§25). Where Part II evolves a Part I component, it says so
> explicitly.

## 1. Summary

A standalone Python HTTP server that **encapsulates LangChain blob loaders** and
exposes them to gpt through an **MCP (streamable-HTTP) interface**. It serves the
ingestion **read path**: enumerate a source, then hand back **one document at a
time** — preferably as extracted **text**, falling back to a raw **blob** when a
type can't be parsed.

It is **read-only**. It only *gets* blobs/text from LangChain drivers; it never
deletes, updates, renames, or otherwise mutates the enumerated elements.

Launch provider: the **local filesystem** (`FileSystemBlobLoader`). The contract
is designed so additional providers and a per-request access key slot in later
without changing the tool shapes.

Defining properties (each ties to a stated requirement):

1. **Encapsulates LangChain blob loaders** — the server is the only thing that
   touches LangChain; gpt talks plain MCP.
2. **Text preferred, blob fallback** — `read_next` returns extracted text where
   possible (pdf/docx/html/txt/csv), else base64 bytes.
3. **The server keeps the enumeration cursor** and returns one document per
   iteration call — the caller does not track an index.
4. **The function takes the provider name** as a parameter.
5. **Per-client cursor** — the server may serve several clients at once, so the
   cursor is kept **per `client_id`** (§6).
6. **Read-only** — no delete/update/rename/move; getting blobs/text is the whole
   job (§10).
7. **Provider discovery** — a `list_providers` tool returns all available
   blob/text providers (§5.1).

## 2. Motivation

Today the ingestion loader reads through the PHP `UniversalFS` MCP server, which
returns **base64 blobs** that gpt parses itself in PHP (`Smalot\PdfParser`,
`ZipArchive` for docx, `League\HTMLToMarkdown`). LangChain already has mature
blob loaders + parsers that enumerate filesystem (and later cloud) sources
uniformly and parse pdf/docx/html to clean text. Moving the read path onto a
LangChain-backed server lets us return text directly, retire gpt's bespoke decode
path over time, and gain new providers by adding one source class.

## 3. Scope

### In scope (launch)

- Standalone FastAPI app at `/Applications/XAMPP/xamppfiles/htdocs/langfs/`.
- MCP streamable-HTTP transport (mirrors the `vector/` Qdrant server).
- Three tools: `list_providers`, `read_next`, `reset` (§5).
- **Local filesystem provider only**, via `FileSystemBlobLoader`.
- Recursive enumeration with a **document-type filter**.
- **Server-held cursor per `client_id`**, with collision verification (§6).
- Text extraction via `MimeTypeBasedParser` (pdf/docx/html/txt/csv); `base64`
  fallback for non-parseable binaries.
- Path-traversal guard against a configured root.
- Pytest suite over a fixture tree + one live round-trip from gpt.

### Out of scope (future phases — designed for, not built)

- **Any mutation** — write, copy, move, rename, delete. langfs is read-only by
  charter (§10); these stay with UniversalFS.
- **Cloud providers** (S3, Google Drive, OneDrive). The `provider` arg and
  `list_providers` are the extension points; only `"local"` ships now.
- **Per-request access keys / credentials** — the workflow loader form will later
  supply an access key forwarded as a tool arg (§11). No credential handling now.

## 4. Architecture

```
gpt PHP                                   langfs (FastAPI / MCP)
  │                                              │
  │  MCPToolsLoader->executeTool(...)            │   cursor store
  ├── POST /mcp list_providers() ───────────────▶│   { client_id → {owner,
  │  ◀── {providers:[{name:"local",...}]} ───────┤        fingerprint,
  │                                              │        sources, cursor} }
  ├── POST /mcp read_next(provider, path,        │
  │              types, client_id) ─────────────▶│   verify owner+fingerprint
  │                                              │   → sources[cursor] → parse
  │  ◀── {index, count, source, content, done} ──┤   → cursor += 1
  │                                              │
  └── …one read_next per pipeline round…         │
```

Internally the server is layered so each unit has one job and cloud providers
slot in without touching the rest:

```
langfs/
  server.py            # FastAPI + MCP JSON-RPC routing; thin glue
  cursors.py           # per-client cursor store: get/create/verify/reset, TTL
  sources/
    base.py            # BlobSource protocol: enumerate(path, suffixes) / open(file_id)
    registry.py        # provider name → BlobSource; powers list_providers
    local.py           # LocalBlobSource — FileSystemBlobLoader + root guard
  parsing/
    registry.py        # MimeTypeBasedParser + doc-type→suffix map
  config.py            # allowed root(s), host/port, TTL
  tests/ …
  requirements.txt
  README.md
```

## 5. Tool contract

MCP tools. Errors return `{"error": true, "code": "...", "message": "..."}` (gpt
already checks `$res['error']`).

### 5.1 `list_providers`

Discovery. Returns every available blob/text provider.

- **Arguments:** none.
- **Result:**

```json
{ "providers": [
    { "name": "local", "kind": "text",
      "description": "Local filesystem via LangChain FileSystemBlobLoader",
      "requires_credentials": false }
] }
```

`kind` is `"text"` when the provider's reads are parsed to text, `"blob"` when
only bytes are available. Future providers (s3, gdrive, onedrive) appear here with
`requires_credentials: true`.

### 5.2 `read_next`

Return the **next** document for this client's enumeration of `(provider, path,
types)`, advancing the **server-held cursor**. The first call for a `client_id`
enumerates and returns item 0; each subsequent call returns the next item.

**Arguments**

| arg         | type     | required | notes                                                            |
|-------------|----------|----------|------------------------------------------------------------------|
| `provider`  | string   | yes      | Provider name from `list_providers`. `"local"` only at launch.   |
| `path`      | string   | yes      | Root folder (or single file) to enumerate.                       |
| `client_id` | string   | yes      | Caller-named id; keys the cursor (§6). E.g. `{userId}:{runId}`.  |
| `types`     | string[] | no       | Doc-type filter `pdf,word,text,csv,html`. Empty/absent → all.    |
| `format`    | string   | no       | `"text"` (default) or `"base64"`.                                |
| `reset`     | bool     | no       | `true` re-enumerates from item 0 (and overrides a collision).    |

**Result**

```json
{ "index": 0, "count": 12,
  "source": "/docs/sub/c.docx", "name": "c.docx",
  "format": "text", "content": "<extracted text>",
  "done": false }
```

- **`done: true`** with no `content` once the cursor passes the last item — the
  pipeline's stop signal.
- **Per-file parse failure** → `{ "index", "count", "source",
  "error": true, "message", "done": false }`; the cursor still advances so one
  bad file does not stall the run (mirrors `readRound`'s `current.error`).
- **Collision** (`client_id` reused for a different owner/source) →
  `{ "error": true, "code": "client_id_conflict", "message": ... }` unless
  `reset: true` (§6).

### 5.3 `reset`

Drop a client's cursor explicitly (optional; cursors also expire by TTL).

- **Arguments:** `client_id` (string, required).
- **Result:** `{ "reset": true }` (idempotent — succeeds even if unknown).

### 5.4 Consumption: one file at a time into the ingestion pipeline

The server exposes capability; the **pipeline owns the clock** — the
store-clocks-loader model is preserved, the cursor simply lives server-side now:

```
providers = list_providers()                 # once, for the loader form / validation
loop:
    doc = read_next(provider, path, types, client_id)   # ONE document, server advances cursor
    if doc.done: break
    pipeline.process(doc.content, source=doc.source)     # split → embed → store, to completion
```

The store decides *when* to call `read_next` (it clocks the loop); the server
decides *which* document is next (it holds the cursor). "A file at a time" is the
result of the store pulling exactly one per round.

## 6. Client identity, cursor state & collision handling

The server keeps, per `client_id`:

```
store[client_id] = { owner, fingerprint, sources, cursor, created_at }
fingerprint = sha256( owner ‖ provider ‖ normalized_path ‖ sorted(types) )
```

- **Client-named id.** The caller supplies `client_id`, reusing an id it already
  owns — the ingestion **run / thread id**, namespaced by user (`{userId}:{runId}`).
  No server-minted handle, so no extra round-trip, and the id is meaningful in
  logs.
- **Cursor as a rebuildable cache, not authoritative state.** Enumeration is
  deterministic from `(provider, path, types)`. If the entry is missing (TTL
  eviction, server restart), the next `read_next` re-enumerates and continues —
  the interaction self-heals. (A fully stateless variant — client also passes the
  index — remains possible later for horizontal scaling; not needed at launch.)
- **Collision verification on every call:**
  1. **Owner check** — caller principal must equal `store[client_id].owner`;
     mismatch → `client_id_conflict`.
  2. **Fingerprint check** — call's `(provider, path, types)` must match the
     stored fingerprint; a reused id pointing at a *different* source →
     `client_id_conflict`.
  3. **Match** → serve `sources[cursor]`, advance.
  4. **Unknown id** → create (fresh enumeration). Not a collision.
  - `reset: true` overrides 1–2 by replacing the entry — the explicit "I really do
    mean to restart this id" escape hatch.
- **Concurrency** — a per-`client_id` lock serializes the read-modify-write of the
  cursor so two racing calls can't skip or double-serve an item.
- **Lifecycle** — entries expire after an idle TTL (config, default 1h); `reset`
  frees one eagerly. Launch runs a single uvicorn process with an in-memory store;
  multi-process/horizontal scaling (shared store or the stateless variant) is a
  later concern, noted in §16.

## 7. Enumeration semantics (how the blob provider lists a hierarchy)

`FileSystemBlobLoader` is a thin wrapper over `pathlib.Path.glob()`:

1. `Path(root).glob("**/[!.]*")` walks the tree; `**` makes it **recursive**, the
   `[!.]` skips dotfiles.
2. Only `path.is_file()` survives — **directories are traversed but never
   emitted** (a `Blob` is always a file).
3. The `suffixes` filter keeps only requested extensions.
4. It `yield`s a **lazy** `Blob` per file (bytes unread until `.as_bytes()`).

The server drains that generator **once** when it first builds `sources` for a
`client_id` (cheap — no contents read), then serves from the cached list. The
hierarchy is flattened to a stream of files with **full-path** ids (provenance);
folders are never returned as entries.

## 8. Document-type filter

The blob loader filters by **suffix**; gpt's checkboxes speak **doc-type**. The
parser registry owns the map:

```python
TYPE_SUFFIXES = {
    "pdf":  [".pdf"],
    "word": [".docx", ".doc"],
    "text": [".txt"],
    "csv":  [".csv"],
    "html": [".html", ".htm"],
}
```

`types=["pdf","word"]` → `suffixes=[".pdf",".docx",".doc"]`. Empty/absent → all
supported suffixes ("no restriction"). Filtering happens **at the source**, so a
5,000-file folder with one pdf enumerates fast. The filter is part of the
fingerprint, so changing it under the same `client_id` is a deliberate reset, not
a silent cursor reuse.

## 9. Text extraction

`read_next(format="text")` runs the blob through a `MimeTypeBasedParser`:

| mime / type                                                     | parser           |
|-----------------------------------------------------------------|------------------|
| `application/pdf`                                               | `PyMuPDFParser`  |
| `…wordprocessingml.document` (docx)                            | `Docx2txtParser` |
| `text/html`                                                    | `BS4HTMLParser`  |
| `text/plain` (txt)                                             | `TextParser`     |
| `text/csv`                                                     | `TextParser`     |

Result text = `"\n\n".join(d.page_content for d in docs)`. `format="base64"` skips
the parser and returns `base64(blob.as_bytes())` — the fallback for images /
unparseable binaries. An unsupported mime under `format="text"` → error.

## 10. Read-only guarantee

langfs **only reads**. It exposes no tool that writes, copies, moves, renames, or
deletes, and the `BlobSource` protocol has no mutating method — `enumerate` and
`open` are the entire surface. The local source opens files read-only and is
confined to a configured root (no traversal above it). This is a charter
constraint, not just an omission: mutation belongs to UniversalFS, never here.

## 11. Forward compatibility (designed for, not built)

- **Cloud providers.** Add a `BlobSource` impl (e.g. `S3BlobSource` over
  `CloudBlobLoader`) and register it under a provider name. `list_providers`,
  `read_next`, the cursor store, and `parsing/` are untouched; the new provider
  shows up in discovery with `requires_credentials: true`.
- **Access key from the loader form.** A later phase adds an optional
  `credentials` / `access_key` arg to `read_next`, supplied by the workflow loader
  form and forwarded by gpt. The server still keys the cursor by `client_id`; the
  key rides on each request. `"local"` needs none, so launch carries zero secrets.

## 12. Error handling

- **Unknown provider / tool** → `{error, code, message}`.
- **`client_id_conflict`** → owner/fingerprint mismatch (§6); caller resolves by
  using a distinct id or `reset: true`.
- **Path traversal** — every `path` / `file_id` resolves under a configured root;
  escapes → error.
- **Per-file parse failure** → error object for that one item, cursor advances,
  run continues.
- **Unsupported type** under `format="text"` → error (the type filter normally
  prevents reaching this).

## 13. Integration with gpt

The cursor moves from gpt's PHP into langfs, so this is **not** a pure drop-in for
the old `list_files`/`read_file` closures — it is a deliberate change of the read
contract:

- Register `langfs` as the ingestion read MCP server (the slot UniversalFS holds).
- `IngestionController` / `IngestionLoader` shift from "enumerate + read by PHP
  cursor" to "call `read_next(provider, path, types, client_id)` per round." The
  `client_id` is `{userId}:{runId}` from the existing run/thread context.
- `readRound` becomes a thin wrapper over `read_next`, surfacing `index` / `count`
  / `done` for the loader Output tab. gpt's PHP recursion and `decode()` for the
  text path become dead code (removed in a follow-up cleanup, not this spec).
- `list_providers` backs the loader form's provider dropdown.

## 14. Testing

1. **Unit (pytest over `tests/fixtures/`)** — a tree with pdf/docx/html/txt/csv
   and nested subfolders:
   - Recursive enumeration is flattened; subfolders are not entries; dotfiles
     excluded.
   - `types` filter narrows to requested suffixes; empty → all.
   - `read_next` walks items 0..N-1 then `done:true`; cursor is per `client_id`
     (two ids over the same path iterate independently).
   - **Collision:** same `client_id`, different `path`/owner → `client_id_conflict`;
     `reset:true` overrides.
   - TTL/eviction → next call re-enumerates and resumes.
   - `read_next(text)` extracts non-empty text per type; `base64` round-trips bytes.
   - Path-traversal attempt → error; corrupt file → per-file error, no crash.
   - `list_providers` returns `local`.
2. **Live round-trip** — point gpt's loader MCP registration at `langfs`, run the
   loader preview against the fixture tree, confirm one-file-at-a-time text in the
   Output tab.

## 15. Dependencies

- `fastapi`, `uvicorn`
- `langchain-community` (`FileSystemBlobLoader`, `MimeTypeBasedParser`, parsers)
- `pymupdf` (pdf), `docx2txt` (docx), `beautifulsoup4` (html)
- Pinned in `langfs/requirements.txt`, isolated venv (separate from
  `langchain_runner`).

## 16. Open items

- **Multi-process cursor store.** Launch is single-process in-memory. If langfs is
  ever scaled horizontally, either pin clients (sticky) or adopt the fully
  stateless variant (client passes the index) or a shared store. Deferred.
- **MCP registration mechanism** in gpt's server registry — reuse the
  Qdrant/`vector` registration path; confirm during implementation.
- **Cleanup of gpt's now-dead PHP recursion + text-path `decode()`** — follow-up,
  to keep this change focused.

---

# Part II — Multi-provider extension (Phase 1)

## 17. Goal & deployment context

Part I serves one provider (local filesystem). Part II lets the workflow
**loader node** choose among several **document-storage backends** reachable via
LangChain — and enter that backend's **credentials** and **scope** in the node
form. Storage and file format stay **orthogonal**: a `.docx` in S3 is read by the
exact same `extract_text` layer (§9) as a `.docx` on disk; Part II adds *sources*,
not parsers.

**Deployment context (drives the whole security posture):** ingestion runs on a
**single enterprise's local network**, used by that enterprise's own trusted
users — it is **not** a public internet service. Consequences:

- Holding provider credentials in server memory for the duration of a session is
  acceptable; no public-internet at-rest / zero-trust machinery is introduced.
- The session owner/fingerprint check (§6) guards against accidental cross-run
  cursor mix-ups, not hostile multi-tenancy.

**Phase 1 scope:** local (done) + a single `CloudBlobSource` covering **S3, GCS,
and Azure Blob** via key / connection-string auth. **OAuth** providers (Drive,
OneDrive) and **package install-on-demand** are explicitly **future phases**
(§25); Phase 1 only reserves room for them in the descriptor schema.

## 18. The provider descriptor (JSON "rules" file)

Each provider is declared by one JSON file in `langfs/providers/*.json`, loaded
and **schema-validated at startup** (an invalid descriptor fails fast, not at use
time). The descriptor is the **single source of truth** that drives the dynamic
loader-node form. Fields:

- **Identity:** `name` (id), `label`, `kind` (`object_store` | `drive` | `web` |
  `knowledge_store`), `description`.
- **Capabilities:** `enumerable` (bool), `recursive` (bool), and `scope_schema` —
  what "scope" means for this provider and the form field(s) to collect it
  (local: one `path`; object store: `bucket` + `prefix`; drive: a folder id; …).
- **Auth:** `auth_method` (`none` | `api_key` | `connection_string` | `oauth2` |
  `service_account_json`) + `credential_fields[]`, each
  `{name, label, type (text|password|file|oauth), required, mask, help}`. The
  loader node renders its credential inputs directly from this list.
- **Formats:** `default_formats[]` — the doc-types this storage is *expected* to
  hold. These **pre-check** the type-filter boxes but are **not enforced**
  (§22).
- **Provisioning (reserved for Phase 3):** `pip_packages[]` (pinned) and a
  `system_deps` flag. Present in the schema from Phase 1 so the install story
  (§25) needs no descriptor rework; unused at launch (Phase 1 packages are
  pre-installed).

Example (`providers/s3.json`, abridged):

```json
{
  "name": "s3", "label": "Amazon S3", "kind": "object_store",
  "description": "S3 / GCS / Azure object storage via LangChain CloudBlobLoader",
  "enumerable": true, "recursive": true,
  "scope_schema": { "fields": [
    { "name": "bucket", "label": "Bucket / container", "required": true },
    { "name": "prefix", "label": "Prefix (folder)", "required": false } ] },
  "auth_method": "api_key",
  "credential_fields": [
    { "name": "access_key", "label": "Access key", "type": "text", "required": true },
    { "name": "secret_key", "label": "Secret key", "type": "password", "required": true, "mask": true },
    { "name": "region", "label": "Region", "type": "text", "required": false } ],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": [], "system_deps": false
}
```

## 19. `list_providers` becomes the UI's data source

Part I's `list_providers` (§5.1) returns only `{name, kind, description,
requires_credentials}`. Part II expands each entry to include the descriptor's
**credential schema, scope schema, default formats, and `available`** (is the
provider's package installed?). The loader node renders the entire form —
credential inputs, scope inputs, pre-checked format boxes — dynamically from this
payload. No provider-specific UI is hard-coded.

### 19.1 Provider catalog

`list_providers` surfaces one entry per descriptor present in `langfs/providers/`.
The full set of candidate providers, the LangChain loader each maps to, its auth
method, and the phase it lands in:

| Provider | `kind` | LangChain loader | `auth_method` | Phase |
|---|---|---|---|---|
| Local filesystem | `object_store` | `FileSystemBlobLoader` | `none` | 1 ✅ shipped |
| Amazon S3 | `object_store` | `CloudBlobLoader` (`s3://`) | `api_key` | 1 |
| Google Cloud Storage | `object_store` | `CloudBlobLoader` (`gs://`) | `service_account_json` | 1 |
| Azure Blob Storage | `object_store` | `CloudBlobLoader` (`az://`) | `connection_string` | 1 |
| Google Drive | `drive` | `GoogleDriveLoader` | `oauth2` | 2 |
| OneDrive | `drive` | `OneDriveLoader` | `oauth2` | 2 |
| SharePoint | `drive` | `SharePointLoader` | `oauth2` | 2 |
| Dropbox | `drive` | `DropboxLoader` | `api_key` | 3 |
| Box | `drive` | `BoxLoader` | `oauth2` | 3 |
| GitHub / Git | `knowledge_store` | `GithubFileLoader` / `GitLoader` | `api_key` | 3 |

Phase 1 ships the first four — and S3/GCS/Azure are one `CloudBlobSource` adapter
(§21), so the Phase-1 provider work is **one** new source class plus four
descriptors. A provider whose package is not installed still appears in
`list_providers` with `available: false` (the install story is §25).

## 20. Session store (evolves the cursor store)

Part I's per-`client_id` cursor store (§6) becomes a **session store**. Each entry
grows from `{owner, fingerprint, sources, cursor, …}` to:

```
{ owner, fingerprint, credentials, live_connection, descriptors, cursor, updated_at }
```

- **Authenticate once, reuse the connection.** On session start (first
  `read_next`, or an explicit `test_connection`), the source **logs in once** and
  the **live authenticated connection** (SDK client / token) is cached in the
  entry. Every later `read_next` in the session **reuses** it — no re-login (the
  expensive part is the handshake, not sending the credential).
- **Lifecycle.** The connection is **closed** when the entry is evicted by TTL or
  dropped by `reset`. (OAuth token refresh is a Phase 2 concern, §25.)
- **Fingerprint** (§6) gains a **non-secret account identity** (bucket / account
  name / drive id — never the secret) so switching accounts under one `client_id`
  is a detected `client_id_conflict`.
- **Credentials in memory only** — never logged, masked in any trace; acceptable
  at rest per the LAN context (§17). The per-`client_id` lock (§6) also serializes
  access to connections that aren't thread-safe.

## 21. `BlobSource` interface + `CloudBlobSource`

The `BlobSource` protocol (§4) gains two methods, keeping the read-only charter
(§10) intact:

- `connect(credentials) -> connection` — establish/return the session connection.
- `test_connection(credentials, scope) -> ok | error` — validate before a run.

`LocalBlobSource` implements both as no-ops (no auth, no connection). A new
**`CloudBlobSource`** wraps LangChain's **`CloudBlobLoader`** (the cloud sibling
of `FileSystemBlobLoader`, built on `cloudpathlib`) to cover **S3, GCS, and Azure
in one adapter** — `s3://bucket/prefix`, `gs://…`, `az://…` — exposing the same
`enumerate` / `read_bytes` it already defines.

New MCP tool **`test_connection`** (provider, credentials, scope) → mirrors the
existing MCP-server "test" affordance so the loader node validates credentials
before running ingestion.

## 22. Scope & format semantics

- **Scope** is the descriptor's `scope_schema` generalized: local `path`, object
  store `bucket`+`prefix`, etc. Enumeration is recursive within scope (an S3
  prefix is naturally a recursive subtree).
- **Format** is a **UI default, not a restriction.** `default_formats`
  pre-checks the loader's type boxes, but the user may tick others; the server
  skips a file **only** when no extractor exists for it (the §9 `extract_text`
  raising `UnsupportedType`). A stray `.pdf` in a "text" bucket still ingests.

## 23. New runtime constraints (don't exist for local FS)

- **Pagination / caps.** Object stores can hold millions of keys. Cloud
  enumeration must page and honor a configurable cap rather than draining the
  whole listing into the session entry at once (Part I's full-drain is fine for a
  folder, not for a bucket). The cap is surfaced (logged / returned) so truncation
  is never silent.
- **MIME-based format detection.** Items may lack file extensions (e.g. Drive
  returns MIME types, not suffixes). Detection becomes **provider-aware**: use the
  storage-reported MIME when there is no usable suffix, then dispatch into the
  same `extract_text` (§9).
- **Provenance as a URI.** A source id is now `s3://bucket/key` (or `gdrive://id`
  later), not a local path — this is what the store records as provenance.

## 24. Testing (Phase 1)

- **Unit:** descriptor load + schema-validation (a malformed descriptor fails at
  startup); `CloudBlobSource` enumerate/read against a mocked store; session
  connection **reuse** (connect called once across several `read_next`);
  `test_connection` good/bad credentials; pagination cap honored; MIME dispatch
  for an extension-less item; fingerprint conflict on account switch.
- **Live (creds permitting):** a real S3 (and/or GCS/Azure) bucket — `read_next`
  walks items as text with a working cursor; smoke script extended for one cloud
  provider.
- **End-to-end:** the loader node renders its form dynamically from
  `list_providers` for local + one cloud provider; selecting a provider, entering
  credentials, choosing scope, and running ingestion returns text into the
  pipeline.

## 25. Forward compatibility (Phase 2 / Phase 3 — designed for, not built)

- **Phase 2 — OAuth providers (Google Drive, OneDrive/SharePoint).** Descriptor
  `auth_method: oauth2` already reserves the slot; adds an OAuth redirect flow and
  **token refresh** inside a long session (the session store's connection entry is
  where a refreshed token lives). No Phase 1 rework needed.
- **Phase 3 — install on demand from a vetted allowlist.** The descriptor's
  `pip_packages` (pinned) + `system_deps` fields drive it: a provider whose package
  is absent shows `available: false` and "needs admin install" rather than failing
  mid-run; installs come from the **curated allowlist only**, with a lock, timeout,
  pinned versions, and surfaced failures. Lower-risk on the LAN (§17), but
  reliability-guarded (system-dep providers are flagged un-installable). **Not**
  silent arbitrary install of anything LangChain names.
- **Provider roadmap** — see the catalog in §19.1 for the full phased list
  (Drive/OneDrive/SharePoint in Phase 2; Dropbox/Box/GitHub and the long tail in
  Phase 3). Notion and Confluence (`knowledge_store`) are candidate Phase-3
  additions beyond the catalog's file-storage focus.

Each future phase is its own spec → plan → implementation cycle.
