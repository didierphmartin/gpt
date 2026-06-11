# RAG Ingestion — Editor (3 nodes + forms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. **Verification is manual/visual** (no frontend unit runner) — the goal is a UX you can eyeball.

**Goal:** Add the 3 ingestion component nodes (`loader`, `splitter`, `vectorstore`) to the workflow editor — a palette section, draggable onto the canvas, each with an **editable config form** — so the ingestion UX can be checked against the existing agent UX.

**Architecture:** Mirror the existing **agent/start/output** node pattern in `workflow-editor.js`: a palette card (`renderAgentsPanel`), a drop→create branch (the `node-type` drop handler ~5328), a canvas node render, and a config modal (the `node-config-hint` ⚙). Component nodes get a distinct colour and type‑specific form fields. Nothing about the engine/compile changes here — this is editor‑only.

**Tech Stack:** vanilla JS (`workflow-editor.js`, ~13k lines), Drawflow, the editor's existing node/modal system. **No unit runner — `node --check` + manual.**

**Spec:** `docs/superpowers/specs/2026-06-10-rag-ingestion-components-design.md` (§4 node configs, §9 forms). This is the **editor slice** (engine already in PR #4; authoring `compile.py` is a later plan).
**Repo:** `/Applications/XAMPP/xamppfiles/htdocs/gpt` · **Branch:** `feat/rag-ingestion-editor` (already created off `main`).

---

## Reference facts (verified)

- Palette built in `renderAgentsPanel()` (~242). ESSENTIALS section (~276): cards are `<div class="workflow-agent-card special <type>-node" draggable="true" data-node-type="start|output">` with `.agent-icon` + `.agent-info(.agent-name/.agent-type)`. Agent cards `data-node-type="agent"` (~783).
- Drag: `dragstart` sets `e.dataTransfer.setData('node-type', card.dataset.nodeType)` (~5308). Drop: reads `getData('node-type')` (~5328) and creates the node.
- Node config opens via `.node-config-hint` ⚙ in the node template (~5396 / ~6109).
- The 3 component config schemas (spec §4):
  - `loader`: `source` (v1: `pdf`), `path`.
  - `splitter`: `strategy` (v1: `recursive`), `chunk_size` (1000), `overlap` (150).
  - `vectorstore`: `store` (v1: `pgvector`), `embeddings` (`openai:text-embedding-3-small`), `collection`.

---

## Task 1: Ingestion palette section + 3 draggable cards

**Files:** Modify `frontend/assets/js/workflow-editor.js` (`renderAgentsPanel`).

- [ ] **Step 1:** Read `renderAgentsPanel()` (~242–360) — the ESSENTIALS section markup (~276–300) and how sections/cards are structured + how `collapsedSections` works.
- [ ] **Step 2:** After the ESSENTIALS section (before the AGENTS section), insert a new **"Ingestion"** section mirroring the ESSENTIALS markup, with 3 cards (use a distinct class `ingestion-node` for colour):
```javascript
`<div class="workflow-section">
   <div class="workflow-section-header" data-section="ingestion">
     <span class="section-toggle">${collapsedSections.ingestion ? '▶' : '▼'}</span>
     <span class="section-title">Ingestion</span>
     <span class="section-count">3</span>
   </div>
   <div class="workflow-section-content ${collapsedSections.ingestion ? 'collapsed' : ''}" data-section="ingestion">
     <div class="workflow-agent-card special ingestion-node" draggable="true" data-node-type="loader">
       <div class="agent-icon">📥</div><div class="agent-info"><div class="agent-name">Loader</div><div class="agent-type">Load a document (PDF)</div></div></div>
     <div class="workflow-agent-card special ingestion-node" draggable="true" data-node-type="splitter">
       <div class="agent-icon">✂️</div><div class="agent-info"><div class="agent-name">Splitter</div><div class="agent-type">Chunk the text</div></div></div>
     <div class="workflow-agent-card special ingestion-node" draggable="true" data-node-type="vectorstore">
       <div class="agent-icon">🗄️</div><div class="agent-info"><div class="agent-name">Vector store</div><div class="agent-type">Embed → pgvector</div></div></div>
   </div>
 </div>`
```
Make sure `collapsedSections.ingestion` is handled like the others (it'll be `undefined` → expanded, which is fine).
- [ ] **Step 3: Verify:** `node --check frontend/assets/js/workflow-editor.js && echo OK`; `grep -n 'data-node-type="loader"' frontend/assets/js/workflow-editor.js`.
- [ ] **Step 4: Commit:** `git add frontend/assets/js/workflow-editor.js && git commit -m "feat(editor): ingestion palette section (loader/splitter/vectorstore cards)"`

---

## Task 2: Create the 3 node types on drop

**Files:** Modify `frontend/assets/js/workflow-editor.js` (the `node-type` drop handler ~5328).

- [ ] **Step 1:** Read the drop handler from ~5328 — how it branches on `nodeType` to create `start`/`output`/`agent` Drawflow nodes (the `addNode` call: inputs/outputs count, the node's `data` object, the node HTML/template, position).
- [ ] **Step 2:** Add a branch for `loader`/`splitter`/`vectorstore`. Each is a 1‑in/1‑out node (loader: 1 in from start, 1 out; splitter: 1/1; vectorstore: 1/1) with a default `config`:
```javascript
const INGESTION_DEFAULTS = {
  loader:      { source: 'pdf', path: '' },
  splitter:    { strategy: 'recursive', chunk_size: 1000, overlap: 150 },
  vectorstore: { store: 'pgvector', embeddings: 'openai:text-embedding-3-small', collection: '' },
};
// in the drop branch for these types: build the node data { node_type: nodeType, name: <Label>, config: {...INGESTION_DEFAULTS[nodeType]} }
// and add it via the SAME addNode/drawflow call the agent path uses (1 input, 1 output, the component node HTML from Task 3).
```
Mirror exactly how the agent branch builds + registers the node (so connections, the ⚙ hint, and saving all work). Reuse the node‑HTML builder from Task 3.
- [ ] **Step 3: Verify:** `node --check …` ; grep the new branch.
- [ ] **Step 4: Commit:** `git commit -am "feat(editor): create loader/splitter/vectorstore nodes on drop"`

---

## Task 3: Component node template + colour

**Files:** Modify `frontend/assets/js/workflow-editor.js` (node HTML builder) + `frontend/assets/css/workflow-editor.css`.

- [ ] **Step 1:** Find the function that builds an agent node's canvas HTML (the template containing `.node-config-hint` ~5396). Add a builder (or branch) for component nodes: a header with the icon + name + the **`.node-config-hint` ⚙** (so the existing config‑open wiring fires) and a one‑line `.node-config-display` summarising config (e.g. loader → `pdf`, splitter → `recursive 1000/150`, vectorstore → `pgvector`).
- [ ] **Step 2:** Add CSS in `workflow-editor.css` for a distinct ingestion colour:
```css
.drawflow-node.loader, .drawflow-node.splitter, .drawflow-node.vectorstore { border-color:#0ea5e9; }
.drawflow-node.loader .drawflow_content_node, .drawflow-node.splitter .drawflow_content_node,
.drawflow-node.vectorstore .drawflow_content_node { background:#f0f9ff; }
.workflow-agent-card.ingestion-node .agent-icon { background:#e0f2fe; }
```
(Match the real Drawflow node class names you find when reading the agent template — adjust selectors accordingly.)
- [ ] **Step 3: Verify:** `node --check …`; grep the component template branch.
- [ ] **Step 4: Commit:** `git commit -am "feat(editor): component node template + ingestion colour"`

---

## Task 4: Editable config form per component type

**Files:** Modify `frontend/assets/js/workflow-editor.js` (the node‑config modal).

- [ ] **Step 1:** Find how the agent config modal opens from `.node-config-hint` and how it renders fields + **saves back into the node's `data.config`**. (Search for where the ⚙ click handler is wired and the agent form's Save writes to the node.)
- [ ] **Step 2:** Add a config form per component type (rendered when the clicked node's `node_type` is `loader`/`splitter`/`vectorstore`). All fields **editable**, pre‑filled from the node's current `config`:
  - `loader`: Source `<select>` (v1: just `pdf`) + Path `<input>`.
  - `splitter`: Strategy `<select>` (v1: `recursive`) + Chunk size `<input type=number>` + Overlap `<input type=number>`.
  - `vectorstore`: Store `<select>` (v1: `pgvector`) + Embeddings `<input>` (default `openai:text-embedding-3-small`) + Collection `<input>`.
  On **Save**, write the field values back into `node.data.config` (the same mechanism the agent form uses) and refresh the node's `.node-config-display`.
- [ ] **Step 3: Verify:** `node --check …`; grep the component form.
- [ ] **Step 4: Commit:** `git commit -am "feat(editor): editable config forms for loader/splitter/vectorstore"`

---

## Task 5: Cache‑bust + manual UX check

- [ ] **Step 1:** Bump the `workflow-editor.js` (and `workflow-editor.css` if present) cache version in `frontend/index.html` (e.g. `?v=20260610-ingestion`).
- [ ] **Step 2: Static:** `node --check frontend/assets/js/workflow-editor.js && echo OK`; confirm all symbols present (the section, the 3 cards, the drop branch, the template branch, the 3 forms).
- [ ] **Step 3: Manual UX (you):** hard‑refresh → open the workflow editor → confirm: the **Ingestion** palette section shows 3 cards; dragging **Loader/Splitter/Vector store** onto the canvas creates a node (distinct colour, ⚙ config hint); clicking ⚙ opens a form with the right **editable** fields; editing + Save updates the node summary; nodes connect start→loader→splitter→vectorstore→output. **This is the conformance check.**
- [ ] **Step 4: Commit** any fixes from the visual check.

---

## Done — outcome

The workflow editor has an **Ingestion** palette with `loader/splitter/vectorstore`, draggable onto the canvas with a distinct look and **editable config forms** — same UX shape as agent nodes — so the ingestion modelling can be visually verified before wiring it to the engine (PR #4) and the `compile.py` authoring path.
