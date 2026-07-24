# Google ADK Workflow Compiler — Design Spec

- **Date:** 2026-07-01
- **Status:** Approved design, pending implementation plan
- **Author:** Didier Martin (with Claude Code)

## 1. Purpose

Add a second workflow-compilation backend that translates the existing workflow
DSL into a **fully self-contained Google ADK Python program**, mirroring the
existing LangGraph compiler (`LangGraphGenerator.php`).

The compiler runs in PHP at compile time only. Its output is a standalone `.py`
file that runs anywhere Python is available, with **zero runtime dependency on
the PHP backend or the workflow editor** — identical to the self-containment
guarantee of the current LangGraph output.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Compiler language | PHP — new `ADKGenerator.php` beside `LangGraphGenerator.php` |
| Output language | Python targeting Google ADK (`google-adk`) |
| Scope | Full parity: sequential + fan-out + fan-in + LLM nodes + MCP + skills + multi-provider |
| Delivery | New `generate-adk` route, same shape as `generate-python` (`{filename, code}`, `?download=1`) |
| DAG → ADK topology | **Topological layering** (Approach A) |
| MCP transport | **Port the proven inline HTTP JSON-RPC client** as ADK `FunctionTool`s (Approach A) |
| Skills | Port `_run_skill_script`; add an async-safe subprocess entry for parallel layers |

## 3. Input contract (existing workflow DSL)

Consumed unchanged from `WorkflowGraphRepository::getGraph()`:

```
{ "nodes": [ ... ], "edges": [ ... ] }
```

- **Node types:** `start`, `agent` / `agent-template`, `parallel`, `output`
  (plus `realtime-*`, out of scope for this backend).
- **Agent node config:** `systemPrompt`/`instructions`, `provider`/`model`,
  `selectedTools`/`tools`, `settings.{temperature,max_tokens}`,
  `skill_content`, `skill_dir`, `documents`, `output_schema_id`.
- **Start node config:** `prompt`, `documents`.
- **Edges:** `from_node_id` → `to_node_id`; fan-out = one parent → many children;
  fan-in = many parents → one (`output`) node. `condition_expr` reserved/unused.

The ADK compiler consumes a **byte-identical** contract to the LangGraph compiler.
Any output difference stems from ADK idioms, never from DSL reinterpretation.

## 4. Self-containment invariant (non-negotiable)

The emitted `.py` bakes everything inline:

- MCP server URLs/keys → inline `MCP_SERVERS` dict + ported HTTP client.
- Tool definitions → inline `TOOL_CATALOG`.
- Skill runner → inline `_run_skill_script` (subprocess, real CPython).
- Agent prompts, models, tool bindings, edges, start prompt, document context →
  inline constants.
- `Runner` + `main()` → runs via `python workflow_<name>_adk.py`.

**Self-contained ≠ stripped-down.** The output performs full MCP and skill
execution *within its own Python environment*:

- **MCP:** the script is itself the JSON-RPC client; it dials the servers directly.
- **Skills:** the script runs each skill's Python scripts as subprocesses in its
  own environment and pip-installs each skill's `SKILL.md` dependencies into that
  same environment on first use.

External-resource footprint equals the current LangGraph output — and nothing more:
(1) pip deps, (2) network reach to MCP servers, (3) local skills dir
(`~/Documents/synergyAI/skills`) only when skills are used.

The shared `WorkflowGraphAnalyzer` (Section 7) exists **only in the PHP compiler**
and is never referenced by the emitted Python.

## 5. Core mapping: DAG → ADK tree (Approach A, topological layering)

ADK has no graph primitive; it composes a tree of `SequentialAgent` /
`ParallelAgent` / `LlmAgent`. The compiler converts the DAG as follows:

1. Compute topological levels (same topo-order the LangGraph generator uses).
2. Each level with >1 independent node → `ParallelAgent([...])`; a single-node
   level → that node's `LlmAgent`.
3. `root_agent = SequentialAgent([Layer0, Layer1, ...])`.
4. Data flows via ADK shared `session.state`: each node writes
   `output_key="node_<id>"`; downstream instructions read parent outputs via
   `{node_<id>}` state templating.

