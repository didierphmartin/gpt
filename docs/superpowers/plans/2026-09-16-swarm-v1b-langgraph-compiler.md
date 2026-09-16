# Swarm v1(b) — the LangGraph compiler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow set to `orchestration = "swarm"` compiles to a runnable Python package built on `langgraph-swarm`, with one module per member, and the code-generation dialog stops offering layouts a swarm cannot use.

**Architecture:** The generator gains a fourth emit path beside single-file, modular and A2A. It reads the architecture from the workflow (not from a build option — §10: architecture is a property of the workflow), runs the **same** `SwarmRewriter` the editor runs in JS, and emits the modular layout with `workflow.py` replaced by a swarm built from `create_swarm`. Every other file in that layout is unchanged.

**Tech Stack:** PHP 8.4 + PHPUnit (the generator), Python 3.13 + `langgraph-swarm 0.1.0` (the emitted code), vanilla JS (the dialog).

**Spec:** `docs/superpowers/specs/2026-09-14-swarm-orchestration-design.md`. Read §2 (why the library), §4 (the package and the dialog), §5 (the checkpointer), §8.3 (the tests) and §10 before starting.

## The library, verified rather than assumed

`langgraph-swarm 0.1.0` is installed in the runner venv (`~/Documents/synergyAI/python/.venv`). Its real API, read from the installed package:

```
create_swarm(agents: list[Pregel], *, default_active_agent: str,
             state_schema: type = SwarmState, context_schema: type | None = None) -> StateGraph
create_handoff_tool(*, agent_name: str, name: str | None = None, description: str | None = None) -> BaseTool
add_active_agent_router(builder: StateGraph, *, route_to: list[str], default_active_agent: str) -> StateGraph
SwarmState fields: ['messages', 'active_agent']
```

`create_swarm` returns an **uncompiled** `StateGraph`; you call `.compile(...)` yourself. Do not invent parameters — if something you want is not in that signature, say so in your report rather than guessing.

## Global Constraints

- **Workflow-mode output must stay byte-identical.** Swarm is a *new* emit path beside four existing ones (LangGraph single/modular/A2A, plus ADK/MAF/NOOA sharing helpers). The existing generator pins cover this; they must stay green, unchanged. If you find yourself editing an existing expectation, stop — you have changed a shared path.
- **The rewrite is not reimplemented.** `SwarmRewriter::rewrite()` already exists, is tested against a 16-case fixture, and is byte-identical to its JS twin. The compiler *calls* it. Any behaviour change belongs in the rewriter and its fixture, never in the emitter.
- **Refusals are the rewriter's, verbatim.** The six codes (`start_needs_two_agents`, `dispatcher_in_swarm`, `agent_not_on_start`, `duplicate_agent_names`, `multiple_outputs`, `playbook_unsupported`) become generation errors naming the offending nodes. Do not add a seventh in the emitter.
- **Agent names are graph node names.** `create_swarm` identifies agents by name, and handoff tools target them by name. The rewriter already refuses duplicate names (case- and whitespace-insensitively), which is what makes this safe — but names still need sanitising into valid Python identifiers for module and symbol names, and the display name must survive for the tool.
- **Modular layout only.** Single-file and A2A are deferred (§7). A swarm asked for either is refused.
- **PHP coerces numeric-string array keys to int.** Cast ids back with `(string)` before comparing with `===`.
- **Pre-existing failures**: `backend/tests/Unit` sits at 25 failures (12 errors, 13 failures) out of 411. They stay, name for name.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `backend/src/AgentTeam/Services/LangGraphGenerator.php` | `orchestration` in the facts; swarm dispatch; the swarm emit path | 1, 3 |
| `backend/tests/Unit/LangGraphSwarmGeneratorTest.php` | New. Emit assertions for the swarm package | 1, 3 |
| `backend/tests/fixtures/compiled/swarm_probe.py` | New. Imports the emitted package and builds the graph with the LLM stubbed | 4 |
| `frontend/assets/js/workflow-editor.js` | The dialog becomes orchestration-aware | 5 |
| `frontend/assets/i18n/{en,es,fr}.json` | Dialog copy | 5 |

---

### Task 1: The architecture reaches the generator, and the wrong layouts are refused

