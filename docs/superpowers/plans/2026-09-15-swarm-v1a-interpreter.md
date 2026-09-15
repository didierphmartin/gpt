# Swarm v1(a) — the interpreter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow can be set to run as a **swarm** in the editor, and the live interpreter runs it — the Dispatcher dissolves, its children become a mutually-connected swarm carrying its routing prompt as their handoff guide, and control passes between them until one answers.

**Architecture:** Orchestration becomes a workflow-level setting. A pure `graph → graph` rewrite in the PHP analyzer turns a valid swarm canvas into the graph that actually runs; the same rewrite exists in JS for live editor feedback, and a shared JSON fixture keeps the two honest. The interpreter then runs the rewritten graph with a handoff loop instead of a topological walk. **No compiler, no run server, no checkpointer, no database in this plan.**

**Tech Stack:** PHP 8.4 + PHPUnit 10.5 (analyzer, model, fixture), vanilla JS (editor + interpreter), MySQL (one column).

**Spec:** `docs/superpowers/specs/2026-09-14-swarm-orchestration-design.md` — read §3, §3a, §3b, §6b and §10 before starting.

**Where the rewrite lives.** The spec points at `WorkflowGraphAnalyzer::analyzeGraph`. This plan puts it in a new `SwarmRewriter` service instead, and leaves the analyzer untouched. The reason is testability: the rewrite must be a pure `graph → graph` function that a fixture can drive in both languages, and the analyzer carries dependencies that a fixture cannot supply. The analyzer calls into `SwarmRewriter` when v1(b) compiles a swarm. In v1(a) the PHP side has **no production caller** — it exists as the compiler's foundation and as the half of the contract that keeps the JS honest. Do not add a caller for it here.

## Global Constraints

- **Workflow mode is untouched.** Every existing canvas keeps running exactly as today when `orchestration = "workflow"`, which is the default. The existing compiler suites pin this byte-identical; they must stay green.
- **Swarm mode accepts exactly one shape**: a node tagged Dispatcher (`config.agent_type === 'dispatcher'`) fanning out to **two or more** agents. Every other canvas is refused, naming the offending nodes (spec §3a).
- **The dispatcher is not an agent in swarm mode.** It contributes no turn, no LLM call, no MCP tool, no skill. Only its routing prompt survives, as the handoff guide every member carries (spec §3b).
- **Synthesised edges**: the dispatcher's children become a full mesh — with children A, B, C the handoffs are A↔B, A↔C, B↔C.
- **Entry** is the dispatcher's child with the **lowest node id**, deterministically. Every list the rewrite returns — agents, handoffs, the nodes named in a refusal — is sorted by numeric node id, in PHP and in JS alike. Insertion order must never leak into the result: PHP preserves it and JS does not, so anything relying on it would make the two implementations disagree.
- **PHP coerces numeric-string array keys to integers.** `$a['3']` and `$a[3]` are the same slot, and `foreach` hands back `int 3`. Every id read out of a keyed array must be cast back with `(string)` before it is compared with `===`, or the comparison silently fails. The rewriter below does this at every boundary; keep it that way.
- **Hop budget** default 25 handoffs; exhausting it ends the run with status `hop_budget_exhausted`.
- **Skills run only on the turn that ends the run**, and only the answering agent's (spec §6b).
- **The rewrite is pure**: `graph → graph`, no I/O, no randomness, identical output for identical input in both PHP and JS.
- **i18n**: every new `t()` key must exist in `en.json`, `es.json` and `fr.json` — a missing key renders as the raw key.
- **Cache-buster**: any edit to `frontend/assets/js/workflow-editor.js` requires bumping its `?v=` in `frontend/index.html` (currently `20260911-tplnode1`).
- **Pre-existing failures**: `backend/tests/Unit` has 25 failures that predate this work. They stay at 25, name for name.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `backend/tests/fixtures/swarm/rewrite-cases.json` | **The contract.** Canvases in, expected rewritten graphs and refusals out. Read by both the PHP and JS tests | 1 |
| `backend/src/AgentTeam/Services/SwarmRewriter.php` | The rewrite, PHP. Pure static functions, no dependencies on the generator | 2 |
| `backend/tests/Unit/SwarmRewriterTest.php` | Drives the fixture against the PHP implementation | 2 |
| `backend/src/AgentTeam/Models/Workflow.php` | `orchestration` field, default `workflow` | 3 |
| `backend/src/AgentTeam/Controllers/WorkflowController.php` | Accept and return `orchestration` | 3 |
| `frontend/assets/js/swarm-rewrite.js` | The rewrite, JS. Same function, same fixture | 4 |
| `frontend/assets/js/workflow-editor.js` | The setting control, mode-aware node form, canvas feedback, the handoff loop | 5, 6, 7 |
| `frontend/assets/i18n/{en,es,fr}.json` | New keys | 5, 6, 7 |

---

### Task 1: The rewrite contract

The fixture both implementations are tested against. It exists before either of them, so neither can define the truth by accident.

**Files:**
- Create: `backend/tests/fixtures/swarm/rewrite-cases.json`

**Interfaces:**
- Produces: the fixture format every later task reads —
  `{"cases": [{"name", "graph": {"nodes", "edges"}, "expect": {...}}]}`, where `expect` is either
  `{"ok": true, "agents": [...], "handoffs": [[from, to], ...], "entry": "<id>", "guide_contains": [...]}`
  or `{"ok": false, "error": "<code>", "nodes": ["<id>", ...]}`

- [ ] **Step 1: Write the fixture**

Create `backend/tests/fixtures/swarm/rewrite-cases.json`. Node shape mirrors the editor's: `{"id", "node_type", "config": {"type", "agent_name", "agent_type", "instructions", "tools", "bound_skill"}}`.

