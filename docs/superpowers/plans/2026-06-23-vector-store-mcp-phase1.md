# Vector-store MCP — Phase 1 (Qdrant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Python + LangChain-family vector-store MCP in `mcp_qrant/` with **Qdrant (local) functional end-to-end** and the other 9 popular vector DBs **listed but disabled**, plus `list_providers` / `list_embeddings` / `test_connection` / `store` / `find` — the store-side twin of langfs.

**Architecture:** A FastAPI MCP server (same transport/envelope as langfs: handler at `/` and `/mcp`). Providers come from JSON descriptors; a `VectorStoreProvider` protocol unifies them. The **Qdrant provider uses `qdrant_client[fastembed]` directly** (`client.add(documents=…)` / `client.query(query_text=…)`) so Qdrant **self-embeds** (`embeds_internally: true`) — no embedder needed this phase. pgvector + 8 others are descriptor-only (greyed). `list_embeddings` returns a static catalog (used only by non-self-embedding providers, which arrive in Phase 2).

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, `qdrant-client[fastembed]`, pytest, httpx.

**Spec:** `docs/superpowers/specs/2026-06-23-vector-store-mcp-design.md`.

## Global Constraints

- **Location:** `/Applications/XAMPP/xamppfiles/htdocs/mcp_qrant/` (its own git repo). The Python MCP is **added alongside** the existing PHP files this phase — do NOT delete the PHP (`public/`, `src/`, `composer.*`) yet; its retirement is the remote-Qdrant cutover (Phase 3). New Python files don't collide with PHP ones.
- **Python venv:** `mcp_qrant/.venv`, separate. Run tests `./.venv/bin/python -m pytest`; `pyproject.toml` sets `pythonpath=["."]`; output must stay **pristine**.
- **MCP envelope (verbatim, same as langfs):** every tool result is `{"content":[{"type":"text","text": json.dumps(payload)}]}`. Application outcomes are payload fields; JSON-RPC `error` (-32601) only for unknown method/tool. Handler served at **both `/` and `/mcp`**.
- **Tools (Phase 1):** `list_providers`, `list_embeddings`, `test_connection`, `store`, `find`.
- **Providers (verbatim catalog, 10):** `qdrant` (available), `pgvector`, `chroma`, `pinecone`, `milvus`, `weaviate`, `faiss`, `redis`, `elasticsearch`, `mongodb` — all `available:false` except `qdrant`.
- **`embeds_internally`:** `qdrant` → **true** (send text; `qdrant_client` fastembed embeds); every other → **false**.
- **Qdrant API (verified):** `QdrantClient(path=…)` (local) or `QdrantClient(url=…, api_key=…)` (remote); `client.add(collection_name, documents=[str], metadata=[dict], ids=[str])`; `client.query(collection_name, query_text=str, limit=int)` → results with `.document`, `.metadata`, `.score`.
- **Read-only-ish:** the MCP only stores/searches vectors; no deleting of user source data. Secrets (api_key, dsn) ride per-request, never logged (LAN posture).

---

## File Structure

```
mcp_qrant/
  requirements.txt          # fastapi, uvicorn, qdrant-client[fastembed], pytest, httpx
  pyproject.toml            # [tool.pytest.ini_options] pythonpath=["."], filterwarnings
  .gitignore                # .venv/, __pycache__/, .pytest_cache/, .superpowers/
  config.py                 # AppConfig (host/port, providers_dir)
  descriptors.py            # ProviderDescriptor + load_descriptors + DescriptorError
  providers/                # 10 descriptor JSONs
    qdrant.json pgvector.json chroma.json pinecone.json milvus.json
    weaviate.json faiss.json redis.json elasticsearch.json mongodb.json
  embedding.py              # EMBEDDING_CATALOG (list_embeddings source)
  stores/
    base.py                 # VectorStoreProvider protocol, StoreError
    qdrant.py               # QdrantProvider (functional)
    registry.py             # build_registry + providers_payload
  handlers.py               # Handlers: list_providers/list_embeddings/test_connection/store/find
  server.py                 # FastAPI + MCP JSON-RPC (/ and /mcp) + main()
  tests/ …
```

---

### Task 1: Scaffold + config + dependencies

**Files:** Create `mcp_qrant/requirements.txt`, `pyproject.toml`, `.gitignore`, `config.py`, package `__init__.py`s; Test `tests/test_config.py`.

**Interfaces:**
- Produces `config.AppConfig` dataclass: `host:str="127.0.0.1"`, `port:int=8008`, `providers_dir:str`; classmethod `from_env()` (env `MCPQ_HOST`/`MCPQ_PORT`/`MCPQ_PROVIDERS_DIR`, `providers_dir` defaults to the packaged `providers/`).

