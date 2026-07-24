# PHP → TypeScript Porting Gap Audit: "Compile to Python" Generators

Scope: the three workflow-builder services that compile a saved workflow DSL into a
standalone, self-contained Python script (MAF / ADK / LangGraph frameworks) which later
runs externally, orchestrating a multi-agent AI run. This audit compares the PHP
originals (`backend/src/AgentTeam/Services/`) against the TypeScript port
(`backend_typescript/src/AgentTeam/`) to size the remaining porting work.

Audited on branch `feat/ts-workflow-parity` (backend_typescript is untracked / WIP —
no git history exists for it yet, so all TS gaps below were found by direct code
comparison, not `git log`).

## Summary table

| Generator | PHP LOC | TS LOC | TS status | Effort estimate |
|---|---|---|---|---|
| **LangGraphGenerator** | 1,543 (`LangGraphGenerator.php`) + shares 535-line `PythonEmitHelpers.php` | 1,070 (`LangGraphGenerator.ts`) + 22-line-but-~35KB `pyBlocks.ts` | Exists, but **behind** — missing the mandatory skill-step pipeline, Output-node storage toggle, inline HTML-deliverable extraction on save, and the `_langgraph` filename suffix | 2–3 days to reach parity |
| **ADKGenerator** | 963 (`ADKGenerator.php`) | 0 — file does not exist | **Missing entirely** | 4–6 days |
| **MAFGenerator** | 628 (`MAFGenerator.php`) | 0 — file does not exist | **Missing entirely** | 3–4 days |
| **PythonEmitHelpers** (shared PHP helper class, used by all 3) | 535 | Partially covered by `pyBlocks.ts` (~35KB of string constants, but shaped only for LangGraph/LangChain, not the shared ADK/MAF-reusable form) | Partial | included in above (shared-block extraction, ~0.5–1 day, amortized) |

**Rough total remaining effort: ~9–13 days** (LangGraph parity fixes + full ADK port +
full MAF port + controller/route wiring + shared-helper extraction), assuming one
engineer familiar with the existing TS LangGraph port. ADK is the largest single new
port (963 PHP lines, most complex skill/session-state model); MAF is mid-sized but
lower logic complexity (functional API, thinner orchestration layer).

---

## 1. LangGraphGenerator

- **PHP file**: `backend/src/AgentTeam/Services/LangGraphGenerator.php` — 1,543 lines
  (plus shared `PythonEmitHelpers.php`, 535 lines, used by all three generators)
- **TS file**: `backend_typescript/src/AgentTeam/LangGraphGenerator.ts` — 1,070 lines,
  plus `backend_typescript/src/AgentTeam/pyBlocks.ts` (22 top-level `export const`
  string blocks, ~35KB of embedded Python)
- **TS status**: exists, controller/route wired, and the file's own header comment
  states intent to be "BYTE-FOR-BYTE identical to the PHP generator's output" — but it
  is **behind current PHP** on several load-bearing recent fixes (see below). The
  TS file predates PHP's most recent skill-architecture rewrite.

### What the PHP emits (structure/shape)

Single Python script built via `implode()` of ordered code blocks:
1. Header/docstring + imports (LangChain / LangGraph / httpx / pydantic)
2. `MCP_SERVERS` / `TOOL_CATALOG` dicts baked from the analyzed workflow, MCP JSON-RPC
   client (`PythonEmitHelpers::mcpClientBlock()`)
3. `build_tools_from_catalog()` — wraps MCP tools as LangChain `StructuredTool`s
4. Document converter block (attachment → markdown)
5. Skill runtime: `PythonEmitHelpers::skillDepsBlock()` (SKILLS_DIR + dependency
   install) + `PythonEmitHelpers::skillFsSyncBlock()` (bucketed `/outputs`+`/scratch`,
   virtual-path remap, `input_files` staging, `read_outputs` stash) — shared with
   ADK/MAF — plus LangGraph-specific `RUN_SKILL_SCRIPT_TOOL` (`StructuredTool` +
   `create_model` args schema)
