# Simplified Workflow Language → DSL compiler

There are **two** workflow representations in this project:

1. **The full DSL `definition`** — positioned nodes (`pos_x/pos_y`), ports, numeric ids, full agent
   configs. This is what the **visual editor** saves and what `GraphWorkflowRunner` /
   `LangGraphGenerator` consume.
2. **The Simplified Workflow Language** — a compact, position‑free JSON an LLM (or a human) authors
   from intent. It is **compiled into the full DSL** by the `workflow-compile` skill.

> **Where the compiler lives:** the `workflow-compile` skill (folder‑backed Pyodide skill) at
> `~/Documents/synergyAI/skills/workflow-compile/` — `scripts/compile.py`, `references/schema.json`,
> and `references/*.simple.json` / `*.dsl.json` examples. It is **not yet vendored into this repo**
> (see [Vendoring](#vendoring)).

This is the capability behind *"ask in chat to build a workflow and it appears in the editor."*

---

## The simplified language

```jsonc
{
  "name": "...",                 // required
  "description": "...",          // optional
  "start": {
    "prompt": "...",             // required — kickoff prompt
    "documents": []              // optional — paths or full doc objects
  },
  "agents": [                    // required, ≥1 — agents defined INLINE
    {
      "id": "researcher",        // required — referenced by flow; NOT "start"/"output"
      "name": "Research Agent",  // required
      "provider": "openai",      // required — openai | anthropic | kimi | grok | deepseek | gemini
      "instructions": "...",     // required — system prompt
      "tools": [],               // optional — must match references/mcp-catalog.md verbatim (strict)
      "skill": "...",            // optional — inline procedure text (→ DSL skill_content)
      "skill_binding": "html",   // optional — bind a folder-backed skill by dir_name
      "model": "", "max_tokens": 4096, "temperature": 0.7,
      "agent_template_id": null, "output_schema_id": null
    }
  ],
  "flow": [                      // required — directed edges [from, to]
    ["start", "researcher"],
    ["researcher", "output"]
  ]
}
```

**Reserved ids:** `start` (entry; source‑only) and `output` (terminus; target‑only) — exactly one of
each, always emitted. The graph must be a **DAG**; every agent must be reachable from `start` and have
a path to `output`.

**Parallelism is implicit in the edges — there is no `parallel` node to declare:**
- **Fan‑out** = multiple edges from one source → those targets run in parallel.
- **Fan‑in** = multiple edges into one target → it receives all inputs (the compiler sets
  `merge_strategy: "labeled"` automatically).

---

## What `compile.py` does (simple → DSL)

```
simplified JSON  ──▶  compile.py  ──▶  full DSL JSON  ──▶  /outputs/<name>.json  ──▶  editor import
```

1. **Schema validation** — required fields, types, `provider` enum, duplicate‑id detection.
2. **Graph validation** — DAG (no cycles), reachable‑from‑`start`, path‑to‑`output`, ≥1 edge into `output`.
3. **MCP‑tool validation** — every `mcp_*` in any agent's `tools` is checked **verbatim** against
   `references/mcp-catalog.md` (strict allowlist); unknown names are rejected with closest‑match
   suggestions. Empty `tools: []` is always valid.
4. **Layout** — topological columns, left‑to‑right: `start` at `x=61`, columns **330px** apart,
   siblings stacked **175px** apart around `y=250`.
5. **Emit** the full DSL and **write** to the output path. All errors are aggregated on stderr for
   one‑shot self‑correction (exit `1` = validation fail, `2` = bad/missing input, `0` = success).

### Field/structure mapping

| Simplified | Full DSL |
|---|---|
| `start.prompt` (+ `documents`) | one `start` node (`node_type:"start"`, `agent_id:null`, prompt in config) |
| each `agents[i]` | one `agent` node (`node_type:"agent"`, inline config: provider, instructions, `skill_content`, tools, model, max_tokens, temperature, output_schema_id; `agent_id` = `agent_template_id` or null) |
| implicit terminus | one `output` node (`node_type:"output"`, `agent_id:null`) |
| node ids | numeric: `start`→`"1"`, agents→`"2".."n+1"`, `output`→`"n+2"` |
| `flow` edge `[from,to]` | `{ "from": id[from], "to": id[to], "from_port": "output_1" }` |
| fan‑in (≥2 edges → one node) | `merge_strategy: "labeled"` (auto) |
| — | defaults: `runtime_mode:"batch"`, `output_storage_enabled:0`, layout positions |

> Note: the compiled DSL expresses parallelism purely by **graph shape + `merge_strategy`** — it does
> **not** emit a separate `parallel` node (that node type exists in the editor, but the compiler
> doesn't use it). All edges use `from_port:"output_1"`.

---

## The chat → editor flow (the `workflow-compile` skill)

1. User: *"build a workflow that researches crypto and PubMed in parallel and publishes a newspaper."*
2. The model **authors** the simplified JSON (it composes it from intent — it does not ask the user to write JSON).
3. The model calls `run_skill_script` → `compile.py -i /scratch/x.simple.json -o /outputs/x.json`.
4. `compile.py` validates + compiles → full DSL in `/outputs/`. On error, the model reads the
   aggregated list, fixes **all** issues, and recompiles.
5. The user **imports** the DSL into the workflow editor (a future version will POST it to the backend
   directly). It then runs on `GraphWorkflowRunner`.

Any of the **six** providers (openai, anthropic, kimi, grok, deepseek, gemini) can author, because the
only requirement is schema‑conformant structured output + the compiler's validation as the guardrail.

---

## Example — parallel research → synthesis

`flow` does the work; agents are inline:

```json
{
  "name": "Market Briefing",
  "start": { "prompt": "Latest on metals, stocks, cryptocurrencies, and finance/macro." },
  "agents": [
    { "id": "metals",  "name": "Metals Researcher",  "provider": "grok",     "tools": ["mcp_get_financial_news"], "instructions": "Research metals; report facts with sources." },
    { "id": "stocks",  "name": "Stocks Researcher",  "provider": "openai",   "tools": ["mcp_get_financial_news"], "instructions": "Research equities; report moves with sources." },
    { "id": "cryptos", "name": "Crypto Researcher",  "provider": "kimi",     "tools": ["mcp_get_crypto_news"],    "instructions": "Research crypto; confirmed news only, with sources." },
    { "id": "finance", "name": "Finance Researcher", "provider": "gemini",   "tools": ["mcp_get_financial_news"], "instructions": "Research macro/finance; key indicators with sources." },
    { "id": "synth",   "name": "Synthesizer",        "provider": "deepseek", "tools": [],                          "instructions": "Combine the four briefs into ONE document: a section per topic + an executive summary." }
  ],
  "flow": [
    ["start","metals"], ["start","stocks"], ["start","cryptos"], ["start","finance"],
    ["metals","synth"], ["stocks","synth"], ["cryptos","synth"], ["finance","synth"],
    ["synth","output"]
  ]
}
```

`compile.py` turns this into 6 positioned DSL nodes + 9 edges, with `merge_strategy:"labeled"` on
`synth` and `start`→`metals/stocks/cryptos/finance` fanning out in parallel.

---

## Vendoring

The `workflow-compile` skill currently lives only in `~/Documents/synergyAI/skills/` — outside this
repo and outside version control. To make it self‑contained, copy the skill (`SKILL.md`,
`scripts/compile.py`, `references/schema.json`, the `*.simple.json` / `*.dsl.json` examples — but **not**
the auto‑generated `mcp-catalog.md` / `skills-catalog.md`, which are user/runtime‑specific) into the
repo (e.g. `skills/workflow-compile/`) and reference it from `frontend/README.md`.
