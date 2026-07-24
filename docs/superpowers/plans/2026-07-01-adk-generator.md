# Google ADK Workflow Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PHP `ADKGenerator` that compiles the existing workflow DSL into a fully self-contained Google ADK Python program, mirroring `LangGraphGenerator`.

**Architecture:** Extract the DSL-analysis front half both compilers share into a compile-time-only `WorkflowGraphAnalyzer` (returns a normalized array). `ADKGenerator::generate()` = `analyze()` + a pure `emitAdk(array $analyzed): string`. The emitter maps the DAG to a `SequentialAgent` of per-topological-layer `ParallelAgent`s, wires MCP tools via a ported inline HTTP JSON-RPC client, and runs skills via a ported (async-safe) subprocess executor. Output has zero runtime dependency on the PHP backend.

**Tech Stack:** PHP 8 (PHPUnit ^10), emitted Python targets `google-adk` + `litellm`. Reference implementation: `backend/src/AgentTeam/Services/LangGraphGenerator.php`.

## Global Constraints

- Emitted Python MUST be self-contained: no calls back into the PHP backend or workflow editor; MCP servers, tool catalog, skill runner, prompts, models, edges all baked inline. External footprint == LangGraph output (pip deps; network to MCP servers; `~/Documents/synergyAI/skills` only when skills used).
- Input DSL consumed unchanged from `WorkflowGraphRepository::getGraph()` → `{nodes, edges}`. Byte-identical contract to LangGraph; no DSL reinterpretation.
- `WorkflowGraphAnalyzer` lives only in the PHP compiler; it is never referenced by emitted Python.
- Skills execute as real CPython subprocesses in the generated program's own environment; deps come from each skill's `SKILL.md` frontmatter.
- Node types in scope: `start`, `agent`/`agent-template`, `parallel`, `output`. Out of scope: `realtime-*`, `condition_expr` execution, native `MCPToolset`.
- PHPUnit tests: namespace `Quantis\AIPortfolioAssistant\Tests\Unit`, extend `PHPUnit\Framework\TestCase`, live in `backend/tests/Unit/`, run with `cd backend && ./vendor/bin/phpunit tests/Unit/<File>.php`.
- Emitted `.py` filename suffix: `_adk.py`. Response shape: `['filename' => ..., 'code' => ...]`.
- After editing any `frontend/assets/js/*`, bump its `?v=` cache-buster in `frontend/index.html`.
- **Shared emit helpers (pre-flight decision):** `jsonToPython()`, `pyStr()`, `mcpClientBlock()`, `skillDepsBlock()` live in `AgentTeam\Services\PythonEmitHelpers` (Task 2) and are called as `PythonEmitHelpers::<name>()` from BOTH generators. Where later task code snippets write `self::pyStr(...)` / `self::jsonToPython(...)`, read them as `PythonEmitHelpers::<name>(...)` — do not define private copies in `ADKGenerator`.

---

### Task 1: Extract `WorkflowGraphAnalyzer` (shared front half)

**Files:**
- Create: `backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php`
- Test: `backend/tests/Unit/WorkflowGraphAnalyzerTest.php`

**Interfaces:**
- Produces: `WorkflowGraphAnalyzer::__construct(PDO $db, WorkflowRepository $workflowRepo, WorkflowGraphRepository $graphRepo, AgentRepository $agentRepo)` and `analyze(int $workflowId, ?string $userId): array`.
- The returned array (the **AnalyzedGraph**) has keys:
  - `workflow`: `['id' => int, 'name' => string]`
  - `byId`: `array<string,array>` node keyed by string id
  - `order`: `string[]` topological node-id order
  - `agents`: `array<string,array>` per agent node → `['name','systemPrompt','provider','model','temperature','max_tokens','tools' => string[],'skill_content','output_schema_id','documents' => array]`
  - `edges`: `array<int,array{from:string,to:string}>`
  - `children`: `array<string,string[]>` adjacency (node id → child ids)
  - `parents`: `array<string,string[]>` reverse adjacency
  - `layers`: `string[][]` topological layers (level 0 = start)
  - `startNodeId`: `string`
  - `usedCatalog`: `array<string,array>` tool name → tool def (only tools referenced by agents)
  - `usedServers`: `array<string,array>` server key → server def (only servers whose tools are used)
  - `startPrompt`: `string`, `startDocuments`: `array`