- [ ] **Step 1: Create venv + requirements**

Create `mcp_qrant/requirements.txt`:
```
fastapi>=0.110
uvicorn>=0.29
qdrant-client[fastembed]>=1.9
pytest>=8
httpx>=0.27
```
Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/mcp_qrant
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```
Expected: installs `qdrant-client`, `fastembed`, `fastapi`, etc. without error.

- [ ] **Step 2: pyproject + gitignore + package files**

Create `mcp_qrant/pyproject.toml`:
```
[tool.pytest.ini_options]
pythonpath = ["."]
filterwarnings = [
    "ignore::DeprecationWarning",
]
```
Create `mcp_qrant/.gitignore`:
```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.superpowers/
```
Create empty `mcp_qrant/__init__.py`, `mcp_qrant/stores/__init__.py`, `mcp_qrant/tests/__init__.py`.

- [ ] **Step 3: Write the failing test**

Create `mcp_qrant/tests/test_config.py`:
```python
from config import AppConfig


def test_defaults(monkeypatch):
    monkeypatch.delenv("MCPQ_PORT", raising=False)
    monkeypatch.delenv("MCPQ_PROVIDERS_DIR", raising=False)
    cfg = AppConfig.from_env()
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 8008
    assert cfg.providers_dir.endswith("providers")


def test_env_override(monkeypatch):
    monkeypatch.setenv("MCPQ_PORT", "9000")
    assert AppConfig.from_env().port == 9000
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/mcp_qrant && ./.venv/bin/python -m pytest tests/test_config.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'config'`.

- [ ] **Step 5: Implement `config.py`**

```python
from __future__ import annotations

import os
from dataclasses import dataclass

_DEFAULT_PROVIDERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "providers")


@dataclass
class AppConfig:
    providers_dir: str = _DEFAULT_PROVIDERS_DIR
    host: str = "127.0.0.1"
    port: int = 8008

    @classmethod
    def from_env(cls) -> "AppConfig":
        return cls(
            providers_dir=os.environ.get("MCPQ_PROVIDERS_DIR", _DEFAULT_PROVIDERS_DIR),
            host=os.environ.get("MCPQ_HOST", "127.0.0.1"),
            port=int(os.environ.get("MCPQ_PORT", "8008")),
        )
```

- [ ] **Step 6: Run to verify pass + commit**

Run: `./.venv/bin/python -m pytest tests/test_config.py -v` → PASS.
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/mcp_qrant
git add requirements.txt pyproject.toml .gitignore config.py __init__.py stores/__init__.py tests/__init__.py tests/test_config.py
git commit -m "feat(vstore): scaffold python vector-store MCP + AppConfig"
```

---

### Task 2: Provider descriptors (10) + loader

**Files:** Create `descriptors.py`, `providers/*.json` (10); Test `tests/test_descriptors.py`.

**Interfaces:**
- Produces `descriptors.ProviderDescriptor` dataclass: `name, label, description, available:bool, embeds_internally:bool, connection_schema:dict`; `descriptors.DescriptorError(Exception)`; `descriptors.load_descriptors(dir) -> dict[str, ProviderDescriptor]` (validate: required fields present, `name`==filename; raise `DescriptorError` otherwise).

- [ ] **Step 1: Write the failing test**

Create `mcp_qrant/tests/test_descriptors.py`:
```python
import json, pytest
from descriptors import load_descriptors, DescriptorError, ProviderDescriptor

TEN = {"qdrant","pgvector","chroma","pinecone","milvus","weaviate","faiss","redis","elasticsearch","mongodb"}


def test_loads_ten(tmp_path):
    # copy the packaged descriptors into tmp to test the loader in isolation
    import os, shutil
    src = os.path.join(os.path.dirname(__file__), "..", "providers")
    for fn in os.listdir(src):
        if fn.endswith(".json"):
            shutil.copy(os.path.join(src, fn), tmp_path / fn)
    reg = load_descriptors(str(tmp_path))
    assert set(reg) == TEN
    assert reg["qdrant"].available is True and reg["qdrant"].embeds_internally is True
    assert reg["pgvector"].available is False and reg["pgvector"].embeds_internally is False
    assert all(reg[n].available is False for n in TEN - {"qdrant"})


def test_missing_field_raises(tmp_path):
    (tmp_path / "x.json").write_text(json.dumps({"name": "x"}))
    with pytest.raises(DescriptorError):
        load_descriptors(str(tmp_path))
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_descriptors.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'descriptors'`.

- [ ] **Step 3: Implement `descriptors.py`**

