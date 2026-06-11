# RAG / Ingestion Components in the Workflow Editor — Design Spec

- **Date:** 2026-06-10
- **Project:** `gpt` (workflow system: editor + simple language + `compile.py` + `GraphWorkflowRunner` + `LangGraphGenerator` + `langchain_runner`)
- **Status:** Design (from a collaborative design dialogue) — for review before planning

## 1. Goal

Let the existing **workflow editor** also model **ingestion / RAG pipelines** (load → split → embed → store → retrieve) as graphs, alongside today's LLM‑agent workflows. These pipelines **compile to Python (LangChain / LangGraph)** and run in `langchain_runner`; they are **not** interpretable by the PHP `GraphWorkflowRunner`. The editor stays a single canvas — drag *agents* for interpretable graphs, drag *components* for compile‑only ingestion — and the execution target is **inferred**, not chosen by the user.

## 2. Core decisions (locked in the dialogue)

1. **Node runtime tiers.** Every node type declares a capability:
   - `interpretable` — runs on `GraphWorkflowRunner` (today's `start`/`output`/`agent`/`tool`/`skill`).
   - `python-only` — compiles to LangChain/LangGraph, never interpreted (the ingestion components).
   A workflow's **effective target** = `python` if it contains *any* `python-only` node, else `interpretable`. The PHP runner **rejects** a `python` graph with a clear message; it runs in `langchain_runner`.

2. **A new node category: components** — thin wrappers over LangChain primitives, **3 types** (ingestion only):
   `loader`, `splitter`, `vectorstore`.
   - **Embeddings is a property of the `vectorstore`, not a node.** In LangChain the store *owns* its embedding function (`FAISS.from_documents(chunks, embeddings)`) and ingest/query **must** use the same model, which binding it to the store guarantees. So it's an **Embeddings** field on the vectorstore form, never an `embedder` node.
   - **Retrieval is not a component, it's an agent.** A vector store with an **MCP interface** is queried by an ordinary **`agent` + that MCP tool** (the agent node already exists). No `retriever` node.
   - **Multi‑source merging is implicit fan‑in** — multiple edges into a node, like agent fan‑in today (no `merge` node).
   - **Tabular has no separate node** — the `splitter` does row serialization via `strategy: "rows"`.

   Net: the *only* new, compile‑only surface is **ingestion** (`loader → splitter → vectorstore`). The **query side reuses today's interpretable `agent` + MCP** — nothing new, no Python compile.

3. **Connector backends are pluggable: built‑in OR MCP.** `loader.source`, `vectorstore.store`, and `vectorstore.embeddings` resolve to a built‑in LangChain implementation **or** `mcp:<server>` (reusing the existing MCP ecosystem). The generator dispatches: built‑in → LangChain class; `mcp:` → MCP client call (via `langchain-mcp-adapters`).

4. **Typed ports carry a "content kind".** Edges aren't generic `output_1/input_1`; they carry a type (`Document[]:<kind>`, `Embeddings`, `VectorStore`, `Retriever`). `<kind> ∈ { text, markdown, html, code:<lang>, json, rows, binary }`. This drives validation and the auto‑splitter.

5. **Splitter selection is coupled to the loader's content kind.** Mode `manual` (user picks `strategy`) or `auto` (router: group docs by `content_type`, apply the right splitter per group, recombine). Some loaders pre‑split → the splitter is optional. **Tabular/SQL** uses the same `splitter` with `strategy: "rows"` (serialize each row → 1 document), not character chunking.

6. **Single vs multiple sources = fan‑in.** Multiple loaders → a `merge` node → splitter. No new "multi‑source" concept; it's the existing `flow` model.

7. **Compilation shape:** a **linear** ingestion graph emits a **plain LangChain script**; a graph with **branching or agents** emits a **LangGraph `StateGraph`**.

8. **Embeddings online or offline.** `vectorstore.embeddings`: `openai:…`/`gemini:…` (online API) or `ollama:…`/`hf:…` (offline/local). Online and offline both run **server‑side** in `langchain_runner` (neither works in the Pyodide sandbox). **Default to offline/local for sensitive data** (e.g. SQL rows).

## 3. Non‑Goals

- Running ingestion on the PHP interpreter or in Pyodide skills (impossible: no network/compute there).
- A full type system for ports — only the small fixed **content‑kind** set above.
- Building the vector‑store infrastructure itself (FAISS/Chroma/pgvector/Pinecone are external; we integrate, not implement).
- Auto‑sync / CDC for live SQL tables (re‑ingestion strategy is future work — see §10).
- Replacing the simple language or the interpreter — this is additive.

## 4. Component node types

Three **new** ingestion nodes. Embeddings is a **field on the `vectorstore`**, not a node. Retrieval is the **existing `agent` + the store's MCP tool** (not a component). Multi‑source = implicit fan‑in. Tabular = `splitter` with `strategy:"rows"`.

| Node | LangChain target | Key config | Ports (in → out) |
|---|---|---|---|
| `loader` | `PyPDFLoader` / `WebBaseLoader` / `SQLDatabaseLoader` / **MCP** | `source` (`pdf`/`web`/`sql`/`mcp:<srv>`), `path`/`query`/`tool`, `format` | `start` → `Document[]:<kind>` |
| `splitter` | `Recursive…` / `MarkdownHeader…` / `…from_language` / `HTML…` / `RecursiveJson…` / row‑template | `strategy` (`auto` default; `rows` for tabular), `chunk_size`/`max_tokens`, `overlap`, `row_template`/`pk_columns` (when `rows`) | `Document[]:<kind>` (1+ via fan‑in) → `Document[]` |
| `vectorstore` | `FAISS` / `Chroma` / `PGVector` / **MCP** | `store` (`faiss`/`chroma`/`pgvector`/`mcp:<srv>`), `path`/`conn`/`index`, **`embeddings`** (`openai:…`/`ollama:…`/`hf:…`/`mcp:<srv>`) | `Document[]` → `VectorStore` (persisted) |

**Query side (no new node):** an `agent` whose `tools` include the vector store's MCP `retrieve` tool. Runs on the interpreter today.

## 5. Content‑kind types + loader→splitter compatibility

`kind ∈ { text, markdown, html, code:<lang>, json, rows, binary }`, carried as `Document[]:<kind>`.

| Loader kind | Default splitter strategy | Notes |
|---|---|---|
| text | `recursive` | paragraphs→sentences |
| markdown | `markdown_header` | keep sections |
| html | `html_section` | drop boilerplate |
| code:<lang> | `language:<lang>` | split on funcs/classes |
| json | `recursive_json` | keep objects |
| **rows** | **`splitter` strategy `rows`** (serialize each row → 1 doc) | tabular — no character splitting |
| binary (e.g. image PDF) | loader must OCR/emit text first | else not embeddable |

The editor auto‑picks the default when a loader connects to a splitter; the user can override. `strategy: "auto"` defers the choice to runtime (per‑doc routing) for mixed sources.

## 6. Simple‑language + DSL extension

Additive to `{name, description, start, agents, flow}`:
- New top‑level `components: [ { id, type, config, ... } ]`.
- New `node_type` values in the DSL: `loader`, `splitter`, `vectorstore` (the 3 ingestion components).
- New optional top‑level `target: "interpretable" | "python"` — **inferred** by `compile.py` (set to `python` when any component node is present); authors don't set it.
- `flow` edges unchanged in shape; `compile.py` validates **port‑type compatibility** along edges using the content‑kind table.
- **Canvas coordinates:** in the **DSL**, component nodes carry `pos_x`/`pos_y` exactly like agent nodes (the editor draws them at those positions). Two authoring paths, unchanged:
  - **Editor** → coordinates come from where the node is dropped (drawflow is the source of truth).
  - **Simple language** (position‑free) → `compile.py` assigns layout; its topological‑column layout just needs to also place the component node types. The simple language itself stays coordinate‑free.

**Example — pure ingestion (compile‑only):**
```jsonc
{
  "name": "Ingest product manual",
  "start": { "documents": ["manuals/x.pdf"] },
  "components": [
    { "id": "load",  "type": "loader",      "config": { "source": "pdf" } },
    { "id": "split", "type": "splitter",    "config": { "strategy": "auto", "max_tokens": 512 } },
    { "id": "store", "type": "vectorstore", "config": { "store": "pgvector",
                                                        "embeddings": "ollama:nomic-embed-text" } }
  ],
  "flow": [ ["start","load"], ["load","split"], ["split","store"], ["store","output"] ]
}
```
> **Querying it is a separate, normal agent workflow** (interpretable, no components): an `agent` whose `tools` include the `pgvector` store's MCP `retrieve` tool — runs on `GraphWorkflowRunner` today.

## 7. Compilation (`compile.py` + `LangGraphGenerator`)

1. **`compile.py`**: existing validation + **port‑type checks** (loader→splitter kind, splitter→store is `Document[]`). Infers `target`. Emits the DSL with component nodes (with `pos_x`/`pos_y` from the layout).
2. **Target routing**: `target: interpretable` → unchanged (`GraphWorkflowRunner`). `target: python` → `LangGraphGenerator`.
3. **`LangGraphGenerator`** (extended): a **template per node type**; for each connector node, resolve backend:
   - built‑in → emit the LangChain class (`PyPDFLoader(...)`, `RecursiveCharacterTextSplitter(...)`, `FAISS.from_documents(...)`).
   - `mcp:<srv>` → emit an MCP client call (`mcp.call(srv, tool, args)` via `langchain-mcp-adapters`).
   - **Shape**: linear component chain → a plain `def run(inputs): …` script; branching/agents → a `StateGraph` with a node per graph node.

**Generated (MCP‑backed) sketch:**
```python
docs   = mcp.call("gdrive", "list_files", {"query": "folder:Manuals"})   # loader = MCP
docs    = [tag_content_type(d) for d in docs]
chunks = auto_split(docs, max_tokens=512)                                 # splitter routes by kind
store  = PGVector.from_documents(chunks, OllamaEmbeddings(model="nomic-embed-text"), connection=CONN)
# branching/agent present → StateGraph with a retrieval+LLM node
```

## 8. Execution: `langchain_runner` run endpoint

A backend endpoint (e.g. `POST /api/v1/workflows/{id}/run-python`) that:
1. Compiles the workflow to a Python script (LangGraphGenerator).
2. Runs it in the `langchain_runner` venv (subprocess, server‑side — has network, embeddings libs, DB/MCP access).
3. Streams progress (node start/complete) and returns the result (e.g. `{vectorstore, chunks}` for ingestion, or the answer for RAG).

The editor's **Run** button is target‑aware: `interpretable` → existing run‑stream; `python` → this endpoint (shown as **"Compile & run in langchain_runner"**).

## 9. Editor changes

- New **"Data / Ingestion" palette group** (components), visually distinct (compile‑only colour).
- **Per‑node config form** — exactly the same UX as today's **agent node form**: each node has an attached form, and **you set the node's parameters by filling it** (not by editing JSON). The form fields are **generated from that node type's config schema** (§4):
  - `loader` → **Source** (dropdown: built‑ins `pdf`/`web`/`sql` **+ the user's MCP servers** as `mcp:<srv>`), Path/Query/Tool, Format.
  - `splitter` → **Strategy** (`auto` default; `markdown_header`/`language:<lang>`/`rows`/…), Chunk size / Max tokens, Overlap, Row template/PK (when `rows`).
  - `vectorstore` → **Store** (`faiss`/`chroma`/`pgvector` **+ `mcp:<srv>`**), Path/Connection/Index, **Embeddings** (`openai:…`/`ollama:…`/`hf:…`).
  So the **config schema is the single source of truth**: it validates the DSL *and* renders the form — the same way agent fields (provider, instructions, tools…) render today.
  - **Retrieval is not a component form** — it's a normal **agent** node whose `tools` include the vector‑store's MCP retrieve tool (existing agent form, unchanged).
- **Typed ports** with the content‑kind set; connection validation; **auto‑default splitter** on connect (the splitter form's Strategy pre‑fills from the upstream loader's kind).
- Target badge on the canvas (`interpretable` / `python`); Run button adapts.

## 10. Error / edge handling

- **Type mismatch on an edge** (e.g. `VectorStore` into a splitter) → compile error with the offending edge.
- **Interpreter asked to run a `python` graph** → clear rejection ("contains ingestion components — run in langchain_runner").
- **MCP server unavailable** at run → surfaced as a node error in the stream.
- **Binary/scanned PDF** (no extractable text) → loader emits `binary`; compiler warns it needs OCR before embedding.
- **Live SQL staleness** (out of scope to auto‑fix): vectors store the **PK as metadata**; retrieval re‑fetches the authoritative row from SQL. Re‑ingestion is manual/scheduled (future).

## 11. Testing

- `compile.py`: port‑type validation (valid chain passes; mismatched edge fails; target inferred `python` when a component is present). Standalone python assertion tests (as in `workflow-compile/tests`).
- `LangGraphGenerator`: golden‑file tests — a component DSL → expected Python (built‑in path and `mcp:` path); linear → script, branching → StateGraph.
- `langchain_runner` endpoint: a tiny fixture pipeline (load a 1‑page text → split → FAISS in‑memory) runs and returns `{chunks>0}` (no external API — use a local/fake embedder in the test).
- Manual E2E: author an ingestion graph in the editor → compile & run → vector store populated; a mixed graph answers a question.

## 12. Decomposition (for the plan)

1. **Node taxonomy + tiers**: declare `runtime` per node type; `target` inference in `compile.py`; interpreter rejection.
2. **Content‑kind ports + validation** in `compile.py` (the kind set + loader→splitter table + edge‑type checks).
3. **Component schemas** in `schema.json` + the simple language (`components`, the 3 node types `loader`/`splitter`/`vectorstore`, the `built‑in | mcp:` backend strings, `pos_x`/`pos_y`).
4. **`LangGraphGenerator` templates**: one per component; built‑in vs `mcp:` dispatch; linear‑script vs StateGraph shape.
5. **`langchain_runner` run endpoint** + streaming + result.
6. **Editor**: component palette, typed ports + auto‑default splitter, target‑aware Run.
7. **Examples + docs**: a pure‑ingestion and a mixed RAG example pair (simple + compiled).

## 13. Open questions to confirm before planning

1. **Mixed graphs**: confirm "any python‑only node ⇒ whole graph compiles to Python" (LLM agents become LangChain LLM nodes) vs. splitting sub‑graphs. *(Recommend: whole‑graph.)*
2. **Vector store + embeddings defaults**: pgvector (you run MySQL, but pgvector needs Postgres — or FAISS/Chroma on disk) + local embeddings (Ollama) as the privacy default. Confirm the stack.
3. **Port typing strictness**: the fixed content‑kind set only (recommended) vs. richer typing.
4. **Run endpoint**: server‑side subprocess in `langchain_runner` (recommended) vs. download‑and‑run the script.
5. **Scope of v1**: ship **pure ingestion** end‑to‑end — the 3 components (`loader`/`splitter`/`vectorstore`) + generator templates + the `langchain_runner` run endpoint, populating a vector store. The **query side needs no new nodes** (agent + the store's MCP `retrieve` tool, already interpretable), so it's mostly wiring/docs in v2.
