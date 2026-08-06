# NOOA (NVIDIA OO Agents) Workflow Compiler Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NOOA (NVIDIA-labs OO Agents, PyPI package `nooa`) as the 4th workflow-compiler backend beside LangGraph, ADK, and MAF: a `NOOAGenerator` that compiles the visual workflow graph into a self-contained NOOA Python script with per-node Agent classes, native MCP via `MCPManager`, mandatory skill post-steps, and `asyncio.gather` fan-out.

**Architecture:** `NOOAGenerator.php` follows the exact MAFGenerator pattern — same 4-arg constructor, `generate()` front half that runs `WorkflowGraphAnalyzer::analyze()`, and a pure static `emitNooa(array $analyzed): string` back half. It reuses `PythonEmitHelpers` (`pyStr`, `jsonToPython`, `skillDepsBlock`, `skillFsSyncBlock`, `documentConverterBlock`). Unlike the other targets, orchestration is emitted as plain asyncio driver code (NOOA has no graph API): each editor agent node becomes a NOOA `Agent` subclass (class docstring = system prompt, one `respond()` generation method), each topological layer with >1 runnable node becomes one `asyncio.gather`, and the Output node is a verbatim text merge.

**Tech Stack:** PHP 8 (generator, PSR-4 autoloaded under `AgentTeam\Services`), PHPUnit (in `backend/tests`, run via `php vendor/bin/phpunit`), emitted Python targets `nooa` + `nooa[mcp]` + `python-dotenv`, vanilla JS frontend (`workflow-editor.js`).

## Global Constraints