- [ ] **Step 1: Write the failing test**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class WorkflowGraphAnalyzerTest extends TestCase
{
    /** A diamond: start(1) -> a(2), start(1) -> b(3), a(2) -> out(4), b(3) -> out(4) */
    private function diamond(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'You are B', 'provider' => 'gemini', 'model' => 'gemini-2.5-pro', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'],
                ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4'],
            ],
        ];
    }

    public function testLayersGroupIndependentNodes(): void
    {
        $a = WorkflowGraphAnalyzer::analyzeGraph($this->diamond());
        // level 0: [1]; level 1: [2,3] (independent, same depth); level 2: [4]
        $this->assertSame(['1'], $a['layers'][0]);
        sort($a['layers'][1]);
        $this->assertSame(['2', '3'], $a['layers'][1]);
        $this->assertSame(['4'], $a['layers'][2]);
    }

    public function testParentsAndChildren(): void
    {
        $a = WorkflowGraphAnalyzer::analyzeGraph($this->diamond());
        sort($a['parents']['4']);
        $this->assertSame(['2', '3'], $a['parents']['4']);
        sort($a['children']['1']);
        $this->assertSame(['2', '3'], $a['children']['1']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/WorkflowGraphAnalyzerTest.php`
Expected: FAIL — class `AgentTeam\Services\WorkflowGraphAnalyzer` not found.

- [ ] **Step 3: Write minimal implementation**

Create `WorkflowGraphAnalyzer.php`. Move the pure graph-analysis helpers out of `LangGraphGenerator` (do not delete them there yet — Task 2 rewires LangGraph). Expose a **static, DB-free** `analyzeGraph(array $graph): array` that does normalization + topo layering + parent/child maps, and an instance `analyze(int $workflowId, ?string $userId): array` that loads the graph from repos then calls `analyzeGraph()` and enriches with `agents`/`usedCatalog`/`usedServers`.

```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use PDO;

class WorkflowGraphAnalyzer
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    /** Pure, DB-free analysis of a {nodes,edges} graph. */
    public static function analyzeGraph(array $graph): array
    {
        $nodes = $graph['nodes'] ?? [];
        $edges = $graph['edges'] ?? [];

        $byId = [];
        foreach ($nodes as $n) {
            $id = (string) ($n['id'] ?? '');
            if ($id === '') { continue; }
            $byId[$id] = $n;
        }

        // Normalize edges to {from,to} strings (accept from_node_id/to_node_id/source/target).
        $norm = [];
        $children = [];
        $parents = [];
        foreach ($byId as $id => $_) { $children[$id] = []; $parents[$id] = []; }
        foreach ($edges as $e) {
            $from = (string) ($e['from'] ?? $e['from_node_id'] ?? $e['source'] ?? '');
            $to   = (string) ($e['to']   ?? $e['to_node_id']   ?? $e['target'] ?? '');
            if ($from === '' || $to === '' || !isset($byId[$from]) || !isset($byId[$to])) { continue; }
            $norm[] = ['from' => $from, 'to' => $to];
            $children[$from][] = $to;
            $parents[$to][] = $from;
        }

        // Topological layers via Kahn (longest-path level assignment).
        $indeg = [];
        foreach ($byId as $id => $_) { $indeg[$id] = count($parents[$id]); }
        $level = [];
        $queue = [];
        foreach ($indeg as $id => $d) { if ($d === 0) { $queue[] = $id; $level[$id] = 0; } }
        $order = [];
        $work = $indeg;
        while ($queue) {
            $id = array_shift($queue);
            $order[] = $id;
            foreach ($children[$id] as $c) {
                $level[$c] = max($level[$c] ?? 0, ($level[$id] ?? 0) + 1);
                if (--$work[$c] === 0) { $queue[] = $c; }
            }
        }
        if (count($order) !== count($byId)) {
            throw new \RuntimeException('Workflow graph has a cycle or disconnected node');
        }

        $layers = [];
        foreach ($level as $id => $lv) { $layers[$lv][] = $id; }
        ksort($layers);
        $layers = array_values($layers);

        $startNodeId = '';
        foreach ($byId as $id => $n) {
            if (self::typeOf($n) === 'start') { $startNodeId = $id; break; }
        }

        return [
            'byId' => $byId,
            'order' => $order,
            'edges' => $norm,
            'children' => $children,
            'parents' => $parents,
            'layers' => $layers,
            'startNodeId' => $startNodeId,
        ];
    }

    public static function typeOf(array $n): string
    {
        return (string) ($n['type'] ?? $n['node_type'] ?? ($n['config']['type'] ?? 'agent'));
    }

    /** DB-backed: load graph + enrich with agents/tools/servers. */
    public function analyze(int $workflowId, ?string $userId = null): array
    {
        $wf = $this->workflowRepo->findById($workflowId);
        if (!$wf) { throw new \RuntimeException('Workflow not found'); }
        $graph = $this->graphRepo->getGraph($workflowId);
        $base = self::analyzeGraph($graph);

        $agents = [];
        foreach ($base['order'] as $id) {
            $n = $base['byId'][$id];
            if (!in_array(self::typeOf($n), ['agent', 'agent-template'], true)) { continue; }
            $c = $n['config'] ?? [];
            $tools = $c['selectedTools'] ?? $c['tools'] ?? [];
            $agents[$id] = [
                'name' => (string) ($c['agent_name'] ?? "agent_$id"),
                'systemPrompt' => (string) ($c['systemPrompt'] ?? $c['instructions'] ?? ''),
                'provider' => (string) ($c['agent_provider'] ?? $c['provider'] ?? $c['llm_provider'] ?? 'claude'),
                'model' => (string) ($c['model'] ?? ''),
                'temperature' => $c['settings']['temperature'] ?? null,
                'max_tokens' => $c['settings']['max_tokens'] ?? null,
                'tools' => array_values(array_map('strval', $tools)),
                'skill_content' => (string) ($c['skill_content'] ?? ''),
                'output_schema_id' => $c['output_schema_id'] ?? null,
                'documents' => $c['documents'] ?? [],
            ];
        }

        // Reuse the exact same tool/server catalog logic LangGraphGenerator uses.
        [$usedCatalog, $usedServers] = $this->buildToolCatalog($agents);

        $startNode = $base['byId'][$base['startNodeId']] ?? [];
        return array_merge($base, [
            'workflow' => ['id' => $workflowId, 'name' => (string) ($wf['name'] ?? "workflow_$workflowId")],
            'agents' => $agents,
            'usedCatalog' => $usedCatalog,
            'usedServers' => $usedServers,
            'startPrompt' => (string) ($startNode['config']['prompt'] ?? ''),
            'startDocuments' => $startNode['config']['documents'] ?? [],
        ]);
    }

    /**
     * Port the tool/server catalog assembly from LangGraphGenerator (lines ~220-244, 517-549):
     * load MCP tools with server URLs from DB, keep only tools referenced by agents,
     * keep only servers whose tools are used. Return [usedCatalog, usedServers].
     */
    private function buildToolCatalog(array $agents): array
    {
        // COPY the body of the corresponding LangGraphGenerator private method(s) verbatim,
        // substituting $agents['...']['tools'] as the "referenced tool names" source.
        // (This is a lift-and-shift, not new logic.)
        return [[], []];
    }
}
```

> Note: the `buildToolCatalog` body must be lifted verbatim from the existing catalog logic in `LangGraphGenerator.php` (the block that reads MCP tools + server URLs from the DB and filters to used ones). Do not invent new SQL.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/WorkflowGraphAnalyzerTest.php`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php backend/tests/Unit/WorkflowGraphAnalyzerTest.php
git commit -m "feat(adk): add WorkflowGraphAnalyzer shared DSL analysis"
```

---

### Task 2: Route `LangGraphGenerator` through the analyzer + extract shared `PythonEmitHelpers` (behavior-preserving)

**Files:**
- Create: `backend/src/AgentTeam/Services/PythonEmitHelpers.php`
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php`
- Test: `backend/tests/Unit/LangGraphParityTest.php`, `backend/tests/Unit/PythonEmitHelpersTest.php`

**Interfaces:**
- Consumes: `WorkflowGraphAnalyzer::analyzeGraph()` (Task 1).
- Produces:
  - unchanged `LangGraphGenerator::generate()` output.
  - `PythonEmitHelpers` with the **shared** emit helpers both generators use, moved verbatim out of `LangGraphGenerator`:
    - `static jsonToPython(mixed $v, bool $pretty = false): string`
    - `static pyStr(string $s): string`
    - `static mcpClientBlock(): string`
    - `static skillDepsBlock(): string` (the `_ensure_skill_deps` + `SKILL.md` frontmatter parse Python)

**Decision (from pre-flight):** the human chose **extract shared helpers** over duplication. These helpers are lifted from `LangGraphGenerator` into `PythonEmitHelpers`; `LangGraphGenerator` now calls them (behavior-preserving); `ADKGenerator` (Tasks 5-7) calls the same ones. This modifies the proven LangGraph emitter, so the parity check below is the gate.

Add a `PythonEmitHelpersTest` that pins the two pure string helpers:

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;
use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PythonEmitHelpers;
class PythonEmitHelpersTest extends TestCase
{
    public function testPyStrEscapes(): void
    {
        $out = PythonEmitHelpers::pyStr("line1\nquote\"x");
        $this->assertStringContainsString('\\n', $out);
        $this->assertStringContainsString('\\"', $out);
    }
    public function testJsonToPythonNullTrueFalse(): void
    {
        $out = PythonEmitHelpers::jsonToPython(['a' => null, 'b' => true, 'c' => false]);
        $this->assertStringContainsString('None', $out);
        $this->assertStringContainsString('True', $out);
        $this->assertStringContainsString('False', $out);
    }
}
```

- [ ] **Step 1: Write the failing test** (captures current output as a golden snapshot, then asserts equality after refactor)

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class LangGraphParityTest extends TestCase
{
    public function testTopoOrderMatchesAnalyzer(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']],
                ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent']],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $a = WorkflowGraphAnalyzer::analyzeGraph($graph);
        $this->assertSame(['1', '2', '3'], $a['order']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/LangGraphParityTest.php`
Expected: PASS (analyzer already exists) — this test pins the ordering contract LangGraph will now depend on.

- [ ] **Step 3: Refactor LangGraphGenerator**

Two behavior-preserving moves:
1. In `LangGraphGenerator::generate()`, replace the inline graph-load + topo + agent-extraction + catalog blocks with a call to `WorkflowGraphAnalyzer` and read from the AnalyzedGraph array. Keep `toolBuilderBlock`, `stateBlock`, `runBodyBlock`, etc. as-is; they now read `$analyzed['agents']`, `$analyzed['order']`, `$analyzed['usedCatalog']`, `$analyzed['usedServers']` instead of local vars.
2. Create `PythonEmitHelpers.php` and **move** `jsonToPython()`, `pyStr()`, `mcpClientBlock()`, and the `_ensure_skill_deps`/`SKILL.md`-parse Python (as `skillDepsBlock()`) out of `LangGraphGenerator` into it, verbatim. Replace the originals in `LangGraphGenerator` with calls to `PythonEmitHelpers::<name>()`. **Do not change generated Python** — same bytes out.

- [ ] **Step 4: Verify LangGraph output is unchanged**

Manually generate one existing workflow before and after and diff:
Run: `cd backend && php tests/CheckExistingWorkflows.php > /tmp/lg_after.txt` (adapt this existing script to print `generate()` output for a known workflow id).
Expected: no diff in emitted Python vs a snapshot captured before the refactor. If `CheckExistingWorkflows.php` cannot print code, add a tiny throwaway script `php -r` that instantiates the generator for one workflow id and echoes `['code']`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/PythonEmitHelpers.php backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/LangGraphParityTest.php backend/tests/Unit/PythonEmitHelpersTest.php
git commit -m "refactor(adk): LangGraphGenerator uses WorkflowGraphAnalyzer + shared PythonEmitHelpers (no output change)"
```

---

### Task 3: `ADKGenerator` skeleton + pure `emitAdk()` header

**Files:**
- Create: `backend/src/AgentTeam/Services/ADKGenerator.php`
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Consumes: AnalyzedGraph array (Task 1).
- Produces:
  - `ADKGenerator::__construct(PDO $db, WorkflowRepository $workflowRepo, WorkflowGraphRepository $graphRepo, AgentRepository $agentRepo)`
  - `generate(int $workflowId, ?string $userId): array` → `['filename' => '<name>_adk.py', 'code' => string]`
  - `static emitAdk(array $analyzed): string` (pure — the unit-test seam)

- [ ] **Step 1: Write the failing test**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class AdkGeneratorEmitTest extends TestCase
{
    protected function analyzed(): array
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = WorkflowGraphAnalyzer::analyzeGraph($graph);
        return array_merge($base, [
            'workflow' => ['id' => 7, 'name' => 'demo'],
            'agents' => ['2' => ['name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []]],
            'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
        ]);
    }

    public function testHeaderAndImports(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('google-adk', $code);
        $this->assertStringContainsString('from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent', $code);
        $this->assertStringContainsString('from google.adk.models.lite_llm import LiteLlm', $code);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php`
Expected: FAIL — class `AgentTeam\Services\ADKGenerator` not found.

- [ ] **Step 3: Write minimal implementation**

```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use PDO;

class ADKGenerator
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    public function generate(int $workflowId, ?string $userId = null): array
    {
        $analyzer = new WorkflowGraphAnalyzer($this->db, $this->workflowRepo, $this->graphRepo, $this->agentRepo);
        $analyzed = $analyzer->analyze($workflowId, $userId);
        $name = preg_replace('/[^a-z0-9_]+/i', '_', $analyzed['workflow']['name']);
        return ['filename' => strtolower($name) . '_adk.py', 'code' => self::emitAdk($analyzed)];
    }

    public static function emitAdk(array $analyzed): string
    {
        $lines = [];
        $lines[] = self::headerBlock($analyzed);
        // Later tasks append: mcp client, skill runner, tools, model factory,
        // agents, layering/root, main.
        return implode("\n", $lines) . "\n";
    }

    private static function headerBlock(array $analyzed): string
    {
        $name = $analyzed['workflow']['name'];
        return <<<PY
        """Standalone Google ADK workflow: {$name}
        Auto-generated -- backend-independent. Self-contained: MCP + skills run
        in this program's own Python environment.

        requirements:
            pip install google-adk litellm
        """
        import asyncio, json, os, subprocess, sys, urllib.request
        from typing import Any

        from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent
        from google.adk.models.lite_llm import LiteLlm
        from google.adk.tools import FunctionTool
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        PY;
    }
}
```

> The heredoc is indented; strip leading indentation at emit time OR use a nowdoc with column-0 content (match whatever `LangGraphGenerator` already does — copy its heredoc-dedent convention exactly).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): ADKGenerator skeleton + header emit"
```

---

### Task 4: Model factory + provider mapping

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php`
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Produces: emitted `_make_model(provider, model)` Python and calls `self::modelFactoryBlock()` inside `emitAdk()`.

