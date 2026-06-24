# Ingestion Execution Model — event‑driven loop + faithful lowerings

> Companion to `2026-06-14-dual-mode-ingestion-{overview,spec}.md`. Captures the
> execution semantics worked out for the loader's implicit loop and generalized
> to an event model. Written to be read by humans (prose) AND used as the
> contract (the boxed signatures are normative).

## 1. Principle: one semantics, two faithful lowerings

The **node graph + `triggerEvent`** is the *source language* — it defines *what
happens*. It is realized two ways:

- **Interpreted** (**PHP backend** — the workflow engine is PHP, like agent
  workflows' `GraphWorkflowRunner`): a live **event router** over the graph that
  runs each node in PHP — for authoring, stepping, and seeing real `docs`/`chunks`.
  *(Supersedes the earlier dual‑mode‑overview design that ran the loader/splitter
  in the browser via Pyodide; interpretation is server‑side PHP. The pure‑Python
  `ingestion_loader.py` is the compiler‑side artifact, not the interpreter.)*
- **Compiled**: the PHP compiler lowers the same semantics to a portable
  **standalone Python script** (langchain splitter + UniversalFS loader +
  qdrant‑store MCP, parallelized with `ProcessPoolExecutor`). Design:
  **`2026-06-19-ingestion-python-compiler.md`**.

> **Build order (user):** the **interpreter (PHP) is built first**; the compiler
> follows once the interpreter works. So `IngestionLoader.php` (PHP, the
> interpreter's loader) leads; the emitted‑Python loader catches up later.

**The discipline that makes it trustworthy:** *compiled must be a faithful
lowering of interpreted* — what you watch run is what the exported `.py` does. So
every node feature is specified once at the semantic level, then checked to lower
cleanly to **both** targets. If they disagree, that is the bug. (This is the same
rule already behind the per‑node "Generated code" chunks and `Output = Input +
Generated`.)

## 2. Substrate: the node map (already exists)

The editor's Drawflow graph is a node registry + edge list:
```
editor.drawflow.drawflow.Home.data[nodeId] = {
  id, name, data: { node_type, config },
  inputs:  { input_1:  { connections: [{ node: '<srcId>',  input: 'output_1' }] } },
  outputs: { output_1: { connections: [{ node: '<destId>', output: 'input_1' }] } },
}
```
Nodes are **addressable by id**; edges are **explicit**. The backend mirrors it
(`workflow_nodes` + `workflow_edges`). That is all the routing substrate needed.

## 3. The primitive

```
node.triggerEvent(destNodeId, payload)
```
A node emits an event to a destination node with a payload. A single‑consumer
**event router** sits over the node map:
- `triggerEvent(dest, payload)` → look up `dest` → call `dest.onEvent(payload, fromId)`.
- `dest` is either the node's **graph‑connected** output(s) (forward, the common
  case) or an **explicit id** (loops / bridges).

| Pattern | Edge |
|---|---|
| Forward flow | loader → splitter → store |
| **Loop** | store → **loader** (`triggerEvent(loaderId, {type:'next'})`) |
| Bridge | any node → any non‑adjacent node |
| Inter‑workflow (future) | address `workflowId:nodeId`; a global router + permission boundary |

## 4. The loader = stateful iterator

The loader OWNS the "am I done?" state — it is the enumerator.

```
loader.onEvent({type:'next'}):
  if not enumerated:                       # first stimulate (from ▶ Play)
     files  = enumerate(source)            # single file → [file];
                                           # folder → RECURSIVE walk (descend EVERY
                                           # nested subfolder, any depth), type-filtered
     cursor = 0                            # (or hold a lazy recursive iterator for huge trees)
  if cursor < len(files):
     text = load_for(files[cursor])        # type detected by extension; file kept
                                           # only if its type ∈ checked File types
     triggerEvent(splitterId, { text, source: files[cursor] })
     cursor += 1
  else:
     pass                                  # IGNORE — exhausted → emit nothing
```

## 5. The loop: the store clocks the loader

- **▶ Play** → `triggerEvent(loaderId, {next})` — kickoff. *(Built — CLOSED loop:
  the Start node's ▶ opens an SSE run `POST .../ingestion/run-stream`. The BACKEND
  enumerates the source ONCE (loader = stateful iterator) and loops
  loader→split→store itself; the store's per‑file completion IS the clock that
  advances the loader (true backpressure, no browser cursor, no re‑enumeration).
  The frontend just reflects the streamed events — node glow + per‑file logs. The
  earlier frontend cursor loop (`loader-text`/`splitter-chunks`/`store-chunks` per
  round) is retired for ▶ Start but those per‑round endpoints still power the
  per‑node Output stepper.)*
- **Store/embeddings**, *on completion* → `triggerEvent(loaderId, {next})` — same
  action Play took.

So the **store's done‑event is the clock**: the loader physically cannot advance
until the store finishes the current file ⇒ **one file at a time, fully to the
end**, with no queue/backpressure machinery. The splitter and store stay "dumb" —
they just process the current payload; they don't know they're in a loop.

## 6. Termination: silence

When the loader's enumeration is exhausted it **ignores** the `next` event (§4
`else: pass`). Nothing more is emitted ⇒ the event queue drains ⇒ **run complete**
(light everything green, "N files processed").