Before emitting anything, the generator has to know it is compiling a swarm, and say no to the layouts that cannot express one.

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php`
- Create: `backend/tests/Unit/LangGraphSwarmGeneratorTest.php`

**Interfaces:**
- Produces: `$facts['orchestration']` — `'workflow'` or `'swarm'`, read from the Workflow model inside `analyzeForEmit()`.
- Produces: `generate()` dispatching to `generateSwarm($facts)` when the workflow is a swarm.
- Produces: a `RuntimeException` whose message names the unsupported layout when a swarm is asked for single-file or A2A.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/LangGraphSwarmGeneratorTest.php`. Follow the existing `LangGraphModularGeneratorTest.php` for how a workflow fixture is built and the generator invoked — match its setup exactly rather than inventing a new harness.

Three tests to start:

```php
public function testASwarmWorkflowCompilesThroughTheSwarmPath(): void
{
    // a valid swarm: Start -> two agents, no dispatcher
    $files = $this->generateSwarm($this->twoAgentSwarm());
    $this->assertArrayHasKey('workflow.py', $files);
    $this->assertStringContainsString('create_swarm', $files['workflow.py']);
}

public function testSingleFileIsRefusedForASwarm(): void
{
    $this->expectException(\RuntimeException::class);
    $this->expectExceptionMessageMatches('/single file|modular/i');
    $this->generate($this->twoAgentSwarm(), []);          // no modular, no a2a
}

public function testA2AIsRefusedForASwarm(): void
{
    $this->expectException(\RuntimeException::class);
    $this->expectExceptionMessageMatches('/A2A/i');
    $this->generate($this->twoAgentSwarm(), ['a2a' => true]);
}
```

- [ ] **Step 2: Run them and watch them fail**

`cd backend && php vendor/bin/phpunit tests/Unit/LangGraphSwarmGeneratorTest.php`
Expected: failures — the swarm path does not exist and nothing refuses.

- [ ] **Step 3: Carry the architecture in the facts**

In `analyzeForEmit()` (around line 693), `$workflow` is already loaded. Add:

```php
        // Architecture is a property of the workflow, not of the build (§10):
        // read it here rather than taking it as a generate() option, so every
        // caller agrees without having to remember to pass it.
        'orchestration' => $workflow->getOrchestration(),
```

to the returned facts array, beside the other workflow-level values.

- [ ] **Step 4: Dispatch, and refuse what a swarm cannot be**

In `generate()` (around line 246), before the existing a2a/modular branches:

```php
        if (($facts['orchestration'] ?? 'workflow') === 'swarm') {
            // §7 defers both. A2A swarm in particular is a different design —
            // handoffs crossing the network between agent servers — not a
            // packaging variation, so refusing is honest rather than lazy.
            if (!empty($options['a2a'])) {
                throw new RuntimeException(
                    'A2A packaging is not supported for swarm workflows yet. Generate this swarm with "Agents in separate files".'
                );
            }
            if (empty($options['modular'])) {
                throw new RuntimeException(
                    'Single-file packaging is not supported for swarm workflows yet. Generate this swarm with "Agents in separate files".'
                );
            }
            return $this->generateSwarm($facts);
        }
```

Add a `generateSwarm()` stub that throws `RuntimeException('not implemented')` for now — Task 3 fills it. The two refusal tests pass at this point; the first does not.

- [ ] **Step 5: Confirm nothing else moved**

```bash
cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3
```
Expected: exactly `Errors: 12, Failures: 13`, plus your one intended failure. Every existing generator test must be untouched — `analyzeForEmit` feeds all of them, so a mistake here shows up immediately.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/LangGraphSwarmGeneratorTest.php
git commit -m "feat(swarm): the generator reads the architecture and refuses the layouts a swarm cannot use"
```

---

### Task 2: The rewrite drives the emit, and its refusals become generation errors

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php`
- Modify: `backend/tests/Unit/LangGraphSwarmGeneratorTest.php`

**Interfaces:**
- Consumes: `SwarmRewriter::rewrite(array $graph): array` — `{ok:true, agents:{id:{id,name,instructions,tools,skills,handoffs}}, entry}` or `{ok:false, error, nodes}`.
- Produces: `$facts['swarm']` — the accepted rewrite, for Task 3 to emit from.

- [ ] **Step 1: Write the failing tests**

```php
public function testARefusedCanvasFailsGenerationNamingTheNodes(): void
{
    // Start -> ONE agent: start_needs_two_agents
    $this->expectException(\RuntimeException::class);
    $this->expectExceptionMessageMatches('/two or more agents|start_needs_two_agents/i');
    $this->generateSwarm($this->oneAgentSwarm());
}

public function testADispatcherTaggedNodeIsRefusedAtCompileTime(): void
{
    $this->expectException(\RuntimeException::class);
    $this->expectExceptionMessageMatches('/Dispatcher/i');
    $this->generateSwarm($this->swarmWithDispatcherTag());
}

public function testTheMembersAreStartsFanOutInCanvasOrder(): void
{
    $files = $this->generateSwarm($this->threeAgentSwarm());
    // one module per member, none for anything else
    $this->assertSame(
        ['agents/agent_a.py', 'agents/agent_b.py', 'agents/agent_c.py'],
        array_values(array_filter(array_keys($files), fn($f) => str_starts_with($f, 'agents/')))
    );
}
```