```json
{
  "note": "The swarm rewrite contract. Read by SwarmRewriterTest.php (PHP) and swarm-rewrite.test (JS). A change here must make both sides pass or neither.",
  "cases": [
    {
      "name": "dispatcher with two children becomes a two-agent mesh",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start", "prompt": "hello"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "techBuddy", "agent_type": "dispatcher",
            "instructions": "Greet the caller warmly. When they mention vacations or HR, transfer to Human resources. When they mention passwords or network, transfer to IT claims."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "Human resources", "agent_type": "standard", "instructions": "You handle leave and payroll."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "IT claims", "agent_type": "standard", "instructions": "You handle passwords and access."}},
          {"id": "5", "node_type": "output", "config": {"type": "output"}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"},
                  {"from": "3", "to": "5"}, {"from": "4", "to": "5"}]
      },
      "expect": {
        "ok": true,
        "agents": ["3", "4"],
        "handoffs": [["3", "4"], ["4", "3"]],
        "entry": "3",
        "guide_contains": ["Human resources", "IT claims", "transfer to Human resources"]
      }
    },
    {
      "name": "three children become a full mesh",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route it."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}},
          {"id": "5", "node_type": "", "config": {"type": "agent-template", "agent_name": "C", "agent_type": "standard", "instructions": "C."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}, {"from": "2", "to": "5"}]
      },
      "expect": {
        "ok": true,
        "agents": ["3", "4", "5"],
        "handoffs": [["3", "4"], ["3", "5"], ["4", "3"], ["4", "5"], ["5", "3"], ["5", "4"]],
        "entry": "3",
        "guide_contains": ["A", "B", "C"]
      }
    },
    {
      "name": "the dispatcher's tools and skills reach no agent",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher",
            "instructions": "Route it.", "tools": ["mcp_get_news", "mcp_lookup_users"], "bound_skill": {"dir_name": "html"}}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A.", "tools": ["mcp_own_tool"]}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}]
      },
      "expect": {
        "ok": true,
        "agents": ["3", "4"],
        "handoffs": [["3", "4"], ["4", "3"]],
        "entry": "3",
        "tools_by_agent": {"3": ["mcp_own_tool"], "4": []},
        "skills_by_agent": {"3": [], "4": []},
        "dropped_from_dispatcher": {"tools": 2, "skills": 1}
      }
    },
    {
      "name": "an edge from a child to a non-dispatcher node survives",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route it."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}},
          {"id": "6", "node_type": "", "config": {"type": "agent-template", "agent_name": "Specialist", "agent_type": "standard", "instructions": "S."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}, {"from": "3", "to": "6"}]
      },
      "expect": {
        "ok": true,
        "agents": ["3", "4", "6"],
        "handoffs": [["3", "4"], ["3", "6"], ["4", "3"]],
        "entry": "3",
        "guide_contains": ["Specialist"]
      }
    },
    {
      "name": "no dispatcher is refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}]
      },
      "expect": {"ok": false, "error": "no_dispatcher", "nodes": []}
    },
    {
      "name": "a dispatcher with one child is refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route it."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}]
      },
      "expect": {"ok": false, "error": "dispatcher_needs_two_children", "nodes": ["2"]}
    },
    {
      "name": "a worker fanning out is refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "W", "agent_type": "standard", "instructions": "W."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}]
      },
      "expect": {"ok": false, "error": "no_dispatcher", "nodes": []}
    },
    {
      "name": "a merge node is refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route it."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}},
          {"id": "5", "node_type": "", "config": {"type": "agent-template", "agent_name": "M", "agent_type": "standard", "instructions": "M."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"},
                  {"from": "3", "to": "5"}, {"from": "4", "to": "5"}]
      },
      "expect": {"ok": false, "error": "merge_node", "nodes": ["5"]}
    },
    {
      "name": "two start edges are refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route it."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "1", "to": "3"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}]
      },
      "expect": {"ok": false, "error": "two_entry_points", "nodes": ["2", "3"]}
    },
    {
      "name": "a playbook node is refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route it."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "playbook", "config": {"type": "playbook", "name": "PB", "playbook": "Title: X"}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}]
      },
      "expect": {"ok": false, "error": "playbook_unsupported", "nodes": ["4"]}
    },
    {
      "name": "nested dispatchers are refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D1", "agent_type": "dispatcher", "instructions": "Route."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "D2", "agent_type": "dispatcher", "instructions": "Route again."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"}]
      },
      "expect": {"ok": false, "error": "nested_dispatchers", "nodes": ["2", "3"]}
    },
    {
      "name": "two output nodes are refused",
      "graph": {
        "nodes": [
          {"id": "1", "node_type": "start", "config": {"type": "start"}},
          {"id": "2", "node_type": "", "config": {"type": "agent-template", "agent_name": "D", "agent_type": "dispatcher", "instructions": "Route."}},
          {"id": "3", "node_type": "", "config": {"type": "agent-template", "agent_name": "A", "agent_type": "standard", "instructions": "A."}},
          {"id": "4", "node_type": "", "config": {"type": "agent-template", "agent_name": "B", "agent_type": "standard", "instructions": "B."}},
          {"id": "5", "node_type": "output", "config": {"type": "output"}},
          {"id": "6", "node_type": "output", "config": {"type": "output"}}
        ],
        "edges": [{"from": "1", "to": "2"}, {"from": "2", "to": "3"}, {"from": "2", "to": "4"},
                  {"from": "3", "to": "5"}, {"from": "4", "to": "6"}]
      },
      "expect": {"ok": false, "error": "multiple_outputs", "nodes": ["5", "6"]}
    }
  ]
}
```

- [ ] **Step 2: Verify it is valid JSON and self-consistent**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
python3 -c "
import json
d = json.load(open('backend/tests/fixtures/swarm/rewrite-cases.json'))
cases = d['cases']
print('cases:', len(cases))
ok = [c for c in cases if c['expect'].get('ok')]
bad = [c for c in cases if not c['expect'].get('ok')]
print('accepting:', len(ok), '| refusing:', len(bad))
codes = sorted({c['expect']['error'] for c in bad})
print('error codes:', codes)
assert len(cases) == 12, cases
assert codes == ['dispatcher_needs_two_children','merge_node','multiple_outputs','nested_dispatchers','no_dispatcher','playbook_unsupported','two_entry_points'], codes
names = [c['name'] for c in cases]
assert len(set(names)) == len(names), 'duplicate case names'
print('fixture OK')
"
```
Expected: `cases: 12`, `accepting: 4 | refusing: 8`, `fixture OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/fixtures/swarm/rewrite-cases.json
git commit -m "test(swarm): the rewrite contract — 12 cases both implementations must satisfy"
```

---

### Task 2: The rewrite in PHP

**Files:**
- Create: `backend/src/AgentTeam/Services/SwarmRewriter.php`
- Create: `backend/tests/Unit/SwarmRewriterTest.php`

**Interfaces:**
- Consumes: the fixture from Task 1.
- Produces:
  - `SwarmRewriter::rewrite(array $graph): array` returning
    `['ok' => true, 'agents' => [id => ['id','name','instructions','tools','skills','handoffs' => [id,...]]], 'entry' => '<id>', 'dropped' => ['tools' => int, 'skills' => int]]`
    or `['ok' => false, 'error' => '<code>', 'nodes' => ['<id>', ...]]`
  - `SwarmRewriter::handoffGuide(string $dispatcherInstructions, array $colleagues): string` — colleagues are `[['name' => string, 'role' => string], ...]`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/SwarmRewriterTest.php`:

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\SwarmRewriter;

/**
 * The swarm rewrite, driven by the shared contract in
 * tests/fixtures/swarm/rewrite-cases.json. The JS implementation is tested
 * against the same file; a change that satisfies one side only fails here.
 */
class SwarmRewriterTest extends TestCase
{
    /** @return array<string, array{array, array}> */
    public static function cases(): array
    {
        $raw = json_decode(file_get_contents(__DIR__ . '/../fixtures/swarm/rewrite-cases.json'), true);
        $out = [];
        foreach ($raw['cases'] as $c) {
            $out[$c['name']] = [$c['graph'], $c['expect']];
        }
        return $out;
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('cases')]
    public function testRewriteMatchesTheContract(array $graph, array $expect): void
    {
        $got = SwarmRewriter::rewrite($graph);

        if (!($expect['ok'] ?? false)) {
            $this->assertFalse($got['ok'], 'expected a refusal');
            $this->assertSame($expect['error'], $got['error']);
            $this->assertSame($expect['nodes'], array_values($got['nodes']), 'the refusal must name the offending nodes');
            return;
        }

        $this->assertTrue($got['ok'], 'expected acceptance, got: ' . ($got['error'] ?? '?'));
        // array_keys hands back ints for numeric-string keys; the fixture is JSON,
        // so its ids are strings. Compare on one side's terms, not both.
        $this->assertSame($expect['agents'], array_map('strval', array_keys($got['agents'])), 'agents, by node id');
        $this->assertSame($expect['entry'], $got['entry']);

        // handoffs as sorted [from, to] pairs
        $pairs = [];
        foreach ($got['agents'] as $id => $a) {
            foreach ($a['handoffs'] as $to) {
                $pairs[] = [(string) $id, (string) $to];
            }
        }
        sort($pairs);
        $want = $expect['handoffs'];
        sort($want);
        $this->assertSame($want, $pairs);

        foreach ($expect['guide_contains'] ?? [] as $needle) {
            $all = implode("\n", array_column($got['agents'], 'instructions'));
            $this->assertStringContainsString($needle, $all, "guide should mention: {$needle}");
        }
        foreach ($expect['tools_by_agent'] ?? [] as $id => $tools) {
            $this->assertSame($tools, $got['agents'][$id]['tools'], "tools of agent {$id}");
        }
        foreach ($expect['skills_by_agent'] ?? [] as $id => $skills) {
            $this->assertSame($skills, $got['agents'][$id]['skills'], "skills of agent {$id}");
        }
        if (isset($expect['dropped_from_dispatcher'])) {
            $this->assertSame($expect['dropped_from_dispatcher']['tools'], $got['dropped']['tools']);
            $this->assertSame($expect['dropped_from_dispatcher']['skills'], $got['dropped']['skills']);
        }
    }

