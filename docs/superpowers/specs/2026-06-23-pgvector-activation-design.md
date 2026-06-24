# pgvector activation (vector-store MCP Phase 2) — design

- **Date:** 2026-06-23
- **Status:** Approved direction; spec for implementation.
- **Location:** `/Applications/XAMPP/xamppfiles/htdocs/mcp_qrant/` (its own repo).
- **Builds on:** the vector-store MCP Phase 1 (Qdrant active) — spec
  `gpt/docs/superpowers/specs/2026-06-23-vector-store-mcp-design.md`; and the gpt
  store-node integration — spec `…/2026-06-23-gpt-store-node-integration-design.md`.

## 1. Summary

Activate **pgvector** as a second functional vector-store provider in `mcp_qrant`,
mirroring how Qdrant was activated — a new provider class behind the same
`VectorStoreProvider` protocol — plus the one thing Qdrant didn't need: an
**embedding factory**. Unlike Qdrant (`embeds_internally: true`, self-embeds),
pgvector has `embeds_internally: false`, so the MCP computes embeddings in-process
before storing. Phase 2 wires **OpenAI online embeddings** (`text-embedding-3-small`
default, `-large` selectable) via `langchain_openai`, and stores/queries through
`langchain_postgres.PGVector`.

## 2. Motivation

pgvector is the second provider the store node offers (descriptor already present,
`available: false`). Activating it proves the `embeds_internally: false` path end to
end — the embedding factory, the embeddings dropdown the store node already renders
(gated on `embeds_internally: false`), and a non-self-embedding LangChain vector
store — against a real local Postgres. The user runs Postgres + pgvector locally.

## 3. Scope

### In scope
- `stores/pgvector.py` — `PgVectorProvider` (`embeds_internally = False`) using
  `langchain_postgres.PGVector` for `connect`/`test_connection`/`store`/`find`.
- `embedding.py` — the **factory** `make_embeddings(id) -> Embeddings`, wiring the
  **OpenAI** ids via `langchain_openai.OpenAIEmbeddings` keyed from
  `MCPQ_OPENAI_API_KEY`.
- `providers/pgvector.json` → `available: true`; dsn falls back to
  `MCPQ_PGVECTOR_DSN` env (node Connection box optional/override).
- `stores/registry.py` → add `pgvector` to `_IMPL`.
- Deps: `langchain-postgres`, `psycopg[binary]`, `langchain-openai`.

### Out of scope (later)
- Wiring the **local** embedders (fastembed / HuggingFace) — they stay in the
  catalog but `make_embeddings` raises a clear "not wired in Phase 2" error if picked.
- **Per-node** OpenAI key (Phase 2 uses server env `MCPQ_OPENAI_API_KEY`).
- Remote Qdrant; the 8 long-tail vector DBs.
- gpt UI changes — none needed (the embeddings dropdown + dsn field already exist;
  selecting pgvector flips `embeds_internally:false` and shows them).

## 4. Architecture & components

```
gpt store node ──store/find {provider:"pgvector", connection:{dsn?}, collection,
                              items|query, embedding:"openai:…"}──▶ mcp_qrant
                                                                      │
                                              PgVectorProvider (embeds_internally=false)
                                                  │ make_embeddings(id) → OpenAIEmbeddings(key=env)
                                                  └ langchain_postgres.PGVector(collection, conn, embeddings)
```

- **`PgVectorProvider`** (`stores/pgvector.py`), implements `VectorStoreProvider`:
  - `connect(connection)` → resolves the dsn (call `connection.dsn`, else
    `MCPQ_PGVECTOR_DSN`); raises `StoreError` if neither. Returns a small handle
    holding the resolved dsn (PGVector instances are built per call, bound to the
    chosen collection + embeddings).
  - `test_connection(connection)` → `{ok: bool, message?}`: validate dsn reachability
    and that the `vector` extension is available; surface a clear message otherwise.
  - `store(conn, collection, items, embedding)` → build `Embeddings` from
    `embedding` (or the server default), build `PGVector(collection_name=collection,
    connection=dsn, embeddings=…)`, `add_texts([i.text], metadatas=[i.metadata])`
    for non-blank items → `{stored, errors}`.
  - `find(conn, collection, query, limit, embedding)` → same PGVector,
    `similarity_search_with_score(query, k=limit)` → `{results:[{text, metadata,
    score}]}` (`text` from `doc.page_content`, `metadata` from `doc.metadata`,
    `score` the returned distance/similarity).