```python
from __future__ import annotations

import json
import os
from dataclasses import dataclass

_REQUIRED = ["name", "label", "description", "available", "embeds_internally", "connection_schema"]


class DescriptorError(Exception):
    """A provider descriptor is malformed."""


@dataclass
class ProviderDescriptor:
    name: str
    label: str
    description: str
    available: bool
    embeds_internally: bool
    connection_schema: dict


def _validate(obj: dict, fn: str) -> ProviderDescriptor:
    missing = [k for k in _REQUIRED if k not in obj]
    if missing:
        raise DescriptorError(f"{fn}: missing fields {missing}")
    expected = os.path.splitext(os.path.basename(fn))[0]
    if obj["name"] != expected:
        raise DescriptorError(f"{fn}: name '{obj['name']}' must equal filename '{expected}'")
    return ProviderDescriptor(**{k: obj[k] for k in _REQUIRED})


def load_descriptors(dir_path: str) -> dict[str, ProviderDescriptor]:
    out: dict[str, ProviderDescriptor] = {}
    for fn in sorted(os.listdir(dir_path)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(dir_path, fn)
        try:
            with open(path, encoding="utf-8") as fh:
                obj = json.load(fh)
        except json.JSONDecodeError as e:
            raise DescriptorError(f"{fn}: invalid JSON: {e}") from e
        d = _validate(obj, fn)
        out[d.name] = d
    return out
```

- [ ] **Step 4: Create the 10 descriptor JSONs**

Create `mcp_qrant/providers/qdrant.json`:
```json
{
  "name": "qdrant", "label": "Qdrant", "description": "Qdrant vector DB (self-embeds via FastEmbed)",
  "available": true, "embeds_internally": true,
  "connection_schema": {"fields": [
    {"name": "mode", "label": "Mode", "type": "select", "options": ["local", "remote"], "required": true},
    {"name": "path", "label": "Local storage path", "type": "text", "required": false},
    {"name": "url", "label": "Remote URL", "type": "text", "required": false},
    {"name": "api_key", "label": "API key", "type": "password", "required": false, "mask": true}]}
}
```
Create `mcp_qrant/providers/pgvector.json`:
```json
{
  "name": "pgvector", "label": "PostgreSQL + pgvector", "description": "Postgres pgvector (embeddings computed by the MCP)",
  "available": false, "embeds_internally": false,
  "connection_schema": {"fields": [
    {"name": "dsn", "label": "Postgres DSN", "type": "password", "required": true, "mask": true}]}
}
```
Create the remaining **8** with `"available": false, "embeds_internally": false` and an empty `"connection_schema": {"fields": []}` (placeholders), one per file, e.g. `chroma.json`:
```json
{"name": "chroma", "label": "Chroma", "description": "Chroma vector DB (coming soon)", "available": false, "embeds_internally": false, "connection_schema": {"fields": []}}
```
Repeat verbatim for `pinecone` ("Pinecone"), `milvus` ("Milvus"), `weaviate` ("Weaviate"), `faiss` ("FAISS"), `redis` ("Redis"), `elasticsearch` ("Elasticsearch"), `mongodb` ("MongoDB Atlas") — same shape, only `name`/`label`/`description` differ.

- [ ] **Step 5: Run to verify pass + commit**

Run: `./.venv/bin/python -m pytest tests/test_descriptors.py -v` → PASS (2).
```bash
git add descriptors.py providers/ tests/test_descriptors.py
git commit -m "feat(vstore): 10 provider descriptors + loader (qdrant available, 9 listed/disabled)"
```

---

### Task 3: `VectorStoreProvider` protocol + registry

**Files:** Create `stores/base.py`, `stores/registry.py`; Test `tests/test_registry.py`.

**Interfaces:**
- Produces `stores.base.StoreError(Exception)`; `stores.base.VectorStoreProvider` Protocol: attrs `name:str`, `embeds_internally:bool`; methods `connect(connection:dict)->object`, `test_connection(connection:dict)->dict`, `store(conn, collection:str, items:list[dict], embedding:str|None)->dict`, `find(conn, collection:str, query:str, limit:int, embedding:str|None)->dict`.
- `stores.registry.build_registry(cfg) -> dict[str, VectorStoreProvider]` (only `available` providers that have an impl → Phase 1: just `qdrant`); `stores.registry.providers_payload(cfg) -> list[dict]` (all 10 with `name,label,description,available,embeds_internally,connection_schema`).

- [ ] **Step 1: Write the failing test**