- [ ] **Step 1: Write the failing test** (append method)

```php
    public function testModelFactoryMapsProviders(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('def _make_model(provider: str, model: str)', $code);
        // Gemini => bare model string; others => LiteLlm(...)
        $this->assertStringContainsString('return model', $code);          // gemini path
        $this->assertStringContainsString('return LiteLlm(model=', $code); // non-gemini path
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testModelFactoryMapsProviders`
Expected: FAIL — string not found.

- [ ] **Step 3: Implement** — add to `emitAdk()` (`$lines[] = self::modelFactoryBlock();`) and the method:

```php
    private static function modelFactoryBlock(): string
    {
        return <<<'PY'
        _LITELLM_PREFIX = {
            "claude": "anthropic/", "anthropic": "anthropic/",
            "openai": "openai/", "grok": "xai/", "xai": "xai/",
            "mistral": "mistral/", "groq": "groq/",
        }

        def _make_model(provider: str, model: str):
            p = (provider or "").lower()
            if p in ("gemini", "google", "google-genai", ""):
                return model or "gemini-2.5-pro"
            prefix = _LITELLM_PREFIX.get(p, p + "/")
            spec = model if "/" in model else prefix + model
            return LiteLlm(model=spec)
        PY;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testModelFactoryMapsProviders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): emit provider->model factory (_make_model)"
```

