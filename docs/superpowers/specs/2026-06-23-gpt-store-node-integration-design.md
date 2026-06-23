# gpt store-node integration — wire the store node to the vector-store MCP (design)

- **Date:** 2026-06-23
- **Status:** Approved direction; spec for implementation.
- **Branch context:** gpt `feat/rag-ingestion-full`.
- **Depends on:** the vector-store MCP (`htdocs/mcp_qrant/`, Phase 1 shipped) —
  spec `docs/superpowers/specs/2026-06-23-vector-store-mcp-design.md`.

## 1. Summary

Wire the gpt workflow-editor **store node** (and its backend `VectorMcpStore` +
`IngestionController` paths) to the new Python **`mcp_qrant`** vector-store MCP's
**unified `store`/`find`** tools. This is the **store-side twin of the langfs loader
integration**: the store node becomes dynamic — provider list, connection form, and
(when applicable) embeddings list are discovered from the server via
`list_providers` / `list_embeddings` / `connection_schema`, instead of the current
hardcoded fields.

**Hard cut.** The old per-DB path (`qdrant-store` / `qdrant-find`) is **removed**, not
kept behind a compatibility alias. The store node stops talking to the old PHP /
`~/qdrant-mcp` servers and drives `mcp_qrant` exclusively.

## 2. Motivation

The store node today sends `{store: "mcp:<id>", embeddings (free-text, unused),
collection}` and `VectorMcpStore` calls `qdrant-store` once per chunk (args
`{information, collection_name, metadata, model}`) and `qdrant-find` returning XML.
That path is bound to a single self-embedding Qdrant server and a free-text
embeddings field that nothing consumes. The new `mcp_qrant` MCP exposes one
provider-agnostic interface (`store`/`find` with `provider`+`connection`+`items`),
so the store node can gain the same "pick any backend, configured dynamically"
freedom the loader now has, and the dead embeddings field is replaced by a real,
discovered list (used only when a provider needs external embedding).

## 3. Scope

### In scope
- Frontend store node rendered dynamically (mirrors the loader): vector-store MCP
  server discovery + `list_providers` (gated on `available`), connection form from
  `connection_schema`, embeddings dropdown from `list_embeddings` (shown only when
  `embeds_internally:false`), and a **Test connection** button (`test_connection`).
- Backend `VectorMcpStore` rewritten to the unified `store`/`find` contract.
- `IngestionController` store paths (`storeChunks`, `runStream`, `runWorker`,
  `storeFind`) pass `provider`/`connection`/`embedding`/`collection` through.
- Removal of the `qdrant-store`/`qdrant-find` tool calls and the XML find-parser.
- Shared frontend helper for the `/mcp/proxy` call + defensive MCP-result parsing,
  factored out of the loader so both nodes use it (no parallel copy).

### Out of scope (later, own cycles)
- **pgvector activation** + actually exercising the embeddings dropdown (Phase 2 of
  the mcp_qrant project; in Phase 1 only Qdrant is active and it self-embeds, so the
  dropdown is built but never shown).
- Remote-Qdrant connection UX polish.
- Retiring the old PHP (`htdocs/vector/`) / `~/qdrant-mcp` servers from the MCP
  catalog once nothing points at them.
- Any "server kind/type" column on `mcp_servers` (name heuristic is reused).

## 4. Architecture & data flow

Per file, inside the existing `loader → splitter → store` stream (store-clocks-loader):

```
store node config        IngestionController            VectorMcpStore.store()         mcp_qrant `store`
{ store: "mcp:<id>",  ─►  resolve server URL+headers ─►  build ONE call:           ─►   {provider, connection,
  provider: "qdrant",      open MCP session (once)         {provider, connection,         collection,
  connection: {…},                                          collection,                   items:[{text,metadata}]}
  embedding: ""|null,                                       items:[{text,metadata}],  ◄─   → {stored, errors}
  collection: "…" }                                         embedding}
```

The `mcp:<id>` → server URL/headers resolution and `openMcpSession` are unchanged.
Secrets in `connection` (e.g. `api_key`) ride per request to the MCP and are never
logged — same posture as the loader closures (LAN-only; see the ingestion LAN-only
constraint).

## 5. Contract mapping (old → new)

| | Old (`qdrant-store` / `qdrant-find`) | New (`store` / `find`) |
|---|---|---|
| Store granularity | one call per chunk | **one call per file** — all chunks as `items[]` |
| Store args | `{information, collection_name, metadata, model}` | `{provider, connection, collection, items:[{text,metadata}], embedding?}` |
| Store result | per-chunk | `{stored, errors}` (+ `collection` echoed back) |
| Find call | `qdrant-find` | `find` |
| Find args | `{query, collection_name?}` | `{provider, connection, collection, query, limit?, embedding?}` |
| Find result | XML parsed to `[{content,source,score?}]` | JSON `{results:[{text,metadata,score}]}` |

The per-chunk fan-out (`storeParallel` + `storeArgs`) collapses into a single batch
`store` call per file; the new MCP batches `items` internally and reports
`{stored, errors}`.

## 6. Frontend — store node (mirror the loader)