Create `mcp_qrant/tests/test_registry.py`:
```python
from config import AppConfig
from stores.registry import build_registry, providers_payload

def test_payload_lists_ten():
    payload = {p["name"]: p for p in providers_payload(AppConfig())}
    assert len(payload) == 10
    assert payload["qdrant"]["available"] is True and payload["qdrant"]["embeds_internally"] is True
    assert payload["pgvector"]["available"] is False

def test_registry_only_functional():
    reg = build_registry(AppConfig())
    assert set(reg) == {"qdrant"}            # only the implemented + available one
```

- [ ] **Step 2: Run → FAIL** (`ModuleNotFoundError: stores.registry`).
Run: `./.venv/bin/python -m pytest tests/test_registry.py -v`

- [ ] **Step 3: Implement `stores/base.py`**

```python
from __future__ import annotations

from typing import Protocol, runtime_checkable


class StoreError(Exception):
    """A vector-store operation failed."""


@runtime_checkable
class VectorStoreProvider(Protocol):
    name: str
    embeds_internally: bool

    def connect(self, connection: dict) -> object: ...
    def test_connection(self, connection: dict) -> dict: ...
    def store(self, conn: object, collection: str, items: list[dict], embedding: str | None) -> dict: ...
    def find(self, conn: object, collection: str, query: str, limit: int, embedding: str | None) -> dict: ...
```

- [ ] **Step 4: Implement `stores/registry.py`**

```python
from __future__ import annotations

from config import AppConfig
from descriptors import load_descriptors
from stores.base import VectorStoreProvider
from stores.qdrant import QdrantProvider

# provider name -> factory (only implemented providers; others are descriptor-only)
_IMPL = {"qdrant": lambda d: QdrantProvider()}


def build_registry(cfg: AppConfig) -> dict[str, VectorStoreProvider]:
    descs = load_descriptors(cfg.providers_dir)
    out: dict[str, VectorStoreProvider] = {}
    for name, d in descs.items():
        if d.available and name in _IMPL:
            out[name] = _IMPL[name](d)
    return out


def providers_payload(cfg: AppConfig) -> list[dict]:
    descs = load_descriptors(cfg.providers_dir)
    return [{
        "name": d.name, "label": d.label, "description": d.description,
        "available": d.available, "embeds_internally": d.embeds_internally,
        "connection_schema": d.connection_schema,
    } for d in descs.values()]
```
(Imports `QdrantProvider` from Task 4 — implement that first or in the same commit.)

- [ ] **Step 5: (after Task 4) Run → PASS; commit with Task 4.**

---

### Task 4: `QdrantProvider` (functional, self-embedding)

**Files:** Create `stores/qdrant.py`; Test `tests/test_qdrant.py`.

**Interfaces:**
- Consumes `qdrant_client` (verified API). Produces `stores.qdrant.QdrantProvider` implementing `VectorStoreProvider`: `name="qdrant"`, `embeds_internally=True`.
  - `connect(connection)` → `QdrantClient(path=connection["path"])` when `mode=="local"`, else `QdrantClient(url=connection["url"], api_key=connection.get("api_key"))`.
  - `test_connection(connection)` → `{ok:bool, message?}` (build client + `get_collections()`).
  - `store(conn, collection, items, embedding)` → `conn.add(collection_name=collection, documents=[i["text"]], metadata=[i.get("metadata",{})])`; returns `{stored:int, errors:int}`. (`embedding` ignored — Qdrant self-embeds.)
  - `find(conn, collection, query, limit, embedding)` → `conn.query(collection_name=collection, query_text=query, limit=limit)`; returns `{results:[{text, metadata, score}]}` from `.document/.metadata/.score`.

- [ ] **Step 1: Write the failing test** (fake client — no real Qdrant needed)

Create `mcp_qrant/tests/test_qdrant.py`:
```python
from stores.qdrant import QdrantProvider


class FakeHit:
    def __init__(self, doc, meta, score): self.document, self.metadata, self.score = doc, meta, score


class FakeClient:
    def __init__(self): self.added = []
    def add(self, collection_name, documents, metadata=None, **kw):
        self.added.append((collection_name, list(documents), metadata)); return ["id1"]
    def query(self, collection_name, query_text, limit=10, **kw):
        return [FakeHit("hello world", {"source": "a.txt"}, 0.91)]
    def get_collections(self): return type("R", (), {"collections": []})()


def test_flags():
    p = QdrantProvider()
    assert p.name == "qdrant" and p.embeds_internally is True


def test_store_passes_text(monkeypatch):
    p = QdrantProvider()
    c = FakeClient()
    out = p.store(c, "learn_docs", [{"text": "hello", "metadata": {"source": "a.txt"}}], None)
    assert out == {"stored": 1, "errors": 0}
    assert c.added[0][0] == "learn_docs" and c.added[0][1] == ["hello"]


def test_find_maps_hits():
    p = QdrantProvider()
    out = p.find(FakeClient(), "learn_docs", "hi", 5, None)
    assert out["results"][0]["text"] == "hello world"
    assert out["results"][0]["metadata"]["source"] == "a.txt"
    assert out["results"][0]["score"] == 0.91
```