Adjust the expected module filenames to whatever the existing modular path actually produces — read `emitModularAgentFile`/`modularLayout` first and match their naming, do not invent a scheme.

- [ ] **Step 2: Run, watch fail, then wire the rewrite**

In `generateSwarm()`, build the graph shape `SwarmRewriter::rewrite()` expects from the facts the analyzer already has, call it, and translate a refusal into a `RuntimeException` that names both the reason and the offending nodes:

```php
        $rw = SwarmRewriter::rewrite(['nodes' => $nodes, 'edges' => $edges]);
        if (!$rw['ok']) {
            $names = implode(', ', array_map(fn($id) => $nodeNames[$id] ?? "node {$id}", $rw['nodes']));
            throw new RuntimeException(self::swarmRefusalMessage($rw['error']) . ($names !== '' ? " ({$names})" : ''));
        }
        $facts['swarm'] = $rw;
```

`swarmRefusalMessage()` maps each of the six codes to a sentence. Keep those sentences close to the editor's — a user who hit the refusal while drawing should recognise it when compiling. They are not i18n'd: generator errors are developer-facing and the rest of this file is English.

**The shape the rewriter expects** is `{nodes:[{id,node_type,config}], edges:[{from,to}]}` — the same shape the API uses. Check what `analyzeForEmit` already holds before building it; if the facts carry a different shape, convert, and say so in your report.

- [ ] **Step 3: Verify and commit**

```bash
cd backend && php vendor/bin/phpunit tests/Unit/LangGraphSwarmGeneratorTest.php
cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3
```

```bash
git commit -m "feat(swarm): the compiler runs the shared rewrite and surfaces its refusals"
```

---

