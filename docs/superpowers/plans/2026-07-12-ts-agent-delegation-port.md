# TS Agent Teams Delegation Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Agent Teams manager→worker delegation to the TypeScript backend so a `manager` agent on Node can delegate to worker agents (parity with PHP).

**Architecture:** Two new files (`AgentDelegationFunctions.ts` = the 3 delegation tool handlers; `AgentToolsExecutor.ts` = an executor that routes delegation tool names to those handlers) plus edits to `AgentRunner` (manager branch of `buildToolsForAgent` + `setupFunctionExecutor`) and a `findWorkerAgents` method on `AgentRepository`. Managers use `tool_choice='auto'` — the existing provider tool loop drives delegate → result → answer. No provider-internals changes.

**Tech Stack:** TypeScript + Kysely (`db` from `../db/pools`); `node:test` via `tsx`; providers already ported.

## Global Constraints

- Managers use the default `tool_choice='auto'`. Do NOT force tool use and do NOT implement the `___WORKFLOW_COMPLETE___` marker-switch (decision in the spec). No provider files change.
- Port exactly 3 tools: `delegate_to_agent`, `list_available_agents`, `complete_task`. Do NOT port `run_agents_parallel`.
- `canDelegateToAgent`: not-a-manager → false; **empty `canDelegateTo` → true (any agent)**; else `agentId ∈ canDelegateTo`.
- `findWorkerAgents`: empty `canDelegateTo` → all enabled `worker`/`standard` agents; else `id IN (canDelegateTo) AND enabled=1`, ordered `display_order ASC, name ASC`.
- Tool schemas and result payload keys must match the PHP `AgentDelegationFunctions` verbatim (names, descriptions, required fields, result keys).
- `Agent` in TS is a plain interface: use `agent.name`, `agent.agentType`, `agent.canDelegateTo`, `agent.enabled`, `agent.id` (NOT PHP-style getters).

---

## File Structure

- `backend_typescript/src/AgentTeam/AgentRepository.ts` — **edit**: export `canDelegateToAgent()`, add `findWorkerAgents()`.
- `backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts` — **new**: 3 handlers + schemas.
- `backend_typescript/src/AgentTeam/AgentToolsExecutor.ts` — **new**: routing executor.
- `backend_typescript/src/AgentTeam/AgentRunner.ts` — **edit**: `getDelegationFunctions()`, manager branches of `buildToolsForAgent` + `setupFunctionExecutor`.
- Tests under `backend_typescript/tests/`.

Test runner: `cd backend_typescript && node --import tsx --test tests/<file>.test.ts`
Typecheck: `cd backend_typescript && npm run typecheck`

---

## Task 1: AgentRepository — `canDelegateToAgent` + `findWorkerAgents`

**Files:**
- Modify: `backend_typescript/src/AgentTeam/AgentRepository.ts`
- Test: `backend_typescript/tests/canDelegateToAgent.test.ts`

**Interfaces:**
- Produces:
  - `export function canDelegateToAgent(manager: Agent, agentId: number): boolean` (pure)
  - `AgentRepository.findWorkerAgents(managerId: number): Promise<Agent[]>`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDelegateToAgent } from '../src/AgentTeam/AgentRepository';

const mk = (over: any) => ({
  id: 1, userId: 1, teamId: null, category: null, name: 'M', description: '',
  agentType: 'manager', parentAgentId: null, canDelegateTo: [], displayOrder: 0,
  provider: 'claude', model: null, instructions: '', tools: [], visibility: 'personal',
  enabled: true, settings: {}, createdAt: null, updatedAt: null, ...over,
});