- [ ] **Step 2: Run → FAIL** (`ModuleNotFoundError: stores.qdrant`).

- [ ] **Step 3: Implement `stores/qdrant.py`**

```python
from __future__ import annotations

from qdrant_client import QdrantClient

from stores.base import StoreError, VectorStoreProvider


class QdrantProvider:
    name = "qdrant"
    embeds_internally = True  # qdrant_client[fastembed] embeds text on add/query

    def connect(self, connection: dict) -> QdrantClient:
        mode = connection.get("mode", "local")
        if mode == "remote":
            return QdrantClient(url=connection.get("url"), api_key=connection.get("api_key") or None)
        path = connection.get("path")
        if not path:
            raise StoreError("qdrant local mode needs a 'path'")
        return QdrantClient(path=path)

    def test_connection(self, connection: dict) -> dict:
        try:
            self.connect(connection).get_collections()
            return {"ok": True}
        except Exception as e:  # noqa: BLE001 — surface to the UI
            return {"ok": False, "message": str(e)}

    def store(self, conn: QdrantClient, collection: str, items: list[dict], embedding: str | None) -> dict:
        docs = [str(i.get("text", "")) for i in items if str(i.get("text", "")).strip()]
        metas = [dict(i.get("metadata") or {}) for i in items if str(i.get("text", "")).strip()]
        if not docs:
            return {"stored": 0, "errors": 0}
        conn.add(collection_name=collection, documents=docs, metadata=metas)
        return {"stored": len(docs), "errors": 0}

    def find(self, conn: QdrantClient, collection: str, query: str, limit: int, embedding: str | None) -> dict:
        hits = conn.query(collection_name=collection, query_text=query, limit=limit)
        return {"results": [
            {"text": getattr(h, "document", None), "metadata": getattr(h, "metadata", {}) or {},
             "score": getattr(h, "score", None)}
            for h in hits
        ]}


_: VectorStoreProvider = QdrantProvider()
```

- [ ] **Step 4: Run → PASS**

Run: `./.venv/bin/python -m pytest tests/test_qdrant.py tests/test_registry.py -v` → PASS.

- [ ] **Step 5: Commit (Tasks 3+4 together)**

```bash
git add stores/base.py stores/registry.py stores/qdrant.py tests/test_registry.py tests/test_qdrant.py
git commit -m "feat(vstore): VectorStoreProvider protocol + registry + functional QdrantProvider (self-embedding)"
```

---

### Task 5: `list_embeddings` catalog

**Files:** Create `embedding.py`; Test `tests/test_embedding.py`.

**Interfaces:**
- Produces `embedding.EMBEDDING_CATALOG: list[dict]` and `embedding.catalog() -> list[dict]`, each entry `{id, label, provider, dimensions, requires_credentials}`.

- [ ] **Step 1: Write the failing test**

Create `mcp_qrant/tests/test_embedding.py`:
```python
from embedding import catalog

def test_catalog_shape():
    cat = {e["id"]: e for e in catalog()}
    assert "openai:text-embedding-3-small" in cat
    assert cat["openai:text-embedding-3-small"]["requires_credentials"] is True
    assert cat["openai:text-embedding-3-small"]["dimensions"] == 1536
    assert any(not e["requires_credentials"] for e in catalog())   # at least one local
    assert all({"id","label","provider","dimensions","requires_credentials"} <= set(e) for e in catalog())
```

- [ ] **Step 2: Run → FAIL** (`ModuleNotFoundError: embedding`).

- [ ] **Step 3: Implement `embedding.py`**

```python
from __future__ import annotations

# Embedding models the store node may offer (used only by providers whose
# descriptor has embeds_internally=false; Qdrant self-embeds and ignores this).
# The factory that turns an id into a LangChain Embeddings lands in Phase 2.
EMBEDDING_CATALOG: list[dict] = [
    {"id": "fastembed:bge-small-en-v1.5", "label": "FastEmbed BGE small (local)",
     "provider": "fastembed", "dimensions": 384, "requires_credentials": False},
    {"id": "hf:all-MiniLM-L6-v2", "label": "HuggingFace all-MiniLM-L6-v2 (local)",
     "provider": "huggingface", "dimensions": 384, "requires_credentials": False},
    {"id": "openai:text-embedding-3-small", "label": "OpenAI text-embedding-3-small",
     "provider": "openai", "dimensions": 1536, "requires_credentials": True},
    {"id": "openai:text-embedding-3-large", "label": "OpenAI text-embedding-3-large",
     "provider": "openai", "dimensions": 3072, "requires_credentials": True},
]


def catalog() -> list[dict]:
    return list(EMBEDDING_CATALOG)
```