Replaces the three static fields (`Vector DB` select, free-text `Embeddings`,
`Collection`) with the loader's dynamic pattern.

1. **Server + provider.** Discover vector-store MCP servers from
   `window.mcpClient.servers` via a new `_isVectorStoreMcpServer(server)` heuristic
   (name/description/URL matches `/vector|qdrant|qdant/i` plus the new server's
   name). Auto-resolve one (saved choice → name match → first vector server), store
   its id in a hidden input. Then call `list_providers` on it via `/mcp/proxy` and
   render providers gated on `available` (Qdrant active; the other 9 greyed),
   reusing the loader's `renderProviders` 2-column-grid pattern + CSS.
2. **Connection form — rendered from the chosen provider's `connection_schema`.**
   Each field `{name,label,type,required,mask}` → an input; `type:"password"` or
   `mask:true` → a password input. Qdrant: `mode` + (`path` | `url`+`api_key`).
3. **Embeddings dropdown — from `list_embeddings`, shown only when the chosen
   provider has `embeds_internally:false`.** Hidden for Qdrant (self-embeds). The
   selected `id` becomes config `embedding`. Replaces the old free-text field.
4. **Collection** — free-text, unchanged.
5. **Test connection button** — calls `test_connection` via `/mcp/proxy` with the
   entered `provider`+`connection`; renders ok/error inline; never blocks editing.

**Reuse:** factor the loader's `/mcp/proxy` invocation + defensive MCP-result
parsing (`_parseListProviders` and the content-framing handling) into a shared
helper both nodes call. Do not duplicate.

**Saved config** (vectorstore case of the config read/save functions):
```js
{ store: "mcp:<id>", provider: "qdrant", connection: {…}, embedding: "", collection: "", disabled }
```
`provider` and `connection` are new; `embedding` (selected list id, or empty when
the provider self-embeds) replaces the old `embeddings` free-text key.

## 7. Backend — `VectorMcpStore` rewrite

Dispatch-callable injection (`fn(int $serverId, string $tool, array $args): array`)
is unchanged; only tool names and arg shapes change.

- **`store(int $serverId, array $chunks, array $cfg): array`** — builds **one**
  `store` call: `{provider, connection, collection, items: [{text, metadata}],
  embedding}`. `items` = all non-blank chunks; each chunk's `metadata` carries
  `source` = filename (as today). Returns `{stored, errors, collection}` mapped from
  the MCP result.
- **`find(int $serverId, array $cfg): array`** — calls `find` with `{provider,
  connection, collection, query, limit, embedding}`; parses JSON
  `{results:[{text,metadata,score}]}`.
- **Removed:** `storeParallel`, `storeArgs`, and the `qdrant-find` XML parser.

`$cfg` carries `provider`, `connection`, `collection`, `embedding` (and `metadata`
base for `source`).

## 8. Backend — `IngestionController`

`storeChunks`, `runStream`, `runWorker`, `storeFind` stop hardcoding
`qdrant-store`/`qdrant-find`. They read `provider`, `connection`, `embedding`,
`collection` from the store node config and pass them into `VectorMcpStore`. The
`mcp:<id>` regex resolution, `mcp_servers` URL/headers lookup, and single
`openMcpSession` per run remain. A blank `embedding` is sent as null/omitted (Qdrant
self-embeds).

## 9. Error handling

- A `store` result with `errors > 0` surfaces `{stored, errors}` on the file's SSE
  event (partial-file failures stay visible, like today's per-file reporting).
- A hard MCP/transport error throws and is reported on that file's event; the run
  continues to the next file per existing stream semantics.
- `test_connection` failures render inline in the node form and never block editing.
- Secrets are never written to logs or error messages.

## 10. Testing

- **Backend (PHP):** `VectorMcpStore` unit tests with a fake dispatch — `store`
  builds the correct single-call args (items array, metadata/`source` alignment,
  `embedding` + `connection` + `provider` passed through) and maps `{stored,errors}`;
  `find` parses the JSON results. Update the existing
  `backend/scripts/test-vector-mcp-store.php`.
- **Frontend (live):** store node renders Qdrant from `list_providers`, the
  connection form from `connection_schema`, embeddings dropdown hidden for Qdrant;
  Test connection round-trips good/bad.
- **End-to-end:** langfs loader → splitter → `mcp_qrant store` (Qdrant local) →
  `find` retrieves the stored chunks. Reuses the running `mcp_qrant` (:8008) + a
  local Qdrant. This is the acceptance test.

## 11. Setup note (not code)

The `mcp_qrant` server must be registered once in gpt's `mcp_servers` catalog by URL
(e.g. `http://127.0.0.1:8008/mcp`) with a name the `_isVectorStoreMcpServer`
heuristic matches (e.g. contains `vector` or `qdrant`), so the store node
auto-resolves it.

## 12. Open items

- Default `limit` for the `find` retrieval test (pick a sensible constant in the
  plan, e.g. 5).
- Whether the connection form pre-fills a default Qdrant `path` or leaves it to the
  user (decide in the plan; Phase-1 local Qdrant needs a host-side path).