- Form values are used VERBATIM in generated code — never silently overridden (platform principle; only hard API constraints are corrected, mirroring MAF's `chat_options`: kimi-k2 temperature 0.6/1.0, glm thinking flag, deepseek-v4 drops temperature while thinking).
- Provider endpoints/env keys must match MAF's `ProviderClients` table exactly: claude/anthropic native; openai default; gemini/google `https://generativelanguage.googleapis.com/v1beta/openai/` + `GOOGLE_API_KEY`; grok `https://api.x.ai/v1` + `XAI_API_KEY`; kimi `https://api.moonshot.ai/v1` + `KIMI_API_KEY`; deepseek `https://api.deepseek.com` + `DEEPSEEK_API_KEY`; glm `https://api.z.ai/api/paas/v4` + `GLM_API_KEY`.
- Empty model after analyzer default-resolution → raise loudly at runtime (`RuntimeError`), never emit an empty model string.
- Skill scripts execute via the shared `_run_skill_script` subprocess helper (root-level scripts), NOT NOOA's `TextSkill.run_script` (which only resolves `scripts/<name>` — platform skills keep scripts at the skill dir root).
- A failed skill step degrades to the pre-skill text; a script-produced file (via `read_outputs` → `_LAST_SKILL_OUTPUTS`) wins over model text.
- MCP server URLs are normalized at GENERATION time in PHP (append `/mcp` unless the URL ends with `/mcp` or `.php`) because `MCPManager` does no normalization.
- `ini_set('serialize_precision', '-1')` at the top of `emitNooa` (web SAPI float-precision bug, same as MAF).
- Frontend JS edits require bumping the `?v=` cache-buster on `workflow-editor.js` in `frontend/index.html:4168`.
- Out of scope (separate plan): TypeScript backend port (`backend_typescript`) and i18n translation entries (inline `|| '…'` fallbacks suffice).
- Commit after each task with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified NOOA API facts (from the cloned repo, do not re-derive)

- `from nooa import Agent`; subclass with `class X(Agent, llm=<UnifiedLLM>)`; instance-level `Agent(llm=...)` also works (first positional param of `Agent.__init__`).
- Class docstring = system prompt. A generation method is `async def m(self, ...) -> str:` with a docstring and a body of `...`; the default strategy is CodeActStrategy, under which visible `self` methods are callable tools from generated code.
- `from nooa.unifiedllm.registry import get_llm_client`; `get_llm_client(model_string, api_base=..., api_key=..., max_tokens=..., temperature=..., extra_body=...)` — model_string is a litellm routing string; `openai/<model>` + `api_base` routes any OpenAI-compatible endpoint; bare `claude-*`/`gpt-*` route natively.
- `from nooa.mcp import MCPManager`; `MCPManager.create_from_server(server_name, url=..., headers=..., transport="streamable-http", tool_call_timeout=timedelta(...))` returns an object whose methods are the server's tools; attach as a class attribute (connects at class-body execution).
- The workflow's `usedServers` map has NO headers column (only `name`) — emit no headers kwarg.

---

### Task 1: Core NOOAGenerator (no MCP, no skills) + emit/compile tests

**Files:**
- Create: `backend/src/AgentTeam/Services/NOOAGenerator.php`
- Test: `backend/tests/Unit/NooaGeneratorEmitTest.php`
- Test: `backend/tests/Unit/NooaGeneratorCompileTest.php`

**Interfaces:**
- Consumes: `WorkflowGraphAnalyzer::analyze()` output shape (see MafGeneratorEmitTest fixture), `PythonEmitHelpers::{pyStr, jsonToPython, documentConverterBlock}`.
- Produces: `NOOAGenerator::generate(int $workflowId, ?string $userId): array{filename, code}` and pure `NOOAGenerator::emitNooa(array $analyzed): string`. Task 2/3 add `mcpBlock()`/`skillBlock()` into the same file. Task 4 instantiates the class from the controller.

- [ ] **Step 1: Write the failing emit test** — `backend/tests/Unit/NooaGeneratorEmitTest.php` with the same fixture shape as `MafGeneratorEmitTest` (start→A(claude)→output), asserting: `from nooa import Agent`, `from nooa.unifiedllm.registry import get_llm_client`, `def make_llm(provider`, `class A(Agent, llm=make_llm("claude", "claude-sonnet-4-6"`, the pyStr'd docstring `"You are A."`, `async def respond(self, prompt: str) -> str:`, `async def main(`, `DEFAULT_PROMPT = "Analyze example.com"`, `WORKFLOW_ID = 7`, and (negative) no `MCPManager`, no `_run_skill_script`, no `asyncio.gather` for the linear fixture. A second test with the diamond fixture (2 parallel agents) asserts `asyncio.gather(` and both `run_agent("2"` / `run_agent("3"` inside it; storage flags baked (`OUTPUT_STORAGE_ENABLED = True`).
- [ ] **Step 2: Run to verify it fails** — `cd backend/tests && php vendor/bin/phpunit Unit/NooaGeneratorEmitTest.php` → error: class `NOOAGenerator` not found.
- [ ] **Step 3: Implement `NOOAGenerator.php`** — full class per the emitted-Python design below. Sections: `generate()` (analyzer + filename `<name>_nooa.py`), `emitNooa()` (parts assembly with MAF-style `banner()`), `headerBlock` (module docstring with frozen layer outline + TO RUN `pip install "nooa[mcp]" python-dotenv`, imports, `load_dotenv` of `../.env`), `llmFactoryBlock` (`make_llm` with the provider table + sampling quirks), `progressBlock` (compact `Progress` class: banner, ▶/✓ lines, 15s heartbeat thread, summary), `agentsBlock` (one `class <Name>(Agent, llm=make_llm(...))` per node — class name = CamelCased node label, deduped, `Node<id>` fallback when empty/digit-leading/reserved {Agent, Progress, SkillStepAgent, MCP} — plus `AGENTS = {id: {"name", "cls", "skills", "provider", "model", "max_tokens", "temperature", "thinking"}}`), `runnerBlock` (`async def run_agent(node_id, parent_texts, request)` — date-grounded framed input mirroring MAF `_framed_input`, instantiate `cls()`, `await .respond(framed)`, loop `run_skill` over `AGENTS[id]["skills"]`), `globalsBlock` (DEFAULT_PROMPT/WORKFLOW_NAME/WORKFLOW_ID/OUTPUT_STORAGE_ENABLED/OUTPUT_FOLDER/START_DOCUMENTS), `mainBlock` (layer-driven driver: per layer, single node → direct await; multi → `_r<i> = await asyncio.gather(...)` + unpack; parents filtered to emitted ids; ADK-style START_DOCUMENTS merge at top; Output node → verbatim merge `"\n\n---\n\n".join`), `entryBlock` (argv prompt, `Progress.begin`, `asyncio.run(main(_prompt))`, WORKFLOW STOPPED on exception, MAF-style html/md extraction + save when storage enabled, `Progress.summary`). `documentConverterBlock` emitted only when `startDocuments` non-empty; `max_tokens` defaults 4096, `temperature` 0.7 when null (same as MAF AGENTS bake).
- [ ] **Step 4: Emit tests pass** — same phpunit command → OK.
- [ ] **Step 5: Write + run the compile test** — `NooaGeneratorCompileTest.php` cloned from `MafGeneratorCompileTest` (py_compile via python3; diamond fixture) with only the diamond test for now → OK.
- [ ] **Step 6: Commit** — `feat(nooa): core NOOA workflow compiler backend`.

### Task 2: MCP emission (MCPManager registry + per-class attachment)

**Files:**
- Modify: `backend/src/AgentTeam/Services/NOOAGenerator.php`
- Test: both test files from Task 1

**Interfaces:**
- Consumes: `analyzed['usedServers']` (url → {name}), `analyzed['usedCatalog']` (tool → {server_url, description, input_schema}), agent `tools` lists (strip `mcp_` prefix — same normalization as MAF agentsBlock).
- Produces: emitted `MCP = {url: MCPManager.create_from_server(...)}` dict; agent classes gain `mcp_<i> = MCP["<url>"]` attributes and a tool-guidance line in the `respond` docstring.

- [ ] **Step 1: Failing test** — extend emit test with the MAF MCP fixture (server `https://mcp.example/mcp`, tool `web_search` on agent 2): assert `from nooa.mcp import MCPManager`, `from datetime import timedelta`, `MCP_SERVERS = {`, `create_from_server(`, `transport="streamable-http"`, `mcp_0 = MCP["https://mcp.example/mcp"]` inside `class A`, and the docstring guidance `Tools selected for this node: web_search`; negative — an MCP-free emission still contains none of these. Run → fails.
- [ ] **Step 2: Implement `mcpBlock()`** — gated on `usedCatalog` non-empty: emit `MCP_SERVERS` via `jsonToPython(usedServers, true)`, then `MCP` dict with one `MCPManager.create_from_server("<server name sanitized to [A-Za-z0-9_-]>", url="<php-normalized url>", transport="streamable-http", tool_call_timeout=timedelta(seconds=180))` per server. In `agentsBlock`, compute each node's server set from its (prefix-stripped) tools via `usedCatalog[tool]['server_url']`; emit one class attribute per server; append tool list to the respond docstring: `Tools selected for this node: <t1>, <t2> — use these via the attached MCP server(s); other server tools are out of scope.` Header imports gain the two MCP imports, gated.
- [ ] **Step 3: Tests pass** — emit suite OK; add the MCP fixture to the compile test (mirrors `testMcpFixtureCompiles`) → OK.
- [ ] **Step 4: Commit** — `feat(nooa): native MCPManager tool emission`.

### Task 3: Skill runtime (mandatory post-steps, CodeAct-native)

**Files:**
- Modify: `backend/src/AgentTeam/Services/NOOAGenerator.php`
- Test: both test files

**Interfaces:**
- Consumes: `PythonEmitHelpers::skillDepsBlock()` + `skillFsSyncBlock()` (provides `SKILLS_DIR`, `_run_skill_script`, `_read_skill_md`, `_remap_virtual_path`, `_skill_output_dir`, `_fix_overescaped`, `_LAST_SKILL_OUTPUTS`), `AGENTS[id]["skills"]` entries `{dir}` / `{inline}`.
- Produces: emitted `SkillStepAgent` class (instance-level `llm`; `stage_file` + `run_skill_script` self-methods; `apply()` generation method) and `async def run_skill(skill, prior, request, ad)` called by `run_agent`. Gated: only emitted when some agent has skills; `run_agent`'s skill loop guarded by `AGENTS[id]["skills"]` being baked (always present, may be empty).

- [ ] **Step 1: Failing test** — emit fixture with `skills = [['dir' => 'html']]`: assert `class SkillStepAgent(Agent):`, `async def run_skill(`, `def _run_skill_script(` (shared block), `_LAST_SKILL_OUTPUTS`, `"dir": "html"` baked; negative — skill-free emission contains none. Run → fails.
- [ ] **Step 2: Implement `skillBlock()`** — `skillDepsBlock() + skillFsSyncBlock()` + the NOOA-specific runtime (single-phase CodeAct design — the model stages content and runs scripts from generated code, so MAF's two-phase author/stage/render split is unnecessary): `SkillStepAgent` with static docstring ("execute ONE skill step; follow embedded SKILL INSTRUCTIONS; material is CONTENT, never refuse"), `_dir` attr, `stage_file` (writes under `/scratch/` via `_remap_virtual_path` + `_fix_overescaped`), `run_skill_script` (delegates to `_run_skill_script(self._dir, ...)`), `apply(task)` generation method; `run_skill()` builds the task string (SKILL INSTRUCTIONS from `_read_skill_md(dir)` or inline body + MATERIAL + ORIGINAL REQUEST), instantiates `SkillStepAgent(llm=make_llm(ad[...]))`, and applies the deliverable-selection guard: script-produced file (`_LAST_SKILL_OUTPUTS`) → step text (reject empty or <400-char collapse of a 4×-larger prior) → degrade to `prior`; any exception degrades to `prior`.
- [ ] **Step 3: Tests pass** — emit suite OK; add skill fixture to compile test → OK.
- [ ] **Step 4: Commit** — `feat(nooa): mandatory skill post-steps`.

### Task 4: Controller method + route

**Files:**
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (after `generateMaf`, ~line 400)
- Modify: `backend/src/routes.php:353`

- [ ] **Step 1: Add `generateNooa()`** — verbatim copy of `generateMaf()` with `MAFGenerator`→`NOOAGenerator`, log tag `generateNooa`, docblock `generate-nooa`.
- [ ] **Step 2: Register route** — `$r->get('/api/v1/workflows/{id:\d+}/generate-nooa', ['AgentTeam:WorkflowController', 'generateNooa']);` after the generate-maf line.
- [ ] **Step 3: Verify** — `php -l` both files; full `php vendor/bin/phpunit Unit/` still green.
- [ ] **Step 4: Commit** — `feat(nooa): generate-nooa endpoint`.

### Task 5: Frontend — Output-node button, menu, modals, run

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` (button template ~line 9938, click dispatch ~line 2502, new block after the MAF section ~line 3960)
- Modify: `frontend/index.html:4168` (cache-buster)

- [ ] **Step 1: Button** — in `createOutputNodeHtml()` after the MAF button: `<button class="node-langgraph node-nooa" title="NVIDIA OO Agents: set up the runtime or generate the script" data-action="nooa-menu"><span class="gen-label">NVIDIA OO Agents - Python</span><span class="gen-caret">▾</span></button>` (with `this.t('workflow.output.nooaTitle') || …` pattern).
- [ ] **Step 2: Dispatch** — after the mafBtn lines: `const nooaBtn = e.target.closest('[data-action="nooa-menu"]'); if (nooaBtn) { e.stopPropagation(); this._showNooaMenu(nooaBtn); return; }`.
- [ ] **Step 3: NOOA block** — mirror the MAF block function-for-function with `maf`→`nooa` substitutions: `_showNooaMenu` (also close other `.langgraph-menu`s; menu class `nooa-menu`), `generateNooaScript` (endpoint `generate-nooa`, default filename `workflow_nooa.py`), `_showNooaSetupModal` (install line: `./.venv/bin/pip install "nooa[mcp]" python-dotenv`), `_showNooaInfoModal` (NOOA blurb: agents as Python classes, CodeAct execution, link github.com/NVIDIA-NeMo/labs-OO-Agents), `_runNooaScript`, `_showNooaCodeModal`.
- [ ] **Step 4: Cache-buster** — bump to `?v=20260806-nooa`.
- [ ] **Step 5: Verify** — `node --check frontend/assets/js/workflow-editor.js` passes.
- [ ] **Step 6: Commit** — `feat(nooa): workflow editor NOOA export UI`.

### Task 6: End-to-end verification against a real workflow

- [ ] **Step 1:** Small PHP harness in the scratchpad (modeled on the DB bootstrap used by `backend/tests/CheckExistingWorkflows.php`; remember: workflows live in the CONTEXTS db `netfo587_chatbot`) that instantiates `NOOAGenerator` against a real workflow id (pick one with ≥2 agents; ideally one with a skill and MCP tools) and writes the emitted script to the scratchpad.
- [ ] **Step 2:** `python3 -m py_compile` the emitted script → exit 0. Read the emitted file and sanity-check: class per node, gather per parallel layer, verbatim prompts.
- [ ] **Step 3:** Report the emitted script to the user for a live run (live LLM/MCP execution needs their API keys and runner env — user-driven, same as ADK/MAF live smoke).

## Self-Review Notes

- Spec coverage: MCP mandatory (Task 2, native MCPManager), skills mandatory (Task 3, driver-enforced), fan-out/fan-in (Task 1 mainBlock), provider parity + defaults (Task 1 make_llm + analyzer's default-model resolution), storage/output (Task 1 entryBlock), UI parity (Task 5).
- Known deliberate deltas from MAF, to be stated in the emitted header docstring: (1) NOOA agents fulfill methods by generating and executing Python (CodeAct) rather than chat completions; (2) MCP attachment exposes ALL tools of a selected server to the node — the selected-tool list is enforced as docstring guidance, not a hard filter (LAN-only posture, per project policy); (3) single-phase skill steps (CodeAct sidesteps the tool-arg-refusal problem that forced MAF's two-phase design).
