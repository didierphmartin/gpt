# Microsoft Agent Framework (MAF) Generator — Design Spec

**Date:** 2026-07-05
**Status:** Draft for review
**Scope:** A third compiler backend beside `LangGraphGenerator` and `ADKGenerator` that turns the workflow DSL into a self-contained **Microsoft Agent Framework** Python program.

---

## Goal

Compile a saved workflow into a standalone Python script that runs on **Microsoft Agent Framework** (`pip install agent-framework`, v1.9.x, GA'd April 2026, Python ≥3.10) with **full parity** with the ADK/LangGraph backends: sequential + fan-out (parallel) + fan-in (merge), multi-provider LLMs, MCP tools, and the **mandatory skill pipeline** (skill runs as a post-agent step; its produced deliverable — e.g. rendered HTML — becomes the node output). Same delivery shape: a `generate-maf` route returning `{filename, code}` and an Output-node submenu.

---

## Grounding: the MAF API (verified from the docs)

- **Agent:** `Agent(name="...", instructions="<system prompt>", client=<chat client>[, tools=[...]])`; run with `result = await agent.run(input)`, read `result.text`.
- **Providers (Python):** Azure OpenAI, OpenAI, Anthropic, Ollama, Foundry, Foundry Local, GitHub Copilot. Function tools + MCP tools supported on OpenAI/Azure/Foundry/Anthropic. **No native Google Gemini provider.**
- **Workflow — Functional API** (`from agent_framework import workflow, step`): decorate an `async def` with `@workflow`; use plain Python + **`asyncio.gather`** for parallelism; agents are called as normal functions inside it. Run via `await wf.run(prompt)` → `WorkflowRunResult`, read `.text`. `@step` adds caching/checkpointing (optional). **Marked experimental.**
- **Workflow — Graph API** (`WorkflowBuilder` + executors + edges): stable, explicit fan-out/fan-in, superstep parallelism.

---

## Architecture decision: use the Functional API

The generated program is **one `@workflow async def main(prompt)`** that executes the DAG as topological layers — exactly our LangGraph model, minus LangChain.

**Why Functional over Graph:**
- It is our existing LangGraph shape (async node functions + layer orchestration), so the node-function + skill-pipeline + capture logic ports almost verbatim.
- Full control for the mandatory-skill step (a second `agent.run` + subprocess + deliverable capture) — no executor/edge ceremony.
- `asyncio.gather` gives fan-out directly; fan-in is just "a consolidator function reads its parents' results."

**Caveat & mitigation:** the Functional API is *experimental*. Mitigation: **pin `agent-framework`** (runner requirements + emitted header), and keep the emitter's orchestration isolated (`mainBlock`) so a later move to the stable **Graph API** is a localized change. (Graph API is the documented fallback if the functional decorator churns.)

---

## DSL → MAF mapping

| DSL concept | MAF emission |
|---|---|
| Agent node (system prompt, provider, model) | `Agent(name="node_<id>", instructions=<system prompt>, client=_make_client(provider, model), tools=[…mcp…])` |
| Run an agent on its input | `text = (await agent.run(input)).text` |
| **Fan-out** (parallel dimension nodes in a layer) | `results = await asyncio.gather(*[node_<id>(inp) for id in layer])` |
| **Fan-in / merge** | consolidator node receives the merged parent outputs as its input (same `build_context` join we use in LangGraph) |
| Sequential layers | run layers in order inside `main` |
| MCP tools | reuse the shared HTTP JSON-RPC MCP client (`_call_mcp_tool`); wrap each tool as a **MAF function tool** and pass in `Agent(tools=[…])` |
| **Skills** (folder-backed, mandatory post-step) | **port verbatim** the ADK/LangGraph runtime: `_run_skill_script` (bucketed `/outputs`+`/scratch`, remap, `input_files`, `read_outputs` stash) + `_run_skill_step` (a MAF `Agent` on the node model with `SKILL.md` as instructions + a dir-scoped `run_skill_script` tool) + deliverable capture (produced file → node output, else LLM text) |
| Multi-provider | `_make_client(provider, model)` factory (below) |
| Start-node prompt | baked as `main`'s default input (same as ADK/LangGraph) |
| End-node storage | same `if OUTPUT_STORAGE_ENABLED:` save to `synergyAI/outputs/workflow/…` (html/md by signature) |

---

## Provider factory (`_make_client`)

Imports: `from agent_framework.anthropic import AnthropicClient`; `from agent_framework.openai import OpenAIChatCompletionClient`.

```
claude   -> AnthropicClient(model=…, api_key=env ANTHROPIC_API_KEY)
openai   -> OpenAIChatCompletionClient(model=…, api_key=env OPENAI_API_KEY)
grok     -> OpenAIChatCompletionClient(model=…, base_url="https://api.x.ai/v1", api_key=env XAI_API_KEY)
kimi     -> OpenAIChatCompletionClient(model=…, base_url="https://api.moonshot.ai/v1", api_key=env KIMI_API_KEY)
deepseek -> OpenAIChatCompletionClient(model=…, base_url="https://api.deepseek.com", api_key=env DEEPSEEK_API_KEY)
gemini   -> OpenAIChatCompletionClient(model=…, base_url="https://generativelanguage.googleapis.com/v1beta/openai/", api_key=env GOOGLE_API_KEY)
```

> **⚠️ Spike-verified gotcha — use `OpenAIChatCompletionClient`, NOT `OpenAIChatClient`.** `OpenAIChatClient` targets the `/responses` API and **404s** against every OpenAI-*compatible* endpoint (Gemini, DeepSeek, and by extension Grok/Kimi). `OpenAIChatCompletionClient` targets `/chat/completions` and works everywhere. Verified 2026-07-05: Gemini + DeepSeek both PASS via `OpenAIChatCompletionClient(base_url=…)`, both FAIL via `OpenAIChatClient`.

Gemini has no native MAF provider, so it goes through the **OpenAI-compatible** endpoint — same pattern as Grok/Kimi/DeepSeek (which is exactly how ADK's `LiteLlm` and LangGraph's `ChatOpenAI+base_url` already handle these). Azure is out of scope (no form provider). Never override form values (temperature/model) — [[feedback_no_override_form_params]].

**Keys come from the runner's `.env`** — the same `~/Documents/synergyAI/python/.env` the ADK/LangGraph scripts use. The runner already `load_dotenv()`s at startup and runs scripts with that env, so the keys are present as env vars. Because **MAF does not auto-load `.env`**, the emitted MAF script also calls `load_dotenv()` at the top (pointing at `<install>/.env`) so keys resolve whether it's run via the runner **or** standalone. No keys are ever baked into the generated code.

---

## Emitted program structure

1. **Header + imports** — `from agent_framework import Agent, workflow`; `from agent_framework.anthropic import AnthropicClient`; `from agent_framework.openai import OpenAIChatCompletionClient`; `asyncio, json, os, subprocess, sys, time, traceback, urllib.request, httpx`, `from dotenv import load_dotenv`; `pip install "agent-framework>=1.10,<2"` note + required keys.
2. `_make_client(provider, model)` — the factory above.
3. **MCP** — `MCP_SERVERS`/`TOOL_CATALOG` baked; the shared `_call_mcp_tool` client; each tool wrapped as a MAF function tool.
4. **Skill runtime** (emitted iff a node has skills) — `SKILL_OUTPUTS_ROOT`/`SKILL_SCRATCH_DIR`/`_LAST_SKILL_OUTPUTS`, `_skill_output_dir`, `_remap_virtual_path`, `_run_skill_script`, `_read_skill_md`, `_make_skill_tool`, `_run_skill_step`. **Ported from the ADK/LangGraph emitter** (same behavior, MAF `Agent` for the skill LLM turn).
5. **Node functions** — one `async def node_<id>(input)` per agent node: `text = (await Agent(instructions=…, client=…, tools=…).run(input)).text`, then `for skill in SKILLS[id]: text = await _run_skill_step(skill, text, provider, model)`; return `text`.
6. **`@workflow async def main(prompt)`** — seed prompt (+ documents), run topological layers (`asyncio.gather` per parallel layer), thread fan-in inputs, produce the final result.
7. **Entry** — `result = asyncio.run(main.run(" ".join(sys.argv[1:]) or DEFAULT_PROMPT))`; then the storage-aware save (honor `OUTPUT_STORAGE_ENABLED`/`OUTPUT_FOLDER`).

---

## Reuse (keep the three backends DRY)

- **`WorkflowGraphAnalyzer` — 100% reuse.** Same analyzed data (`agents`, `layers`, `edges`, `parents`, `usedCatalog`, `usedServers`, `startPrompt`, `startDocuments`, `skills`, `outputStorageEnabled`, `outputFolder`). No analyzer change needed.
- **`PythonEmitHelpers` — reuse** `jsonToPython`, `pyStr`, `skillDepsBlock`, `documentConverterBlock`, and the MCP client block (the raw `_call_mcp_tool`); MAF-specific wrapping of MCP tools + the skill runtime live in `MAFGenerator`.
- **Skill runtime Python** — lift the ADK skill block (it's provider-agnostic Python: subprocess + FS + capture); only the *LLM turn* inside `_run_skill_step` swaps `LlmAgent`/`create_react_agent` → MAF `Agent`.

---

## Lessons from the ADK/LangGraph build — apply directly (esp. skills)

These are hard-won; ignoring them = repeating days of iteration.

1. **Verify against the *installed* package AND runtime-test — import/py_compile are not enough.** The ADK skill step crashed at runtime (`ctx.state` had no attribute) while passing import + py_compile. So: a Phase-0 spike that *actually runs* an `Agent` with a tool, and a skill step that *actually* produces + captures a file — not just "it imports."
2. **Skills = mandatory post-agent step + deliverable capture.** The node output must become the skill's **produced file** (via `read_outputs` stash), not the LLM's final text. This capture is the whole reason html→HTML works; it makes the result independent of whether the model "narrates" or emits the doc. Port `_LAST_SKILL_OUTPUTS` + the capture step.
3. **Replicate the ENTIRE skill filesystem up front — do not rediscover it dir-by-dir.** Real bucketed `/outputs/<group>` + `/scratch`, remap `/outputs//scratch` argv paths, stage `input_files`, stash `read_outputs`, export `SYNERGYAI_OUTPUT_DIR/SCRATCH_DIR/SKILL_DIR_NAME/SKILL_GROUP`. This block is provider-agnostic Python — lift it verbatim from the ADK emitter; only the skill step's LLM turn changes.
4. **Forceful skill-step instruction** ("MANDATORY step… you MUST call run_skill_script, stage via input_files, pass read_outputs") so the model reliably runs the skill; the capture is the safety net if it still narrates.
5. **Don't override agent-form values** (temperature/model). Kimi-K2's 0.6 constraint etc. is surfaced to the user, not silently fixed — [[feedback_no_override_form_params]].
6. **Bake skills into the emitted per-agent data** — easy to forget (LangGraph's manual `AGENTS` emission initially dropped the `skills` field, silently making the pipeline a no-op).
7. **Pin the framework version** (`agent-framework>=1.9,<2`) — an unpinned major upgrade broke assumptions before.

## Phase-0 spike results (2026-07-05 — RESOLVED, agent-framework 1.10.0)

Ran the throwaway spike (introspection + real LLM calls) against the installed package. All five unknowns resolved; **no blockers found.**

1. **✅ BLOCKING question — `agent.run` auto-loops tool calls.** Real run: the agent called a function tool, the result was fed back, and the final answer used it (`tool invoked: 1×`, response contained the tool's return value). **The whole skill design is viable** — a skill step is just an `Agent` whose `run_skill_script` tool fires in the loop.
2. **✅ Skill-step file capture works at runtime.** A tool that *writes* an HTML file was invoked by the agent; we captured the file (via a `_LAST_SKILL_OUTPUTS`-style stash) and made **that** the node output (`<!DOCTYPE html>…`), not the model's chatter. Exact ADK/LangGraph parity, proven live.
3. **✅ Client classes.** `AnthropicClient` (`agent_framework.anthropic`) for Claude; **`OpenAIChatCompletionClient`** (`agent_framework.openai`) for OpenAI + all base_url providers. `base_url` + `api_key` confirmed on the constructor.
4. **✅ Gemini/Grok/Kimi/DeepSeek via base_url** — PASS, **but only with `OpenAIChatCompletionClient`** (`OpenAIChatClient` → `/responses` → 404). See the ⚠️ gotcha in the provider factory. Gemini + DeepSeek both verified live.
5. **✅ Tool binding** — plain Python callables passed to `Agent(tools=[fn])` are auto-wrapped (no decorator needed); MCP is native (`MCPStreamableHTTPTool`).
6. **✅ Coexistence** — `agent-framework 1.10.0` + `google-adk 2.3.0` + `langgraph 1.2.7` import + run in one venv. The pip `anthropic` downgrade warning (0.80.0 vs langchain-anthropic's `>=0.96`) is **benign**: `ChatAnthropic` still constructs and the LangGraph Claude path is unaffected. Mitigation: pin `anthropic` and monitor.

**Decision:** proceed with the **Functional API** (experimental → pin `agent-framework>=1.10,<2`). One refinement from the spike: `agent-framework` is **installed and required** — add it to `requirements.txt` (done).

---

## Delivery

- **Backend:** `MAFGenerator::emitMaf(array): string` (pure) + `generate(id, userId)`; a `GET /api/v1/workflows/{id}/generate-maf` route (mirror `generate-adk`).
- **Frontend:** a "Microsoft Agent Framework — Python" submenu on the Output node (Setup / Generate / Info / Run / Display Code), mirroring the ADK one; Run reuses the no-prompt runner; Setup provisions `agent-framework` into the shared venv.
- **Output location:** the generated script is written to **`~/Documents/synergyAI/python/scripts/<name>_maf.py`** — the exact same place as the ADK (`<name>_adk.py`) and LangGraph scripts (via `window.localFs` → `python/scripts/`), so it runs through the same runner and reads the same `.env`.
- **Runner:** `agent-framework>=1.10,<2` (+ `anthropic>=0.80` floor) added to `langchain_runner/requirements.txt` — **done**; spike-verified to coexist with google-adk + langgraph in the one venv.

---

## Non-goals / phasing

- **Phase 0:** API spike — ✅ **DONE 2026-07-05** (all 5 unknowns resolved; see spike results). **Phase 1:** core emitter — agents + `_make_client` + topological `main` + storage/prompt parity (no skills/MCP yet). **Phase 2:** skills + capture (port). **Phase 3:** MCP tools. **Phase 4:** frontend submenu + route + Setup.
- Not doing: the Graph API path (kept as the documented fallback), `McpSkillsSource` (our skills are folder-backed subprocess, not MCP), HITL/checkpointing (MAF features we don't map from the DSL).

Relates to [[project_adk_compiler]], [[project_skill_pipeline_execution]], [[feedback_no_override_form_params]], [[project_langchain_runner]].