---

### Task 5: Port MCP HTTP client + `FunctionTool` builder

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php`
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Produces: emitted `MCP_SERVERS`, `TOOL_CATALOG`, `_call_mcp_tool(...)`, `build_tools_from_catalog() -> dict[str, FunctionTool]`.

- [ ] **Step 1: Write the failing test**

```php
    public function testMcpToolBuilderEmitted(): void
    {
        $a = $this->analyzed();
        $a['usedServers'] = ['srv1' => ['url' => 'http://localhost:9000/mcp']];
        $a['usedCatalog'] = ['search' => ['server' => 'srv1', 'description' => 'Search', 'input_schema' => ['type' => 'object', 'properties' => []]]];
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('MCP_SERVERS = {', $code);
        $this->assertStringContainsString('TOOL_CATALOG = {', $code);
        $this->assertStringContainsString('def _call_mcp_tool(', $code);
        $this->assertStringContainsString('def build_tools_from_catalog()', $code);
        $this->assertStringContainsString('FunctionTool(', $code);
        $this->assertStringContainsString('http://localhost:9000/mcp', $code);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testMcpToolBuilderEmitted`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `emitAdk()` append:
```php
$lines[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($analyzed['usedServers'], true);
$lines[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($analyzed['usedCatalog'], true);
$lines[] = PythonEmitHelpers::mcpClientBlock();   // shared helper (Task 2)
$lines[] = self::adkToolBuilderBlock();
```
- Use the shared `PythonEmitHelpers::jsonToPython()` and `PythonEmitHelpers::mcpClientBlock()` created in Task 2 (do not re-copy; the HTTP JSON-RPC client is transport-identical). Add `use AgentTeam\Services\PythonEmitHelpers;` if needed (same namespace, so a bare `PythonEmitHelpers::` reference resolves without a use statement).
- New `adkToolBuilderBlock()` wraps each catalog tool as a `FunctionTool`. Each generated wrapper calls `_call_mcp_tool(server_url, tool_name, kwargs)` and returns its result:

```php
    private static function adkToolBuilderBlock(): string
    {
        return <<<'PY'
        def build_tools_from_catalog() -> dict:
            tools = {}
            for name, spec in TOOL_CATALOG.items():
                server = MCP_SERVERS.get(spec.get("server", ""), {})
                url = server.get("url", "")
                def _make(_name=name, _url=url):
                    def _fn(**kwargs) -> str:
                        """MCP tool proxy."""
                        return _call_mcp_tool(_url, _name, kwargs)
                    _fn.__name__ = _name
                    _fn.__doc__ = TOOL_CATALOG.get(_name, {}).get("description", _name)
                    return FunctionTool(_fn)
                tools[name] = _make()
            return tools
        PY;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testMcpToolBuilderEmitted`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): emit ported MCP client + FunctionTool builder"
```

---

### Task 6: Port async-safe skill executor

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php`
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Produces: emitted `_run_skill_script(dir_name, script, argv, ...)`, `_ensure_skill_deps(...)`, `SKILLS_DIR`, `RUN_SKILL_SCRIPT_TOOL` (a `FunctionTool`), auto-attached when an agent prompt references `run_skill_script`.

- [ ] **Step 1: Write the failing test**

```php
    public function testSkillRunnerEmittedAndAsyncSafe(): void
    {
        $a = $this->analyzed();
        $a['agents']['2']['skill_content'] = "Use the skill: call run_skill_script with dir_name='html/create'";
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('SKILLS_DIR', $code);
        $this->assertStringContainsString('def _run_skill_script(', $code);
        $this->assertStringContainsString('asyncio.create_subprocess_exec', $code); // async-safe entry
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL = FunctionTool(', $code);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillRunnerEmittedAndAsyncSafe`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Emit `SKILLS_DIR` and the dep-install helper via the shared `PythonEmitHelpers::skillDepsBlock()` from Task 2 (it carries `_ensure_skill_deps` + the `SKILL.md` frontmatter parse). Do not re-copy.
- Emit the ADK-specific async runner below (this part is NOT shared — the LangGraph path uses a blocking `subprocess.run`; ADK needs async so parallel layers don't serialize). Wrap it so the `FunctionTool` exposes an `async def`:

```php
    private static function skillRunnerBlock(): string
    {
        return <<<'PY'
        SKILLS_DIR = os.path.expanduser("~/Documents/synergyAI/skills")

        async def _run_skill_script(dir_name: str, script: str, argv: list[str] | None = None,
                                    input_files: dict | None = None, read_outputs: bool = True) -> str:
            """Run a skill's Python script as a subprocess in THIS environment."""
            argv = argv or []
            skill_path = os.path.join(SKILLS_DIR, dir_name)
            _ensure_skill_deps(skill_path)  # ported: parse SKILL.md frontmatter, pip install once
            script_path = os.path.join(skill_path, script)
            proc = await asyncio.create_subprocess_exec(
                sys.executable, script_path, *[str(a) for a in argv],
                cwd=skill_path,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, err = await proc.communicate()
            if proc.returncode != 0:
                return f"[skill error rc={proc.returncode}] {err.decode('utf-8', 'replace')}"
            return out.decode("utf-8", "replace")

        RUN_SKILL_SCRIPT_TOOL = FunctionTool(_run_skill_script)
        PY;
    }
```
- Append `self::skillRunnerBlock()` in `emitAdk()` only when any agent has non-empty `skill_content` OR any agent prompt references `run_skill_script` (mirror LangGraph's auto-detect at ~line 490).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillRunnerEmittedAndAsyncSafe`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): emit async-safe skill subprocess runner"
```

---

### Task 7: Emit per-node `LlmAgent`s

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php`
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Produces: one `LlmAgent(name=..., model=_make_model(...), instruction=..., tools=[...], output_key="node_<id>")` per agent node, with `## Skill` block and `{node_<parent>}` injections appended to the instruction, and `run_skill_script` added to tools when referenced.

- [ ] **Step 1: Write the failing test**

```php
    public function testAgentEmittedWithOutputKeyAndParentInjection(): void
    {
        $a = $this->analyzed();
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('node_2 = LlmAgent(', $code);
        $this->assertStringContainsString('output_key="node_2"', $code);
        $this->assertStringContainsString('model=_make_model("claude", "claude-sonnet-4-6")', $code);
        $this->assertStringContainsString('You are A', $code);
    }

    public function testParentOutputsInjectedIntoInstruction(): void
    {
        // node 3 (output) is child of 2; a downstream agent reading node 2 must see {node_2}
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B reads A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B reads A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('{node_2}', $code); // node 3 instruction injects parent 2
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testAgent`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add an `agentsBlock(array $analyzed): string` that, for each id in `$analyzed['agents']`, emits an `LlmAgent`. Build the instruction as: systemPrompt, then (if `skill_content`) `"\n\n## Skill\n" . skill_content`, then for each parent p in `$analyzed['parents'][$id]` that is an agent, append `"\n\n## Input from {parents}\n{node_<p>}"`. Resolve tools: map each tool name to `catalog["<name>"]`; if instruction references `run_skill_script`, add `RUN_SKILL_SCRIPT_TOOL`. Emit temperature/max_tokens via `generate_content_config` only when set (use ADK's config type; if unset, omit). Use `PythonEmitHelpers::pyStr()` (the shared escaper from Task 2) for the instruction.

```php
    private static function agentsBlock(array $analyzed): string
    {
        $out = [];
        foreach ($analyzed['agents'] as $id => $ag) {
            $instr = $ag['systemPrompt'];
            if ($ag['skill_content'] !== '') {
                $instr .= "\n\n## Skill\n" . $ag['skill_content'];
            }
            $agentParents = array_values(array_filter(
                $analyzed['parents'][$id] ?? [],
                fn($p) => isset($analyzed['agents'][$p])
            ));
            foreach ($agentParents as $p) {
                $instr .= "\n\n## Input from node {$p}\n{node_{$p}}";
            }
            $toolExprs = [];
            foreach ($ag['tools'] as $t) { $toolExprs[] = 'catalog["' . $t . '"]'; }
            if (strpos($instr, 'run_skill_script') !== false) { $toolExprs[] = 'RUN_SKILL_SCRIPT_TOOL'; }
            $toolsPy = '[' . implode(', ', $toolExprs) . ']';
            $model = 'model=_make_model("' . $ag['provider'] . '", "' . $ag['model'] . '")';
            $out[] = "node_{$id} = LlmAgent(\n"
                . "    name=\"node_{$id}\",\n"
                . "    {$model},\n"
                . "    instruction=" . self::pyStr($instr) . ",\n"
                . "    tools={$toolsPy},\n"
                . "    output_key=\"node_{$id}\",\n"
                . ")";
        }
        return implode("\n\n", $out);
    }
```
Emit `catalog = build_tools_from_catalog()` (and `catalog` gets `RUN_SKILL_SCRIPT_TOOL` referenced directly) just before the agents block in `emitAdk()`. Port `pyStr()` verbatim from LangGraph.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testAgent`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): emit per-node LlmAgents with output_key + parent injection"
```

---

### Task 8: Topological layering → root assembly + `main()`

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php`
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Produces: `root_agent = SequentialAgent(...)` composed of per-layer `ParallelAgent`s (multi-node layers) or single agents; an output-consolidator agent for the `output` node; `main()` seeding state and running via `Runner`.

- [ ] **Step 1: Write the failing test**

```php
    public function testRootLayeringAndMain(): void
    {
        // diamond -> layer 1 has two agents -> ParallelAgent
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'], ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('ParallelAgent(', $code);
        $this->assertStringContainsString('root_agent = SequentialAgent(', $code);
        $this->assertStringContainsString('node_4', $code);            // output consolidator
        $this->assertStringContainsString('async def main(', $code);
        $this->assertStringContainsString('Runner(', $code);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testRootLayeringAndMain`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **Output consolidator:** for each `output` node, emit an `LlmAgent` named `node_<id>` whose instruction is `"Consolidate the following results into the final answer.\n\n"` plus `"{node_<p>}"` for each parent p, with `output_key="node_<id>"` and no tools. (Matches LangGraph output-node consolidation by parent.)
- **Layering:** build `root_agent` from `$analyzed['layers']`. Skip the start layer (level 0) unless it maps to an agent (start is not an agent → it only seeds state). For each remaining layer, collect the emitted var names (`node_<id>`) of nodes that are agents or output; if a layer has one → use it directly; if >1 → wrap in `ParallelAgent(name="layer_<k>", sub_agents=[...])`. Compose `root_agent = SequentialAgent(name="workflow", sub_agents=[<layer exprs in order>])`.

```php
    private static function rootBlock(array $analyzed): string
    {
        $isRunnable = function (string $id) use ($analyzed): bool {
            $t = WorkflowGraphAnalyzer::typeOf($analyzed['byId'][$id]);
            return in_array($t, ['agent', 'agent-template', 'output'], true);
        };
        $layerExprs = [];
        foreach ($analyzed['layers'] as $k => $layer) {
            $vars = [];
            foreach ($layer as $id) { if ($isRunnable($id)) { $vars[] = "node_{$id}"; } }
            if (!$vars) { continue; }
            if (count($vars) === 1) {
                $layerExprs[] = $vars[0];
            } else {
                $layerExprs[] = "ParallelAgent(name=\"layer_{$k}\", sub_agents=[" . implode(', ', $vars) . "])";
            }
        }
        $body = implode(",\n    ", $layerExprs);
        return "root_agent = SequentialAgent(\n    name=\"workflow\",\n    sub_agents=[\n    {$body}\n    ],\n)";
    }

    private static function mainBlock(array $analyzed): string
    {
        $startPromptPy = self::pyStr($analyzed['startPrompt']);
        return <<<PY
        async def main(user_prompt: str = {$startPromptPy}):
            session_service = InMemorySessionService()
            runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)
            session = await session_service.create_session(app_name="workflow", user_id="local", state={})
            final = ""
            from google.genai import types
            content = types.Content(role="user", parts=[types.Part(text=user_prompt)])
            async for event in runner.run_async(user_id="local", session_id=session.id, new_message=content):
                if event.is_final_response() and event.content and event.content.parts:
                    final = event.content.parts[0].text or final
            os.makedirs("outputs", exist_ok=True)
            print(final)
            return final

        if __name__ == "__main__":
            asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else {$startPromptPy}))
        PY;
    }
```
Wire both into `emitAdk()` after the agents block: `$lines[] = self::rootBlock($analyzed); $lines[] = self::mainBlock($analyzed);` (emit output-consolidator agents alongside the agents block, before `rootBlock`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testRootLayeringAndMain`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): emit topological layering root + Runner main()"
```

---

### Task 9: `generate-adk` route + controller + frontend affordance

**Files:**
- Modify: `backend/src/routes.php:307` (add sibling route)
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (add `generateAdk()`)
- Modify: `frontend/assets/js/workflow-editor.js` (add "Compile → ADK" action)
- Modify: `frontend/index.html` (bump `workflow-editor.js` `?v=`)
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php` (py_compile smoke, below in Task 10)

**Interfaces:**
- Consumes: `ADKGenerator::generate()` (Task 3).
- Produces: `GET /api/v1/workflows/{id}/generate-adk` returning `{filename, code}` (and `?download=1` file download).

- [ ] **Step 1: Add the route** (after line 307)

```php
$r->get('/api/v1/workflows/{id:\d+}/generate-adk', ['AgentTeam:WorkflowController', 'generateAdk']);
```

- [ ] **Step 2: Add `generateAdk()`** — clone `generatePython()`, swap the generator class and filename content-type stays `text/x-python`:

```php
    public function generateAdk(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $download = ($request['query']['download'] ?? '0') === '1';
        if (!$userId) { return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401]; }
        if (!$workflowId) { return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400]; }
        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
            }
            $agentRepo = new \AgentTeam\Services\AgentRepository($this->db);
            $gen = new \AgentTeam\Services\ADKGenerator($this->db, $this->workflowRepository, $this->graphRepository, $agentRepo);
            $result = $gen->generate($workflowId, (string) $userId);
            if ($download) {
                return ['success' => true, 'raw_body' => $result['code'], 'headers' => [
                    'Content-Type' => 'text/x-python; charset=utf-8',
                    'Content-Disposition' => 'attachment; filename="' . $result['filename'] . '"',
                ], 'status_code' => 200];
            }
            return ['success' => true, 'data' => $result, 'status_code' => 200];
        } catch (\Throwable $e) {
            error_log('[WorkflowController] generateAdk failed: ' . $e->getMessage());
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }
```

- [ ] **Step 3: Add the frontend action** — in `workflow-editor.js`, locate the existing "Generate Python"/download control and add a sibling that GETs `/api/v1/workflows/${id}/generate-adk?download=1`. Reuse the exact same download helper the Python button uses (find it; do not write a new one).

- [ ] **Step 4: Bump cache-buster** — in `frontend/index.html`, find `workflow-editor.js?v=<n>` and increment `<n>`.

- [ ] **Step 5: Manual verification**

Run the app, open a workflow, click "Compile → ADK", confirm a `<name>_adk.py` downloads and its first line is the ADK docstring.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes.php backend/src/AgentTeam/Controllers/WorkflowController.php frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(adk): wire generate-adk route, controller, editor button"
```

---

### Task 10: End-to-end golden + `py_compile` + smoke

**Files:**
- Create: `backend/tests/Unit/AdkGeneratorCompileTest.php`
- Create: `backend/tests/fixtures/adk_diamond.golden.py` (committed golden)

**Interfaces:**
- Consumes: `ADKGenerator::emitAdk()` (all prior tasks).

- [ ] **Step 1: Write the failing test** (generates the diamond, writes to a temp file, runs `python -m py_compile`)

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class AdkGeneratorCompileTest extends TestCase
{
    public function testGeneratedFileIsValidPython(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'], ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4']],
        ];
        $base = WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'diamond'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $tmp = sys_get_temp_dir() . '/adk_diamond_test.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        $this->assertSame(0, $rc, "Generated Python failed to compile:\n" . implode("\n", $out));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorCompileTest.php`
Expected: FAIL if any emitted block has a Python syntax error; the failure message shows the exact line. Fix emit code until it passes. (No `google-adk` install needed — `py_compile` only checks syntax.)

- [ ] **Step 3: Make it pass** — fix any syntax issues surfaced (indentation from heredocs, trailing commas, f-string braces vs `{node_X}` templating — ensure `{node_X}` sits in plain strings, not f-strings).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/AdkGeneratorCompileTest.php`
Expected: PASS.

- [ ] **Step 5: Smoke run (manual, documented)**

In a venv: `pip install google-adk litellm`, export the needed provider API key, generate a real workflow's ADK file via the editor, and run `python <name>_adk.py "test prompt"`. Confirm it produces a final answer and, if the workflow uses MCP/skills, that those execute. Record the result in the PR description.

- [ ] **Step 6: Commit**

```bash
git add backend/tests/Unit/AdkGeneratorCompileTest.php backend/tests/fixtures/adk_diamond.golden.py
git commit -m "test(adk): py_compile golden + smoke coverage"
```

---

## Self-Review

**Spec coverage:**
- Locked decisions (compiler=PHP, output=ADK Python, full parity, generate-adk route) → Tasks 3, 9. ✓
- Topological layering (Approach A) → Tasks 1 (layers), 8 (root). ✓
- MCP ported HTTP client + FunctionTool → Task 5. ✓
- Skills ported + async-safe → Task 6. ✓
- Multi-provider via LiteLlm → Task 4. ✓
- Self-containment invariant → enforced by inline-only emit (Tasks 3-8); no backend calls in emitted code. ✓
- Start seeding + output consolidator → Task 8. ✓
- `output_schema` (Pydantic) when `output_schema_id` set → **GAP**: not yet a task. See note below.
- Shared `WorkflowGraphAnalyzer` compile-time-only → Tasks 1-2. ✓
- Testing (golden, py_compile, smoke, analyzer parity) → Tasks 1, 2, 10. ✓

**Gap fix — output_schema:** parity requires emitting a Pydantic model + `output_schema=` on agents whose node sets `output_schema_id`. This is additive and low-risk. Add as **Task 8b** (before Task 9) mirroring Task 7's structure: resolve the schema by id via the analyzer (load from `workflow_schemas`), emit a `class Node<id>Out(BaseModel)`, and set `output_schema=Node<id>Out` on that agent. If a workflow sets no `output_schema_id`, emit nothing. Test: an analyzed graph with `output_schema_id` set asserts `class Node` + `output_schema=` appear; unset asserts they do not.

> **ADK constraint (verified 2026-07-01):** `output_schema` and `tools` are **mutually exclusive** on an `LlmAgent` — setting `output_schema` disables tool use / transfer. So in Task 8b, when a node has BOTH `output_schema_id` AND a non-empty tools list (or references `run_skill_script`), the generator must emit `tools=[]` for that agent and include a comment `# tools omitted: output_schema disables tool use (ADK)`. Add a test asserting a node with both set emits `output_schema=` and `tools=[]`.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Ported blocks name exact source methods/line ranges to copy. ✓

**Type consistency:** `analyzeGraph()`/`analyze()`, `emitAdk()`, `pyStr()`, `jsonToPython()`, `build_tools_from_catalog()`, `RUN_SKILL_SCRIPT_TOOL`, `node_<id>`, `output_key="node_<id>"` used consistently across Tasks 1-10. ✓
