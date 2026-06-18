# Ingestion Execution Model — event‑driven loop + faithful lowerings

> Companion to `2026-06-14-dual-mode-ingestion-{overview,spec}.md`. Captures the
> execution semantics worked out for the loader's implicit loop and generalized
> to an event model. Written to be read by humans (prose) AND used as the
> contract (the boxed signatures are normative).

## 1. Principle: one semantics, two faithful lowerings

The **node graph + `triggerEvent`** is the *source language* — it defines *what
happens*. It is realized two ways:

- **Interpreted** (Pyodide): a live **event router** over the graph — for
  authoring, stepping, and seeing real `docs`/`chunks`.
- **Compiled**: the same semantics lowered to a portable **standalone script**.

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
     files  = enumerate(source)            # single file → [file]; folder → list_files(type-filtered)
     cursor = 0                            # (or hold a lazy directory iterator for huge folders)
  if cursor < len(files):
     text = load_for(files[cursor])        # Auto → loader by extension; explicit → forced
     triggerEvent(splitterId, { text, source: files[cursor] })
     cursor += 1
  else:
     pass                                  # IGNORE — exhausted → emit nothing
```

## 5. The loop: the store clocks the loader

- **▶ Play** → `triggerEvent(loaderId, {next})` — kickoff.
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

**Interpreted (Pyodide):** the event router *is* the engine — a single‑consumer
queue with sequential dispatch (which *is* the backpressure). Node handlers are
the load/split/store cells; the store cell `await`s the `embed-store` pyfetch and,
on resolve, `triggerEvent(loaderId, {next})`. The loader holds `{files, cursor}`.

**Compiled (standalone Python):** a linear+loop graph collapses to:
```python
for path in files:                              # the enumeration (filtered)
    docs   = load_for(path)                      # Auto: by ext; explicit: forced
    chunks = splitter.split_documents(docs)
    store(chunks, metadata={"source": path})     # blocks; next file only after
```
Arbitrary event graphs (bridges, fan‑in, inter‑workflow) would lower to a
generated **event‑driven harness** — a later step; **v1 compile = this loop.**

## 8. Loader node — form + behavior (current)

- **2‑column form:** row 1 = File storage (UFS MCP) | Disable execution; row 2 =
  Document type | Provider (vertical radios); UniversalFS key box + Source picker
  full‑width below.
- **File storage** = a registered file‑storage MCP (UniversalFS), filtered from
  the MCP registry by description (`_isFileStorageMcpServer`).
- **Provider** = UFS providers (`local/gdrive/s3/onedrive`) via `list_providers`;
  providers not currently available are marked "(needs key)" and reveal a
  conditional `ufs_…` key box.
- **Document type** = **Auto** (default — detect the loader per file by extension)
  or an explicit type. Single file in Auto → "(detected: word)" hint; the dropdown
  stays on Auto.
  - **explicit + FOLDER ⇒ extension filter** (only matching files are looped);
  - **Auto + folder ⇒** all supported files, each by its own extension;
  - ext map: `pdf→pdf, docx/doc→word, txt→text, csv→csv`; unsupported skipped.
- **Source** = a single file (1‑item iteration) or a folder (iterate the filtered
  files). **Per‑file provenance:** the filename is carried into the store's
  `metadata` (so retrieved chunks know their source file).

## 9. Open / future

- **Inter‑workflow events:** global node addressing (`wf:node`), a cross‑workflow
  router, and a permission/security boundary. Designed later; loop/bridge cases
  work within one graph's node map today.
- **Compiled harness** for non‑linear event graphs.
- **Per‑file error policy:** halt (default) vs. skip‑and‑continue (later option).