- **Compiled:** the `for` loop's iterator exhausts ⇒ the loop simply ends. Same
  rule: *absence of more work = done.*
- **Errors are EXPLICIT, never silent:** a failing node emits an error
  (red / halt), so "quiet because finished" is never confused with "quiet because
  something broke." Intentional silence = success; failure announces itself.

## 7. The two lowerings, concretely

**Interpreted (PHP backend):** the event router *is* the engine — a
single‑consumer queue with sequential dispatch (which *is* the backpressure),
running in the PHP workflow engine. Node handlers run in PHP: the loader is
`IngestionLoader` (enumerate via UniversalFS MCP `list_files`, read via
`read_file` with `encoding:base64` so binary PDFs/DOCX survive JSON transport,
decode to text), the splitter chunks, and the store writes via `VectorMcpStore`
over a **session‑based** vector‑DB MCP call (`openMcpSession` once →
`callMcpTool` per chunk; see §8); on the store's completion it
`triggerEvent(loaderId, {next})`. The loader holds `{files, cursor}`.

> **Built node‑by‑node (loader first).** The loader node runs today via
> `IngestionLoader::readRound(...,$cursor)` behind `POST
> .../ingestion/loader-text {config,cursor}` — **one round = one file's text**
> (enumerate, then read+decode `files[cursor]`). The loader's Output tab shows
> that one file's text and steps the cursor (Prev / Next file ▶), exactly the
> per‑round shape the store‑clocked loop will drive automatically. **Fan‑out is
> NOT the loader's concern:** the loader is a pure producer of `{text, source}`
> items; routing each item to one‑or‑many next nodes (V2 round‑robin across
> several connected splitters) lives in the *event router that consumes* them, so
> adding it needs zero loader changes.

**Compiled (standalone Python):** a linear+loop graph collapses to:
```python
for path in root.rglob('*'):                    # RECURSIVE enumeration (all subfolders)
    if not path.is_file() or not matches(path):  # keep if detected type ∈ checked
                                                 # File types (empty set = all supported)
        continue
    docs   = load_for(path)                      # Auto: by ext; explicit: forced
    chunks = splitter.split_documents(docs)
    store(chunks, metadata={"source": str(path)})  # full path; blocks; next file only after
```
Arbitrary event graphs (bridges, fan‑in, inter‑workflow) would lower to a
generated **event‑driven harness** — a later step; **v1 compile = this loop.**

## 8. Loader node — form + behavior (current)

- **Logs tab:** every interpreted node (loader/splitter/store) has a **Logs**
  tab. Each node endpoint returns a `logs: string[]` of **tag‑prefixed** lines
  (`[loader] …`, `[splitter] …`, `[store] …`); the frontend routes each line to
  the matching node's per‑type buffer, so a node's Logs show its own activity
  AND its upstream stages. Populated by per‑round runs and by ▶ Start; timestamped;
  Clear button.
- **Tabs:** the loader is interpreted, so its modal has only **Config** and
  **Output** — the compiler‑oriented **Input** and **Generated code** tabs are
  dropped (they're irrelevant when there's no emitted code to show). **Output =
  the file CONTENT extracted to text** (what the splitter receives), not Python.
  The Output is **per round**: it shows ONE file's text at a time with a
  **Prev / Next file ▶** stepper ("File k of N"), refreshed each round — matching
  the live loop where the store clocks the loader one file at a time. Splitter /
  vectorstore keeps the four‑tab compiler view for now.