- [ ] **Step 4: Run → PASS + commit**

```bash
git add embedding.py tests/test_embedding.py
git commit -m "feat(vstore): list_embeddings catalog (FastEmbed/HF local + OpenAI)"
```

---

### Task 6: Handlers (list_providers / list_embeddings / test_connection / store / find)

**Files:** Create `handlers.py`; Test `tests/test_handlers.py`.

**Interfaces:**
- Produces `handlers.Handlers(cfg)`: `registry=build_registry(cfg)`. Methods (pure dict in/out):
  - `list_providers(args) -> {"providers": providers_payload(cfg)}`
  - `list_embeddings(args) -> {"embeddings": catalog()}`
  - `test_connection(args{provider,connection}) -> provider.test_connection(...)` or `{error,code:"unknown_provider"}`
  - `store(args{provider,connection,collection,items,embedding?}) -> {stored,errors}` (connect then store) or `{error,code,message}`
  - `find(args{provider,connection,collection,query,limit?,embedding?}) -> {results:[…]}` or error

- [ ] **Step 1: Write the failing test**

Create `mcp_qrant/tests/test_handlers.py`:
```python
import pytest
from config import AppConfig
from handlers import Handlers


@pytest.fixture
def H(tmp_path):
    return Handlers(AppConfig()), tmp_path


def test_list_providers(H):
    h, _ = H
    assert len(h.list_providers({})["providers"]) == 10


def test_list_embeddings(H):
    h, _ = H
    assert any(e["id"] == "openai:text-embedding-3-small" for e in h.list_embeddings({})["embeddings"])


def test_unknown_provider(H):
    h, _ = H
    assert h.store({"provider": "pinecone", "connection": {}, "collection": "c", "items": []})["code"] == "unknown_provider"


def test_qdrant_store_find_roundtrip(H, tmp_path):
    h, _ = H
    conn = {"mode": "local", "path": str(tmp_path / "qd")}
    s = h.store({"provider": "qdrant", "connection": conn, "collection": "t",
                 "items": [{"text": "the cat sat on the mat", "metadata": {"source": "a"}}]})
    assert s["stored"] == 1
    r = h.find({"provider": "qdrant", "connection": conn, "collection": "t", "query": "where did the cat sit", "limit": 3})
    assert r["results"] and "cat" in r["results"][0]["text"]
```
(`test_qdrant_store_find_roundtrip` is a REAL local-Qdrant round-trip using a temp path + FastEmbed — it downloads the small model on first run.)

- [ ] **Step 2: Run → FAIL** (`ModuleNotFoundError: handlers`).

- [ ] **Step 3: Implement `handlers.py`**

```python
from __future__ import annotations

from config import AppConfig
from embedding import catalog
from stores.registry import build_registry, providers_payload


class Handlers:
    def __init__(self, cfg: AppConfig) -> None:
        self.cfg = cfg
        self.registry = build_registry(cfg)

    def list_providers(self, args: dict) -> dict:
        return {"providers": providers_payload(self.cfg)}

    def list_embeddings(self, args: dict) -> dict:
        return {"embeddings": catalog()}

    def _provider(self, args: dict):
        return self.registry.get(str(args.get("provider", "")))

    def test_connection(self, args: dict) -> dict:
        p = self._provider(args)
        if p is None:
            return {"error": True, "code": "unknown_provider", "message": "unknown or unavailable provider"}
        return p.test_connection(args.get("connection") or {})

    def store(self, args: dict) -> dict:
        p = self._provider(args)
        if p is None:
            return {"error": True, "code": "unknown_provider", "message": "unknown or unavailable provider"}
        try:
            conn = p.connect(args.get("connection") or {})
            return p.store(conn, str(args.get("collection", "")), list(args.get("items") or []), args.get("embedding"))
        except Exception as e:  # noqa: BLE001
            return {"error": True, "code": "store_failed", "message": str(e)}

    def find(self, args: dict) -> dict:
        p = self._provider(args)
        if p is None:
            return {"error": True, "code": "unknown_provider", "message": "unknown or unavailable provider"}
        try:
            conn = p.connect(args.get("connection") or {})
            return p.find(conn, str(args.get("collection", "")), str(args.get("query", "")),
                          int(args.get("limit", 10)), args.get("embedding"))
        except Exception as e:  # noqa: BLE001
            return {"error": True, "code": "find_failed", "message": str(e)}
```

