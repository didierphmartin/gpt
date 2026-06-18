# Dual‑Mode Ingestion — Overview (human‑readable)

> Companion to the synthetic spec `2026-06-14-dual-mode-ingestion-spec.md`. This
> document explains the *why* and the shape of the design in plain language. The
> spec document is the terse, technical source of truth for implementation. The
> **execution semantics** (event‑driven loop, loader‑as‑iterator, the two faithful
> lowerings) are in `2026-06-18-ingestion-execution-model.md`.

## What we're building, in one sentence

Give the ingestion pipeline the **same two modes the agent workflows already
have** — an **interpreted** mode you run with the ▶ button to watch it work
stage by stage, and a **compile** mode that exports a standalone Python script —
while changing as little as possible and reusing what already exists.

## Why two modes

Today an ingestion workflow can only be **compiled**: you press a button and get
a `.py` file that runs on the server. That's great for production (portable,
runs on a cron box), but it's a black box while you're *authoring* — you can't
see what the loader actually read or what the splitter produced without running
the whole thing server‑side.

The agent workflows solved this long ago: **interpreted is the default** (press
▶ and watch each node light up as it runs), and **compile** is a menu on the end
node for when you want the exported artifact. We're simply giving ingestion the
same two doors.

## The key realization: interpreting means running in the browser

For agents, "interpret" means the *backend* runs the workflow and streams
progress back. For ingestion we want something more interactive — actually
**run the pipeline in the browser**, cell by cell, like a Python notebook — so
you see the real documents and the real chunks at each step.

That's possible because your **skills already run Python in the browser via
Pyodide**. So:

- **Loader** and **Splitter** run **in Pyodide** (pure‑Python libraries:
  `pypdf`, `docx2txt`, the text splitter). You watch `docs` then `chunks` appear.
- **Vector store** can't run in the browser — a browser can't hold a database
  connection or safely hold API keys — so that one step makes a single
  **authenticated call back to the server**, which does the embedding and the
  write. This is exactly the pattern your `geo-content` skill already uses
  (`pyfetch` to a backend endpoint).

So interpreted ingestion is a **hybrid**: browser for the cheap, visible work;
one server hop for the part that needs the database and the keys. Nothing
sensitive ever lives in the browser.

## What it looks like to the user

1. Press **▶** on the start node.
2. The **Loader** node glows **orange** (running), then **green** (done) — and
   its Output tab now shows the *actual text it read*.
3. The **Splitter** glows orange → green — its Output tab shows the *actual
   chunks*.
4. The **Vector store** glows orange while the server embeds + stores, then
   green — its Output shows how many chunks were written.
5. If anything fails, that node glows **red** and its Output tab shows the
   error. A reset button clears it; an abort button stops a run in progress.

This is the **identical orange/red/green behavior** the agent workflows use — we
reuse that machinery rather than inventing a parallel one.

To **export** instead of run, use the end node's existing **"langGraph‑Python"
menu** (it already has an ingestion variant) — that's compile mode, unchanged.

## How the two modes stay in sync (and cheap to maintain)

We keep **one compiler**. The per‑node code chunks we already generate are the
same in both modes for loading and splitting. **Only the store step differs**:

- **Compile** writes the real Python (`PGVector` / the MCP adapter) into the
  standalone script.
- **Interpret** writes a tiny "call the server" cell instead.

So adding the second mode doesn't fork the codebase — it adds one branch at one
step. (One open question we'll settle with a quick experiment: whether the heavy
`langchain` loader libraries load in the browser, or whether we should use the
lighter pure‑Python loaders everywhere. Either way the structure is the same.)

## The store is now "your vector database," not "pgvector"

Instead of hardcoding pgvector, the **store node lists the vector‑database MCP
servers you've registered** — using the *same* "Add MCP server" tool you already
have. The dropdown is **filtered by description** so only vector‑DB servers show
(not every MCP server you own). You register two or three vector DBs once; the
store node lets you pick which one. The server‑side step (and the compiled
script) talks to whichever one you chose.

## Node forms match the agent forms

The loader/splitter/store editing forms will use the **same modal and tabs as
the agent node forms** — same chrome, same Settings tab for the fields, same
Input/Output tabs — so the whole editor feels consistent. We retire the
one‑off ingestion modal in favor of the shared one.

## We start with a small experiment, not the feature

Before building, a tiny **spike** (you already have a `frontend/spike/` folder)
loads the loader + splitter libraries in Pyodide, runs them on a sample file,
and calls a stub server endpoint. That proves the risky assumptions — *do the
libraries load? does data flow from one cell to the next?* — in an afternoon,
before we commit to the full build. Lowest‑risk way in.

## Scope of the first version

Keep it to the path that already works: PDF/Word/Text loaders, the recursive
splitter, and storing into a registered vector‑DB MCP server. Everything else
(more loader types, auto‑splitting by file type, more stores) stays for later —
the architecture is built to extend, but v1 stays small.

## What we reuse vs. what's new

**Reused:** the agent glow machine (orange/green/red, reset, abort), the agent
node‑form modal/tabs, the MCP registration + listing, the Pyodide runner, the
existing `IngestionCompiler`, and the end‑node compile menu.

**New (small):** a browser‑side orchestrator that runs the cells in order and
drives the glow; a way for Pyodide cells to share variables between runs; one
backend endpoint that embeds + stores; the vector‑DB dropdown; and one extra
branch in the compiler for the "call the server" store cell.
