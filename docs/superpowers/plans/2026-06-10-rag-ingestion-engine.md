# RAG Ingestion — Plan 1: the Engine (headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A hand‑written DSL with `loader → splitter → vectorstore` nodes compiles to a LangChain script and, run in `langchain_runner`, loads a PDF → recursive‑splits → writes embeddings to **pgvector** — end to end, no UI.

**Architecture:** Add a small parameterized **`ingestion.py`** to `langchain_runner` (load+split+store, the testable core), teach **`LangGraphGenerator`** to emit a call to it for the 3 component node types, and expose a **run endpoint** that generates + executes it (mirroring the existing `generatePython` flow). pgvector is the store; OpenAI is the default embedder.

**Tech Stack:** Python (`langchain`, `langchain-community`, `langchain-postgres`, `pypdf`, `psycopg`), PostgreSQL + `pgvector`, PHP backend (`LangGraphGenerator`, `WorkflowController`).

**Spec:** `docs/superpowers/specs/2026-06-10-rag-ingestion-components-design.md` (this is **Plan 1 of 3**: engine → then authoring `compile.py` → then editor).
**Repo:** `/Applications/XAMPP/xamppfiles/htdocs/gpt` · **Branch:** create `feat/rag-ingestion-engine` off `main`.

---

## Reference facts (verified)

- `LangGraphGenerator.php::generate(int $workflowId, ?string $userId)` (line ~225); node type read via `$n['node_type'] ?? $n['type'] ?? $cfg['type']` (line ~50). Emits Python that lives under `langchain_runner/` (referenced at line ~14).
- `langchain_runner/` is a Python package: `main.py` (CLI, argparse/sys.argv), `graph_builder.py`, `code_generator.py`, `mcp_tools.py`, `script_io.py`, plus generated workflow scripts (e.g. `my_newspaper_journal.py`).
- Existing endpoint: `generatePython` (routes.php ~291; `WorkflowController` ~235/280) → `LangGraphGenerator::generate`.
- **v1 strict minimum:** `loader(source=pdf)` → `splitter(strategy=recursive)` → `vectorstore(store=pgvector, embeddings=openai:text-embedding-3-small)`. Built‑in only; no MCP, no auto‑splitter, no SQL/rows.

---

## Task 1: Provision Postgres + pgvector + Python deps

**Files:** Modify `backend/.env.example`; Create `langchain_runner/requirements-ingestion.txt`.

- [ ] **Step 1 (infra — operator action, documented):** Stand up Postgres with the `pgvector` extension. Locally:
```bash
# Postgres must be running; then once per database:
psql "$VECTOR_DB_DSN" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```
Set the DSN env var (psycopg3 / SQLAlchemy form):
`VECTOR_DB_DSN=postgresql+psycopg://user:pass@localhost:5432/vectordb`

- [ ] **Step 2:** Add the var to `backend/.env.example` (no secret — placeholder):
```
# Vector store for RAG ingestion (Plan 1). Postgres + pgvector.
VECTOR_DB_DSN=postgresql+psycopg://user:pass@localhost:5432/vectordb
```

- [ ] **Step 3:** Create `langchain_runner/requirements-ingestion.txt`:
```
langchain-community>=0.3
langchain-postgres>=0.0.12
langchain-openai>=0.2
pypdf>=4.0
psycopg[binary]>=3.1
```

- [ ] **Step 4: Install into the venv + verify import:**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/langchain_runner
.venv/bin/pip install -q -r requirements-ingestion.txt
.venv/bin/python -c "from langchain_postgres import PGVector; from langchain_community.document_loaders import PyPDFLoader; print('deps OK')"
```
Expected: `deps OK`.

- [ ] **Step 5: Commit:**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/.env.example langchain_runner/requirements-ingestion.txt
git commit -m "chore(ingestion): pgvector + ingestion python deps + VECTOR_DB_DSN

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `langchain_runner/ingestion.py` — load + split (TDD core)

**Files:** Create `langchain_runner/ingestion.py`; Create `langchain_runner/tests/test_ingestion.py`.

- [ ] **Step 1: Write the failing test** — `langchain_runner/tests/test_ingestion.py`:
```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ingestion import load_and_split

def test_load_and_split_text(tmp_path):
    p = tmp_path / "doc.txt"
    p.write_text(("Para one. " * 200) + "\n\n" + ("Para two. " * 200), encoding="utf-8")
    chunks = load_and_split({"source": "text", "path": str(p)},
                            {"strategy": "recursive", "chunk_size": 500, "overlap": 50})
    assert len(chunks) > 1
    assert all(hasattr(c, "page_content") for c in chunks)
    assert all(len(c.page_content) <= 700 for c in chunks)  # ~chunk_size + slack
    print(f"load_and_split: {len(chunks)} chunks — PASS")