    public function testTheDispatcherPersonaIsNotCarriedButItsRoutingIs(): void
    {
        $guide = SwarmRewriter::handoffGuide(
            "Greet the caller warmly and be friendly.\nWhen they mention vacations, transfer to Human resources.",
            [['name' => 'Human resources', 'role' => 'leave and payroll']]
        );
        $this->assertStringContainsString('Human resources', $guide);
        $this->assertStringContainsString('transfer to Human resources', $guide);
        $this->assertStringContainsString('Do not hand back', $guide, 'the volley guard must be present');
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/SwarmRewriterTest.php`
Expected: FAIL — `Class "AgentTeam\Services\SwarmRewriter" not found`.

- [ ] **Step 3: Write the rewriter**

Create `backend/src/AgentTeam/Services/SwarmRewriter.php`:

```php
<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Turns a swarm canvas into the graph that actually runs.
 *
 * A swarm is drawn as a node tagged Dispatcher fanning out to two or more
 * agents. The dispatcher is scaffolding: a swarm routes itself, so the node
 * is NOT compiled as an agent. Its children become the swarm, wired to each
 * other, carrying its routing prompt as their shared handoff guide.
 *
 * Pure: no I/O, no randomness, no state. The JS twin in
 * frontend/assets/js/swarm-rewrite.js must produce the same result, and
 * tests/fixtures/swarm/rewrite-cases.json is the contract both satisfy.
 */
class SwarmRewriter
{
    /** Handoffs beyond this end a run; mirrored in the interpreter. */
    public const HOP_BUDGET = 25;

    /**
     * @param array $graph {nodes: [...], edges: [...]}
     * @return array ok: {ok, agents, entry, dropped} | refusal: {ok:false, error, nodes}
     */
    public static function rewrite(array $graph): array
    {
        // PHP coerces numeric-string array keys to int, so read ids back out
        // as strings everywhere: an int 3 never === the string "3" an edge
        // carries, and the mismatch is silent.
        $nodes = [];
        $ids = [];
        foreach ($graph['nodes'] ?? [] as $n) {
            $id = (string) $n['id'];
            $nodes[$id] = $n;
            $ids[] = $id;
        }
        $edges = [];
        foreach ($graph['edges'] ?? [] as $e) {
            $edges[] = [(string) ($e['from'] ?? $e['from_node_id'] ?? ''), (string) ($e['to'] ?? $e['to_node_id'] ?? '')];
        }

        // Every returned list is ordered by node id, never by insertion:
        // PHP keeps insertion order and JS does not, and the two must agree.
        $byId = static function (array $list): array {
            usort($list, static fn($a, $b) => (int) $a <=> (int) $b ?: strcmp((string) $a, (string) $b));
            return array_values($list);
        };
        $children = static function (string $id) use ($edges): array {
            $out = [];
            foreach ($edges as [$f, $t]) {
                if ($f === $id) {
                    $out[] = $t;
                }
            }
            return $out;
        };
        $parents = static function (string $id) use ($edges): array {
            $out = [];
            foreach ($edges as [$f, $t]) {
                if ($t === $id) {
                    $out[] = $f;
                }
            }
            return $out;
        };
        $typeOf = static fn(array $n): string => (string) ($n['config']['type'] ?? $n['node_type'] ?? '');
        $isAgent = static fn(array $n): bool => in_array($typeOf($n), ['agent', 'agent-template'], true);
        $isDispatcher = static fn(array $n): bool => ($n['config']['agent_type'] ?? '') === 'dispatcher';

        // --- refusals, in the order a user is most likely to hit them ---
        $playbooks = [];
        $outputs = [];
        foreach ($ids as $id) {
            if ($typeOf($nodes[$id]) === 'playbook') {
                $playbooks[] = $id;
            }
            if ($typeOf($nodes[$id]) === 'output') {
                $outputs[] = $id;
            }
        }
        if ($playbooks !== []) {
            return ['ok' => false, 'error' => 'playbook_unsupported', 'nodes' => $byId($playbooks)];
        }
        if (count($outputs) > 1) {
            return ['ok' => false, 'error' => 'multiple_outputs', 'nodes' => $byId($outputs)];
        }

        $dispatchers = [];
        foreach ($ids as $id) {
            if ($isAgent($nodes[$id]) && $isDispatcher($nodes[$id])) {
                $dispatchers[] = $id;
            }
        }
        if (count($dispatchers) > 1) {
            return ['ok' => false, 'error' => 'nested_dispatchers', 'nodes' => $byId($dispatchers)];
        }
        if ($dispatchers === []) {
            return ['ok' => false, 'error' => 'no_dispatcher', 'nodes' => []];
        }
        $dispatcherId = $dispatchers[0];

        $entryTargets = [];
        foreach ($ids as $id) {
            if ($typeOf($nodes[$id]) !== 'start') {
                continue;
            }
            foreach ($children($id) as $c) {
                $entryTargets[] = $c;
            }
        }
        $entryTargets = $byId(array_unique($entryTargets));
        if (count($entryTargets) > 1) {
            return ['ok' => false, 'error' => 'two_entry_points', 'nodes' => $entryTargets];
        }

        $menu = $byId(array_values(array_filter(
            $children($dispatcherId),
            static fn($c) => isset($nodes[$c]) && $isAgent($nodes[$c])
        )));
        if (count($menu) < 2) {
            return ['ok' => false, 'error' => 'dispatcher_needs_two_children', 'nodes' => [$dispatcherId]];
        }

        // A merge is any agent with more than one agent parent once the
        // dispatcher is removed: one conversation cannot arrive twice.
        foreach ($ids as $id) {
            if (!$isAgent($nodes[$id])) {
                continue;
            }
            $agentParents = array_values(array_filter(
                $parents($id),
                static fn($p) => $p !== $dispatcherId && isset($nodes[$p]) && $isAgent($nodes[$p])
            ));
            if (count($agentParents) > 1) {
                return ['ok' => false, 'error' => 'merge_node', 'nodes' => [$id]];
            }
        }

        // --- the rewrite ---
        $members = $menu;                                   // the swarm proper
        foreach ($menu as $m) {                             // children of members survive as agents too
            foreach ($children($m) as $c) {
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && !in_array($c, $members, true)) {
                    $members[] = $c;
                }
            }
        }
        $members = $byId($members);

        $nameOf = static fn(string $id): string => (string) ($nodes[$id]['config']['agent_name'] ?? $nodes[$id]['config']['name'] ?? "node {$id}");
        $roleOf = static function (string $id) use ($nodes): string {
            $text = trim((string) ($nodes[$id]['config']['instructions'] ?? ''));
            $first = trim(explode("\n", $text)[0] ?? '');
            return mb_substr($first, 0, 120);
        };

        $agents = [];
        foreach ($members as $id) {
            $handoffs = [];
            if (in_array($id, $menu, true)) {
                foreach ($menu as $other) {           // the synthesised mesh
                    if ($other !== $id) {
                        $handoffs[] = $other;
                    }
                }
            }
            foreach ($children($id) as $c) {          // preserved edges to non-dispatcher agents
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && $c !== $dispatcherId && !in_array($c, $handoffs, true)) {
                    $handoffs[] = $c;
                }
            }
            $handoffs = $byId($handoffs);
            $colleagues = array_map(
                static fn(string $h): array => ['name' => $nameOf($h), 'role' => $roleOf($h)],
                $handoffs
            );
            $own = (string) ($nodes[$id]['config']['instructions'] ?? '');
            $guide = $colleagues === []
                ? ''
                : self::handoffGuide((string) ($nodes[$dispatcherId]['config']['instructions'] ?? ''), $colleagues);

            $skills = $nodes[$id]['config']['bound_skill'] ?? null;
            $agents[$id] = [
                'id' => $id,
                'name' => $nameOf($id),
                'instructions' => $guide === '' ? $own : rtrim($own) . "\n\n" . $guide,
                'tools' => array_values((array) ($nodes[$id]['config']['tools'] ?? [])),
                'skills' => $skills ? [$skills] : [],
                'handoffs' => $handoffs,
            ];
        }

        $dispatcherCfg = $nodes[$dispatcherId]['config'] ?? [];
        return [
            'ok' => true,
            'agents' => $agents,
            'entry' => $menu[0],
            'dropped' => [
                'tools' => count((array) ($dispatcherCfg['tools'] ?? [])),
                'skills' => isset($dispatcherCfg['bound_skill']) ? 1 : 0,
            ],
        ];
    }