### Task 3: Emit the swarm package

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php`
- Modify: `backend/tests/Unit/LangGraphSwarmGeneratorTest.php`

**Interfaces:**
- Consumes: `$facts['swarm']` from Task 2.
- Produces: the same file set as `generateModular()` with `workflow.py` and `agents/*.py` replaced by swarm equivalents; `common.py`, `runs.py`, `api.py` emitted by the **existing** modular helpers, unchanged.

- [ ] **Step 1: Read the modular emitter before writing anything**

`generateModular()` (2479), `emitModularCommon()` (2550), `emitModularApi()` (2659), `emitModularAgentFile()` (2702), `emitModularWorkflow()` (2808), `modularLayout()` (2450). Your swarm path reuses common/api/runs verbatim and replaces only the workflow and agent emitters. Reuse by calling those methods, not by copying their bodies.

- [ ] **Step 2: Emit each agent module**

One module per member. Each builds a react agent whose tools are its own tools plus one handoff tool per colleague:

```python
from langgraph_swarm import create_handoff_tool
from langgraph.prebuilt import create_react_agent
from common import make_llm, load_skill          # whatever the modular common.py exposes

NODE = {...}                                     # keep the existing NODE metadata block

HANDOFFS = [
    create_handoff_tool(
        agent_name="IT claims",
        description="Hand the conversation to IT claims — passwords, network access, technical support.",
    ),
]

def build_agent():
    return create_react_agent(
        make_llm(NODE),
        TOOLS + HANDOFFS,
        prompt=INSTRUCTIONS,
        name="Human resources",
    )
```

The `name=` is the member's **display name**, because that is what `create_swarm` and the handoff tools identify agents by, and what the rewriter guaranteed unique. The module and symbol names come from the existing slug helper. The `description` is the colleague's own role summary — the rewrite already composed exactly that into `instructions`; take it from the same source rather than recomputing.

- [ ] **Step 3: Emit `workflow.py`**

```python
from langgraph_swarm import create_swarm
from langgraph.checkpoint.memory import MemorySaver

from agents.human_resources import build_agent as build_human_resources
from agents.it_claims import build_agent as build_it_claims

def build_graph():
    return create_swarm(
        [build_human_resources(), build_it_claims()],
        default_active_agent="Human resources",
    ).compile(checkpointer=MemorySaver())
```

Three things to get right:

- `create_swarm` returns an **uncompiled** `StateGraph`; `.compile()` is yours to call.
- `default_active_agent` is `$facts['swarm']['entry']`'s display name — the first agent connected to Start.
- `MemorySaver` is what makes the compiled server hold a session between prompts (§5). It is in-process and needs no configuration; a database-backed saver is a later step and the code should keep the saver a single injection point, not a shape the graph depends on.

Keep the runner/CLI block the modular path already emits, so a generated swarm runs the same way a generated workflow does.

- [ ] **Step 4: Assert the emit**

Add tests for: `create_swarm` present with the right `default_active_agent`; one `create_handoff_tool` per colleague per module (a three-member mesh gives each agent two); no router or dispatcher module; `common.py`/`runs.py`/`api.py` byte-identical to what `generateModular()` produces for the same workflow — assert that by generating both and comparing, which also proves you reused rather than copied.

- [ ] **Step 5: Verify and commit**

```bash
cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3
```
Expected: `Errors: 12, Failures: 13` and your new tests green.

---

### Task 4: Prove the emitted package actually runs

Emit assertions prove the text. They do not prove Python accepts it.

**Files:**
- Create: `backend/tests/fixtures/compiled/swarm_probe.py`
- Modify: `backend/tests/Unit/LangGraphSwarmGeneratorTest.php`

- [ ] **Step 1: Read how the existing compile probes work**

`AdkGeneratorCompileTest.php`, `MafGeneratorCompileTest.php` and `NooaGeneratorCompileTest.php` already do this for other targets, and `backend/tests/fixtures/compiled/` holds their probes. Follow that pattern exactly.

- [ ] **Step 2: Write the probe**

It writes the generated package to a temp directory, stubs the LLM factory so no provider is called, imports `workflow.py`, calls `build_graph()`, and asserts:

- the graph compiles;
- its nodes are exactly the member display names;
- `default_active_agent` is the entry agent;
- each agent exposes a handoff tool per colleague, named for that colleague.

Use the runner venv's interpreter — `~/Documents/synergyAI/python/.venv/bin/python` — which is where `langgraph-swarm 0.1.0` is installed. If the test cannot find it, **skip with a clear message** rather than failing; the existing compile tests do the same and that convention exists so a machine without the venv can still run the suite.

- [ ] **Step 3: Verify and commit**

Run the probe directly first, then through PHPUnit. Put both outputs in your report.

---

### Task 5: The dialog stops offering what a swarm cannot use

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/assets/i18n/{en,es,fr}.json`
- Modify: `frontend/index.html` (cache-buster)

- [ ] **Step 1: Make the modal orchestration-aware**

`_showCodegenOptionsModal()` builds three radios from a `choices` array. In swarm mode, `single` and `a2a` are **shown but disabled**, each with a one-line reason appended to its help text (spec §4). Hiding them would make the feature look absent; refusing at Generate would tell the user only after they had chosen.

Force the selection to `modular` when the workflow is a swarm, so the dialog cannot return a mode the generator will reject.

- [ ] **Step 2: Add the copy, in all three locales**

`t()` renders the raw key when one is missing, so a `|| 'fallback'` never fires. Every new key goes in `en.json`, `es.json` and `fr.json`.

- [ ] **Step 3: Verify**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
for f in en es fr; do python3 -c "import json;json.load(open('frontend/assets/i18n/$f.json'));print('$f ok')"; done
```
Then list every `t()` key you added and grep each out of all three locale files.

A pre-commit hook refuses a commit that changes a file under `frontend/assets/` without moving its `?v=` in `index.html`. **Read the current value; do not assume it.**

- [ ] **Step 4: The owner's pass — report it outstanding, do not tick it**

1. Open the swarm test workflow, choose **LangGraph → Generate**. The dialog offers only "Agents in separate files"; the other two are visible, disabled, and say why.
2. Generate. Read `workflow.py`: `create_swarm`, the entry agent as `default_active_agent`, one import per member, no router module.
3. Run the generated package and hold a two-prompt conversation through it — the second prompt must reach the agent that answered the first. That is the same property v1(a) proves in the editor, now proven in compiled code.
4. Switch the workflow to `workflow` mode and generate again: byte-identical to what it produced before this work.

---

## What this plan does not build

Single-file and A2A swarm packaging (§7 — A2A swarm is a different design, not a packaging variation), ADK and MAF swarm targets (§9), a database-backed checkpointer (§5 — `MemorySaver` only), multi-user (its own spec), chat authoring swarms (§7), and the TypeScript/Python backend twins (parity tracker row 158).