- The **splitter** is likewise interpreted: Config + Output, where Output is
  per‑round and shows that file's **chunks** (`POST .../ingestion/splitter-chunks
  {loader, splitter, cursor}` reads the upstream loader's text for the file and
  chunks it via the PHP `IngestionSplitter` — a langchain‑parity port of the
  vendored recursive splitter). Same Prev/Next file stepper as the loader.
- The **store** node is interpreted too: Config + Output, but its Output is a
  SAFE **preview** (no write — "N chunks → collection Y on server mcp:id"); the
  actual write happens only on ▶ Start. `POST .../ingestion/store-chunks
  {loader, splitter, vectorstore, cursor}` runs loader→split→**write each chunk**
  to the chosen vector‑DB MCP via `VectorMcpStore` (`qdrant-store {information,
  metadata:{source}, collection_name?}`, server self‑embeds). The store node
  **targets the selected server by id** (`store:"mcp:<id>"` → direct JSON‑RPC to
  that server's URL), NOT whichever server happens to own the tool. ▶ Start now
  drives loader→splitter→store per round.
  - **Vector‑DB MCP transport = session‑based** (Streamable HTTP). A write is
    NOT a bare `tools/call`: it's **initialize (capture the `Mcp-Session-Id`
    response header) → notifications/initialized → tools/call** carrying that
    session — both the Qdrant double and the PHP server require it. (UniversalFS,
    used by the loader, is stateless and needs no session.) Tool‑level failures
    arrive as `result.isError`, NOT a JSON‑RPC `error` — handled as an error.
  - **One session per run (perf).** `callMcpServer` is split into
    `openMcpSession()` (handshake once → reusable session headers) + `callMcpTool()`
    (one call on the open session). The run‑stream opens the session **once** and
    every chunk write across every file reuses it; per‑node store opens one per
    file. Cost drops from **3 round‑trips per chunk → N+2 for N chunks** — small
    on localhost, ~2.5–3× on a latency‑bound remote server, and the basis for the
    `curl_multi` parallel store in the fan‑out spec.
  - **`qdrant-store`/`qdrant-find` contract quirk (the local double):** accepts
    ONLY documented args — the double rejects `collection_name`/`limit` (its
    collection is fixed by the `COLLECTION_NAME` env). So we send
    `collection_name` **only when the user set a Collection** (blank for the
    double; the PHP/cloud server takes it).
- **2‑column form:** row 1 = File storage (UFS MCP) | Disable execution; row 2 =
  File types (checkbox filter) | Provider (vertical radios); UniversalFS key box +
  Source picker full‑width below.
- **File storage** = a registered file‑storage MCP (UniversalFS), filtered from
  the MCP registry by description (`_isFileStorageMcpServer`).
- **Provider** = UFS providers (`local/gdrive/s3/onedrive`) via `list_providers`;
  providers not currently available are marked "(needs key)" and reveal a
  conditional `ufs_…` key box.
- **File types** = a **checkbox filter**, one box per format (PDF / Word / Text /
  CSV). The document type is ALWAYS detected from the extension; the checkboxes
  decide **which detected types are kept**. The checked set is the allow‑list:
  - **a file is processed iff its detected type ∈ the checked set;**
  - **empty set ⇒ no restriction** — every supported type is kept (so a fresh
    node, and graphs saved before this field existed, ingest everything);
  - applies uniformly to a folder (keep matching files) and a single file
    (skipped if its type isn't checked / unsupported);
  - ext map: `pdf→pdf, docx/doc→word, txt→text, csv→csv, html/htm→html`;
    unsupported always skipped. Config key: `types: string[]` (was the single
    `source` string). HTML decodes via html→markdown (keeps headings/links).
  - There is no separate "Auto" — detection is always on; the filter only
    restricts. (Saved `source:'auto'` migrates to `types:[]`; `source:'pdf'` to
    `types:['pdf']`.)
- **Source** = a single file (1‑item iteration) or a folder — **recursively** walk
  the folder and ALL nested subfolders (any depth), iterating the filtered files;
  skip symlink cycles and cap absurd depth. **Per‑file provenance:** the full
  (relative) path is carried into the store's `metadata`, so identically‑named
  files in different subfolders (`a/x.pdf` vs `b/x.pdf`) stay distinct.
  - **Picking the source = browse THROUGH UniversalFS**, not the browser's local
    file system. "Browse storage…" calls `list_files(provider, path)` and shows a
    navigable list (Up · folders to descend · files); **"✓ Use this folder"**
    picks the current folder, clicking a file picks that file. Only the PATH is
    captured (UniversalFS does the reading), so it works for any provider and any
    absolute path — the OS file picker (forces a file, can't supply provider
    paths) is gone. The path is still free‑typable.

## 9. Open / future

- **Fan‑out (N parallel branches):** loader → several `splitter→store` chains,
  each clocked by a **thread id** carried in the event payload (store emits
  `{next, threadId}`; loader keeps a `threadId → connection` map and dispatches
  the next file to the lane that's free — work‑stealing, not static round‑robin).
  The single‑branch loop above is the N = 1 case. Full design:
  **`2026-06-19-ingestion-fanout-threadid.md`**.
- **Inter‑workflow events:** global node addressing (`wf:node`), a cross‑workflow
  router, and a permission/security boundary. Designed later; loop/bridge cases
  work within one graph's node map today.
- **Compiled harness** for non‑linear event graphs.
- **Per‑file error policy:** halt (default) vs. skip‑and‑continue (later option).