- [ ] **Step 4: Run → PASS** (the round-trip downloads FastEmbed's small model once).

Run: `./.venv/bin/python -m pytest tests/test_handlers.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add handlers.py tests/test_handlers.py
git commit -m "feat(vstore): handlers — list_providers/list_embeddings/test_connection/store/find"
```

---

### Task 7: MCP server (FastAPI, / and /mcp) + full suite

**Files:** Create `server.py`; Test `tests/test_server_http.py`.

**Interfaces:**
- Produces `server.create_app(cfg) -> FastAPI` (POST `/` and `/mcp`: `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/*`; dispatch the 5 tools through `_wrap`); `server.main()`.

- [ ] **Step 1: Write the failing test**

Create `mcp_qrant/tests/test_server_http.py`:
```python
import json, pytest
from fastapi.testclient import TestClient
from config import AppConfig
from server import create_app


@pytest.fixture
def client():
    return TestClient(create_app(AppConfig()))


def rpc(method, params=None, id=1):
    return {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}


def _payload(resp):
    return json.loads(resp.json()["result"]["content"][0]["text"])


def test_tools_list_five(client):
    body = client.post("/mcp", json=rpc("tools/list")).json()
    assert {t["name"] for t in body["result"]["tools"]} == {
        "list_providers", "list_embeddings", "test_connection", "store", "find"}


def test_initialize_and_root_alias(client):
    assert client.post("/", json=rpc("initialize")).json()["result"]["serverInfo"]["name"] == "mcp_qrant"
    assert client.post("/mcp", json=rpc("initialize")).status_code == 200


def test_list_providers_call(client):
    payload = _payload(client.post("/mcp", json=rpc("tools/call",
        {"name": "list_providers", "arguments": {}})))
    assert len(payload["providers"]) == 10


def test_unknown_tool_jsonrpc_error(client):
    body = client.post("/mcp", json=rpc("tools/call", {"name": "nope", "arguments": {}})).json()
    assert body["error"]["code"] == -32601
```

- [ ] **Step 2: Run → FAIL** (`ModuleNotFoundError: server`).

- [ ] **Step 3: Implement `server.py`**

```python
from __future__ import annotations

import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from config import AppConfig
from handlers import Handlers

PROTOCOL_VERSION = "2025-06-18"


def _obj(props, required):
    return {"type": "object", "properties": props, "required": required}


TOOLS = [
    {"name": "list_providers", "description": "List available vector-DB providers.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_embeddings", "description": "List embedding models the store node may offer.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "test_connection", "description": "Validate a provider connection.",
     "inputSchema": _obj({"provider": {"type": "string"}, "connection": {"type": "object"}}, ["provider"])},
    {"name": "store", "description": "Embed (unless the provider self-embeds) + upsert chunks.",
     "inputSchema": _obj({"provider": {"type": "string"}, "connection": {"type": "object"},
                          "collection": {"type": "string"},
                          "items": {"type": "array", "items": {"type": "object"}},
                          "embedding": {"type": "string"}}, ["provider", "collection", "items"])},
    {"name": "find", "description": "Semantic search.",
     "inputSchema": _obj({"provider": {"type": "string"}, "connection": {"type": "object"},
                          "collection": {"type": "string"}, "query": {"type": "string"},
                          "limit": {"type": "integer"}, "embedding": {"type": "string"}},
                         ["provider", "collection", "query"])},
]


def _wrap(payload: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


def create_app(cfg: AppConfig) -> FastAPI:
    app = FastAPI(title="mcp_qrant")
    h = Handlers(cfg)

    def ok(i, r): return JSONResponse({"jsonrpc": "2.0", "id": i, "result": r})
    def err(i, c, m): return JSONResponse({"jsonrpc": "2.0", "id": i, "error": {"code": c, "message": m}})

    @app.post("/")
    @app.post("/mcp")
    async def rpc(request: Request):
        body = await request.json()
        i, method, params = body.get("id"), body.get("method"), body.get("params") or {}
        if method == "initialize":
            return ok(i, {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}},
                          "serverInfo": {"name": "mcp_qrant", "version": "0.1.0"}})
        if method is not None and method.startswith("notifications/"):
            return JSONResponse({"jsonrpc": "2.0", "id": i, "result": {}})
        if method == "ping":
            return ok(i, {})
        if method == "tools/list":
            return ok(i, {"tools": TOOLS})
        if method == "tools/call":
            name = params.get("name"); args = params.get("arguments") or {}
            fn = {"list_providers": h.list_providers, "list_embeddings": h.list_embeddings,
                  "test_connection": h.test_connection, "store": h.store, "find": h.find}.get(name)
            if fn is None:
                return err(i, -32601, f"unknown tool '{name}'")
            return ok(i, _wrap(fn(args)))
        return err(i, -32601, f"unknown method '{method}'")

    return app


def main() -> None:  # pragma: no cover
    import uvicorn
    cfg = AppConfig.from_env()
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port)


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: Run focused, then FULL suite (pristine)**

Run: `./.venv/bin/python -m pytest tests/test_server_http.py -v` → PASS.
Run: `./.venv/bin/python -m pytest -v` → ALL pass, **pristine**.

- [ ] **Step 5: Commit**

```bash
git add server.py tests/test_server_http.py
git commit -m "feat(vstore): MCP JSON-RPC server (/ and /mcp) + 5-tool envelope"
```

---

### Task 8: Live smoke + README

**Files:** Create `tests/smoke.sh`, `README.md`.

- [ ] **Step 1: README + smoke script**

Create `README.md` documenting: run (`MCPQ_PORT=8008 ./.venv/bin/python server.py`), the 5 tools, the 10 providers (Qdrant active, 9 coming soon), `embeds_internally` (Qdrant self-embeds; others need an embedding from `list_embeddings`), and that the PHP files are being retired at the remote-Qdrant cutover.

Create `tests/smoke.sh` that boots the server (`MCPQ_PORT=8008`), then via curl: `list_providers` (expect 10), `store` a couple of chunks into a temp Qdrant local path + collection, `find` a query and show the hit. Mirror langfs's smoke.sh start/trap/curl.

- [ ] **Step 2: Run it**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/mcp_qrant/tests && chmod +x smoke.sh && ./smoke.sh`
Expected: `list_providers` → 10 providers; `store` → `{"stored":2,...}`; `find` → a result containing the stored text.

- [ ] **Step 3: Commit**

```bash
git add tests/smoke.sh README.md
git commit -m "test(vstore): live Qdrant store/find smoke + README"
```

---

## Follow-up (separate plans, NOT in this plan)

- **gpt store-node integration:** render the provider list from `list_providers` (Qdrant active, 9 greyed) + dynamic connection form from `connection_schema` + an embeddings dropdown from `list_embeddings` (shown when `embeds_internally:false`); point the store node + `VectorMcpStore` at the new MCP's `store`/`find`. Decide the `qdrant-store`/`qdrant-find` compat alias there. gpt JS/PHP — its own spec→plan cycle.
- **Phase 2 — pgvector:** `stores/pgvector.py` over `langchain_postgres.PGVector` + `embedding.py` factory (instantiate the chosen `list_embeddings` id) + flip `pgvector.json` `available:true`.
- **Phase 3 — remote Qdrant** (connection variant) then the 8 long-tail DBs; retire the PHP `mcp_qrant` files.

## Self-Review

**Spec coverage:** §3 tools (list_providers/list_embeddings/test_connection/store/find) → Tasks 5,6,7. §5 catalog (10, qdrant active) → Task 2. §6 descriptors (+embeds_internally, connection_schema) → Task 2. §7 contract + envelope → Tasks 6,7. §8 per-provider embedding (qdrant self-embeds, no embedder this phase) → Task 4 (`embeds_internally=True`, `embedding` ignored). list_embeddings catalog → Task 5. §9 connection per-request → Task 4/6. §11 Phase 1 = Qdrant functional + 9 listed → Tasks 2,3,4. gpt integration + pgvector + remote = Follow-up. ✓

**Placeholder scan:** none — full code/JSON/commands. The 8 long-tail descriptors are intentionally minimal placeholders (`available:false`), not unfinished work.

**Type consistency:** `VectorStoreProvider.{connect,test_connection,store(conn,collection,items,embedding),find(conn,collection,query,limit,embedding)}` defined in Task 3, implemented in Task 4, called in Task 6. `providers_payload`/`catalog` (Tasks 3,5) consumed by handlers (Task 6) + server (Task 7). `store`→`{stored,errors}`, `find`→`{results:[{text,metadata,score}]}` consistent across Tasks 4/6/test. Envelope `_wrap` + `/`,`/mcp` routes match langfs. ✓

**Deviation noted (resolves spec §13):** Qdrant uses **`qdrant_client[fastembed]`** (`add`/`query` with text), NOT `langchain_qdrant.QdrantVectorStore` — because that's the API that preserves `embeds_internally: true` (Qdrant/FastEmbed embeds, we don't). The LangChain vector-store wrapping (`PGVector`, etc.) applies to the non-self-embedding providers in later phases. Verified against the installed `qdrant-client` 0.8-fastembed API.