Rejected alternatives:

- **B. Series-parallel decomposition** — prettier tree, but fails on DAGs that
  are not series-parallel. Too fragile for a general compiler.
- **C. Custom `BaseAgent` scheduler** — replays LangGraph node-by-node; discards
  ADK's orchestration value. Rejected.

## 6. Emitted file structure

Order of generated sections (front half reuses LangGraph blocks near-verbatim):

1. Docstring + `requirements` (`google-adk`, `litellm`, doc-conversion deps).
2. Ported MCP HTTP client (`_call_mcp_tool`, `MCP_SERVERS`, `TOOL_CATALOG`) and
   skill executor (`_run_skill_script`, `SKILL.md` dep install). **Change:** an
   **async** subprocess entry (`asyncio.create_subprocess_exec`) so skills inside
   a `ParallelAgent` layer do not block the event loop and serialize the fan-out.
   This is the only skill-related code difference from the LangGraph path.
3. `build_tools_from_catalog()` → wraps each MCP tool as a `FunctionTool`;
   auto-attaches `run_skill_script` to any agent whose prompt references it.
4. `_make_model(provider, model)`: Gemini → model-string; Claude/Grok/OpenAI/etc.
   → `LiteLlm(model=...)`.
5. Per-node `LlmAgent`: `instruction` = `systemPrompt` (+ `## Skill` block +
   `{node_<parent>}` injections), `tools` = resolved list,
   `output_key="node_<id>"`, `output_schema` (Pydantic) when `output_schema_id` set.
6. Start seeding (`prompt` + converted `documents` seed initial `session.state`)
   and `output` node → final consolidator agent reading all parent `{node_<id>}`
   keys (matches LangGraph's parent-name consolidation).
7. `root_agent = SequentialAgent([...layers...])`.
8. `main()`: `Runner` + in-memory session; seed state with user prompt + doc
   context; run; collect final output; write artifacts to `outputs/`.

## 7. Generator structure (PHP)

- `ADKGenerator::generate(int $workflowId, ?string $userId): array`
  → `['filename' => '..._adk.py', 'code' => '...']` (mirrors `LangGraphGenerator`).
- **Shared `WorkflowGraphAnalyzer`** (new, compile-time only): extracts the
  DSL-analysis front half both compilers share — load graph, topological order,
  `agentData` extraction, `usedCatalog`/`usedServers`, skill resolution. Both
  generators call it; they differ only in their emit half. Rationale: two compilers
  on a byte-identical contract must not diverge on parsing.
- `LangGraphGenerator` is refactored to call `WorkflowGraphAnalyzer` for its front
  half (behavior-preserving; guarded by existing `compare_generators.py`-style
  output checks where practical).

## 8. Wiring

- Route: `GET /api/v1/workflows/{id:\d+}/generate-adk`
  → `WorkflowController::generateAdk()` (near-clone of `generatePython()`; same
  `?download=1` behavior and `{filename, code}` response).
- Frontend: a second "Compile → ADK" affordance next to the existing LangGraph
  one in the workflow editor (exact placement confirmed against the editor during
  implementation). Remember to bump the JS cache-buster `?v=` on edit.

## 9. Testing

- **Golden-file tests:** compile representative workflows (sequential; diamond
  fan-out/fan-in; MCP-tool agent; skill agent; multi-provider) and assert the
  emitted Python matches committed fixtures.
- **Syntax/import check:** `python -m py_compile` on each generated file.
- **Smoke run:** execute at least one generated ADK file end-to-end against a live
  MCP server and a skill, confirming a final output is produced.
- **Analyzer parity:** confirm `WorkflowGraphAnalyzer` refactor leaves
  `LangGraphGenerator` output unchanged for the same inputs.

## 10. Out of scope (this iteration)

- `realtime-*` node types.
- Native ADK `MCPToolset` transport (kept as a future swap for the ported HTTP client).
- Conditional-edge execution (`condition_expr` is reserved/unused in both compilers).
- Frontend runner/execution UI beyond the compile-and-download affordance.