test('non-manager cannot delegate', () => {
  assert.equal(canDelegateToAgent(mk({ agentType: 'worker' }), 5), false);
});
test('manager with empty canDelegateTo can delegate to any', () => {
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: [] }), 5), true);
});
test('manager delegates only to listed ids', () => {
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: [5, 7] }), 5), true);
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: [7] }), 5), false);
});
test('id list compared numerically', () => {
  assert.equal(canDelegateToAgent(mk({ canDelegateTo: ['5'] }), 5), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && node --import tsx --test tests/canDelegateToAgent.test.ts`
Expected: FAIL — `canDelegateToAgent` is not exported.

- [ ] **Step 3: Add `canDelegateToAgent` (pure) near the top-level exports of AgentRepository.ts**

```ts
/** Mirrors Agent::canDelegateToAgent. Manager-only; empty canDelegateTo = any agent. */
export function canDelegateToAgent(manager: Agent, agentId: number): boolean {
  if (manager.agentType !== 'manager') return false;
  const list = Array.isArray(manager.canDelegateTo) ? manager.canDelegateTo : [];
  if (list.length === 0) return true;
  return list.map((x: any) => Number(x)).includes(Number(agentId));
}
```

- [ ] **Step 4: Add `findWorkerAgents` method inside the `AgentRepository` class**

Use the SAME private row→`Agent` mapper the existing finders use (the one `findById`/`findAccessibleByUser` apply to each row — locate it in the file and reuse it; below it is called `mapRow`). Add:

```ts
  /** Mirrors AgentRepository::findWorkerAgents. Empty canDelegateTo → all enabled worker/standard. */
  async findWorkerAgents(managerId: number): Promise<Agent[]> {
    const manager = await this.findById(managerId);
    if (!manager || manager.agentType !== 'manager') return [];
    const list = Array.isArray(manager.canDelegateTo) ? manager.canDelegateTo : [];

    let rows: any[];
    if (list.length === 0) {
      rows = (
        await sql<any>`SELECT * FROM agents
          WHERE agent_type IN ('worker','standard') AND enabled = 1
          ORDER BY display_order ASC, name ASC`.execute(db)
      ).rows;
    } else {
      const ids = list.map((x: any) => Number(x));
      rows = (
        await sql<any>`SELECT * FROM agents
          WHERE id IN (${sql.join(ids)}) AND enabled = 1
          ORDER BY display_order ASC, name ASC`.execute(db)
      ).rows;
    }
    return rows.map((r) => mapRow(r));
  }
```

If the existing row→`Agent` mapper is a private method (e.g. `this.hydrate(r)`) rather than a module function, call it in the same form the other finders use. Do not invent a new mapper.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd backend_typescript && node --import tsx --test tests/canDelegateToAgent.test.ts && npm run typecheck`
Expected: PASS (4 tests) + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add backend_typescript/src/AgentTeam/AgentRepository.ts backend_typescript/tests/canDelegateToAgent.test.ts
git commit -m "feat(ts-agents): AgentRepository canDelegateToAgent + findWorkerAgents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: AgentDelegationFunctions.ts

**Files:**
- Create: `backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts`
- Test: `backend_typescript/tests/AgentDelegationFunctions.test.ts`

**Interfaces:**
- Consumes: `AgentRepository` (`findById`, `findByName`, `findWorkerAgents`), `canDelegateToAgent` (Task 1); `AgentRunner.run` + `AgentRunner.getExecutionContext`.
- Produces:
  - `class AgentDelegationFunctions` — constructed `(repository, runner)`.
  - `static toolNames(): string[]` → `['delegate_to_agent','list_available_agents','complete_task']`.
  - `getAllFunctions(): Record<string, { schema: {description, input_schema}, handler: (params, context) => Promise<any> }>`.
  - `toolDefinitions(): ToolDefinition[]` (name/description/input_schema for the 3 tools).
  - handlers `delegateToAgent`, `listAvailableAgents`, `completeTask`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDelegationFunctions } from '../src/AgentTeam/AgentDelegationFunctions';

const worker = { id: 5, name: 'Researcher', agentType: 'worker', enabled: true, description: 'r', provider: 'claude', tools: [], canDelegateTo: [] } as any;

function fakes(overrides: any = {}) {
  const repo: any = {
    findById: async (id: number) => (id === 5 ? worker : id === 1 ? manager : null),
    findByName: async (n: string) => (n === 'Researcher' ? worker : null),
    findWorkerAgents: async () => [worker],
    ...overrides.repo,
  };
  const manager = { id: 1, name: 'Mgr', agentType: 'manager', enabled: true, canDelegateTo: [] } as any;
  const runner: any = {
    run: async () => ({ success: true, text: 'done', tools_used: [], execution_id: 99 }),
    getExecutionContext: () => ({ user_id: 1, current_agent_id: 1, stream_context: null }),
    ...overrides.runner,
  };
  return { repo, runner };
}

test('delegateToAgent by name returns PHP-shaped success payload', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.delegateToAgent({ agent_name: 'Researcher', task: 'find X' }, runner.getExecutionContext());
  assert.equal(r.success, true);
  assert.equal(r.delegated_to, 'Researcher');
  assert.equal(r.result, 'done');
  assert.equal(r.execution_id, 99);
});

test('delegateToAgent requires a task', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.delegateToAgent({ agent_name: 'Researcher' }, {});
  assert.equal(r.success, false);
});

