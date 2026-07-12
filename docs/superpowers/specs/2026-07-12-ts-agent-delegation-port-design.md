# Port Agent Teams Delegation to the TypeScript Backend

**Date:** 2026-07-12
**Status:** Design approved, pending spec review

## Problem

The PHP backend supports **Agent Teams**: a `manager` agent delegates subtasks to
`worker` agents at runtime via LLM tool calls. The TypeScript backend has this path
**stubbed / deferred** — `AgentRunner.ts` explicitly returns `[]` delegation tools for
managers ("DEFERRED to Slice 1b"), so a manager run on Node has no
`delegate_to_agent` / `list_available_agents` / `complete_task` tools and cannot
delegate. It runs as a plain single agent.

Single-agent runs and **workflows** (`GraphWorkflowRunner`) are already ported; only the
dynamic manager→worker delegation is missing.

## Goal

A `manager` agent executed on the TypeScript backend delegates to worker agents exactly
as it does on PHP: it receives the delegation tools, calls them, sub-agents run and
return results, and the manager synthesizes a final answer.

## Key architectural fact (de-risks the port)

Both backends execute tools via **the provider's built-in tool loop** (PHP
`AgentRunner:188`, TS `AgentRunner:100`). There is **no** manual manager iteration loop
to port. The provider loop already drives delegate → result → delegate again → final
text. Delegation only needs to be (a) offered to the provider as tool definitions and
(b) executable by the function executor.

## Decision: `tool_choice='auto'`, no forced delegation

PHP forces managers with `tool_choice='required'` and relies on a `___WORKFLOW_COMPLETE___`
marker to switch back to `'auto'` so the manager can answer — but that marker-switch is
implemented in **only one PHP provider (`GrokProvider`)**, so forced-delegation completion
is effectively Grok-only in PHP.

For the TS port we deliberately **do not force** tool use. Managers get the delegation
tools with the default `tool_choice='auto'`. The existing TS provider tool loop then
handles everything: the manager calls `delegate_to_agent` when useful, gets results fed
back, and produces final text when done. Consequences:

- **No provider-internals changes** — lowest risk, works on all providers.
- `complete_task` is ported as a **plain signal tool** that returns an acknowledgment; no
  marker-switch is needed or implemented.
- Trade-off vs PHP: a manager is *not compelled* to delegate (it could answer directly).
  Accepted.

## Scope

**In scope — the 3 tools PHP actually wires to managers:**
- `list_available_agents` — list workers the manager may delegate to.
- `delegate_to_agent` — run one worker on a task, return its text.
- `complete_task` — signal the manager is done and will now answer the user.

**Out of scope:**
- `run_agents_parallel` — defined in PHP but never wired to managers (dead code). Skipped
  per decision.
- Any change to single-agent runs, workflows, or the `Task` chat tool.

## Design

### New: `AgentTeam/AgentDelegationFunctions.ts`

Mirrors `AgentDelegationFunctions.php`. Constructed with an `AgentRepository` and the
`AgentRunner` (to execute delegated workers). Exposes:

- `getAllFunctions()` → map of `{ name → { schema, handler } }` for the 3 tools (schemas
  copied verbatim from PHP).
- `delegateToAgent(params, context)`:
  - Resolve the target by `agent_id` or `agent_name` (`AgentRepository.findById` /
    `findByName`).
  - Permission check: the current manager may only delegate to its workers
    (`can_delegate_to`). On violation return `{ success:false, error }` listing allowed
    agents (mirror PHP message).
  - Build the worker input: `task`, optionally prefixed with
    `"## Context from Previous Analysis\n{context}\n\n## Your Task\n{task}"`.
  - Emit `StreamContext.emitAgentDelegate(...)` when a stream context is present.
  - Run the worker: `AgentRunner.run(agent, input, [], userId, { parent_execution_id,
    parent_agent_id })` (fresh conversation `[]`).
  - Return `{ success, delegated_to, agent_id, result, tools_used, execution_id,
    available_agents, hint }` (mirror PHP shape).
- `listAvailableAgents(params, context)`:
  - If a current manager id is present → `findWorkerAgents(managerId)`, optionally
    filtered by `agent_type`. Otherwise → `findAccessibleByUser(userId)` excluding
    managers. Return `{ success, count, agents, message }`.
- `completeTask(params, context)`:
  - Return an acknowledgment payload (mirror PHP) — a signal tool; the provider loop then
    lets the manager produce its final text.
- Context helpers: read `user_id`, `current_agent_id`, `stream_context` from the
  execution context object (the run's `AgentRunner.executionContext`).

### New: `AgentTeam/AgentToolsExecutor.ts`

Mirrors `AgentToolsExecutor.php`. Implements the `FunctionExecutor` interface
(`execute(name, params, context)` / `hasFunction(name)`), wrapping the base
`CombinedToolsExecutor`:

- If `name` is one of the 3 delegation tools → invoke the matching
  `AgentDelegationFunctions` handler, passing the run's `executionContext`.
- Otherwise → delegate to the base executor.

### Edit: `AgentRunner.buildToolsForAgent`

Manager branch (currently `return []`): return the 3 delegation tool definitions from
`AgentDelegationFunctions.getAllFunctions()` (name + description + input_schema). Workers
/ standard agents unchanged.

### Edit: `AgentRunner.setupFunctionExecutor`

Manager branch: wrap the base `CombinedToolsExecutor` in `AgentToolsExecutor` (with a
delegation-functions instance bound to this runner + a fresh repository). Non-managers
keep the base executor.

### Manager tool_choice

No change — managers use the default `tool_choice='auto'` (per the decision above). No
forced-tool-use edit, no marker-switch, no provider changes.

### `AgentRepository.findWorkerAgents(managerId)`

If not already present, add it: resolve the manager's `can_delegate_to` list into the
worker `Agent` objects the user can access. Used by `listAvailableAgents` and the
`delegateToAgent` permission check.

## Testing

- `AgentDelegationFunctions`: unit-test the pure/serializable pieces with a stubbed
  repository + a stubbed runner:
  - `delegateToAgent` resolves by id and by name; builds the context-prefixed input;
    returns the PHP-shaped payload; denies delegation to a non-worker with the allowed
    list in the error.
  - `listAvailableAgents` returns workers for a manager and filters by `agent_type`.
  - `completeTask` returns the acknowledgment shape.
- `AgentToolsExecutor`: routes a delegation tool name to the handler; routes a
  non-delegation name to the base executor.
- `AgentRunner.buildToolsForAgent`: a `manager` agent now yields the 3 delegation tool
  names (was `[]`); a `worker` agent is unchanged.
- TS `tsc` typecheck clean.
- Parity check against PHP: same tool names, same schema shapes, same result payload
  keys.

## Consequences

- Node reaches parity with PHP for Agent Teams; managers delegate on both backends.
- No change to workflows, single-agent runs, or the chat `Task` tool.
- `run_agents_parallel` remains unported (unreachable in PHP too); documented, not a gap.