if __name__ == "__main__":
    import tempfile, pathlib
    test_load_and_split_text(pathlib.Path(tempfile.mkdtemp()))
```

- [ ] **Step 2: Run it — expect FAIL** (no module):
`cd /Applications/XAMPP/xamppfiles/htdocs/gpt && langchain_runner/.venv/bin/python langchain_runner/tests/test_ingestion.py`
Expected: `ModuleNotFoundError: No module named 'ingestion'`.

- [ ] **Step 3: Create `langchain_runner/ingestion.py`** (load_and_split is the v1 surface; `ingest` adds the pgvector write):
```python
"""RAG ingestion (Plan 1, v1 strict minimum): load a document, recursive-split,
write to pgvector. Backends are fixed for v1 (pdf/text loader, recursive splitter,
pgvector store, OpenAI embeddings)."""
import os
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter


def load_and_split(loader_cfg, splitter_cfg):
    """Return a list of LangChain Documents. No DB / no network (testable)."""
    source = loader_cfg.get("source", "pdf")
    path = loader_cfg["path"]
    if source == "pdf":
        docs = PyPDFLoader(path).load()
    elif source == "text":
        docs = TextLoader(path, encoding="utf-8").load()
    else:
        raise ValueError(f"v1 supports source 'pdf'|'text', got {source!r}")
    if splitter_cfg.get("strategy", "recursive") != "recursive":
        raise ValueError("v1 supports splitter strategy 'recursive' only")
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=int(splitter_cfg.get("chunk_size", 1000)),
        chunk_overlap=int(splitter_cfg.get("overlap", 150)),
    )
    return splitter.split_documents(docs)


def _embeddings(spec):
    """spec like 'openai:text-embedding-3-small' (v1 default)."""
    provider, _, model = (spec or "openai:text-embedding-3-small").partition(":")
    if provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(model=model or "text-embedding-3-small")
    raise ValueError(f"v1 supports embeddings provider 'openai', got {provider!r}")


def ingest(loader_cfg, splitter_cfg, store_cfg):
    """Full pipeline: load → split → write to pgvector. Returns a summary dict.
    Needs VECTOR_DB_DSN + a reachable pgvector DB (integration / E2E)."""
    from langchain_postgres import PGVector
    chunks = load_and_split(loader_cfg, splitter_cfg)
    if store_cfg.get("store", "pgvector") != "pgvector":
        raise ValueError("v1 supports store 'pgvector' only")
    dsn = os.environ.get("VECTOR_DB_DSN")
    if not dsn:
        raise RuntimeError("VECTOR_DB_DSN is not set")
    collection = store_cfg.get("collection") or store_cfg.get("index") or "default"
    PGVector.from_documents(
        documents=chunks,
        embedding=_embeddings(store_cfg.get("embeddings")),
        collection_name=collection,
        connection=dsn,
        use_jsonb=True,
    )
    return {"store": "pgvector", "collection": collection, "chunks": len(chunks)}
```

- [ ] **Step 4: Run the test — expect PASS:**
`langchain_runner/.venv/bin/python langchain_runner/tests/test_ingestion.py`
Expected: `load_and_split: <N> chunks — PASS`.

- [ ] **Step 5: Commit:**
```bash
git add langchain_runner/ingestion.py langchain_runner/tests/test_ingestion.py
git commit -m "feat(ingestion): load_and_split + ingest(pgvector) module + node test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `LangGraphGenerator` emits the ingestion call for component nodes

**Files:** Modify `backend/src/AgentTeam/Services/LangGraphGenerator.php`.

- [ ] **Step 1: Read the live code first.** Read `LangGraphGenerator.php::generate()` (~225+) and the node‑type dispatch around line ~50 and wherever it iterates nodes to emit Python. Identify (a) how it currently switches on `node_type` (agent/tool/skill), and (b) where the emitted script's body is assembled.