test('delegateToAgent denies a non-delegable agent', async () => {
  const managerLimited = { id: 1, name: 'Mgr', agentType: 'manager', enabled: true, canDelegateTo: [7] } as any;
  const { runner } = fakes();
  const repo: any = {
    findById: async (id: number) => (id === 5 ? worker : id === 1 ? managerLimited : null),
    findByName: async () => worker,
    findWorkerAgents: async () => [],
  };
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.delegateToAgent({ agent_id: 5, task: 't' }, { user_id: 1, current_agent_id: 1 });
  assert.equal(r.success, false);
  assert.match(r.error, /cannot delegate/i);
});

test('listAvailableAgents returns workers with count', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.listAvailableAgents({}, { user_id: 1, current_agent_id: 1 });
  assert.equal(r.success, true);
  assert.equal(r.count, 1);
  assert.equal(r.agents[0].name, 'Researcher');
});

test('completeTask returns an acknowledgment', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const r = await d.completeTask({ reason: 'done' }, {});
  assert.equal(r.success, true);
  assert.equal(r.status, 'workflow_complete');
});

test('toolNames lists exactly the 3 wired tools', () => {
  assert.deepEqual(AgentDelegationFunctions.toolNames(), ['delegate_to_agent', 'list_available_agents', 'complete_task']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && node --import tsx --test tests/AgentDelegationFunctions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the file**

`backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts`:

```ts
import { Agent, AgentRepository, canDelegateToAgent } from './AgentRepository';
import type { AgentRunner } from './AgentRunner';
import { ToolDefinition } from '../Contracts/FunctionExecutor';

export interface DelegationContext {
  user_id?: number;
  current_agent_id?: number | null;
  execution_id?: number | null;
  parent_execution_id?: number | null;
  stream_context?: any;
}

type Handler = (params: any, context: DelegationContext) => Promise<any>;

/**
 * Manager delegation tools — TS port of AgentDelegationFunctions.php.
 * Ported tools: delegate_to_agent, list_available_agents, complete_task.
 * (run_agents_parallel is intentionally NOT ported — unwired in PHP.)
 * complete_task is a plain signal tool (no marker-switch): with tool_choice='auto'
 * the provider loop lets the manager answer once it stops delegating.
 */
export class AgentDelegationFunctions {
  constructor(private repository: AgentRepository, private runner: AgentRunner) {}

  static toolNames(): string[] {
    return ['delegate_to_agent', 'list_available_agents', 'complete_task'];
  }

  getAllFunctions(): Record<string, { schema: { description: string; input_schema: any }; handler: Handler }> {
    return {
      delegate_to_agent: {
        schema: {
          description:
            'Delegate a task to a specialized sub-agent. The sub-agent will execute the task and return results. Use this to break down complex tasks and assign them to specialists. You can specify the agent by ID or name.',
          input_schema: {
            type: 'object',
            properties: {
              agent_id: { type: 'integer', description: 'ID of the agent to delegate to (use either agent_id or agent_name)' },
              agent_name: { type: 'string', description: 'Name of the agent to delegate to (use either agent_id or agent_name)' },
              task: { type: 'string', description: 'The task description to send to the sub-agent. Be specific and clear about what you need.' },
              context: { type: 'string', description: 'Optional additional context from previous agent outputs or research to help the sub-agent.' },
            },
            required: ['task'],
          },
        },
        handler: (p, c) => this.delegateToAgent(p, c),
      },
      list_available_agents: {
        schema: {
          description:
            'List all agents that this manager can delegate tasks to. Returns agent names, descriptions, and capabilities. Use this to understand your team before delegating.',
          input_schema: {
            type: 'object',
            properties: {
              agent_type: { type: 'string', description: 'Optional filter by agent type: worker, standard, or all', enum: ['worker', 'standard', 'all'] },
            },
            required: [],
          },
        },
        handler: (p, c) => this.listAvailableAgents(p, c),
      },
      complete_task: {
        schema: {
          description:
            'Signal that the workflow is complete and you are ready to provide your final response to the user. Call this ONLY when you have gathered all necessary information from your agents and are ready to synthesize the final answer. After calling this, respond directly to the user with your findings.',
          input_schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'Brief explanation of why the workflow is complete' },
              summary: { type: 'string', description: 'Optional brief summary of what was accomplished during the workflow' },
            },
            required: ['reason'],
          },
        },
        handler: (p, c) => this.completeTask(p, c),
      },
    };
  }

  toolDefinitions(): ToolDefinition[] {
    return Object.entries(this.getAllFunctions()).map(([name, f]) => ({
      name,
      description: f.schema.description,
      input_schema: f.schema.input_schema,
    }));
  }

  async delegateToAgent(params: any, context: DelegationContext): Promise<any> {
    const userId = Number(context.user_id ?? 0);
    const currentAgentId = context.current_agent_id ?? null;
    const parentExecutionId = context.execution_id ?? null;

    const task = String(params.task ?? '').trim();
    if (!task) return { success: false, error: 'Task description is required' };

    const agentId = params.agent_id ?? null;
    const agentName = params.agent_name ?? null;
    if (!agentId && !agentName) return { success: false, error: 'Either agent_id or agent_name is required' };

    let agent: Agent | null;
    try {
      agent = agentId
        ? await this.repository.findById(Number(agentId))
        : await this.repository.findByName(String(agentName), userId);
    } catch (e: any) {
      return { success: false, error: 'Error finding agent: ' + (e?.message ?? e) };
    }

    if (!agent) {
      let available: string[] = [];
      if (currentAgentId) available = (await this.repository.findWorkerAgents(Number(currentAgentId))).map((w) => w.name);
      let msg = `Agent not found: ${agentName ?? `ID ${agentId}`}`;
      if (available.length) msg += `. Available agents you can delegate to: ${available.map((n) => `"${n}"`).join(', ')}`;
      return { success: false, error: msg, available_agents: available };
    }

    if (!agent.enabled) return { success: false, error: `Agent '${agent.name}' is disabled` };

    if (currentAgentId) {
      const manager = await this.repository.findById(Number(currentAgentId));
      if (manager && !canDelegateToAgent(manager, agent.id as number)) {
        return { success: false, error: `Manager cannot delegate to agent '${agent.name}'` };
      }
    }

    let input = task;
    const additional = String(params.context ?? '').trim();
    if (additional) input = `## Context from Previous Analysis\n${additional}\n\n## Your Task\n${task}`;

    if (context.stream_context) {
      const manager = currentAgentId ? await this.repository.findById(Number(currentAgentId)) : null;
      context.stream_context.emitAgentDelegate(Number(currentAgentId ?? 0), manager?.name ?? 'Unknown', agent.id, agent.name, task);
    }

    try {
      const result = await this.runner.run(agent, input, [], userId, {
        parent_execution_id: parentExecutionId,
        parent_agent_id: currentAgentId,
      });
      if (result.success) {
        return {
          success: true,
          delegated_to: agent.name,
          agent_id: agent.id,
          agent_type: agent.agentType,
          status: 'completed',
          result: result.text ?? '',
          tools_used: result.tools_used ?? [],
          execution_id: result.execution_id ?? null,
        };
      }
      return { success: false, agent_name: agent.name, error: result.error ?? 'Unknown error' };
    } catch (e: any) {
      return { success: false, agent_name: agent.name, error: 'Delegation failed: ' + (e?.message ?? e) };
    }
  }

  async listAvailableAgents(params: any, context: DelegationContext): Promise<any> {
    const userId = Number(context.user_id ?? 0);
    const currentAgentId = context.current_agent_id ?? null;
    const typeFilter = params.agent_type ?? 'all';

    const info = (a: Agent) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      type: a.agentType,
      provider: a.provider,
      tools: a.tools,
    });

    const agents: any[] = [];
    if (currentAgentId) {
      const workers = await this.repository.findWorkerAgents(Number(currentAgentId));
      for (const a of workers) if (typeFilter === 'all' || a.agentType === typeFilter) agents.push(info(a));
    } else {
      const filters: any = {};
      if (typeFilter !== 'all') filters.agent_type = typeFilter;
      const accessible = await this.repository.findAccessibleByUser(userId, filters);
      for (const a of accessible) if (a.agentType !== 'manager') agents.push(info(a));
    }

    return {
      success: true,
      count: agents.length,
      agents,
      message: agents.length > 0 ? `Found ${agents.length} agents available for delegation` : 'No agents available for delegation',
    };
  }

  async completeTask(params: any, _context: DelegationContext): Promise<any> {
    const reason = params.reason ?? 'Workflow complete';
    const summary = params.summary ?? '';
    return {
      success: true,
      status: 'workflow_complete',
      reason,
      summary,
      instruction: 'You may now synthesize all results and respond to the user with your final answer.',
    };
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd backend_typescript && node --import tsx --test tests/AgentDelegationFunctions.test.ts && npm run typecheck`
Expected: PASS (6 tests) + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts backend_typescript/tests/AgentDelegationFunctions.test.ts
git commit -m "feat(ts-agents): port AgentDelegationFunctions (delegate/list/complete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: AgentToolsExecutor.ts

**Files:**
- Create: `backend_typescript/src/AgentTeam/AgentToolsExecutor.ts`
- Test: `backend_typescript/tests/AgentToolsExecutor.test.ts`

**Interfaces:**
- Consumes: `FunctionExecutor` (base), `AgentDelegationFunctions`, `AgentRunner.getExecutionContext`.
- Produces: `class AgentToolsExecutor implements FunctionExecutor` — `(base, delegation, runner)`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolsExecutor } from '../src/AgentTeam/AgentToolsExecutor';

test('routes delegation tool to the delegation handler; others to base', async () => {
  const calls: string[] = [];
  const base: any = {
    execute: async (n: string) => { calls.push('base:' + n); return { base: true }; },
    hasFunction: () => true, isMCPTool: () => false, getToolDefinitions: () => [{ name: 'x', description: '', input_schema: {} }],
  };
  const delegation: any = {
    getAllFunctions: () => ({ delegate_to_agent: { schema: {}, handler: async () => ({ delegated: true }) } }),
  };
  // AgentDelegationFunctions.toolNames is static; stub via the constructor's Set source:
  (delegation.constructor as any).toolNames = () => ['delegate_to_agent'];
  const runner: any = { getExecutionContext: () => ({ user_id: 1 }) };

  const exec = new AgentToolsExecutor(base, delegation, runner);
  const del = await exec.execute('delegate_to_agent', { task: 't' });
  assert.deepEqual(del, { delegated: true });
  const other = await exec.execute('some_mcp_tool', {});
  assert.deepEqual(other, { base: true });
  assert.deepEqual(calls, ['base:some_mcp_tool']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && node --import tsx --test tests/AgentToolsExecutor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the file**

`backend_typescript/src/AgentTeam/AgentToolsExecutor.ts`:

```ts
import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';
import { AgentDelegationFunctions } from './AgentDelegationFunctions';
import type { AgentRunner } from './AgentRunner';

/**
 * Executor for manager agents — TS port of AgentToolsExecutor.php.
 * Routes delegation tool names to the delegation handlers (with the runner's
 * executionContext); everything else falls through to the base executor.
 */
export class AgentToolsExecutor implements FunctionExecutor {
  private readonly delegationNames: Set<string>;

  constructor(
    private readonly base: FunctionExecutor,
    private readonly delegation: AgentDelegationFunctions,
    private readonly runner: AgentRunner,
  ) {
    this.delegationNames = new Set(AgentDelegationFunctions.toolNames());
  }

  async execute(name: string, params: any, context?: any): Promise<any> {
    if (this.delegationNames.has(name)) {
      const fn = this.delegation.getAllFunctions()[name];
      return fn.handler(params, this.runner.getExecutionContext());
    }
    return this.base.execute(name, params, context);
  }

  hasFunction(name: string): boolean {
    return this.delegationNames.has(name) || this.base.hasFunction(name);
  }

  isMCPTool(name: string): boolean {
    return this.delegationNames.has(name) ? false : this.base.isMCPTool(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.base.getToolDefinitions();
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd backend_typescript && node --import tsx --test tests/AgentToolsExecutor.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend_typescript/src/AgentTeam/AgentToolsExecutor.ts backend_typescript/tests/AgentToolsExecutor.test.ts
git commit -m "feat(ts-agents): AgentToolsExecutor routes delegation tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire delegation into AgentRunner

**Files:**
- Modify: `backend_typescript/src/AgentTeam/AgentRunner.ts`
- Test: `backend_typescript/tests/AgentRunnerManagerTools.test.ts`

**Interfaces:**
- Consumes: `AgentRepository` (class), `AgentDelegationFunctions` (Task 2), `AgentToolsExecutor` (Task 3), `FunctionExecutor` type.
- Produces: `AgentRunner.getDelegationFunctions()`; a `manager` agent's `buildToolsForAgent` returns the 3 delegation tool defs; `setupFunctionExecutor` wraps the base executor with `AgentToolsExecutor` for managers.

- [ ] **Step 1: Write the failing test (manager gets 3 delegation tool defs)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../src/AgentTeam/AgentRunner';

test('buildToolsForAgent returns the 3 delegation tools for a manager', () => {
  const runner = new AgentRunner();
  const manager = { id: 1, name: 'M', agentType: 'manager', canDelegateTo: [], enabled: true } as any;
  const mcpLoader: any = { getToolDefinitions: () => [] };
  // private method — invoke via reflection
  const tools = (runner as any).buildToolsForAgent(manager, mcpLoader, null);
  const names = tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ['complete_task', 'delegate_to_agent', 'list_available_agents']);
});

test('buildToolsForAgent for a worker does not include delegation tools', () => {
  const runner = new AgentRunner();
  const worker = { id: 2, name: 'W', agentType: 'worker', enabled: true } as any;
  const mcpLoader: any = { getToolDefinitions: () => [] };
  const tools = (runner as any).buildToolsForAgent(worker, mcpLoader, null);
  assert.equal(tools.some((t: any) => t.name === 'delegate_to_agent'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && node --import tsx --test tests/AgentRunnerManagerTools.test.ts`
Expected: FAIL — manager currently returns `[]` (names empty).

- [ ] **Step 3: Add imports at the top of AgentRunner.ts**

Add to the existing import block:

```ts
import { AgentRepository } from './AgentRepository';
import { AgentDelegationFunctions } from './AgentDelegationFunctions';
import { AgentToolsExecutor } from './AgentToolsExecutor';
import { FunctionExecutor } from '../Contracts/FunctionExecutor';
```

(Note: `Agent` / `buildSystemPrompt` are already imported from `./AgentRepository`; add `AgentRepository` to that or a new import line — match the file's style.)

- [ ] **Step 4: Add `getDelegationFunctions()` method to the `AgentRunner` class**

Place near `setupFunctionExecutor`:

```ts
  /** Fresh delegation-functions instance bound to this runner. Mirrors AgentRunner::getDelegationFunctions. */
  private getDelegationFunctions(): AgentDelegationFunctions {
    return new AgentDelegationFunctions(new AgentRepository(), this);
  }
```

- [ ] **Step 5: Replace the manager branch of `buildToolsForAgent`**

Find (currently at ~line 350):

```ts
    if (agent.agentType === 'manager') {
      // DEFERRED: delegation tools (list_available_agents / delegate_to_agent / complete_task).
      return [];
    }
```

Replace with:

```ts
    if (agent.agentType === 'manager') {
      // Managers get ONLY the delegation tools (no built-in / MCP tools) — they must delegate.
      return this.getDelegationFunctions().toolDefinitions();
    }
```

- [ ] **Step 6: Wrap the base executor for managers in `setupFunctionExecutor`**

Find (currently at ~line 333-340):

```ts
    const baseExecutor = new CombinedToolsExecutor(this.toolsManager, mcpLoader);

    // DEFERRED (Slice 1b): manager agents are wrapped with AgentToolsExecutor + AgentDelegationFunctions
    // in PHP. We do NOT add delegation tools here — managers run with the base executor (no delegation).

    const tools = this.buildToolsForAgent(agent, mcpLoader, toolsFilter);
    provider.setFunctionExecutor(new AgentToolDefsExecutor(baseExecutor, tools));
    return tools;
```

Replace with:

```ts
    const baseExecutor = new CombinedToolsExecutor(this.toolsManager, mcpLoader);

    // Managers get a delegation-aware executor: delegation tool names route to the
    // delegation handlers (with this runner's executionContext); all else → base.
    const executor: FunctionExecutor =
      agent.agentType === 'manager'
        ? new AgentToolsExecutor(baseExecutor, this.getDelegationFunctions(), this)
        : baseExecutor;

    const tools = this.buildToolsForAgent(agent, mcpLoader, toolsFilter);
    provider.setFunctionExecutor(new AgentToolDefsExecutor(executor, tools));
    return tools;
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd backend_typescript && node --import tsx --test tests/AgentRunnerManagerTools.test.ts && npm run typecheck`
Expected: PASS (2 tests) + typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add backend_typescript/src/AgentTeam/AgentRunner.ts backend_typescript/tests/AgentRunnerManagerTools.test.ts
git commit -m "feat(ts-agents): wire manager delegation into AgentRunner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Verify parity + integration

**Files:** verify only.

- [ ] **Step 1: Full delegation test suite + typecheck**

Run:
```bash
cd backend_typescript && node --import tsx --test tests/canDelegateToAgent.test.ts tests/AgentDelegationFunctions.test.ts tests/AgentToolsExecutor.test.ts tests/AgentRunnerManagerTools.test.ts && npm run typecheck
```
Expected: all green, typecheck clean.

- [ ] **Step 2: Parity greps**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend_typescript
grep -rn "DEFERRED.*delegation\|managers run with the base executor\|delegation deferred" src/AgentTeam/AgentRunner.ts || echo "no stale DEFERRED delegation comments"
grep -rn "run_agents_parallel" src/AgentTeam || echo "run_agents_parallel correctly not ported"
```
Expected: the stale "DEFERRED delegation" comments are gone; `run_agents_parallel` absent.

- [ ] **Step 3: Live smoke (manual, requires the Node backend + a manager agent)**

- Ensure a `manager` agent exists with at least one enabled worker in `can_delegate_to` (or empty for all).
- Run the manager via the Node backend (`POST /api/v1/agents/:id/run` or the Agent Teams UI on the Node backend).
- Confirm in `logs/backend.log` that the manager's tool defs include `delegate_to_agent` and that a `delegate_to_agent` call runs the worker and returns its text (an `agent_delegate` stream event is emitted).
- Confirm a worker/standard agent is unaffected (no delegation tools).

- [ ] **Step 4: Commit any verification note (if applicable)**

```bash
git add -A
git commit -m "chore(ts-agents): verify manager delegation parity on Node" || echo "nothing to commit"
```

---

## Self-Review

- **Spec coverage:** resolver of workers (Task 1); the 3 tools + handlers (Task 2); routing executor (Task 3); AgentRunner wiring — manager tool defs + delegation-aware executor (Task 4); `tool_choice='auto'` / no marker-switch / no provider changes (honored throughout — nothing touches providers); `run_agents_parallel` excluded (Task 5 grep). ✅
- **Placeholder scan:** all code complete; the one "reuse the existing row→Agent mapper" instruction (Task 1 Step 4) names the exact existing code to call, not a TODO. ✅
- **Type consistency:** `AgentDelegationFunctions(repository, runner)`, `toolNames()`, `getAllFunctions()`, `toolDefinitions()`, `AgentToolsExecutor(base, delegation, runner)`, `canDelegateToAgent(manager, agentId)`, `findWorkerAgents(managerId)` used consistently across tasks; handler result keys match PHP. ✅