- **`make_embeddings(id) -> Embeddings`** (`embedding.py`): for an `openai:` id,
  return `OpenAIEmbeddings(model=<model>, api_key=os.environ["MCPQ_OPENAI_API_KEY"])`;
  for a `fastembed:`/`hf:` id, raise `StoreError("embedding '<id>' is not wired in
  Phase 2")`; unknown id → `StoreError`. Missing `MCPQ_OPENAI_API_KEY` for an
  openai id → `StoreError("OpenAI key not configured (set MCPQ_OPENAI_API_KEY)")`.

## 5. Data flow

**Store** (per file): connect (dsn from call/env) → `make_embeddings(embedding or
MCPQ_EMBEDDING default)` → `PGVector(...).add_texts(...)` → `{stored, errors}`.

**Find:** connect → embeddings → `similarity_search_with_score(query, k=limit)` →
`{results:[{text, metadata, score}]}` — the same shape Qdrant returns, so the gpt
Search panel is unchanged.

## 6. Config & defaults (server-owned, like Qdrant)

- **`MCPQ_PGVECTOR_DSN`** — Postgres DSN used when the call omits `connection.dsn`.
- **`MCPQ_OPENAI_API_KEY`** — OpenAI key for the embedding factory.
- **`MCPQ_EMBEDDING`** — default embedding id when the call omits `embedding`
  (built-in fallback `openai:text-embedding-3-small`). Mirrors the
  `MCPQ_COLLECTION` collection default.
- A call value always overrides the env default.

## 7. The same-model invariant

A pgvector collection stores **fixed-dimension** vectors, so it must be stored and
queried with the **same model** (`text-embedding-3-small` = 1536, `-large` = 3072).
The store node carries one `embedding` value and the Search tab reads that same node
config, so store and find use the same model by construction unless the user changes
the model on an already-populated collection. A real mismatch raises in
PGVector/Postgres and surfaces as a clear `[store]`/`[search] ERROR` (the
VectorMcpStore error-handling fix guarantees no silent 0).

## 8. Error handling

- Missing dsn → `StoreError` "no Postgres DSN (connection.dsn or MCPQ_PGVECTOR_DSN)".
- Missing `MCPQ_OPENAI_API_KEY` (for an openai model) → `StoreError`, before any write.
- Unwired model id (fastembed/hf) → `StoreError` "not wired in Phase 2".
- pgvector extension missing / DB unreachable → `test_connection` returns
  `{ok:false, message}`; a store/find hits the handler's `store_failed`/`find_failed`.
- All ride the existing envelope (`{error:true,code,message}` inside `content[0].text`).

## 9. Testing

- **Unit** (mock `langchain_postgres.PGVector`, no live DB): `store` builds embeddings
  from the id, calls `add_texts(texts, metadatas)`, skips blank items, returns
  `{stored, errors}`; `find` calls `similarity_search_with_score` and maps
  `{text, metadata, score}`. Factory: `make_embeddings("openai:text-embedding-3-small")`
  returns an `OpenAIEmbeddings` configured from env; unwired id raises; missing key
  raises. dsn fallback (call → env) tested like Qdrant's path fallback.
- **Live acceptance** (local Postgres + pgvector + an OpenAI key): set
  `MCPQ_PGVECTOR_DSN` + `MCPQ_OPENAI_API_KEY`, store a few chunks, `find` retrieves
  them by similarity. Mirrors the Qdrant store/find smoke.
- **gpt end-to-end:** select pgvector in the store node → embeddings dropdown
  (default `text-embedding-3-small`) + dsn field appear; run loader→split→store;
  Search returns matches from Postgres.

## 10. Setup notes (operational, not code)

- The target Postgres DB needs `CREATE EXTENSION IF NOT EXISTS vector;`.
- `langchain_postgres` expects a `postgresql+psycopg://…` style connection string;
  `test_connection` surfaces a clear error on a malformed/unreachable dsn.
- `run.sh` gains optional `MCPQ_PGVECTOR_DSN` / `MCPQ_OPENAI_API_KEY` / `MCPQ_EMBEDDING`
  passthrough so the server can own pgvector's config like it owns Qdrant's.