- [ ] **Step 2:** Add a branch: when the graph's nodes are the **3 component types** (`loader`,`splitter`,`vectorstore`) in a linear `start→loader→splitter→vectorstore→output` flow, emit a script that calls `ingestion.ingest(...)` with the nodes' `config`. Emit (follow the file's existing string‑building style):
```php
// Pseudocode of the emitted Python (build this string in generate()):
// import sys; sys.path.insert(0, <langchain_runner dir>)
// from ingestion import ingest
// result = ingest(
//   { "source": <loader.config.source>, "path": <start.documents[0] or loader.config.path> },
//   { "strategy": <splitter.config.strategy>, "chunk_size": <…>, "overlap": <…> },
//   { "store": <vectorstore.config.store>, "embeddings": <vectorstore.config.embeddings>,
//     "collection": <vectorstore.config.collection ?? workflow name slug> },
// )
// print(json.dumps(result))
```
Pull each value from the node `config` (use the node‑config accessor the file already uses for agents). Slug the workflow name for the default collection. Keep the existing agent/tool/skill path untouched — only add the component branch.

- [ ] **Step 3: Verify** PHP syntax + a quick generation smoke (if `generate()` is callable in isolation, otherwise defer to Task 4's endpoint):
```bash
php -l backend/src/AgentTeam/Services/LangGraphGenerator.php && echo "php OK"
grep -nE "ingestion|ingest\(|loader|splitter|vectorstore" backend/src/AgentTeam/Services/LangGraphGenerator.php | head
```
Expected: `php OK`; the component branch present.

- [ ] **Step 4: Commit:**
```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php
git commit -m "feat(langgraph-gen): emit ingestion.ingest() for loader/splitter/vectorstore graphs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Run endpoint — generate + execute in `langchain_runner`

**Files:** Modify `backend/src/routes.php`; Modify `backend/src/AgentTeam/Controllers/WorkflowController.php`.

- [ ] **Step 1: Read** `WorkflowController::generatePython` (~235) and `GraphWorkflowRunner` exec usage (~1700/2639) to follow the existing "write script + run python" pattern + how the venv python is located.

- [ ] **Step 2:** Add `WorkflowController::runIngestion(array $request)`: (a) call `LangGraphGenerator::generate()` to produce the ingestion script; (b) write it under `langchain_runner/`; (c) run it with the venv python via `proc_open`/`exec` (the pattern from GraphWorkflowRunner), passing `VECTOR_DB_DSN` + the LLM/OpenAI key in the env; (d) capture stdout (the `json.dumps(result)`), return it as JSON `{ success, result }`. On non‑zero exit, return the stderr.

- [ ] **Step 3:** Register the route in `routes.php` next to `generatePython`: `POST /api/v1/workflows/{id}/run-ingestion` → `WorkflowController@runIngestion`.

- [ ] **Step 4: Verify:**
```bash
php -l backend/src/AgentTeam/Controllers/WorkflowController.php && php -l backend/src/routes.php && echo "php OK"
grep -nE "runIngestion|run-ingestion" backend/src/routes.php backend/src/AgentTeam/Controllers/WorkflowController.php
```
Expected: `php OK`; route + method present.

- [ ] **Step 5: Commit:**
```bash
git add backend/src/routes.php backend/src/AgentTeam/Controllers/WorkflowController.php
git commit -m "feat(api): POST /workflows/{id}/run-ingestion — generate + run in langchain_runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: End-to-end verification (needs Postgres+pgvector + an OpenAI key)

- [ ] **Step 1: Direct pipeline test** (proves load→split→pgvector without the editor). With `VECTOR_DB_DSN` + `OPENAI_API_KEY` set and a sample PDF at `/tmp/sample.pdf`:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
langchain_runner/.venv/bin/python -c "
from ingestion import ingest
print(ingest({'source':'pdf','path':'/tmp/sample.pdf'},
             {'strategy':'recursive','chunk_size':1000,'overlap':150},
             {'store':'pgvector','embeddings':'openai:text-embedding-3-small','collection':'smoke'}))
"
```
Expected: `{'store': 'pgvector', 'collection': 'smoke', 'chunks': <N>}` and rows in the pgvector collection:
`psql "$VECTOR_DB_DSN" -c "SELECT count(*) FROM langchain_pg_embedding;"` → > 0.

- [ ] **Step 2: Endpoint test** — insert a minimal ingestion DSL (3 component nodes) for a workflow id (via DB or the create API), then:
`curl -XPOST .../api/v1/workflows/{id}/run-ingestion` → `{ success:true, result:{ chunks>0 } }`.

- [ ] **Step 3: Commit** any fixes:
```bash
git add -A && git commit -m "test(ingestion): e2e fixes"
```

---

## Done — outcome

A 3‑component ingestion DSL → `LangGraphGenerator` → a `langchain_runner` script → `ingestion.ingest()` loads a PDF, recursive‑splits, and writes embeddings to **pgvector**, reachable via `POST /workflows/{id}/run-ingestion`. The `load_and_split` core is node‑tested. **Next plans:** authoring (`compile.py` simple→DSL for the 3 nodes + layout), then the editor (3 nodes + editable forms).
