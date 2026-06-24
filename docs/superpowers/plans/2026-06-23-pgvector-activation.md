# pgvector activation (vector-store MCP Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate pgvector as a second functional provider in `mcp_qrant`, computing OpenAI embeddings in-process and storing/querying through `langchain_postgres.PGVector`.

**Architecture:** Mirror the Qdrant provider behind the same `VectorStoreProvider` protocol, plus an embedding **factory** (Qdrant didn't need one because it self-embeds). `PgVectorProvider` (`embeds_internally=False`) resolves a Postgres DSN, asks `make_embeddings(id)` for an `OpenAIEmbeddings`, and uses `PGVector` for store/find. langchain libs are imported lazily through small helpers so unit tests mock them and `catalog()` works without them.

**Tech Stack:** Python, `langchain_postgres.PGVector`, `langchain_openai.OpenAIEmbeddings`, `psycopg` (v3), Postgres + pgvector, pytest.

**Repo:** `/Applications/XAMPP/xamppfiles/htdocs/mcp_qrant/` (its own git repo on `master`). All paths below are relative to it. **No gpt changes.**

## Global Constraints

- **Provider:** `PgVectorProvider`, `name = "pgvector"`, `embeds_internally = False`.
- **Phase 2 wires OpenAI ids only:** `openai:text-embedding-3-small` → `text-embedding-3-small` (1536), `openai:text-embedding-3-large` → `text-embedding-3-large` (3072). A `fastembed:`/`hf:` id raises `StoreError("embedding '<id>' is not wired in Phase 2")`; any other id raises `StoreError("unknown embedding '<id>'")`.
- **Server-owned config (call value overrides env):** `MCPQ_PGVECTOR_DSN` (dsn fallback), `MCPQ_OPENAI_API_KEY` (factory key), `MCPQ_EMBEDDING` (embedding id fallback, built-in default `openai:text-embedding-3-small`).
- **Exact error messages:** missing dsn → `"pgvector needs a Postgres DSN (connection.dsn or MCPQ_PGVECTOR_DSN)"`; missing key → `"OpenAI key not configured (set MCPQ_OPENAI_API_KEY)"`.
- **Contract (unchanged):** `store(conn, collection, items, embedding) -> {"stored":int,"errors":int}` (skip blank items); `find(conn, collection, query, limit, embedding) -> {"results":[{"text","metadata","score"}]}`.
- **Lazy langchain imports:** `embedding._openai_embeddings(model, key)` and `stores.pgvector._make_store(embeddings, collection, dsn)` do the `import` inside the function, so unit tests monkeypatch the helper and the modules import without the libs installed.
- **DSN format:** `langchain_postgres` needs a psycopg-v3 string, e.g. `postgresql+psycopg://user:pass@localhost:5432/db`.
- Run tests with `.venv/bin/python -m pytest -q` from the repo root; suite must stay pristine.

---

### Task 1: OpenAI embedding factory

**Files:**
- Modify: `embedding.py` (add `make_embeddings` + `_openai_embeddings` + the model map; keep the existing catalog)
- Modify: `requirements.txt` (add `langchain-openai`)
- Test: `tests/test_embedding_factory.py` (create)

**Interfaces:**
- Produces: `make_embeddings(embedding_id: str) -> Embeddings` and the lazy helper `_openai_embeddings(model: str, api_key: str) -> Embeddings`. `PgVectorProvider` (Task 2) consumes `make_embeddings`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_embedding_factory.py`:

```python
import pytest

import embedding
from stores.base import StoreError


def test_make_embeddings_openai_maps_model_and_key(monkeypatch):
    captured = {}

    def fake(model, api_key):
        captured["model"] = model
        captured["key"] = api_key
        return ("EMB", model)

    monkeypatch.setattr(embedding, "_openai_embeddings", fake)
    monkeypatch.setenv("MCPQ_OPENAI_API_KEY", "sk-test")

    out = embedding.make_embeddings("openai:text-embedding-3-small")
    assert out == ("EMB", "text-embedding-3-small")
    assert captured == {"model": "text-embedding-3-small", "key": "sk-test"}


def test_make_embeddings_large_id(monkeypatch):
    monkeypatch.setattr(embedding, "_openai_embeddings", lambda model, api_key: model)
    monkeypatch.setenv("MCPQ_OPENAI_API_KEY", "sk-test")
    assert embedding.make_embeddings("openai:text-embedding-3-large") == "text-embedding-3-large"


def test_make_embeddings_missing_key(monkeypatch):
    monkeypatch.setattr(embedding, "_openai_embeddings", lambda model, api_key: model)
    monkeypatch.delenv("MCPQ_OPENAI_API_KEY", raising=False)
    with pytest.raises(StoreError, match="OpenAI key not configured"):
        embedding.make_embeddings("openai:text-embedding-3-small")


def test_make_embeddings_local_not_wired():
    with pytest.raises(StoreError, match="not wired in Phase 2"):
        embedding.make_embeddings("fastembed:bge-small-en-v1.5")
    with pytest.raises(StoreError, match="not wired in Phase 2"):
        embedding.make_embeddings("hf:all-MiniLM-L6-v2")


def test_make_embeddings_unknown():
    with pytest.raises(StoreError, match="unknown embedding"):
        embedding.make_embeddings("nope:whatever")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_embedding_factory.py -q`
Expected: FAIL — `embedding` has no attribute `make_embeddings` / `_openai_embeddings`.

- [ ] **Step 3: Implement the factory**

Append to `embedding.py` (after the existing `catalog()`):

```python
import os

from stores.base import StoreError

_OPENAI_MODELS = {
    "openai:text-embedding-3-small": "text-embedding-3-small",
    "openai:text-embedding-3-large": "text-embedding-3-large",
}


def _openai_embeddings(model: str, api_key: str):
    # Lazy import so catalog() works without langchain_openai installed, and so
    # unit tests can monkeypatch this helper.
    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(model=model, api_key=api_key)


def make_embeddings(embedding_id: str):
    """Build a LangChain Embeddings for a catalog id. Phase 2 wires the OpenAI
    ids; the local ids (fastembed/hf) stay listed but are not wired yet."""
    if embedding_id in _OPENAI_MODELS:
        key = os.environ.get("MCPQ_OPENAI_API_KEY")
        if not key:
            raise StoreError("OpenAI key not configured (set MCPQ_OPENAI_API_KEY)")
        return _openai_embeddings(_OPENAI_MODELS[embedding_id], key)
    if embedding_id.startswith("fastembed:") or embedding_id.startswith("hf:"):
        raise StoreError(f"embedding '{embedding_id}' is not wired in Phase 2")
    raise StoreError(f"unknown embedding '{embedding_id}'")
```

Add to `requirements.txt`:

```
langchain-openai>=0.2
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_embedding_factory.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Install the new dependency (for the live phase)**

Run: `.venv/bin/pip install -q "langchain-openai>=0.2"`
Expected: installs without error. (Unit tests pass regardless — they mock `_openai_embeddings`.)

- [ ] **Step 6: Commit**

```bash
git add embedding.py requirements.txt tests/test_embedding_factory.py
git commit -m "feat(embedding): OpenAI embedding factory make_embeddings (lazy, env-keyed); local ids not-wired"
```

---

### Task 2: PgVectorProvider

**Files:**
- Create: `stores/pgvector.py`
- Modify: `requirements.txt` (add `langchain-postgres`, `psycopg[binary]`)
- Test: `tests/test_pgvector.py` (create)

**Interfaces:**
- Consumes: `make_embeddings` (Task 1); `StoreError`, `VectorStoreProvider` from `stores.base`.
- Produces: `PgVectorProvider` (`name="pgvector"`, `embeds_internally=False`) with `connect`/`test_connection`/`store`/`find`; and the lazy helper `_make_store(embeddings, collection, dsn)`. Registered in the registry by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_pgvector.py`:

```python
import pytest

import stores.pgvector as pg
from stores.base import StoreError
from stores.pgvector import PgVectorProvider


class FakeDoc:
    def __init__(self, content, meta):
        self.page_content, self.metadata = content, meta


class FakeStore:
    last = None

    def __init__(self, embeddings, collection, dsn):
        self.embeddings, self.collection, self.dsn = embeddings, collection, dsn
        self.added = []
        FakeStore.last = self

    def add_texts(self, texts, metadatas=None, **kw):
        self.added.append((list(texts), metadatas))
        return ["id"]

    def similarity_search_with_score(self, query, k=4, **kw):
        return [(FakeDoc("solar power", {"source": "e.txt"}), 0.12)]


@pytest.fixture(autouse=True)
def patch(monkeypatch):
    # Mock the langchain seam + the embedding factory so no DB/key/libs are needed.
    monkeypatch.setattr(pg, "_make_store", lambda embeddings, collection, dsn: FakeStore(embeddings, collection, dsn))
    monkeypatch.setattr(pg, "make_embeddings", lambda i: f"emb::{i}")
    FakeStore.last = None


def test_flags():
    p = PgVectorProvider()
    assert p.name == "pgvector" and p.embeds_internally is False


def test_connect_dsn_required(monkeypatch):
    monkeypatch.delenv("MCPQ_PGVECTOR_DSN", raising=False)
    with pytest.raises(StoreError, match="needs a Postgres DSN"):
        PgVectorProvider().connect({})


def test_connect_call_dsn_overrides_env(monkeypatch):
    monkeypatch.setenv("MCPQ_PGVECTOR_DSN", "env-dsn")
    assert PgVectorProvider().connect({"dsn": "call-dsn"}) == "call-dsn"


def test_store_embeds_and_adds_skipping_blanks(monkeypatch):
    monkeypatch.setenv("MCPQ_PGVECTOR_DSN", "postgresql+psycopg://x")
    p = PgVectorProvider()
    conn = p.connect({})
    out = p.store(conn, "docs",
                  [{"text": "a", "metadata": {"source": "s"}},
                   {"text": "   ", "metadata": {}}],
                  "openai:text-embedding-3-small")
    assert out == {"stored": 1, "errors": 0}
    assert FakeStore.last.collection == "docs"
    assert FakeStore.last.dsn == "postgresql+psycopg://x"
    assert FakeStore.last.embeddings == "emb::openai:text-embedding-3-small"
    assert FakeStore.last.added[0][0] == ["a"]
    assert FakeStore.last.added[0][1] == [{"source": "s"}]


def test_store_empty_is_noop(monkeypatch):
    monkeypatch.setenv("MCPQ_PGVECTOR_DSN", "postgresql+psycopg://x")
    p = PgVectorProvider()
    out = p.store(p.connect({}), "docs", [{"text": "  "}], None)
    assert out == {"stored": 0, "errors": 0}
    assert FakeStore.last is None  # no store built when nothing to write


def test_store_blank_embedding_uses_default(monkeypatch):
    monkeypatch.setenv("MCPQ_PGVECTOR_DSN", "postgresql+psycopg://x")
    monkeypatch.delenv("MCPQ_EMBEDDING", raising=False)
    p = PgVectorProvider()
    p.store(p.connect({}), "docs", [{"text": "a"}], None)
    assert FakeStore.last.embeddings == "emb::openai:text-embedding-3-small"


def test_find_maps_results(monkeypatch):
    monkeypatch.setenv("MCPQ_PGVECTOR_DSN", "postgresql+psycopg://x")
    p = PgVectorProvider()
    out = p.find(p.connect({}), "docs", "q", 5, "openai:text-embedding-3-small")
    r = out["results"][0]
    assert r["text"] == "solar power"
    assert r["metadata"]["source"] == "e.txt"
    assert r["score"] == 0.12
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_pgvector.py -q`
Expected: FAIL — `No module named 'stores.pgvector'`.

- [ ] **Step 3: Implement the provider**

Create `stores/pgvector.py`:

```python
from __future__ import annotations

import os

from embedding import make_embeddings
from stores.base import StoreError, VectorStoreProvider

_DEFAULT_EMBEDDING = "openai:text-embedding-3-small"


def _make_store(embeddings, collection: str, dsn: str):
    # Lazy import so the module is importable (and unit-testable by monkeypatching
    # this helper) without langchain_postgres installed.
    from langchain_postgres import PGVector

    return PGVector(embeddings=embeddings, collection_name=collection, connection=dsn, use_jsonb=True)


class PgVectorProvider:
    name = "pgvector"
    embeds_internally = False  # the MCP computes embeddings (OpenAI in Phase 2)

    def _dsn(self, connection: dict) -> str:
        connection = connection or {}
        dsn = connection.get("dsn") or os.environ.get("MCPQ_PGVECTOR_DSN")
        if not dsn:
            raise StoreError("pgvector needs a Postgres DSN (connection.dsn or MCPQ_PGVECTOR_DSN)")
        return dsn

    def _embedding_id(self, embedding: str | None) -> str:
        return embedding or os.environ.get("MCPQ_EMBEDDING") or _DEFAULT_EMBEDDING

    def connect(self, connection: dict) -> str:
        # The "connection" handle is just the resolved dsn; a PGVector instance is
        # built per call (bound to its collection + embeddings).
        return self._dsn(connection)

    def test_connection(self, connection: dict) -> dict:
        try:
            dsn = self._dsn(connection)
            _make_store(make_embeddings(self._embedding_id(None)), "mcpq_healthcheck", dsn)
            return {"ok": True}
        except Exception as e:  # noqa: BLE001 — surface to the UI
            return {"ok": False, "message": str(e)}

    def store(self, conn: str, collection: str, items: list[dict], embedding: str | None) -> dict:
        texts = [str(i.get("text", "")) for i in items if str(i.get("text", "")).strip()]
        metas = [dict(i.get("metadata") or {}) for i in items if str(i.get("text", "")).strip()]
        if not texts:
            return {"stored": 0, "errors": 0}
        store = _make_store(make_embeddings(self._embedding_id(embedding)), collection, conn)
        store.add_texts(texts=texts, metadatas=metas)
        return {"stored": len(texts), "errors": 0}

    def find(self, conn: str, collection: str, query: str, limit: int, embedding: str | None) -> dict:
        store = _make_store(make_embeddings(self._embedding_id(embedding)), collection, conn)
        hits = store.similarity_search_with_score(query, k=limit)
        return {"results": [
            {"text": getattr(doc, "page_content", None),
             "metadata": getattr(doc, "metadata", {}) or {},
             "score": float(score) if score is not None else None}
            for doc, score in hits
        ]}


_: VectorStoreProvider = PgVectorProvider()
```

Add to `requirements.txt`:

```
langchain-postgres>=0.0.12
psycopg[binary]>=3.1,<4
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_pgvector.py -q`
Expected: PASS (8 passed).

- [ ] **Step 5: Install the new dependencies (for the live phase)**

Run: `.venv/bin/pip install -q "langchain-postgres>=0.0.12" "psycopg[binary]>=3.1,<4"`
Expected: installs without error.

- [ ] **Step 6: Commit**

```bash
git add stores/pgvector.py requirements.txt tests/test_pgvector.py
git commit -m "feat(pgvector): PgVectorProvider (langchain_postgres.PGVector, embeds_internally=false) + tests"
```

---

### Task 3: Activate pgvector (descriptor + registry)

**Files:**
- Modify: `providers/pgvector.json` (`available` → `true`)
- Modify: `stores/registry.py` (add `pgvector` to `_IMPL`)
- Modify: `tests/test_registry.py` (expect pgvector available + built)
- Modify: `run.sh` (echo pgvector/OpenAI config presence)

**Interfaces:**
- Consumes: `PgVectorProvider` (Task 2).
- Produces: `build_registry` now returns `{"qdrant", "pgvector"}`; `providers_payload` lists pgvector `available: true`.

- [ ] **Step 1: Update the registry test (failing)**

In `tests/test_registry.py`, replace:

```python
    assert payload["pgvector"]["available"] is False
```
with:
```python
    assert payload["pgvector"]["available"] is True and payload["pgvector"]["embeds_internally"] is False
```

and replace:

```python
    assert set(reg) == {"qdrant"}            # only the implemented + available one
```
with:
```python
    assert set(reg) == {"qdrant", "pgvector"}   # both implemented + available
```

- [ ] **Step 2: Run the registry test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_registry.py -q`
Expected: FAIL — pgvector still `available: false` and not in `_IMPL`.

- [ ] **Step 3: Activate the descriptor and register the provider**

Edit `providers/pgvector.json` — change `"available": false` to `"available": true`:

```json
{
  "name": "pgvector", "label": "PostgreSQL + pgvector", "description": "Postgres pgvector (embeddings computed by the MCP)",
  "available": true, "embeds_internally": false,
  "connection_schema": {"fields": [
    {"name": "dsn", "label": "Postgres DSN", "type": "password", "required": true, "mask": true}]}
}
```

Edit `stores/registry.py` — import and register pgvector:

```python
from __future__ import annotations

from config import AppConfig
from descriptors import load_descriptors
from stores.base import VectorStoreProvider
from stores.pgvector import PgVectorProvider
from stores.qdrant import QdrantProvider

# provider name -> factory (only implemented providers; others are descriptor-only)
_IMPL = {
    "qdrant": lambda d: QdrantProvider(),
    "pgvector": lambda d: PgVectorProvider(),
}
```

(Leave `build_registry` and `providers_payload` bodies unchanged.)

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_registry.py -q`
Expected: PASS.

- [ ] **Step 5: Add pgvector/OpenAI config visibility to run.sh**

In `run.sh`, replace the final echo block:

```bash
echo "mcp_qrant up on http://127.0.0.1:8008/mcp"
echo "  Qdrant: mode=$MCPQ_QDRANT_MODE path=$MCPQ_QDRANT_PATH"
```
with:
```bash
echo "mcp_qrant up on http://127.0.0.1:8008/mcp"
echo "  Qdrant:   mode=$MCPQ_QDRANT_MODE path=$MCPQ_QDRANT_PATH"
echo "  pgvector: dsn=${MCPQ_PGVECTOR_DSN:+set} openai_key=${MCPQ_OPENAI_API_KEY:+set} embedding=${MCPQ_EMBEDDING:-openai:text-embedding-3-small}"
```

(`MCPQ_PGVECTOR_DSN` / `MCPQ_OPENAI_API_KEY` / `MCPQ_EMBEDDING` are inherited from the shell env — `run.sh` only reports their presence so secrets aren't printed.)

- [ ] **Step 6: Run the full suite (pristine)**

Run: `.venv/bin/python -m pytest -q`
Expected: PASS — all tests green (Phase-1 suite + Task 1 + Task 2 + the updated registry test), output pristine.

- [ ] **Step 7: Commit**

```bash
git add providers/pgvector.json stores/registry.py tests/test_registry.py run.sh
git commit -m "feat(pgvector): activate provider (descriptor available:true, registry, run.sh config visibility)"
```

---

### Task 4: Live acceptance (local Postgres + OpenAI key)

**Files:** none (operational verification). Requires a running local Postgres with the pgvector extension and a valid OpenAI key.

**Interfaces:**
- Consumes: everything from Tasks 1-3; the deps installed in Tasks 1-2.

- [ ] **Step 1: Prepare the Postgres database**

Ensure the pgvector extension exists in the target DB (replace `<db>`):

Run: `psql -d <db> -c 'CREATE EXTENSION IF NOT EXISTS vector;'`
Expected: `CREATE EXTENSION` (or no error if already present).

- [ ] **Step 2: Start mcp_qrant with pgvector + OpenAI config**

Run (from the repo root, substituting real values):

```bash
MCPQ_PGVECTOR_DSN='postgresql+psycopg://USER:PASS@localhost:5432/DB' \
MCPQ_OPENAI_API_KEY='sk-...' \
bash run.sh
```
Expected: `mcp_qrant up …` and the `pgvector: dsn=set openai_key=set …` line.

- [ ] **Step 3: list_providers shows pgvector active**

Run:
```bash
curl -s -X POST http://127.0.0.1:8008/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_providers","arguments":{}}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); ps={p[\"name\"]:p for p in json.loads(d[\"result\"][\"content\"][0][\"text\"])[\"providers\"]}; print('pgvector available:', ps['pgvector']['available'], 'embeds_internally:', ps['pgvector']['embeds_internally'])"
```
Expected: `pgvector available: True embeds_internally: False`.

- [ ] **Step 4: test_connection (blank connection → server env dsn)**

Run:
```bash
curl -s -X POST http://127.0.0.1:8008/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test_connection","arguments":{"provider":"pgvector","connection":{}}}}' \
  | sed 's/.*"text":"//;s/"}].*//'
```
Expected: `{"ok": true}` (or `{"ok": false, "message": "…"}` pointing at the real problem, e.g. missing extension / bad dsn).

- [ ] **Step 5: store → find round-trip via the OpenAI embedder**

Run:
```bash
curl -s -X POST http://127.0.0.1:8008/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"store","arguments":{"provider":"pgvector","connection":{},"collection":"pg_test","items":[{"text":"context is the hidden engine of LLMs","metadata":{"source":"a"}},{"text":"grass is green","metadata":{"source":"b"}}]}}}' \
  | sed 's/.*"text":"//;s/"}].*//'
curl -s -X POST http://127.0.0.1:8008/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find","arguments":{"provider":"pgvector","connection":{},"collection":"pg_test","query":"what powers an LLM","limit":2}}}' \
  | sed 's/.*"text":"//;s/"}].*//'
```
Expected: store → `{"stored": 2, "errors": 0}`; find → a `results` array whose top hit is the "context is the hidden engine" chunk with a numeric `score`.

- [ ] **Step 6: gpt end-to-end (browser)**

In the gpt store node: select **pgvector** → the **Embeddings dropdown** appears (default `text-embedding-3-small`) and the **DSN** field shows in Connection (leave blank to use the server env). Run loader→split→store, then **Search** — matches return from Postgres.

- [ ] **Step 7: Record the outcome**

If the live run surfaces an operational note worth keeping (exact DSN format, extension step), add it to the spec's §10 and commit. Otherwise no commit.

---

## Self-Review

**1. Spec coverage:**
- §3 `PgVectorProvider` via PGVector → Task 2. ✓
- §3 embedding factory wiring OpenAI ids → Task 1. ✓
- §3 descriptor `available:true` + registry `_IMPL` → Task 3. ✓
- §3 deps (langchain-postgres, psycopg, langchain-openai) → Task 1 (openai) + Task 2 (postgres/psycopg). ✓
- §4 factory behavior (openai wired, local not-wired, unknown, missing key) → Task 1 tests. ✓
- §4 provider connect/test/store/find shapes → Task 2 tests. ✓
- §5 data flow (connect→embeddings→PGVector) → Task 2 impl. ✓
- §6 server-owned config (DSN/KEY/EMBEDDING, call overrides env) → Task 1 (key) + Task 2 (dsn, embedding default). ✓
- §7 same-model invariant (one embedding per node; mismatch surfaces) → covered by the blank-embedding default + the existing VectorMcpStore error-handling; no new code. ✓
- §8 error handling (exact messages) → Task 1 + Task 2 (StoreError messages match Global Constraints). ✓
- §9 testing (unit mocked + live) → Tasks 1-2 (unit) + Task 4 (live). ✓
- §10 setup notes (extension, dsn format, run.sh) → Task 3 (run.sh) + Task 4 (extension, dsn). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. Live-test secrets are shown as placeholders the operator substitutes (`USER:PASS@…`, `sk-…`), which is correct for an operational step.

**3. Type consistency:** `make_embeddings(id)` (Task 1) is consumed exactly as `make_embeddings(self._embedding_id(embedding))` (Task 2). `_make_store(embeddings, collection, dsn)` and `_openai_embeddings(model, api_key)` signatures match their monkeypatch sites in the tests. `connect()` returns the dsn string and is passed back as `conn` to `store`/`find` — consistent with the handler's `conn = p.connect(...)` then `p.store(conn, …)` flow (same as Qdrant). Descriptor/registry names (`pgvector`) match across Task 2/3 and the JSON.
