# Vector-store MCP — LangChain vector-DB providers behind one MCP (design)

- **Date:** 2026-06-23
- **Status:** Approved direction; spec for implementation.
- **Location:** `/Applications/XAMPP/xamppfiles/htdocs/mcp_qrant/` (replaces the PHP server there).
- **Branch context:** gpt `feat/rag-ingestion-full`; the MCP is its own project on its own repo (like langfs).

## 1. Summary

A standalone **Python + LangChain MCP server** that wraps LangChain's **vector-store
integrations** behind one unified MCP interface — the **store-side twin of
langfs**. Where langfs wraps LangChain *blob loaders* so the loader node can pick
any source, this wraps LangChain *vector stores* (`QdrantVectorStore`, `PGVector`,
…) so the **Vector store node can pick any vector DB**.

It **replaces the PHP `mcp_qrant/`** and **supersedes the `~/qdrant-mcp` local
double** — one MCP, many vector-DB providers, selected/configured dynamically from
the store node exactly like the loader's provider list.

Launch shape (mirrors the loader's "10 listed, gray except active"):
- The **~10 most popular** LangChain vector DBs are **listed**, all **disabled
  (grey, "coming soon")** except the active one.
- **Qdrant** is the single active entry (local first). **pgvector** is the next to
  activate. The other eight are placeholders.

## 2. Motivation

The store path currently targets a per-DB MCP (`qdrant-store`/`qdrant-find` on a
registered Qdrant MCP, which self-embeds). pgvector is dormant (download-only
codegen + an unused `ingestion.py`). Two separate Qdrant MCPs (PHP cloud +
`~/qdrant-mcp` local double) do the same job differently. Unifying onto LangChain's
vector-store catalog gives the store node the same "pick any backend" freedom the
loader now has, retires the duplicate Qdrant servers, and makes pgvector (and the
rest of LangChain's vector DBs) reachable through one interface.

## 3. Scope

### In scope (Phase 1)
- Standalone Python/LangChain MCP at `mcp_qrant/` (replacing the PHP code).
- MCP streamable-HTTP transport (mirrors langfs: handler at `/` **and** `/mcp`).
- Tools: `list_providers`, `list_embeddings`, `test_connection`, `store`, `find`.
- **Provider descriptors** (JSON, one per vector DB) — the 10 popular DBs, each
  with `available` and `embeds_internally` flags + a connection schema.
- **Qdrant provider functional end-to-end** (local), self-embedding.
- The other 9 providers **listed but disabled** (descriptor-only).

### Out of scope (later phases — designed-for, not built)
- **pgvector activation** (Phase 2): needs the MCP to compute embeddings itself
  (§8) — including choosing the embedding model, deferred to that phase.
- **Remote Qdrant** branch (same single "Qdrant" entry, different connection).
- The remaining 8 vector DBs (Chroma, Pinecone, Milvus, Weaviate, FAISS, Redis,
  Elasticsearch, MongoDB Atlas).
- **gpt store-node + backend integration** (dynamic provider form; `VectorMcpStore`
  → unified `store`/`find`) — its own spec→plan cycle (§10), like the langfs gpt
  integration.

## 4. Architecture

```
gpt store node ──MCP (store/find/list_providers/test_connection)──▶ vector-store MCP (mcp_qrant/)
                                                                       │
                                                   provider registry (descriptors)
                                                       │            │            │
                                              QdrantVectorStore   PGVector     …8 more
                                              (self-embeds)       (we embed)   (descriptor-only)
```

Layered like langfs (one job per unit):
```
mcp_qrant/
  server.py            # FastAPI + MCP JSON-RPC routing (/ and /mcp); thin glue
  providers/*.json     # one descriptor per vector DB (qdrant, pgvector, + 8)
  descriptors.py       # descriptor model + loader/validate (reuse langfs's pattern)
  stores/
    base.py            # VectorStoreProvider protocol: connect/test/store/find
    qdrant.py          # QdrantProvider (local now; remote = a connection variant)
    pgvector.py        # PgVectorProvider (Phase 2)
    registry.py        # build registry from descriptors; providers_payload
  embedding.py         # embedder factory (only used by providers that don't self-embed)
  config.py, tests/
```

## 5. Provider catalog (surfaced by `list_providers`)

| Provider | LangChain vector store | `embeds_internally` | Phase |
|---|---|---|---|
| **Qdrant** | `langchain_qdrant.QdrantVectorStore` / qdrant FastEmbed | **true** | 1 ✅ (local) |
| **pgvector** | `langchain_postgres.PGVector` | **false** | 2 |
| Chroma | `langchain_chroma.Chroma` | false | later |
| Pinecone | `langchain_pinecone.PineconeVectorStore` | false | later |
| Milvus | `langchain_milvus.Milvus` | false | later |
| Weaviate | `langchain_weaviate.WeaviateVectorStore` | false | later |
| FAISS | `langchain_community…FAISS` | false | later |
| Redis | `langchain_redis.RedisVectorStore` | false | later |
| Elasticsearch | `langchain_elasticsearch…` | false | later |
| MongoDB Atlas | `langchain_mongodb…` | false | later |

**Qdrant is one entry** — local now; the remote/cloud branch is a *connection
variant* of the same provider, not a second row.

## 6. Provider descriptor (`providers/*.json`)

One JSON per provider, schema-validated at startup (reuse langfs's descriptor
machinery). Fields:
- **Identity:** `name`, `label`, `description`.
- **`available`:** `true` only when the provider has a working implementation +
  its package is installed (Qdrant now; pgvector when Phase 2 ships; others false).
- **`embeds_internally`:** `true` → the DB embeds (send text); `false` → the MCP
  computes the embedding before storing (§8).
- **`connection_schema`:** the fields the store node collects to reach this DB —
  e.g. Qdrant `{mode: local|remote, path|url, api_key?}`; pgvector `{dsn}`. Each
  field `{name, label, type, required, mask?}`, exactly like langfs credential
  fields, so the store node renders the connection form dynamically.

## 7. Tool contract

MCP tools, results wrapped in the same `{"content":[{"type":"text","text": json}]}`
envelope gpt expects. Errors → `{"error":true,"code"?,"message"}`.

- **`list_providers()`** → `{"providers":[{name,label,description,available,
  embeds_internally,connection_schema}]}` — drives the store node's dynamic form.
- **`list_embeddings()`** → `{"embeddings":[{id,label,provider,dimensions,
  requires_credentials}]}` — the embedding models the store node may offer the user
  (e.g. `openai:text-embedding-3-small` 1536, `hf:all-MiniLM-L6-v2` 384,
  `fastembed:bge-small-en-v1.5` 384). The store node shows this as a **dropdown only
  when the chosen provider has `embeds_internally: false`** (Qdrant self-embeds, so
  it's hidden there). `requires_credentials` lets the UI flag models that need a key
  (e.g. OpenAI). The chosen `id` is what gets passed as `embedding` to `store`/`find`.
- **`test_connection(provider, connection)`** → `{"ok":bool,"message"?}` — validate
  before a run (the store node's test affordance).
- **`store(provider, connection, collection, items, embedding?)`** — `items` is a
  list of `{text, metadata}`. For `embeds_internally` providers, text is handed to
  the DB; otherwise the MCP embeds first (§8). Returns `{stored:int, errors:int}`.
- **`find(provider, connection, collection, query, limit?, embedding?)`** →
  `{results:[{text, metadata, score}]}`. Same embed/no-embed split for the query.

(`store`/`find` are stateless per call — connection passed each time, like langfs's
model; an authenticated client may be cached per `(provider, connection)` as a later
optimization.)

## 8. Embedding — per provider

Embedding behavior is **declared per provider**, not global:
- **Qdrant (`embeds_internally: true`):** the MCP sends **text**; Qdrant embeds it
  (FastEmbed locally / Cloud Inference remotely). The MCP computes **no** vectors.
  → **Phase 1 needs no embedding model at all.**
- **pgvector and the rest (`embeds_internally: false`):** the MCP **computes the
  embedding itself**, in-process — `text → vector` via a LangChain `Embeddings` —
  then stores the vector. This is the "we process the embedding ourselves"
  requirement.

The **catalog of selectable models is exposed by `list_embeddings`** (§7) from
Phase 1, so the store node can render the dropdown — but it's only *used* for
`embeds_internally: false` providers. The chosen model `id` is passed as `embedding`
on `store`/`find`, and `embedding.py` instantiates the matching LangChain
`Embeddings`. Since Phase 1's only active provider (Qdrant) self-embeds, **the
actual embedding computation isn't exercised until Phase 2 (pgvector)** — and which
model is the *default* is decided then. **Invariant:** a collection's store and
query must use the same model/dimension.

## 9. Connection handling

Each provider declares its `connection_schema`; the store node renders those fields
and passes the values as `connection` on every `store`/`find`/`test_connection`
call. Qdrant local = `{mode:"local", path}` (or `{mode:"remote", url, api_key}`);
pgvector = `{dsn}`. No credentials are stored in this MCP; they ride per request
(LAN context — same posture as langfs). Secrets are never logged.

## 10. gpt integration (follow-on, its own plan)

Mirrors the langfs gpt integration:
- Store node renders the **provider list from `list_providers`** (10 entries, Qdrant
  active, 8+pgvector greyed) + a **dynamic connection form** from
  `connection_schema`, plus a **Test connection** button. When the chosen provider
  has `embeds_internally: false`, it also shows an **embeddings dropdown populated
  from `list_embeddings`** (hidden for Qdrant). The store node already has an
  `embeddings` free-text field today — this replaces it with the discovered list.
- Backend `VectorMcpStore` / `storeChunks` / `storeFind` call the unified
  **`store`/`find`** (passing provider + connection) instead of the fixed
  `qdrant-store`/`qdrant-find`. (A `qdrant-store`/`qdrant-find` alias MAY be kept on
  the new MCP as a transition aid so the current path keeps working mid-migration.)
- The store node points at the new vector-store MCP server.

## 11. Phasing

- **Phase 1 (this spec):** the MCP + `list_providers`/`test_connection`/`store`/`find`,
  **Qdrant (local) functional**, 9 others listed+disabled, descriptor machinery,
  `embeds_internally` split honored (Qdrant self-embeds; no embedder yet).
- **Phase 2:** pgvector activation (+ the embedder choice + `embedding.py`).
- **Phase 3:** remote-Qdrant connection variant; then the long-tail vector DBs.
- **gpt store-node integration:** parallel follow-on plan (§10).

## 12. Testing

- **Unit:** descriptor load/validate; `providers_payload` returns 10 with correct
  `available`/`embeds_internally`; registry builds only functional providers;
  `QdrantProvider.store/find` against a mocked client; `embeds_internally` routing
  (text-through for Qdrant; embed-then-store stubbed for pgvector).
- **Live (Qdrant):** `store` a few chunks + `find` round-trip against a local Qdrant;
  `test_connection` good/bad.
- **End-to-end (with the gpt integration):** loader (langfs) → splitter → this MCP's
  `store` (Qdrant) → `find` retrieves the chunks.

## 13. Open items

- Whether to keep a `qdrant-store`/`qdrant-find` compatibility alias during the gpt
  migration (decide in the gpt-integration plan).
- pgvector embedder model + where it's configured (Phase 2).
- Qdrant via LangChain `QdrantVectorStore` (needs an `Embeddings`) vs Qdrant's
  FastEmbed/inference path for the self-embedding behavior — confirm the exact
  LangChain Qdrant API that preserves `embeds_internally: true` during Phase-1
  implementation.