6. `AGENTS` dict (per-node provider/model/temperature/max_tokens/system_prompt/
   tool_names/**skills**) + `_make_llm()` provider factory
7. `WFState` TypedDict, `build_context()`, `parents()/children()` topology helpers
8. `run()`: builds a `StateGraph`, one node-factory per node type (`start` / `agent` /
   `output`), wires edges from `EDGES` respecting topological order, compiles, invokes
9. `__main__`: reads `sys.argv` prompt, runs, prints `FINAL OUTPUT`, then — **inline** —
   honors `OUTPUT_STORAGE_ENABLED`/`OUTPUT_FOLDER`, extracts
   `<!doctype html>…</html>` out of the final text via regex before saving, and writes
   to `~/Documents/synergyAI/outputs/<folder>/<id>-<slug>_<ts>.<html|md>`

### Recent fixes (from git log / grep) — PHP has vs TS has

| Fix | PHP has it | TS has it |
|---|---|---|
| temperature/max_tokens baked **verbatim** from the agent form (no 32000 substitution patch) | Yes (`b1d2395`) | Yes — `agentTemperature`/`agentMaxTokens` read straight from `cfg.settings`, no override |
| `serialize_precision` fix (temps emit as `0.6`, not 54-digit float) | Yes — `ini_set('serialize_precision', '-1')` at emit entry (`a6941a8`) | Yes, but via a different (correct) mechanism: TS reimplements PHP's *exact* `serialize_precision=100` float expansion in `phpFloatExact()`/`jsonEncode()` rather than forcing `-1`; net effect matches the shortest-round-trip literal for well-behaved values. Verified equivalent behavior for `0.6`-class temperatures. |
| Kimi K2 thinking-mode disabled + temp 0.6 hardcoded | Yes (`case 'kimi'` branch, `extra_body.thinking.disabled`) | Yes — `LangGraphGenerator.ts:294` `case 'kimi':` + emitted `kwargs["temperature"] = 0.6` / `model_kwargs.extra_body.thinking.disabled` matches PHP |
| HTML deliverable extraction (`<!doctype html>...</html>` regex) before saving | Yes — inline in `__main__` (`d363fd7`) | **No** — TS `__main__` (in `pyBlocks.ts` `runBodyBlock`) delegates to an external `from script_io import write_output` helper with a comment claiming "auto HTML/MD detection", and has **no** `OUTPUT_STORAGE_ENABLED`/`OUTPUT_FOLDER` handling and no inline regex extraction at all |
| Honor Output-node storage setting (enabled/folder) | Yes (`7a7044f`, `WorkflowGraphAnalyzer::isOutputStorageEnabled()`) | **No** — `OUTPUT_STORAGE_ENABLED`/`OUTPUT_FOLDER` do not appear anywhere in `LangGraphGenerator.ts` or `pyBlocks.ts` |
| Readable run logs (node/step labeling) | Yes — LangGraph already had per-node `print(f"[node] [{n}] ...")` with tool count/provider/model before the ADK/MAF readable-log fix landed | Yes — `runBodyBlock` in `pyBlocks.ts` carries the same `[node] [{n}] start/inputs/done/output head/⚠` print statements, matching PHP closely (this part IS current) |
| Mandatory per-skill run logging + skill pipeline | Yes — `for _skill in ad.get("skills", []): text = await _run_skill_step(_skill, text, LLMS[n]); print(f"[node] [{n}] after skill ...")` (ported from ADK via `bde5afb`) | **No** — TS `AGENTS` dict never includes a `skills` key (`grep` for `.skills`/`'skills'` in `LangGraphGenerator.ts` returns nothing), the run loop has no skill-step loop, and skill content is still injected the OLD way (appended into the system prompt as `## Skill\n{skill_content}` plus an optional `run_skill_script` tool on the main agent) — this is the **pre-`bde5afb`** architecture |
| Skill FS parity (`skillFsSyncBlock`: bucketed `/outputs`+`/scratch`, path remap, `input_files`, `read_outputs`) | Yes — shared `PythonEmitHelpers::skillFsSyncBlock()` | **No** — `pyBlocks.ts` only has the older flat `_run_skill_script` (subprocess + `input_files` dict write, no bucketing/remap) embedded inside `toolBuilderBlock` |
| fail-fast on skill errors | N/A to LangGraph in the audited grep (this is MAF-specific bounded-retry fail-fast); LangGraph's skill step doesn't currently show an explicit fail-fast keyword either | N/A — parity here is moot since TS lacks the skill-step model entirely |
| skill tool argv typed as `list[str]` | Yes — `argv=(list[str], [])` in `create_model(...)` for `RUN_SKILL_SCRIPT_TOOL` | Yes — `pyBlocks.ts` `toolBuilderBlock` has the identical `create_model("RunSkillScriptArgs", ..., argv=(list[str], []), ...)` with the same Gemini-array-schema comment, verbatim |
| `_langgraph` filename suffix | Yes — `$filename = "{$safeName}_langgraph.py";` (`055b0e4`) | **No** — TS: `const filename = \`${safeName}.py\`;` (`LangGraphGenerator.ts:1067`) — missing the suffix entirely; ambiguous next to future `*_adk.py`/`*_maf.py` outputs |

### Controller/route wiring

Already fully wired and matching:
- PHP: `GET /api/v1/workflows/{id:\d+}/generate-python` → `WorkflowController::generatePython`
- TS: `GET /api/v1/workflows/:id(\d+)/generate-python` (`routes.ts:358`) →
  `WorkflowController.generatePython` (`WorkflowController.ts:151`) — same
  auth/validation/order, same raw-vs-JSON `download=1` behavior. No route work needed here.

### Effort estimate

**2–3 days.** This is not a from-scratch port — it's closing four concrete gaps in an
already-wired, mostly-faithful file:
1. Add `skills` to the `AGENTS` dict emission + port `_run_skill_step` /
   `skillFsSyncBlock` from PHP `PythonEmitHelpers.php` into `pyBlocks.ts` as a new
   shared export (largest piece, ~1–1.5 days — this block will also be reused by the
   ADK/MAF ports, so front-loading it here pays off)
2. Add `OUTPUT_STORAGE_ENABLED`/`OUTPUT_FOLDER` baking (analyzer already exposes this
   for ADK-parity purposes per PHP `WorkflowGraphAnalyzer::isOutputStorageEnabled()`;
   TS `WorkflowGraphAnalyzer` port would need the same field surfaced) + inline
   doctype-extraction `__main__` block (~0.5 day)
3. One-line `_langgraph` filename suffix fix (~5 minutes)
4. Regenerate/update TS golden/fixture tests for the new skill + storage behavior

---

## 2. ADKGenerator

- **PHP file**: `backend/src/AgentTeam/Services/ADKGenerator.php` — 963 lines
- **TS status**: **missing entirely** — no file anywhere under `backend_typescript/src`
  (confirmed via `grep -ril "maf\|adk"` returning nothing, and `find -iname "*adk*"`
  returning nothing)

### What the PHP emits (structure/shape)

Framework: **Google ADK** (`google.adk`), using **LiteLLM** for non-Gemini providers.
Single static method `ADKGenerator::emitAdk(array $analyzed): string`, essentially a
monolithic emitter (only two public methods on the class: `__construct`, `generate`;
everything else is private static heredoc-emitting helpers) that concatenates:

1. Header block (module docstring, imports) — heredoc `<<<PY`
2. `# --- Model factory ---` — `modelFactoryBlock()`: maps node provider+model → ADK
   model object; Gemini → native model string, everything else → `LiteLlm(...)`;
   Grok/DeepSeek/Kimi routed through LiteLLM's OpenAI-compatible path; Kimi K2
   `extra_body.thinking.disabled` mirrored here too
3. `# --- MCP ---` — baked `MCP_SERVERS`/`TOOL_CATALOG` + shared
   `PythonEmitHelpers::mcpClientBlock()` + shared `documentConverterBlock()`
4. `adkToolBuilderBlock()` — concrete `_tool_*` functions wrapped as
   `FunctionTool(_tool_x)` (ADK requires the `FunctionTool` wrapper, unlike MAF's plain
   callables)
5. Conditionally, if any agent has skills: `# --- Skills ---` —
   `PythonEmitHelpers::skillDepsBlock()` + `skillRunnerBlock()` (dir-scoped subprocess
   runner + live `SKILL.md` reader + skill instruction provider)
6. `catalog = build_tools_from_catalog()`, `START_DOCUMENTS` baked list
7. `# --- Agents ---` — `agentsBlock()`: one `LlmAgent` per node; a node with skills
   compiles to a `SequentialAgent(main_agent, *skill_steps)` — the main agent **loses**
   the skill tool once skills exist as mandatory sequential steps (this replaced an
   earlier "skill tool on main agent" design per `534f110`/`bde5afb`); each writes its
   result to `session.state["node_<id>"]`, a child reads a parent via `{node_<id>}`
   templating
8. Conditionally, `# --- Output (fan-in) nodes ---` — `passThroughAgentBlock()`
   (`_PassThroughAgent` — a **non-LLM** agent that forwards the parent's result
   verbatim so HTML deliverables aren't re-summarized into markdown, `5fd864d`) +
   `outputConsolidatorsBlock()`
9. `# --- Orchestration ---` — `rootBlock()`: each topological layer becomes a
   `ParallelAgent` (independent nodes run concurrently), layers run in order inside a
   `SequentialAgent`
10. `# --- Entry point ---` — `mainBlock()`: seeds the prompt (+documents), runs via
    ADK `Runner`, streams the trace with **readable run logs**
    (`NODE_NAMES = {id: display_name}` map + per-event author mapping
    `node_<id>_agent`/`node_<id>_skill_N_llm` → `"[node {id}] {Name} → agent|skill step
    active"`, from `31aa6b7`), extracts `<!doctype html>...</html>` before saving
    (regex at `ADKGenerator.php:748`), honors `OUTPUT_STORAGE_ENABLED`/`OUTPUT_FOLDER`

Skill step reads `ctx.session.state` (not `ctx.state` — `InvocationContext` has no
`.state`, fixed in `dc64f6c`); skill tool argv typed `list[str] | None` with
`input_files`/`read_outputs` annotated the same way as LangGraph/MAF.

### Recent fixes present in PHP (git log)

All of: `serialize_precision` float fix, verbatim temperature/max_tokens (was already
verbatim per `b1d2395`'s note "ADK already verbatim"), Kimi K2 thinking-disabled + 0.6
temp, HTML doctype extraction, `NODE_NAMES` readable run logs (**ADK is where this
feature was born**, then ported to MAF and confirmed already-present in LangGraph),
per-skill run logging, `list[str]` argv typing, `google-adk>=2.3,<3` pin. None of these
have a TS counterpart since the file doesn't exist.

### Controller/route wiring needed in TS

PHP reference (`WorkflowController.php:293-341`, `routes.php:312`):
- Route: `GET /api/v1/workflows/{id:\d+}/generate-adk` → `['AgentTeam:WorkflowController', 'generateAdk']`
- Controller method `generateAdk(array $request): array` — identical shape to
  `generatePython`: auth check → workflow-id check → `canUserAccess` → instantiate
  `new \AgentTeam\Services\ADKGenerator($this->db, $this->workflowRepository,
  $this->graphRepository, $agentRepo)` → `->generate($workflowId, $userId)` →
  `download=1` raw `text/x-python` body with `Content-Disposition` header, else JSON
  `{success, data:{filename, code}}`

TS needs (mirroring the exact `generatePython` pattern already in
`WorkflowController.ts:151-183` and `routes.ts:358-375`):
- New `backend_typescript/src/AgentTeam/ADKGenerator.ts`
- `WorkflowController.ts`: new `async generateAdk(ctx: Ctx): Promise<ControllerResult>`
  method, same auth/validation/error order as `generatePython`
- `routes.ts`: new `router.get('/api/v1/workflows/:id(\\d+)/generate-adk', ...)` raw
  handler (same raw-body-vs-JSON branching as the existing `generate-python` route)

### Effort estimate

**4–6 days.** This is the largest of the three — 963 PHP lines, and structurally the
most complex skill/session-state model (SequentialAgent-of-skill-steps,
ParallelAgent-per-layer, `_PassThroughAgent` for fan-in, session-state templating for
parent→child data flow — none of which exist in the TS codebase yet). Most of the
low-level shared blocks (MCP client, document converter, skill deps) can be reused from
the LangGraph-port work in §1 once `pyBlocks.ts` gains proper shared exports, which
meaningfully reduces the marginal cost versus porting from zero. Highest-risk area:
faithfully reproducing ADK's `Runner`/event-stream API surface and the
`NODE_NAMES`/author-mapping readable-log feature, none of which the TS side has any
prior art for (unlike LangGraph, which at least has the print-based node logging
pattern already established in `pyBlocks.ts`).

---

## 3. MAFGenerator

- **PHP file**: `backend/src/AgentTeam/Services/MAFGenerator.php` — 628 lines
- **TS status**: **missing entirely** — no file anywhere under `backend_typescript/src`

### What the PHP emits (structure/shape)

Framework: **Microsoft Agent Framework** (`agent_framework`, Functional API),
`OpenAIChatCompletionClient` with a per-provider `base_url` (this is the *third*
backend besides ADK/LangGraph; PHP docblock explicitly notes it "reuses
WorkflowGraphAnalyzer + PythonEmitHelpers"). Also a single static
`MAFGenerator::emitMaf(array $analyzed): string`, class has only 2 public methods
(`__construct`, `generate`) plus one test-seam (`skillRunnerBlockForTest()`). Emit order
(`emitMaf`, lines 33-72):

1. `headerBlock()` — heredoc, module docstring + imports
2. `clientFactoryBlock()` — `_make_client(provider, model)`: `if p == "kimi": ...`
   provider dispatch, `_chat_opts()` helper (extracted in `31c2c8f`) applying
   `extra_body.thinking.disabled` for `kimi-k2.*` to both the node agent AND its skill
   step — MAF was the last of the three to get this fix (was the only runtime leaving
   thinking ON)
3. If tools used: `MCP_SERVERS`/`TOOL_CATALOG` dicts + shared
   `PythonEmitHelpers::mcpClientBlock()` + `mcpToolBuilderBlock()` — **ported from
   `ADKGenerator::adkToolBuilderBlock()` with one deliberate difference**: catalog
   entries map to the **plain function** (`catalog["name"] = _tool_fn`) since MAF
   auto-wraps callables, no `FunctionTool(_tool_x)` wrapper needed (unlike ADK) — else
   `catalog = {}`
4. Shared `PythonEmitHelpers::documentConverterBlock()`
5. Conditionally (any agent has skills): shared `skillDepsBlock()` +
   `skillRunnerBlock()` — **emitted BEFORE `agentsBlock()`** specifically so
   `_run_skill_step` is defined before `_run_node` references it (explicit ordering
   comment in source); skill step is a **bounded-retry fail-fast** design
   (`FunctionTool(max_invocation_exceptions=1)`, `95aa485`/`7038647`): a skill SCRIPT
   that keeps failing is retried at most once then aborts the whole workflow with
   `"WORKFLOW STOPPED: ..."` to stderr + non-zero exit — but *only* on
   data-gathering failures (bad URL/fetch), not generic tool-usage errors
   (argparse/missing-file), which are allowed to finish with best-effort output
6. `agentsBlock()` — `AGENTS` dict + `_run_node`
7. `globalsBlock()` — **must precede** `orchestrationBlock()`: `DEFAULT_PROMPT` is used
   as a default parameter value in `main()`'s signature, resolved at
   def-execution time, so must exist before that `async def main` line runs (explicit
   ordering comment, subtle Python gotcha called out in the PHP source itself)
8. `orchestrationBlock()` — functional `@workflow` decorator + `main()`; layered
   execution via `asyncio.gather` per layer (functional-API equivalent of ADK's
   `ParallelAgent`)
9. `entryBlock()` — `__main__`

`default_options=ChatOptions` set explicitly on **both** the node agent and its skill
step (temperature/max_tokens verbatim from the form — `b1d2395` fixed this; Anthropic's
default previously truncated a GEO report to a stub because these were unset). Skill
step gets the **original request LAST** in context ordering (SKILL.md system → material
→ original request), root-caused via A/B testing against LangGraph (`5f50517`). Skill
step renders its input as content-to-process, not commands-to-follow (`3d2efa6`) — was
refusing when a consolidator's own authored instructions leaked into a downstream
skill's input. Text deliverables (HTML/Markdown) are the model's raw RESPONSE (not
piped through a `create.py --input_files` script argument, which the model reliably
fumbled — `7c8aae5`, later reverted+refined into today's doctype-extraction approach
per `d363fd7`).

### Recent fixes present in PHP (git log) — none have TS counterparts

`serialize_precision` fix, temperature/max_tokens verbatim on both node+skill,
Kimi K2 thinking-disabled `_chat_opts` helper (node + skill step), HTML doctype
extraction on save, explicit per-node/per-skill readable run logs (name + provider/
model + tool count, agent-done timing, "running skill X" + timing, `[layer N] running
...` banner — `d363fd7`), bounded-retry fail-fast (data-gathering failures only),
`list[str]` argv typing (+ `input_files` dict, `read_outputs` list[str]), MCP tools
bound as plain callables (not `FunctionTool`), `agent-framework>=1.10` pin,
`WorkflowRunResult.get_outputs()` (no `.text` in that version — `3ff4318`).

### Controller/route wiring needed in TS

PHP reference (`WorkflowController.php:351-399`, `routes.php:313`):
- Route: `GET /api/v1/workflows/{id:\d+}/generate-maf` → `['AgentTeam:WorkflowController', 'generateMaf']`
- Controller method `generateMaf(array $request): array` — identical shape/order to
  `generateAdk`/`generatePython`: `new \AgentTeam\Services\MAFGenerator($this->db,
  $this->workflowRepository, $this->graphRepository, $agentRepo)` →
  `->generate($workflowId, $userId)`, same download/JSON branching

TS needs:
- New `backend_typescript/src/AgentTeam/MAFGenerator.ts`
- `WorkflowController.ts`: new `async generateMaf(ctx: Ctx): Promise<ControllerResult>`,
  mirroring `generateAdk`/`generatePython`
- `routes.ts`: new `router.get('/api/v1/workflows/:id(\\d+)/generate-maf', ...)` raw handler

### Effort estimate

**3–4 days.** Smaller and structurally simpler than ADK (628 vs 963 PHP lines; a
functional `@workflow`/`asyncio.gather` orchestration model is a more direct port
target from TS/JS async patterns than ADK's `SequentialAgent`/`ParallelAgent`/
session-state object graph). Main complexity is *not* structural but behavioral: the
bounded-retry fail-fast classification (data-gathering vs tool-usage errors), the
"original request last" context-ordering rule, and the "skill renders input as content
not commands" prompt-framing rule are all subtle, hard-won behavioral fixes from git
history (5+ dedicated commits) that must be ported faithfully, not just structurally —
get any of them wrong and the port will silently regress a real bug that was already
found and fixed once in PHP. If §1's shared-block extraction into `pyBlocks.ts` lands
first (MCP client, document converter, skill deps/FS-sync), MAF's port cost drops
further since it reuses almost all of that shared infrastructure verbatim.

---

## Cross-cutting notes for the TS port plan

1. **Do the shared-block extraction once, first.** `PythonEmitHelpers.php` (535 lines)
   backs all three PHP generators. TS's `pyBlocks.ts` currently only serves
   LangGraph and is missing the new (`bde5afb`-era) `skillFsSyncBlock` shape entirely.
   Porting that one shared block first means LangGraph parity (§1), ADK (§2), and MAF
   (§3) all get it for free instead of three times.
2. **The Kimi K2 thinking-mode fix is the one place all three PHP generators
   independently regressed and were independently fixed** (LangGraph/ADK first, MAF
   last via `31c2c8f`, discovered because "a kimi temp valid in MAF failed in ADK/
   LangGraph and vice-versa"). Any new TS ADK/MAF generator must apply
   `extra_body.thinking.disabled` for `kimi-k2.*` from day one, on **both** the main
   node agent and any skill step — this is the single most-regressed fix in the
   generator's history and the easiest one to silently drop during a port.
3. **`serialize_precision`/float-formatting**: TS's approach (byte-exact reproduction
   of PHP's `serialize_precision=100` expansion via `phpFloatExact()`) is more
   faithful than just forcing shortest-round-trip and should be reused as-is for the
   ADK/MAF ports rather than re-solved.
4. **Filename suffix convention** (`_langgraph.py` / `_adk.py` / `_maf.py`) exists in
   PHP specifically so the three outputs don't collide/ambiguity when saved side by
   side — TS must apply this to all three, including fixing the current LangGraph gap.