    /**
     * The block appended to every agent that can hand off: who the colleagues
     * are, and the dispatcher's routing rules, which say which subject belongs
     * to whom. The dispatcher's persona is deliberately not carried — nothing
     * speaks with that voice in a swarm.
     */
    public static function handoffGuide(string $dispatcherInstructions, array $colleagues): string
    {
        $lines = ["## Colleagues you can hand this to"];
        foreach ($colleagues as $c) {
            $role = trim((string) $c['role']);
            $lines[] = '- ' . $c['name'] . ($role !== '' ? ' — ' . $role : '');
        }
        $routing = trim($dispatcherInstructions);
        if ($routing !== '') {
            $lines[] = '';
            $lines[] = '## When to hand off';
            $lines[] = $routing;
        }
        $lines[] = '';
        $lines[] = 'Hand off when the request is theirs rather than yours, and say why in the reason.';
        $lines[] = 'Answer directly when it is yours.';
        $lines[] = 'Do not hand back what you were just handed unless the subject has genuinely changed.';
        return implode("\n", $lines);
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/SwarmRewriterTest.php`
Expected: PASS — 13 tests (12 fixture cases + the guide test).

- [ ] **Step 5: Confirm no regression**

Run: `cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3`
Expected: the same 25 pre-existing failures, none new.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/SwarmRewriter.php backend/tests/Unit/SwarmRewriterTest.php
git commit -m "feat(swarm): the rewrite in PHP — dissolve the dispatcher, mesh its children, compose the guide"
```

---

### Task 3: `orchestration` on the workflow

**Files:**
- Modify: `backend/src/AgentTeam/Models/Workflow.php`
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php`
- Create: `backend/migrations/add_workflow_orchestration.sql`
- Modify: `backend/tests/Unit/SwarmRewriterTest.php` (one added test)

**Interfaces:**
- Produces: `Workflow::getOrchestration(): string` returning `"workflow"` or `"swarm"`; the same key in `toArray()` and in the API payload; accepted by `WorkflowController::update`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/Unit/SwarmRewriterTest.php`:

```php
    public function testWorkflowCarriesAnOrchestrationDefaultingToWorkflow(): void
    {
        $w = new \AgentTeam\Models\Workflow(['id' => 1, 'name' => 'x', 'user_id' => '3']);
        $this->assertSame('workflow', $w->getOrchestration(), 'default');
        $this->assertSame('workflow', $w->toArray()['orchestration'] ?? null);

        $s = new \AgentTeam\Models\Workflow(['id' => 2, 'name' => 'y', 'user_id' => '3', 'orchestration' => 'swarm']);
        $this->assertSame('swarm', $s->getOrchestration());
        $this->assertSame('swarm', $s->toArray()['orchestration'] ?? null);

        // anything unrecognised falls back rather than propagating
        $j = new \AgentTeam\Models\Workflow(['id' => 3, 'name' => 'z', 'user_id' => '3', 'orchestration' => 'nonsense']);
        $this->assertSame('workflow', $j->getOrchestration());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && php vendor/bin/phpunit --filter testWorkflowCarriesAnOrchestration tests/Unit/SwarmRewriterTest.php`
Expected: FAIL — `Call to undefined method AgentTeam\Models\Workflow::getOrchestration()`.

- [ ] **Step 3: Add the field**

In `backend/src/AgentTeam/Models/Workflow.php`, follow the `outputStorageEnabled` pattern exactly:

```php
    private string $orchestration = 'workflow';
```

In the constructor, beside `$this->outputStorageEnabled = ...`:

```php
        // How the graph is interpreted: a DAG ("workflow") or a swarm of
        // agents handing control to one another ("swarm"). Anything else
        // falls back — an unknown value must not change how a graph runs.
        $o = (string) ($data['orchestration'] ?? 'workflow');
        $this->orchestration = in_array($o, ['workflow', 'swarm'], true) ? $o : 'workflow';
```

Add to **both** array builders that currently emit `output_storage_enabled` (lines ~98 and ~124):

```php
            'orchestration' => $this->orchestration,
```

And the accessor, beside `isOutputStorageEnabled()`:

```php
    public function getOrchestration(): string
    {
        return $this->orchestration;
    }
```

- [ ] **Step 4: Accept it on update**

In `backend/src/AgentTeam/Controllers/WorkflowController.php`, find `update()` and the body fields it already copies (`output_storage_enabled` is the model to follow). Add `orchestration` alongside, validating the same two values:

```php
            // Orchestration is a property of the workflow, not of a build:
            // the live interpreter and every compile target read the same value.
            if (isset($body['orchestration'])) {
                $o = (string) $body['orchestration'];
                $data['orchestration'] = in_array($o, ['workflow', 'swarm'], true) ? $o : 'workflow';
            }
```

- [ ] **Step 5: Add the column**

Create `backend/migrations/add_workflow_orchestration.sql`:

```sql
-- Swarm v1(a): how a workflow's graph is interpreted.
-- "workflow" (default) = the DAG compiler and interpreter as today.
-- "swarm"              = the dispatcher dissolves and its children hand off
--                        to one another (see SwarmRewriter).
-- Runs against the CONTEXTS database, where workflows live.
ALTER TABLE workflows
  ADD COLUMN orchestration VARCHAR(16) NOT NULL DEFAULT 'workflow'
  AFTER output_folder;
```

Apply it against the CONTEXTS database. **Note:** connections to that database sometimes stall for minutes — run it once and wait rather than retrying.

- [ ] **Step 6: Run the tests**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/SwarmRewriterTest.php`
Expected: PASS — 14 tests.

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Models/Workflow.php backend/src/AgentTeam/Controllers/WorkflowController.php \
        backend/migrations/add_workflow_orchestration.sql backend/tests/Unit/SwarmRewriterTest.php
git commit -m "feat(swarm): orchestration is a workflow property, defaulting to workflow"
```

---

### Task 4: The rewrite in JS, against the same fixture

**Files:**
- Create: `frontend/assets/js/swarm-rewrite.js`
- Create: `frontend/assets/js/__tests__/swarm-rewrite.check.js`
- Modify: `frontend/index.html` (load the new script)

**Interfaces:**
- Consumes: the fixture from Task 1.
- Produces: `window.swarmRewrite(graph)` returning the same structure as `SwarmRewriter::rewrite` — `{ok, agents, entry, dropped}` or `{ok: false, error, nodes}`. Task 5, 6 and 7 all call it.

- [ ] **Step 1: Write the failing check**

Create `frontend/assets/js/__tests__/swarm-rewrite.check.js` — a plain Node script, because this repo has no JS test framework:

```js
/**
 * Drives the shared contract against the JS rewrite.
 * Run: node frontend/assets/js/__tests__/swarm-rewrite.check.js
 * Exits non-zero on the first mismatch, naming the case.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../../..');
const src = fs.readFileSync(path.join(root, 'frontend/assets/js/swarm-rewrite.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', src)(sandbox.window);
const rewrite = sandbox.window.swarmRewrite;
if (typeof rewrite !== 'function') { console.error('window.swarmRewrite is not defined'); process.exit(1); }

const fixture = JSON.parse(fs.readFileSync(path.join(root, 'backend/tests/fixtures/swarm/rewrite-cases.json'), 'utf8'));
let failed = 0;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const c of fixture.cases) {
    const got = rewrite(c.graph);
    const want = c.expect;
    const fail = (msg, g, w) => { console.error(`FAIL  ${c.name}\n      ${msg}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`); failed++; };

    if (!want.ok) {
        if (got.ok) { fail('expected a refusal', got.ok, false); continue; }
        if (got.error !== want.error) { fail('error code', got.error, want.error); continue; }
        if (!eq(got.nodes, want.nodes)) { fail('offending nodes', got.nodes, want.nodes); }
        continue;
    }
    if (!got.ok) { fail('expected acceptance', got.error, 'ok'); continue; }
    if (!eq(Object.keys(got.agents), want.agents)) { fail('agents', Object.keys(got.agents), want.agents); continue; }
    if (got.entry !== want.entry) { fail('entry', got.entry, want.entry); }

    const pairs = [];
    for (const [id, a] of Object.entries(got.agents)) for (const to of a.handoffs) pairs.push([id, to]);
    pairs.sort(); const wantPairs = [...want.handoffs].sort();
    if (!eq(pairs, wantPairs)) { fail('handoffs', pairs, wantPairs); }

    for (const needle of want.guide_contains || []) {
        const all = Object.values(got.agents).map(a => a.instructions).join('\n');
        if (!all.includes(needle)) { fail(`guide should mention "${needle}"`, '(absent)', needle); }
    }
    for (const [id, tools] of Object.entries(want.tools_by_agent || {})) {
        if (!eq(got.agents[id].tools, tools)) { fail(`tools of ${id}`, got.agents[id].tools, tools); }
    }
    for (const [id, skills] of Object.entries(want.skills_by_agent || {})) {
        if (!eq(got.agents[id].skills, skills)) { fail(`skills of ${id}`, got.agents[id].skills, skills); }
    }
    if (want.dropped_from_dispatcher && !eq(got.dropped, want.dropped_from_dispatcher)) {
        fail('dropped from dispatcher', got.dropped, want.dropped_from_dispatcher);
    }
}

console.log(failed === 0
    ? `swarm-rewrite: ${fixture.cases.length}/${fixture.cases.length} cases match the contract`
    : `swarm-rewrite: ${failed} mismatch(es)`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt && node frontend/assets/js/__tests__/swarm-rewrite.check.js`
Expected: FAIL — `ENOENT` on `swarm-rewrite.js`.

- [ ] **Step 3: Write the JS rewrite**

Create `frontend/assets/js/swarm-rewrite.js`. It must mirror `SwarmRewriter::rewrite` exactly — same refusal order, same entry rule, same guide text:

```js
/**
 * The swarm rewrite: a swarm canvas -> the graph that actually runs.
 *
 * Twin of backend/src/AgentTeam/Services/SwarmRewriter.php. Both are tested
 * against backend/tests/fixtures/swarm/rewrite-cases.json; a change that
 * satisfies one side only fails the other. The editor needs this in JS so
 * canvas feedback updates as you draw, without a round trip per edit.
 */
(function (global) {
    const HOP_BUDGET = 25;

    function handoffGuide(dispatcherInstructions, colleagues) {
        const lines = ['## Colleagues you can hand this to'];
        for (const c of colleagues) {
            const role = (c.role || '').trim();
            lines.push('- ' + c.name + (role ? ' — ' + role : ''));
        }
        const routing = (dispatcherInstructions || '').trim();
        if (routing) { lines.push('', '## When to hand off', routing); }
        lines.push('',
            'Hand off when the request is theirs rather than yours, and say why in the reason.',
            'Answer directly when it is yours.',
            'Do not hand back what you were just handed unless the subject has genuinely changed.');
        return lines.join('\n');
    }

    function swarmRewrite(graph) {
        const nodes = {};
        const ids = [];
        for (const n of (graph.nodes || [])) { nodes[String(n.id)] = n; ids.push(String(n.id)); }
        const edges = (graph.edges || []).map(e => [
            String(e.from ?? e.from_node_id ?? ''), String(e.to ?? e.to_node_id ?? ''),
        ]);
        // Order every returned list by node id, never by insertion: the PHP
        // twin keeps insertion order and this does not, and they must agree.
        const byId = list => [...list].sort((a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b)));
        const children = id => edges.filter(([f]) => f === id).map(([, t]) => t);
        const parents = id => edges.filter(([, t]) => t === id).map(([f]) => f);
        const typeOf = n => String(n.config?.type ?? n.node_type ?? '');
        const isAgent = n => ['agent', 'agent-template'].includes(typeOf(n));
        const isDispatcher = n => (n.config?.agent_type || '') === 'dispatcher';

        const playbooks = ids.filter(id => typeOf(nodes[id]) === 'playbook');
        if (playbooks.length) return { ok: false, error: 'playbook_unsupported', nodes: byId(playbooks) };
        const outputs = ids.filter(id => typeOf(nodes[id]) === 'output');
        if (outputs.length > 1) return { ok: false, error: 'multiple_outputs', nodes: byId(outputs) };

        const dispatchers = ids.filter(id => isAgent(nodes[id]) && isDispatcher(nodes[id]));
        if (dispatchers.length > 1) return { ok: false, error: 'nested_dispatchers', nodes: byId(dispatchers) };
        if (!dispatchers.length) return { ok: false, error: 'no_dispatcher', nodes: [] };
        const dispatcherId = dispatchers[0];

        const entryTargets = byId([...new Set(ids.filter(id => typeOf(nodes[id]) === 'start').flatMap(children))]);
        if (entryTargets.length > 1) return { ok: false, error: 'two_entry_points', nodes: entryTargets };

        const menu = byId(children(dispatcherId).filter(c => nodes[c] && isAgent(nodes[c])));
        if (menu.length < 2) return { ok: false, error: 'dispatcher_needs_two_children', nodes: [dispatcherId] };

        for (const id of ids) {
            if (!isAgent(nodes[id])) continue;
            const agentParents = parents(id).filter(p => p !== dispatcherId && nodes[p] && isAgent(nodes[p]));
            if (agentParents.length > 1) return { ok: false, error: 'merge_node', nodes: [id] };
        }

        const members = [...menu];
        for (const m of menu) {
            for (const c of children(m)) {
                if (nodes[c] && isAgent(nodes[c]) && !members.includes(c)) members.push(c);
            }
        }
        const ordered = byId(members);

        const nameOf = id => String(nodes[id].config?.agent_name ?? nodes[id].config?.name ?? `node ${id}`);
        const roleOf = id => String(nodes[id].config?.instructions ?? '').trim().split('\n')[0].slice(0, 120);

        const agents = {};
        for (const id of ordered) {
            let handoffs = [];
            if (menu.includes(id)) for (const other of menu) if (other !== id) handoffs.push(other);
            for (const c of children(id)) {
                if (nodes[c] && isAgent(nodes[c]) && c !== dispatcherId && !handoffs.includes(c)) handoffs.push(c);
            }
            handoffs = byId(handoffs);
            const colleagues = handoffs.map(h => ({ name: nameOf(h), role: roleOf(h) }));
            const own = String(nodes[id].config?.instructions ?? '');
            const guide = colleagues.length
                ? handoffGuide(String(nodes[dispatcherId].config?.instructions ?? ''), colleagues)
                : '';
            const skill = nodes[id].config?.bound_skill;
            agents[id] = {
                id, name: nameOf(id),
                instructions: guide ? own.replace(/\s+$/, '') + '\n\n' + guide : own,
                tools: [...(nodes[id].config?.tools || [])],
                skills: skill ? [skill] : [],
                handoffs,
            };
        }

        const dcfg = nodes[dispatcherId].config || {};
        return {
            ok: true, agents, entry: menu[0],
            dropped: { tools: (dcfg.tools || []).length, skills: dcfg.bound_skill ? 1 : 0 },
        };
    }

    global.swarmRewrite = swarmRewrite;
    global.swarmHandoffGuide = handoffGuide;
    global.SWARM_HOP_BUDGET = HOP_BUDGET;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt && node frontend/assets/js/__tests__/swarm-rewrite.check.js`
Expected: `swarm-rewrite: 12/12 cases match the contract`, exit 0.

- [ ] **Step 5: Load it in the app**

In `frontend/index.html`, add before the `workflow-editor.js` tag:

```html
    <script src="assets/js/swarm-rewrite.js?v=20260915-swarm1"></script>
```

- [ ] **Step 6: Commit**

```bash
git add frontend/assets/js/swarm-rewrite.js frontend/assets/js/__tests__/swarm-rewrite.check.js frontend/index.html
git commit -m "feat(swarm): the rewrite in JS, driven by the same fixture as PHP"
```

---

### Task 5: The setting in the workflow panel

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/assets/i18n/{en,es,fr}.json`
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: `window.swarmRewrite` (Task 4); `orchestration` from the API (Task 3).
- Produces: `this.orchestration` on the editor (`'workflow' | 'swarm'`), persisted with the workflow; `this._isSwarm()` returning a boolean, used by Tasks 6 and 7.

- [ ] **Step 1: Add the field and persistence**

In the editor's constructor, beside `this.outputStorageEnabled`:

```js
        // How this workflow's graph is interpreted. A property of the
        // workflow, not of a build: the interpreter and every compile target
        // read the same value.
        this.orchestration = 'workflow';
```

Wherever `output_storage_enabled` is read from a loaded workflow (around line 5889), add:

```js
        this.orchestration = payload.orchestration === 'swarm' ? 'swarm' : 'workflow';
```

And in **each** of the three save payloads that currently send `output_storage_enabled` (around lines 5740, 10715, 10799):

```js
            orchestration: this.orchestration,
```

Add the helper next to them:

```js
    /** True when this workflow is interpreted as a swarm (see swarm-rewrite.js). */
    _isSwarm() {
        return this.orchestration === 'swarm';
    }
```

- [ ] **Step 2: Add the control to the settings panel**

In the Batch Workflow Settings markup (search for `workflow.batchWorkflowSettings`, around line 1112), add a row:

```html
                <label class="flex items-start gap-3 cursor-pointer mt-3">
                    <input type="checkbox" class="wf-swarm-toggle mt-1 h-4 w-4">
                    <span>
                        <span class="block text-sm font-medium text-gray-900">${this.escapeHtml(this.t('workflow.orchestration.swarm') || 'Run as a swarm')}</span>
                        <span class="block text-xs text-gray-500">${this.escapeHtml(this.t('workflow.orchestration.swarmHelp') || 'Agents hand the conversation to one another instead of running in a fixed order. Requires a Dispatcher connected to two or more agents.')}</span>
                    </span>
                </label>
```

Bind it where the panel's other controls are bound:

```js
        panel.querySelector('.wf-swarm-toggle')?.addEventListener('change', (e) => {
            const wanted = e.target.checked ? 'swarm' : 'workflow';
            if (wanted === 'swarm') {
                // Refuse at flip time, not at Run: the user is looking at the
                // graph now, which is when the message is useful.
                const result = window.swarmRewrite(this._currentGraphForRewrite());
                if (!result.ok) {
                    e.target.checked = false;
                    this._showSwarmRefusalModal(result);
                    return;
                }
            }
            // A swarm's context starts large rather than growing into it:
            // Start attachments reach every agent, on every hop (spec §6b).
            // Warn, do not block — the user may well want exactly that.
            if (wanted === 'swarm') {
                const attached = (this._startNodeAttachments?.() || []).length;
                if (attached > 2) {
                    this._wfToast?.(this.t('workflow.swarmAttachWarn') ||
                        `${attached} documents on Start will be sent to every agent on every hop.`, 'warning');
                }
            }
            this.orchestration = wanted;
            this._markDirty?.();
            this._applyOrchestrationToCanvas();
        });
```

`_startNodeAttachments()` may not exist under that name — find how the Start node's attachments are read today (grep `attachment` in the editor) and use the existing accessor. If attachments are held somewhere that makes a count awkward, say so in your report and drop the warning rather than inventing state for it; it is advisory, and the flip must still work.

- [ ] **Step 3: Add the graph adapter**

The rewrite expects `{nodes, edges}` in the API's shape; Drawflow stores its own. Add:

```js
    /**
     * The current canvas in the shape swarm-rewrite.js expects: the same
     * {nodes:[{id,node_type,config}], edges:[{from,to}]} the API uses, so one
     * rewrite serves the editor and the backend.
     */
    _currentGraphForRewrite() {
        const data = this.editor?.drawflow?.drawflow?.Home?.data || {};
        const nodes = Object.keys(data).map(id => ({
            id: String(id),
            node_type: data[id].data?.type || '',
            config: data[id].data || {},
        }));
        const edges = [];
        for (const id of Object.keys(data)) {
            const outputs = data[id].outputs || {};
            for (const o of Object.values(outputs)) {
                for (const c of (o.connections || [])) edges.push({ from: String(id), to: String(c.node) });
            }
        }
        return { nodes, edges };
    }
```

- [ ] **Step 4: Verify**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/swarm-rewrite.check.js
for f in en es fr; do python3 -c "import json;json.load(open('frontend/assets/i18n/$f.json'));print('$f ok')"; done
```
Expected: `JS ok`, `12/12`, `en ok es ok fr ok`.

- [ ] **Step 5: Add the i18n keys**

Add under `workflow` in all three locale files (`orchestration` is a new sub-object):

```json
"orchestration": {
  "swarm": "Run as a swarm",
  "swarmHelp": "Agents hand the conversation to one another instead of running in a fixed order. Requires a Dispatcher connected to two or more agents."
},
"swarmAttachWarn": "The documents on Start will be sent to every agent on every hop."
```

Spanish: `"Ejecutar como enjambre"` / `"Los agentes se pasan la conversación entre ellos en lugar de ejecutarse en un orden fijo. Requiere un Dispatcher conectado a dos o más agentes."`
French: `"Exécuter en essaim"` / `"Les agents se transmettent la conversation au lieu de s'exécuter dans un ordre fixe. Nécessite un Dispatcher connecté à au moins deux agents."`

- [ ] **Step 6: Bump the cache-buster and commit**

In `frontend/index.html` change `workflow-editor.js?v=20260911-tplnode1` to `?v=20260915-swarm1`.

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/i18n/*.json frontend/index.html
git commit -m "feat(swarm): the orchestration setting in the workflow panel, refusing invalid canvases at flip time"
```

---

### Task 6: Editor feedback

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/assets/i18n/{en,es,fr}.json`
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: `this._isSwarm()`, `this._currentGraphForRewrite()`, `window.swarmRewrite` (Tasks 4, 5).
- Produces: `_showSwarmRefusalModal(result)`, `_applyOrchestrationToCanvas()`, and the mode-aware node form.

- [ ] **Step 1: The refusal modal**

It must teach the shape, not just refuse (spec §3a):

```js
    /** Swarm mode refused this canvas: name what was found, what is needed, and draw it. */
    _showSwarmRefusalModal(result) {
        const names = (result.nodes || [])
            .map(id => this.editor?.drawflow?.drawflow?.Home?.data?.[id]?.data?.agent_name
                || this.editor?.drawflow?.drawflow?.Home?.data?.[id]?.data?.name || `node ${id}`);
        const reason = {
            no_dispatcher: this.t('workflow.swarmError.noDispatcher') || 'No agent is tagged Dispatcher.',
            dispatcher_needs_two_children: this.t('workflow.swarmError.oneChild') || 'The Dispatcher is connected to only one agent.',
            merge_node: this.t('workflow.swarmError.merge') || 'Two agents feed one node. A swarm has one conversation, so nothing merges.',
            two_entry_points: this.t('workflow.swarmError.twoEntries') || 'Start is connected to more than one node. A swarm has exactly one first turn.',
            playbook_unsupported: this.t('workflow.swarmError.playbook') || 'This workflow contains a Playbook node, which swarm mode does not support yet.',
            nested_dispatchers: this.t('workflow.swarmError.nested') || 'There is more than one Dispatcher.',
            multiple_outputs: this.t('workflow.swarmError.outputs') || 'There is more than one Output node. A swarm produces one answer.',
        }[result.error] || result.error;

        const backdrop = document.createElement('div');
        backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
        backdrop.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg" role="dialog" aria-modal="true">
                <h3 class="text-lg font-semibold text-gray-900 mb-2">${this.escapeHtml(this.t('workflow.swarmError.title') || 'This workflow cannot run as a swarm')}</h3>
                <p class="text-sm text-gray-700 mb-1"><strong>${this.escapeHtml(this.t('workflow.swarmError.found') || 'Found')}:</strong> ${this.escapeHtml(reason)}</p>
                ${names.length ? `<p class="text-sm text-gray-600 mb-3">${this.escapeHtml(names.join(', '))}</p>` : '<div class="mb-3"></div>'}
                <p class="text-sm text-gray-700 mb-2"><strong>${this.escapeHtml(this.t('workflow.swarmError.needed') || 'Needed')}:</strong> ${this.escapeHtml(this.t('workflow.swarmError.neededText') || 'one agent tagged Dispatcher, connected to two or more agents.')}</p>
                <pre class="bg-gray-100 text-gray-800 text-xs rounded p-3 mb-3 overflow-auto">      Start
        │
        ▼
   ┌────────────┐
   │ Dispatcher │  ← its prompt says which subjects
   └─┬───┬───┬──┘    belong to which colleague
     ▼   ▼   ▼
    HR  IT  Devices  ← the swarm: each can hand to the others</pre>
                <p class="text-xs text-gray-500 mb-4">${this.escapeHtml(this.t('workflow.swarmError.note') || 'In swarm mode the Dispatcher is not an agent — its prompt becomes the handoff guide every member carries.')}</p>
                <div class="flex justify-end">
                    <button class="swarm-err-close px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded">${this.escapeHtml(this.t('common.close') || 'Close')}</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        backdrop.querySelector('.swarm-err-close').addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    }
```

- [ ] **Step 2: Canvas feedback**

```js
    /**
     * Swarm mode hides things the canvas still shows: a node that is not an
     * agent, and edges nobody drew. Make both visible.
     */
    _applyOrchestrationToCanvas() {
        const data = this.editor?.drawflow?.drawflow?.Home?.data || {};
        for (const id of Object.keys(data)) {
            const el = document.getElementById(`node-${id}`);
            if (!el) continue;
            const isDispatcher = (data[id].data?.agent_type === 'dispatcher');
            el.classList.toggle('swarm-dissolved', this._isSwarm() && isDispatcher);
            const existing = el.querySelector('.swarm-dissolved-note');
            if (this._isSwarm() && isDispatcher) {
                if (!existing) {
                    el.querySelector('.node-body')?.insertAdjacentHTML('beforeend',
                        `<div class="swarm-dissolved-note text-xs text-amber-800 mt-1">${this.escapeHtml(this.t('workflow.swarmCanvas.dissolved') || 'Not an agent in swarm mode — its prompt is the team\\'s handoff guide.')}</div>`);
                }
            } else if (existing) {
                existing.remove();
            }
        }
    }
```

Add the CSS to `frontend/index.html`'s style block:

```css
    .workflow-node.swarm-dissolved { opacity: .55; border-style: dashed; }
```

Call `_applyOrchestrationToCanvas()` after a workflow loads and after any node is added or retagged.

- [ ] **Step 3: The mode-aware node form**

In the agent node's edit form, hide the fields a dissolved dispatcher cannot use (spec §3b) — MCP servers, skills, provider, model, temperature, max tokens — and relabel the prompt:

```js
        const dissolved = this._isSwarm() && (nodeData.agent_type === 'dispatcher');
        // Hidden, never deleted: switching back to workflow mode restores them.
        form.querySelectorAll('[data-agent-field="tools"], [data-agent-field="skills"], [data-agent-field="model"]')
            .forEach(el => { el.hidden = dissolved; });
        const promptLabel = form.querySelector('[data-agent-field="instructions"] label');
        if (promptLabel) {
            promptLabel.textContent = dissolved
                ? (this.t('workflow.swarmForm.guideLabel') || 'Handoff guide — which subjects belong to which agent. Every member of the swarm receives this.')
                : (this.t('workflow.agentForm.instructions') || 'System prompt');
        }
```

If those `data-agent-field` attributes do not exist on the form's sections, add them to the relevant wrappers rather than selecting by position — say so in your report if the form's structure requires a different anchor.

- [ ] **Step 4: Verify**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
for f in en es fr; do python3 -c "import json;json.load(open('frontend/assets/i18n/$f.json'));print('$f ok')"; done
grep -o "workflow\.swarm[A-Za-z.]*" frontend/assets/js/workflow-editor.js | sed 's/workflow\.//' | sort -u
```
Expected: `JS ok`, three `ok` lines, and every listed key present in all three locale files.

- [ ] **Step 5: Add every key used above** to en/es/fr, then bump the cache-buster to `?v=20260915-swarm2`.

- [ ] **Step 6: Commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/i18n/*.json frontend/index.html
git commit -m "feat(swarm): editor feedback — teaching refusal, greyed dispatcher, mode-aware node form"
```

---

### Task 7: The handoff loop

The interpreter runs the rewritten graph. This is the task that makes a swarm actually run.

The design point that matters: a swarm has **one conversation**, not a relay of outputs. Every agent that takes the turn sees everything said so far — that is what makes "make it 5 days" reach the right agent without the user repeating themselves (spec §6b). `_runNodeAsChatUnit` currently starts each node with an empty history, so it grows one option before the loop can use it.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: `window.swarmRewrite`, `window.SWARM_HOP_BUDGET`, `this._isSwarm()`, `this._currentGraphForRewrite()`; the existing `_runNodeAsChatUnit(node, inputText, opts)` at `workflow-editor.js:11851`, `_wfDispatchTool(targets)`, `_wfResolveRoute(calls, targets)`, `_wfNodeLog(...)`.
- Produces:
  - `_runNodeAsChatUnit(node, inputText, {dispatchTargets, routedBy, history, skipSkills})` — two new options; its return gains `history` (the array after this turn).
  - `_runSwarm(userPrompt, onProgress)` returning `{output, handoffs, status, history}`.

- [ ] **Step 1: Let a caller seed and read back the conversation**

`_runNodeAsChatUnit` owns a private `conversationHistory` (line 11927) that always starts empty. Three edits make it shareable. In the signature:

```js
    async _runNodeAsChatUnit(node, inputText, { dispatchTargets = null, routedBy = null, history = null, skipSkills = false } = {}) {
```

At line 11927, seed from the caller — copied, not aliased, so a failed turn cannot half-mutate the swarm's transcript:

```js
        // A swarm shares one conversation across agents: the caller passes the
        // transcript in and takes the grown one back. A workflow run passes
        // nothing and gets today's behaviour, an empty history per node.
        const conversationHistory = Array.isArray(history) ? [...history] : [];
```

And add `history: conversationHistory` to **every** `return {` in the function — the success return, the route return, and each error return — so a caller never loses the turn that just happened. There are several; find them with:

```bash
awk 'NR>=11851 && NR<=12200 && /return \{/ {print NR": "$0}' frontend/assets/js/workflow-editor.js
```

- [ ] **Step 2: Verify workflow mode is unchanged**

Run: `node --check frontend/assets/js/workflow-editor.js && echo "JS ok"`

Then open the app, run the existing **Dispatcher demo** workflow with orchestration left at `workflow`, and confirm it behaves exactly as before. This step exists because Step 1 touched the function every workflow run goes through; it is the one place this plan can break existing behaviour.

- [ ] **Step 3: Branch the run**

In `runWorkflow()`, before the topological loop:

```js
        if (this._isSwarm()) {
            // A swarm has no topological order: control moves by handoff.
            return await this._runSwarm(userPrompt, onProgress);
        }
```

- [ ] **Step 4: Write the loop**

```js
    /**
     * Run the workflow as a swarm: the rewritten graph's entry agent holds the
     * first turn, and control passes on each handoff until an agent answers
     * without handing off, or the hop budget is spent.
     *
     * One conversation, not a relay. `transcript` is the shared message array
     * every agent is handed, so an agent taking the turn at hop 4 sees what
     * was said at hop 0 — including any documents dropped on Start, which the
     * caller has already folded into userPrompt.
     *
     * Handoffs reuse the dispatcher machinery already here: a forced tool call
     * over a typed menu. The differences are that the menu is the agent's own
     * colleagues, and that the turn can move any number of times.
     */
    async _runSwarm(userPrompt, onProgress) {
        const rw = window.swarmRewrite(this._currentGraphForRewrite());
        if (!rw.ok) { this._showSwarmRefusalModal(rw); return { output: '', handoffs: [], status: 'refused', history: [] }; }

        const budget = window.SWARM_HOP_BUDGET || 25;
        const handoffs = [];
        let transcript = [];
        let active = rw.entry;
        let output = '';
        let status = 'completed';
        let answered = null;

        for (let hop = 0; hop <= budget; hop++) {
            if (hop === budget) {
                // No turn answered, so no deliverable and no skill run (§6b).
                status = 'hop_budget_exhausted';
                output = `Stopped after ${budget} handoffs without an answer.`;
                break;
            }

            const agent = rw.agents[active];
            const node = this.editor.getNodeFromId(active);
            // The agent's own node, carrying the instructions the rewrite composed:
            // its system prompt plus the handoff guide built from the dispatcher's.
            const swarmNode = { ...node, data: { ...node.data, instructions: agent.instructions } };
            const targets = agent.handoffs.map(id => ({ id, name: rw.agents[id].name }));
            const last = handoffs[handoffs.length - 1];

            this._wfNodeLog(active, 'llm', `${agent.name} holds the turn (hop ${hop})`);
            try { onProgress?.({ type: 'node_start', node_id: active, agent_name: agent.name }); } catch (_) {}

            const res = await this._runNodeAsChatUnit(swarmNode, hop === 0 ? userPrompt : '', {
                dispatchTargets: targets.length ? targets : null,
                routedBy: last ? { from: rw.agents[last.from].name, notes: last.reason } : null,
                history: transcript,
                skipSkills: true,          // a handoff is not a deliverable
            });

            // Take the grown transcript even on failure: what was said was said.
            if (Array.isArray(res?.history)) transcript = res.history;

            if (res && res.success === false) {
                status = 'error';
                output = res.output || 'The swarm stopped on an error.';
                break;
            }

            if (res?.route) {
                const to = String(res.route.id);
                handoffs.push({ from: active, to, reason: res.route.notes || '' });
                this._wfNodeLog(active, 'routing', `hands to ${rw.agents[to].name}${res.route.notes ? ' — ' + res.route.notes : ''}`);
                active = to;
                continue;
            }

            output = res?.output || '';
            answered = active;
            break;
        }

        return { output, handoffs, status, history: transcript, answered };
    }
```

Note what is *not* here: no `message = res.output`. The next agent is handed `''` with the shared transcript, exactly as the existing multi-round loop already does at line 11932 (`message: round === 0 ? inputText : ''`) — proof the backend accepts an empty message when the history carries the content.

- [ ] **Step 5: Skills only on the answering turn**

`_runNodeAsChatUnit` runs an agent's bound skill on every call. In a swarm a turn that hands off has produced no deliverable, so the option added in Step 1 must be honoured. Find the block that loads and runs the bound skill (it reads `data.bound_skill?.dir_name` around line 11869 and uses `dirName` further down) and gate it:

```js
        // A swarm calls this once per hop; only the turn that answers has a
        // deliverable, so the caller suppresses skills on the others (§6b).
        const dirName = skipSkills ? null : (data.bound_skill?.dir_name || null);
```

Gating at `dirName` rather than at each use point means every downstream `if (dirName)` guard already in the function does the right thing, and nothing else changes.

Then run the answering agent's skill once, after the loop, by calling the same function a second time with the deliverable — it is the only reusable entry point:

```js
        // The answer exists; now let the agent that produced it run its skill,
        // with the full conversation behind it.
        const answerNode = answered != null ? this.editor.getNodeFromId(answered) : null;
        if (status === 'completed' && answerNode?.data?.bound_skill?.dir_name) {
            this._wfNodeLog(answered, 'skill', `running ${answerNode.data.bound_skill.dir_name} on the answer`);
            const skillRes = await this._runNodeAsChatUnit(answerNode, output, { history: transcript });
            if (Array.isArray(skillRes?.history)) transcript = skillRes.history;
            if (skillRes?.output) output = skillRes.output;
        }
```

Place this immediately before the `return` in `_runSwarm`.

- [ ] **Step 6: Verify**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
node frontend/assets/js/__tests__/swarm-rewrite.check.js
grep -c "history: conversationHistory" frontend/assets/js/workflow-editor.js
cd backend && php vendor/bin/phpunit tests/Unit 2>&1 | tail -3
```
Expected: `JS ok`; `12/12`; the `history:` count matching the number of `return {` sites you found in Step 1; the same 25 pre-existing failures, none new.

- [ ] **Step 7: Bump the cache-buster to `?v=20260915-swarm3` and commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(swarm): the interpreter's handoff loop over one shared conversation"
```

- [ ] **Step 8: Manual verification — the owner's pass**

This is the deliverable's real test and needs a person (spec §8.5). Report it as outstanding rather than claiming it done.

1. Build a workflow: Start → an agent **tagged Dispatcher** → two agents, each with a distinct role in its prompt, and no playbook node.
2. Leave orchestration as **workflow** and run it: the dispatcher routes once, one branch runs. Nothing about this should have changed.
3. Switch **Run as a swarm** on in the workflow settings panel. The dispatcher greys out with its note; opening its node form hides tools, skills and model.
4. Run it again: the dispatcher's **lowest-id child** holds the first turn. If an agent tagged Dispatcher takes a turn, the dissolution failed.
5. Ask something belonging to the other agent. A handoff appears in the log with its reason.
6. **The conversation test** — the one that distinguishes a swarm from a relay: after the handoff, send a follow-up that only makes sense given the earlier exchange ("make it 5 days"). The agent now holding the turn should understand it without being told the context again.
7. Open each agent's context display: its own prompt, then the labelled handoff guide.

## What this plan does not build

Stated so no one looks for it: no summarisation of a long swarm conversation (spec §5 defers it — the hop budget is the only guard), no compiler changes, no `api.py`, no run server, no checkpointer, no database beyond one column, no multi-user, no ADK/MAF/NOOA. Playbook nodes are refused in swarm mode. Those are later plans (spec §7, §9, §10).
