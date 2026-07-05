# Microsoft Agent Framework (MAF) Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third compiler backend, `MAFGenerator.php`, that compiles a saved workflow into a self-contained Microsoft Agent Framework Python program (Functional API), at parity with the ADK/LangGraph backends (sequential + fan-out + fan-in, multi-provider, MCP, mandatory skill pipeline with deliverable capture).

**Architecture:** Reuse `WorkflowGraphAnalyzer::analyze()` (identical analyzed data as ADK) and `PythonEmitHelpers`. Emit a Functional-API program: one `async def node_<id>(_input)` per agent node calling `Agent(client, instructions, tools).run()`, a `@workflow async def main()` that runs topological layers via `asyncio.gather`, and the ported skill runtime (subprocess + `_LAST_SKILL_OUTPUTS` capture). Deliver via a `generate-maf` route + an Output-node submenu, writing to `python/scripts/<name>_maf.py`.

**Tech Stack:** PHP 8.4 (generator + PHPUnit), Python 3.13 (`agent-framework` 1.10.x, `py_compile` gate), JS (frontend submenu).

## Global Constraints

- Emit against **Functional API**: `from agent_framework import Agent, workflow`.
- Provider clients: Claude → `AnthropicClient` (`agent_framework.anthropic`); **all others → `OpenAIChatCompletionClient`** (`agent_framework.openai`) — NEVER `OpenAIChatClient` (it targets `/responses` and 404s on OpenAI-compatible endpoints).
- Gemini/Grok/Kimi/DeepSeek route through `OpenAIChatCompletionClient(base_url=…)`.
- **Never override agent-form values** (temperature/model): emit them verbatim; surface invalid values to the user, do not silently fix.
- Keys come from `.env`: the emitted script calls `load_dotenv(<install>/.env)` at the top (MAF does not auto-load).
- Skills are **mandatory post-agent steps** whose **produced file becomes the node output** (deliverable capture), not the model's text. Multiple skills chain (pipeline). Port the skill filesystem WHOLE: bucketed `/outputs/<group>` + `/scratch`, argv remap, `input_files` staging, `read_outputs` stash, `SYNERGYAI_*` env.
- Runner requirement `agent-framework>=1.10,<2` (already added to `langchain_runner/requirements.txt`).
- Output filename: `<sanitized-lower-name>_maf.py`, written to `python/scripts/`.
- Reference implementations to mirror: `backend/src/AgentTeam/Services/ADKGenerator.php` and `LangGraphGenerator.php`. When a step says "port from ADK lines X–Y", copy that block verbatim and apply only the adaptation named.

---

## Emitted program shape (the target — all tasks build toward this)

```python
"""Standalone Microsoft Agent Framework workflow: <name> … (header docstring)"""
import asyncio, json, os, subprocess, sys, time, traceback, urllib.request
import httpx
from dotenv import load_dotenv
from agent_framework import Agent, workflow
from agent_framework.anthropic import AnthropicClient
from agent_framework.openai import OpenAIChatCompletionClient

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

def _make_client(provider, model): ...            # Task 1
# MCP: MCP_SERVERS, TOOL_CATALOG, _call_mcp_tool, _tool_*, build_tools_from_catalog   # Task 4
def _convert_doc_to_markdown(path): ...           # Task 2 (PythonEmitHelpers)
# Skill runtime: SKILL_OUTPUTS_ROOT, _run_skill_script, _read_skill_md,
#   _make_skill_tool, _run_skill_step, _LAST_SKILL_OUTPUTS                            # Task 3
catalog = build_tools_from_catalog()              # Task 4 (Task 1/2 emit `catalog = {}`)
START_DOCUMENTS = [...]
AGENTS = { "<id>": {provider, model, system_prompt, tools, skills}, ... }            # Task 2

async def _run_node(nid, _input): ...             # Task 2: builds client+Agent+run, then skill loop
def _build_input(parents, node_outputs, user_prompt): ...                            # Task 2

WORKFLOW_NAME=…; WORKFLOW_ID=…; OUTPUT_STORAGE_ENABLED=…; OUTPUT_FOLDER=…
LAYERS=[[...]]; PARENTS={...}; OUTPUT_NODE_ID="<id>"

@workflow
async def main(user_prompt: str = "<startPrompt>") -> str:                           # Task 2
    node_outputs = {}
    for layer in LAYERS[1:]:
        ids = [n for n in layer if n in AGENTS or n == OUTPUT_NODE_ID]
        results = await asyncio.gather(*[
            _run_node(n, _build_input(PARENTS.get(n, []), node_outputs, user_prompt)) for n in ids])
        for n, r in zip(ids, results): node_outputs[n] = r
    return node_outputs.get(OUTPUT_NODE_ID, "")

if __name__ == "__main__":                                                          # Task 2
    _p = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "<startPrompt>"
    _res = asyncio.run(main.run(_p))
    _text = _res.text
    # storage-aware save (honors OUTPUT_STORAGE_ENABLED / OUTPUT_FOLDER)
```

Note: the output node is handled inside `_run_node` (a pass-through that returns its merged input unchanged — no LLM). `_run_node` branches on `AGENTS.get(nid)`; if absent, it is the output node → return `_input`.

---

## File Structure

- **Create** `backend/src/AgentTeam/Services/MAFGenerator.php` — the generator (mirror of `ADKGenerator.php`).
- **Create** `backend/tests/Unit/MafGeneratorEmitTest.php` — emit-assertion tests.
- **Create** `backend/tests/Unit/MafGeneratorCompileTest.php` — `py_compile` gate + fixtures.
- **Modify** `backend/src/routes.php` (~line 308) — add the `generate-maf` route.
- **Modify** `backend/src/AgentTeam/Controllers/WorkflowController.php` (~line 293) — add `generateMaf()`.
- **Modify** `frontend/assets/js/workflow-editor.js` — MAF Output-node submenu + `generateMafScript()` / `_runMafScript()` / `_showMafCodeModal()` / `_showMafSetupModal()` / `_showMafInfoModal()`.
- **Modify** `frontend/index.html` — bump `workflow-editor.js?v=` cache-buster.

---

### Task 1: MAFGenerator skeleton — class, `generate()`, header, `_make_client`

Produces a generator that emits a valid (agent-less) MAF header + client factory that py_compiles.

**Files:**
- Create: `backend/src/AgentTeam/Services/MAFGenerator.php`
- Test: `backend/tests/Unit/MafGeneratorEmitTest.php`

**Interfaces:**
- Consumes: `WorkflowGraphAnalyzer::analyze(int, ?string): array` (keys: `workflow`, `agents`, `usedCatalog`, `usedServers`, `startPrompt`, `startDocuments`, `outputStorageEnabled`, `outputFolder`, `layers`, `parents`, `byId`, `startNodeId`). Agent entry keys: `name, systemPrompt, provider, model, temperature, max_tokens, tools, skill_content, skills, documents`.
- Produces: `MAFGenerator::emitMaf(array $analyzed): string`; `generate(int, ?string): array{filename,code}`; `MAFGenerator::__construct(PDO, WorkflowRepository, WorkflowGraphRepository, AgentRepository)`.

- [ ] **Step 1: Write the failing test**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\MAFGenerator;

final class MafGeneratorEmitTest extends TestCase
{
    /** Minimal analyzed shape: start -> A(claude) -> output. */
    private function analyzed(): array
    {
        return [
            'workflow' => ['id' => 7, 'name' => 'Demo Flow'],
            'byId' => [
                '1' => ['id' => '1', 'type' => 'start', 'config' => []],
                '2' => ['id' => '2', 'type' => 'agent', 'config' => []],
                '3' => ['id' => '3', 'type' => 'output', 'config' => []],
            ],
            'layers' => [['1'], ['2'], ['3']],
            'parents' => ['2' => ['1'], '3' => ['2']],
            'startNodeId' => '1',
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'You are A.', 'provider' => 'claude',
                        'model' => 'claude-sonnet-4-6', 'temperature' => null, 'max_tokens' => null,
                        'tools' => [], 'skill_content' => '', 'skills' => [], 'documents' => []],
            ],
            'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'Analyze example.com', 'startDocuments' => [],
            'outputStorageEnabled' => false, 'outputFolder' => null,
        ];
    }

    public function testHeaderAndImports(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());
        $this->assertStringContainsString('from agent_framework import Agent, workflow', $code);
        $this->assertStringContainsString('from agent_framework.anthropic import AnthropicClient', $code);
        $this->assertStringContainsString('from agent_framework.openai import OpenAIChatCompletionClient', $code);
        $this->assertStringContainsString('load_dotenv(', $code);
    }

    public function testClientFactoryUsesChatCompletionAndBaseUrls(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());
        $this->assertStringContainsString('def _make_client(provider', $code);
        $this->assertStringContainsString('AnthropicClient(model=model', $code);
        // OpenAI-compatible providers MUST use ChatCompletion, never OpenAIChatClient
        $this->assertStringContainsString('OpenAIChatCompletionClient(model=model', $code);
        $this->assertStringNotContainsString('OpenAIChatClient(', $code);
        $this->assertStringContainsString('https://api.x.ai/v1', $code);
        $this->assertStringContainsString('https://generativelanguage.googleapis.com/v1beta/openai/', $code);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php`
Expected: FAIL — `Class "AgentTeam\Services\MAFGenerator" not found`.

- [ ] **Step 3: Write the generator skeleton**

Create `backend/src/AgentTeam/Services/MAFGenerator.php`:

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Compiles a workflow DSL into a self-contained Microsoft Agent Framework
 * (Functional API) Python program. Third backend beside ADKGenerator /
 * LangGraphGenerator; reuses WorkflowGraphAnalyzer + PythonEmitHelpers.
 */
class MAFGenerator
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
        return [
            'filename' => strtolower($name) . '_maf.py',
            'code'     => self::emitMaf($analyzed),
        ];
    }

    public static function emitMaf(array $analyzed): string
    {
        $parts = [];
        $parts[] = self::headerBlock($analyzed);
        $parts[] = self::clientFactoryBlock();
        // Task 4 will insert MCP blocks here; Task 2 emits `catalog = {}` for now.
        $parts[] = 'catalog = {}';
        // Task 2 inserts documentConverter, AGENTS, node runner, orchestration, main.
        return implode("\n\n", $parts) . "\n";
    }

    private static function headerBlock(array $analyzed): string
    {
        $name = str_replace(['"""', "\\"], ["'''", "\\\\"], (string) $analyzed['workflow']['name']);
        return <<<PY
        """Standalone Microsoft Agent Framework workflow: {$name}

        Auto-generated from the visual workflow editor. Backend-independent and
        self-contained: it calls the LLM providers, MCP servers, and folder-backed
        skills entirely from this one file.

        TO RUN:
            pip install "agent-framework>=1.10,<2" httpx python-dotenv
            # keys are read from ../.env (ANTHROPIC_API_KEY, OPENAI_API_KEY,
            #   GOOGLE_API_KEY, XAI_API_KEY, KIMI_API_KEY, DEEPSEEK_API_KEY)
            python this_file.py "your prompt here"
        """
        import asyncio
        import json
        import os
        import subprocess
        import sys
        import time
        import traceback
        import urllib.request

        import httpx
        from dotenv import load_dotenv
        from agent_framework import Agent, workflow
        from agent_framework.anthropic import AnthropicClient
        from agent_framework.openai import OpenAIChatCompletionClient

        # MAF does not auto-load .env; load the runner's .env (one dir up from scripts/).
        load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
        PY;
    }

    private static function clientFactoryBlock(): string
    {
        return <<<'PY'
        def _make_client(provider: str, model: str):
            """Build a MAF chat client for the given provider/model. Claude uses the
            native AnthropicClient; everyone else uses OpenAIChatCompletionClient (the
            /chat/completions client) -- OpenAIChatClient targets /responses and 404s
            on OpenAI-compatible endpoints (Gemini/Grok/Kimi/DeepSeek)."""
            p = (provider or "claude").lower()
            if p == "claude":
                return AnthropicClient(model=model, api_key=os.environ.get("ANTHROPIC_API_KEY"))
            if p == "openai":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("OPENAI_API_KEY"))
            if p in ("gemini", "google"):
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("GOOGLE_API_KEY"),
                    base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
            if p == "grok":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("XAI_API_KEY"),
                    base_url="https://api.x.ai/v1")
            if p == "kimi":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("KIMI_API_KEY"),
                    base_url="https://api.moonshot.ai/v1")
            if p == "deepseek":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("DEEPSEEK_API_KEY"),
                    base_url="https://api.deepseek.com")
            raise RuntimeError(f"Unknown provider {provider!r} for model {model!r}")
        PY;
    }
}
```

Note on heredoc indentation: PHP 7.3+ closing-marker indentation is stripped from every line, so the `        ` indent above emits column-0 Python. Verify emitted output starts each line at column 0 (Step 4 asserts imports; Task 2's py_compile is the real gate).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && php -l src/AgentTeam/Services/MAFGenerator.php && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php`
Expected: `No syntax errors` + PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/MAFGenerator.php backend/tests/Unit/MafGeneratorEmitTest.php
git commit -m "feat(maf): MAFGenerator skeleton — generate(), header, _make_client (OpenAIChatCompletionClient + base_url per provider)"
```

---

### Task 2: Core emitter — node functions, functional orchestration, storage/prompt (no skills/MCP)

Produces a fully py_compiling MAF program for a skill-free / MCP-free workflow (start → fan-out → fan-in → output).

**Files:**
- Modify: `backend/src/AgentTeam/Services/MAFGenerator.php`
- Modify: `backend/tests/Unit/MafGeneratorEmitTest.php`
- Create: `backend/tests/Unit/MafGeneratorCompileTest.php`

**Interfaces:**
- Consumes: Task 1's `emitMaf`, `headerBlock`, `clientFactoryBlock`.
- Produces: `agentsBlock`, `orchestrationBlock`, `mainBlock` private methods; emitted globals `AGENTS`, `LAYERS`, `PARENTS`, `OUTPUT_NODE_ID`, `_run_node`, `_build_input`, `main`.

- [ ] **Step 1: Write the failing emit test** (append to `MafGeneratorEmitTest.php`)

```php
    public function testAgentsAndOrchestrationEmitted(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());
        $this->assertStringContainsString('AGENTS = {', $code);
        $this->assertStringContainsString('"2": {', $code);            // agent node baked
        $this->assertStringContainsString('async def _run_node(', $code);
        $this->assertStringContainsString('Agent(client, instructions=', $code);
        $this->assertStringContainsString('.run(', $code);
        $this->assertStringContainsString('@workflow', $code);
        $this->assertStringContainsString('async def main(user_prompt', $code);
        $this->assertStringContainsString('asyncio.gather(', $code);
        $this->assertStringContainsString('OUTPUT_NODE_ID = "3"', $code);
        $this->assertStringContainsString('asyncio.run(main.run(', $code);
    }

    public function testStartPromptAndStorageBaked(): void
    {
        $a = $this->analyzed();
        $a['outputStorageEnabled'] = true; $a['outputFolder'] = null;
        $code = MAFGenerator::emitMaf($a);
        $this->assertStringContainsString('Analyze example.com', $code);      // start prompt baked
        $this->assertStringContainsString('OUTPUT_STORAGE_ENABLED = True', $code);
        $this->assertStringContainsString('WORKFLOW_ID = 7', $code);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php`
Expected: FAIL — `AGENTS = {` not found.

- [ ] **Step 3: Implement the three blocks + wire into `emitMaf`**

In `emitMaf`, replace the `// Task 2 inserts …` comment region so the sequence becomes:

```php
        $parts[] = self::headerBlock($analyzed);
        $parts[] = self::clientFactoryBlock();
        $parts[] = 'catalog = {}';
        $parts[] = PythonEmitHelpers::documentConverterBlock();
        // Task 3 inserts the skill runtime here (guarded by needsSkills).
        $parts[] = self::agentsBlock($analyzed);
        $parts[] = self::orchestrationBlock($analyzed);
        $parts[] = self::mainBlock($analyzed);
```

Add `use` nothing new (PythonEmitHelpers is same namespace). Implement:

```php
    /** Bake AGENTS metadata + the per-node runner. */
    private static function agentsBlock(array $analyzed): string
    {
        $entries = [];
        foreach ($analyzed['agents'] as $id => $ag) {
            $instr = (string) ($ag['systemPrompt'] ?? '');
            $tools = array_map(fn($t) => 'catalog.get(' . PythonEmitHelpers::pyStr($t) . ')', $ag['tools'] ?? []);
            $toolsPy = '[' . implode(', ', array_filter($tools)) . ']';
            // Skills baked for Task 3; empty list here is harmless.
            $skillsPy = PythonEmitHelpers::jsonToPython($ag['skills'] ?? []);
            $entries[] = '    ' . PythonEmitHelpers::pyStr((string) $id) . ': {'
                . '"provider": ' . PythonEmitHelpers::pyStr((string) ($ag['provider'] ?? 'claude')) . ', '
                . '"model": ' . PythonEmitHelpers::pyStr((string) ($ag['model'] ?? '')) . ', '
                . '"instructions": ' . PythonEmitHelpers::pyStr($instr) . ', '
                . '"tools": ' . $toolsPy . ', '
                . '"skills": ' . $skillsPy . '},';
        }
        $agents = "AGENTS = {\n" . implode("\n", $entries) . "\n}";

        $runner = <<<'PY'
        async def _run_node(nid, _input):
            """Run one node: the output node is a pass-through (returns its merged input);
            an agent node runs its LLM, then its mandatory skill pipeline (Task 3)."""
            ad = AGENTS.get(nid)
            if ad is None:                      # output / pass-through node
                return _input
            client = _make_client(ad["provider"], ad["model"])
            agent = Agent(client, instructions=ad["instructions"],
                          name=f"node_{nid}", tools=ad["tools"])
            text = (await agent.run(_input)).text or ""
            for _skill in ad.get("skills", []):
                text = await _run_skill_step(_skill, text, ad["provider"], ad["model"])
            return text


        def _build_input(parents, node_outputs, user_prompt):
            """Merge parent outputs (fan-in) as this node's input; the start node's
            children get the user prompt."""
            parts = []
            for p in parents:
                if p in node_outputs:
                    parts.append(str(node_outputs[p]))
            if not parts:
                return user_prompt
            if len(parts) == 1:
                return parts[0]
            return "\n\n---\n\n".join(parts)
        PY;
        return $agents . "\n\n\n" . $runner;
    }
```

`_run_node` references `_run_skill_step`; Task 3 emits it. For a skill-free workflow `skills` is `[]`, so the loop never runs and the name is never resolved — py_compile passes. (A workflow WITH skills without Task 3 would `NameError` at runtime only; Task 3 lands before any skill workflow is generated.)

```php
    /** Topological layers + fan-in wiring baked as data, driven by main(). */
    private static function orchestrationBlock(array $analyzed): string
    {
        $layers = PythonEmitHelpers::jsonToPython(array_values($analyzed['layers']));
        $parents = PythonEmitHelpers::jsonToPython($analyzed['parents'], true);
        // The single output node id (first type=output in byId), else "".
        $outId = '';
        foreach ($analyzed['byId'] as $id => $node) {
            $t = $node['type'] ?? ($node['config']['type'] ?? '');
            if ($t === 'output') { $outId = (string) $id; break; }
        }
        return "LAYERS = {$layers}\n"
             . "PARENTS = {$parents}\n"
             . 'OUTPUT_NODE_ID = ' . PythonEmitHelpers::pyStr($outId) . "\n\n\n"
             . <<<'PY'
        @workflow
        async def main(user_prompt: str = DEFAULT_PROMPT) -> str:
            node_outputs = {}
            # Layer 0 is the start node; its prompt seeds the children via _build_input.
            for layer in LAYERS[1:]:
                ids = [n for n in layer if n in AGENTS or n == OUTPUT_NODE_ID]
                if not ids:
                    continue
                inputs = [_build_input(PARENTS.get(n, []), node_outputs, user_prompt) for n in ids]
                results = await asyncio.gather(*[_run_node(n, inp) for n, inp in zip(ids, inputs)])
                for n, r in zip(ids, results):
                    node_outputs[n] = r
                    print(f"[node] {n}: {len(str(r))} chars", flush=True)
            return node_outputs.get(OUTPUT_NODE_ID, "")
        PY;
    }
```

```php
    /** DEFAULT_PROMPT + workflow/storage globals + the __main__ entry & save. */
    private static function mainBlock(array $analyzed): string
    {
        $sp       = PythonEmitHelpers::pyStr((string) $analyzed['startPrompt']);
        $wfName   = PythonEmitHelpers::pyStr((string) $analyzed['workflow']['name']);
        $wfId     = (int) $analyzed['workflow']['id'];
        $enabled  = !empty($analyzed['outputStorageEnabled']) ? 'True' : 'False';
        $folder   = $analyzed['outputFolder'] ? PythonEmitHelpers::pyStr((string) $analyzed['outputFolder']) : 'None';
        $head = "DEFAULT_PROMPT = {$sp}\n"
              . "WORKFLOW_NAME = {$wfName}\n"
              . "WORKFLOW_ID = {$wfId}\n"
              . "OUTPUT_STORAGE_ENABLED = {$enabled}\n"
              . "OUTPUT_FOLDER = {$folder}";
        $entry = <<<'PY'
        if __name__ == "__main__":
            _prompt = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else DEFAULT_PROMPT
            _result = asyncio.run(main.run(_prompt))
            _text = _result.text or ""
            print("\n=== FINAL OUTPUT ===\n" + _text)
            if OUTPUT_STORAGE_ENABLED:
                _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
                _dir = OUTPUT_FOLDER or os.path.join(_root, "workflow")
                os.makedirs(_dir, exist_ok=True)
                _low = _text.lstrip().lower()
                _ext = "html" if _low.startswith("<!doctype html") or _low.startswith("<html") else "md"
                _slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]
                _ts = time.strftime("%Y%m%d-%H%M%S")
                _path = os.path.join(_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")
                with open(_path, "w", encoding="utf-8") as _fh:
                    _fh.write(_text)
                print(f"[output] saved to {_path}")
        PY;
        return $head . "\n\n\n" . $entry;
    }
```

`main()`'s signature default is `DEFAULT_PROMPT`, defined in `mainBlock` which is emitted AFTER `orchestrationBlock`. Python resolves the default at def-execution time, and `mainBlock` runs before `__main__`, but `@workflow`/`async def main` executes when its module line is reached — `DEFAULT_PROMPT` must exist BEFORE `main` is defined. **Fix ordering:** emit `mainBlock`'s HEAD (the globals) BEFORE `orchestrationBlock`. Change `emitMaf` order to: `agentsBlock`, then a new `globalsBlock` (the `$head` above), then `orchestrationBlock`, then a new `entryBlock` (the `$entry`). Split `mainBlock` into `globalsBlock(array)` (returns `$head`) and `entryBlock()` (returns `$entry`); wire `emitMaf` as: header, client, `catalog={}`, docConverter, agents, globals, orchestration, entry.

- [ ] **Step 4: Write the compile test**

Create `backend/tests/Unit/MafGeneratorCompileTest.php` (mirror `AdkGeneratorCompileTest.php:33–47` for `python3Available`/`pyCompile`):

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\MAFGenerator;

final class MafGeneratorCompileTest extends TestCase
{
    private static function python3Available(): bool
    { exec('command -v python3 2>/dev/null', $o, $rc); return $rc === 0; }

    private static function pyCompile(string $code, string $suffix = 'test'): array
    {
        $tmp = sys_get_temp_dir() . "/maf_{$suffix}_" . getmypid() . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        return [$rc, implode("\n", $out)];
    }

    private static function diamondAnalyzed(): array
    {
        return [
            'workflow' => ['id' => 9, 'name' => 'Diamond'],
            'byId' => [
                '1' => ['id'=>'1','type'=>'start','config'=>[]],
                '2' => ['id'=>'2','type'=>'agent','config'=>[]],
                '3' => ['id'=>'3','type'=>'agent','config'=>[]],
                '4' => ['id'=>'4','type'=>'agent','config'=>[]],
                '5' => ['id'=>'5','type'=>'output','config'=>[]],
            ],
            'layers' => [['1'], ['2','3'], ['4'], ['5']],
            'parents' => ['2'=>['1'],'3'=>['1'],'4'=>['2','3'],'5'=>['4']],
            'startNodeId' => '1',
            'agents' => [
                '2'=>['name'=>'A','systemPrompt'=>'A','provider'=>'claude','model'=>'m','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
                '3'=>['name'=>'B','systemPrompt'=>'B','provider'=>'openai','model'=>'gpt-4o','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
                '4'=>['name'=>'C','systemPrompt'=>'C','provider'=>'gemini','model'=>'gemini-2.5-flash','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
            ],
            'usedCatalog'=>[], 'usedServers'=>[], 'startPrompt'=>'go', 'startDocuments'=>[],
            'outputStorageEnabled'=>true, 'outputFolder'=>null,
        ];
    }

    public function testDiamondCompiles(): void
    {
        if (!self::python3Available()) { $this->markTestSkipped('python3 not on PATH'); }
        [$rc, $out] = self::pyCompile(MAFGenerator::emitMaf(self::diamondAnalyzed()), 'diamond');
        $this->assertSame(0, $rc, "Diamond MAF failed py_compile:\n{$out}");
    }
}
```

- [ ] **Step 5: Run both test files**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php tests/Unit/MafGeneratorCompileTest.php`
Expected: PASS (all). If `py_compile` fails, read the emitted error and fix indentation/ordering.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/MAFGenerator.php backend/tests/Unit/MafGeneratorEmitTest.php backend/tests/Unit/MafGeneratorCompileTest.php
git commit -m "feat(maf): core emitter — AGENTS + _run_node + functional @workflow main (asyncio.gather layers) + storage/prompt; diamond py_compiles"
```

---

### Task 3: Skills — port the skill runtime + MAF skill step + deliverable capture

Produces mandatory skill steps: a skill's produced file becomes the node output. This is the ported ADK/LangGraph skill FS + a MAF-flavored `_run_skill_step`.

**Files:**
- Modify: `backend/src/AgentTeam/Services/MAFGenerator.php`
- Modify: `backend/tests/Unit/MafGeneratorEmitTest.php`, `MafGeneratorCompileTest.php`

**Interfaces:**
- Consumes: `_run_node`'s `for _skill in ad["skills"]: text = await _run_skill_step(...)` loop (Task 2); `AGENTS[id]["skills"]` = `[{"dir": "..."}]` / `[{"inline": "..."}]`.
- Produces: `skillRunnerBlock(): string` + `skillRunnerBlockForTest(): string`; a `needsSkills` gate in `emitMaf`; emitted Python `_run_skill_script`, `_read_skill_md`, `_make_skill_tool`, `_run_skill_step`, `_LAST_SKILL_OUTPUTS`.

- [ ] **Step 1: Write the failing tests** (append to `MafGeneratorEmitTest.php`)

```php
    public function testSkillRuntimeEmittedWhenSkillPresent(): void
    {
        $a = $this->analyzed();
        $a['agents']['2']['skills'] = [['dir' => 'html']];
        $code = MAFGenerator::emitMaf($a);
        $this->assertStringContainsString('_LAST_SKILL_OUTPUTS', $code);
        $this->assertStringContainsString('def _run_skill_script(', $code);
        $this->assertStringContainsString('SYNERGYAI_OUTPUT_DIR', $code);
        $this->assertStringContainsString('async def _run_skill_step(', $code);
        $this->assertStringContainsString('_make_skill_tool', $code);
        // baked into AGENTS
        $this->assertStringContainsString('"skills": [{"dir": "html"}]', $code);
    }

    public function testNoSkillRuntimeWhenNoSkills(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());  // no skills
        $this->assertStringNotContainsString('def _run_skill_script(', $code);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php --filter Skill`
Expected: FAIL — `_run_skill_script` not emitted.

- [ ] **Step 3: Add the `needsSkills` gate + `skillRunnerBlock`**

In `emitMaf`, after `catalog = {}` / docConverter and BEFORE `agentsBlock`, insert:

```php
        $needsSkills = false;
        foreach ($analyzed['agents'] as $ag) {
            if (!empty($ag['skills'])) { $needsSkills = true; break; }
        }
        if ($needsSkills) {
            $parts[] = PythonEmitHelpers::skillDepsBlock();   // SKILLS_DIR + _ensure_skill_deps
            $parts[] = self::skillRunnerBlock();
        }
```

Add the test seam + the block. **Port the FS helpers verbatim from `ADKGenerator::skillRunnerBlock()` (ADKGenerator.php:250–421)** — the globals (`SKILL_OUTPUTS_ROOT`, `SKILL_SCRATCH_DIR`, `_LAST_SKILL_OUTPUTS`), `_skill_output_dir`, `_remap_virtual_path`, `_run_skill_script` (with the `read_outputs` stash into `_LAST_SKILL_OUTPUTS`), and `_read_skill_md` are provider-agnostic and identical. REPLACE the three ADK-specific pieces (`_skill_instruction`, `_make_skill_tool` returning an ADK `FunctionTool`, `_SkillCaptureAgent`, and `RUN_SKILL_SCRIPT_TOOL`) with these MAF versions:

```php
    public static function skillRunnerBlockForTest(): string { return self::skillRunnerBlock(); }

    private static function skillRunnerBlock(): string
    {
        // --- PART A: copy verbatim from ADKGenerator::skillRunnerBlock() the block
        // from `SKILL_OUTPUTS_ROOT = ...` through the end of `_read_skill_md(...)`,
        // INCLUDING _run_skill_script with the `_LAST_SKILL_OUTPUTS[dir_name] = _produced`
        // stash. That code is async + provider-agnostic and needs no change. ---
        $partA = <<<'PY'
        # >>> PASTE ADKGenerator skillRunnerBlock PART A here (SKILL_OUTPUTS_ROOT ..
        #     _remap_virtual_path .. async def _run_skill_script(..) with read_outputs
        #     stash into _LAST_SKILL_OUTPUTS .. def _read_skill_md(..)). Verbatim.
        PY;

        // --- PART B: MAF-specific skill step (replaces ADK's _skill_instruction /
        // _SkillCaptureAgent). A MAF Agent whose tool is the dir-scoped run_skill_script;
        // the node output is the produced file (via _LAST_SKILL_OUTPUTS) else the LLM text. ---
        $partB = <<<'PY'
        def _make_skill_tool(dir_name: str):
            """A run_skill_script bound to ONE skill dir; the model picks only script/argv
            (+ input_files/read_outputs). Plain callable -> MAF auto-wraps it as a tool."""
            def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:
                import asyncio as _a
                return _a.get_event_loop().run_until_complete(
                    _run_skill_script(dir_name, script, argv, input_files, read_outputs)) \
                    if False else _run_skill_script_sync(dir_name, script, argv, input_files, read_outputs)
            run_skill_script.__name__ = "run_skill_script"
            return run_skill_script


        async def _run_skill_step(skill, prior, provider, model):
            """Mandatory skill step on `prior` (previous stage output). A dir-backed skill
            is a MAF Agent instructed by SKILL.md with a dir-scoped run_skill_script tool;
            the step output becomes the produced deliverable file (via _LAST_SKILL_OUTPUTS)
            when it wrote one, else the LLM text. Inline skill = an LLM transform."""
            dir_name = skill.get("dir", "")
            body = skill.get("inline") or (_read_skill_md(dir_name) if dir_name else "")
            system = (
                "You are running the '" + (dir_name or "inline") + "' skill as a MANDATORY "
                "step. Apply the skill to the INPUT. If the skill produces a document/file "
                "(e.g. HTML via a create/render script), you MUST call run_skill_script -- "
                "stage authored content via input_files and pass the output path in "
                "read_outputs; the workflow captures that produced file as this node's "
                "output. If the skill has no script, return the transformed result.\n\n"
                "=== SKILL INSTRUCTIONS ===\n" + body)
            tools = [_make_skill_tool(dir_name)] if dir_name else []
            if dir_name:
                _LAST_SKILL_OUTPUTS.pop(dir_name, None)
            agent = Agent(_make_client(provider, model), instructions=system,
                          name="skill_step", tools=tools)
            text = (await agent.run("## INPUT (apply the skill to this)\n" + str(prior))).text or ""
            produced = _LAST_SKILL_OUTPUTS.pop(dir_name, None) if dir_name else None
            return produced[-1] if produced else text
        PY;
        return $partA . "\n\n\n" . $partB;
    }
```

**Tool sync/async note:** MAF invokes a plain function tool synchronously, but `_run_skill_script` is `async` (ported from ADK, which uses `asyncio.create_subprocess_exec`). Provide a synchronous `_run_skill_script_sync` in PART A that uses `subprocess.run` (mirror LangGraph's `_run_skill_script` at `LangGraphGenerator.php` — it is already synchronous `subprocess.run` with the same FS/stash logic). **Simplest correct path: port PART A from `LangGraphGenerator`'s synchronous `_run_skill_script` (which already has bucketed dirs, remap, `input_files`, `SYNERGYAI_*` env, and the `_LAST_SKILL_OUTPUTS` stash), and have `_make_skill_tool` call it directly** — drop the ADK async version entirely. Rewrite `_make_skill_tool` to:

```python
        def _make_skill_tool(dir_name: str):
            def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:
                return _run_skill_script(dir_name, script, argv, input_files, read_outputs)
            return run_skill_script
```

So: PART A = LangGraph's synchronous skill FS (`_run_skill_script` + `_remap_virtual_path` + `_skill_output_dir` + `SKILL_OUTPUTS_ROOT`/`SCRATCH`/`_LAST_SKILL_OUTPUTS` + `_read_skill_md`), copied from `LangGraphGenerator.php`'s skill block verbatim; PART B = the MAF `_make_skill_tool` + `_run_skill_step` above.

- [ ] **Step 4: Add a skill fixture to the compile test** (append to `MafGeneratorCompileTest.php`)

```php
    public function testSkillFixtureCompiles(): void
    {
        if (!self::python3Available()) { $this->markTestSkipped('python3 not on PATH'); }
        $a = self::diamondAnalyzed();
        $a['agents']['4']['skills'] = [['dir' => 'html']];   // consolidator renders HTML
        [$rc, $out] = self::pyCompile(MAFGenerator::emitMaf($a), 'skill');
        $this->assertSame(0, $rc, "Skill MAF failed py_compile:\n{$out}");
    }
```

- [ ] **Step 5: Run tests**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php tests/Unit/MafGeneratorCompileTest.php`
Expected: PASS (all). py_compile the skill fixture must be 0.

- [ ] **Step 6: Runtime-verify the skill capture (lesson #1: don't trust py_compile alone)**

Generate a script for GEO workflow #31 and runtime-test the skill step against real MAF, mirroring the ADK/LangGraph spike. Write `/tmp/maf_skill_rt.py` that imports the generated module and asserts a produced file becomes the step output. Minimum: run `_run_skill_step({'dir':'html'}, '<h1>hi</h1> as markdown', 'openai', 'gpt-4o-mini')` with `OPENAI_API_KEY` from `.env` and assert the return starts with `<!DOCTYPE html`. Run with `~/Documents/synergyAI/python/.venv/bin/python`. Record the result in the commit message.

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/MAFGenerator.php backend/tests/Unit/MafGeneratorEmitTest.php backend/tests/Unit/MafGeneratorCompileTest.php
git commit -m "feat(maf): mandatory skill pipeline — ported skill FS (bucketed /outputs+/scratch, remap, input_files, read_outputs stash) + MAF _run_skill_step with deliverable capture; runtime-verified HTML capture"
```

---

### Task 4: MCP tools

Produces MCP-tool support: bake `MCP_SERVERS`/`TOOL_CATALOG`, the JSON-RPC client, `_tool_*` wrappers, and `catalog = build_tools_from_catalog()`; agents receive their tools as plain callables.

**Files:**
- Modify: `backend/src/AgentTeam/Services/MAFGenerator.php`
- Modify: `backend/tests/Unit/MafGeneratorEmitTest.php`, `MafGeneratorCompileTest.php`

**Interfaces:**
- Consumes: `emitMaf`'s `catalog = {}` placeholder (replace); `agentsBlock`'s `catalog.get("<tool>")`.
- Produces: `mcpToolBuilderBlock(array): string`; emitted `MCP_SERVERS`, `TOOL_CATALOG`, `_call_mcp_tool`, `_tool_*`, `build_tools_from_catalog`, `catalog = build_tools_from_catalog()`.

- [ ] **Step 1: Failing test** (append to `MafGeneratorEmitTest.php`)

```php
    public function testMcpToolsEmitted(): void
    {
        $a = $this->analyzed();
        $a['usedServers'] = ['https://mcp.example/mcp' => ['url' => 'https://mcp.example/mcp']];
        $a['usedCatalog'] = ['web_search' => [
            'server_url' => 'https://mcp.example/mcp', 'tool_name' => 'web_search',
            'input_schema' => ['type'=>'object','properties'=>['q'=>['type'=>'string']],'required'=>['q']],
        ]];
        $a['agents']['2']['tools'] = ['web_search'];
        $code = MAFGenerator::emitMaf($a);
        $this->assertStringContainsString('MCP_SERVERS = {', $code);
        $this->assertStringContainsString('def _call_mcp_tool(', $code);
        $this->assertStringContainsString('def _tool_web_search(', $code);
        $this->assertStringContainsString('catalog = build_tools_from_catalog()', $code);
        $this->assertStringNotContainsString("catalog = {}", $code);   // placeholder replaced
    }
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php --filter Mcp` — FAIL.

- [ ] **Step 3: Implement.** In `emitMaf`, replace the unconditional `$parts[] = 'catalog = {}';` with conditional MCP emission:

```php
        if (!empty($analyzed['usedCatalog'])) {
            $parts[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($analyzed['usedServers'], true);
            $parts[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($analyzed['usedCatalog'], true);
            $parts[] = PythonEmitHelpers::mcpClientBlock();
            $parts[] = self::mcpToolBuilderBlock($analyzed);
            $parts[] = 'catalog = build_tools_from_catalog()';
        } else {
            $parts[] = 'catalog = {}';
        }
```

Implement `mcpToolBuilderBlock` by **porting `ADKGenerator::adkToolBuilderBlock()` (ADKGenerator.php:787–941) with ONE change**: `build_tools_from_catalog()` must map each catalog key to the **plain function** (MAF auto-wraps callables), NOT `FunctionTool(_tool_x)`. i.e. emit `catalog["<real>"] = _tool_<sanitized>` (drop the `FunctionTool(...)` wrapper). Everything else (the `_tool_*` bodies, arg splitting, `_call_mcp_tool(server_url, tool_name, _args)`, the type map) is identical. `agentsBlock` already emits `catalog.get("web_search")`, which resolves to the callable.

- [ ] **Step 4: Compile fixture** (append to `MafGeneratorCompileTest.php`): add `testMcpFixtureCompiles` using the diamond fixture plus the `usedServers`/`usedCatalog`/`tools` from Step 1; assert `pyCompile` rc 0.

- [ ] **Step 5: Run tests.** Run: `cd backend && php vendor/bin/phpunit tests/Unit/MafGeneratorEmitTest.php tests/Unit/MafGeneratorCompileTest.php` — PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/MAFGenerator.php backend/tests/Unit/MafGeneratorEmitTest.php backend/tests/Unit/MafGeneratorCompileTest.php
git commit -m "feat(maf): MCP tools — MCP_SERVERS/TOOL_CATALOG + JSON-RPC client + _tool_* wrappers bound as plain MAF callables"
```

---

### Task 5: Route + controller

Produces the `generate-maf` HTTP endpoint returning `{filename, code}` (or a raw download).

**Files:**
- Modify: `backend/src/routes.php` (~line 308, beside `generate-adk`)
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (~line 293, beside `generateAdk`)

**Interfaces:**
- Consumes: `MAFGenerator::generate(int, string): array{filename,code}`.
- Produces: `GET /api/v1/workflows/{id}/generate-maf` → `WorkflowController::generateMaf`.

- [ ] **Step 1: Add the route.** In `backend/src/routes.php`, directly after the `generate-adk` line (308):

```php
$r->get('/api/v1/workflows/{id:\d+}/generate-maf', ['AgentTeam:WorkflowController', 'generateMaf']);
```

- [ ] **Step 2: Add the controller method.** In `WorkflowController.php`, copy `generateAdk()` (lines 293–341) to a new `generateMaf(array $request): array`, changing only the generator class: `new \AgentTeam\Services\MAFGenerator(...)` (same 4 constructor args). Keep the `download` branch and the `{success,data:{filename,code}}` shape identical.

- [ ] **Step 3: Verify wiring.** Run: `cd backend && php -l src/routes.php && php -l src/AgentTeam/Controllers/WorkflowController.php` — `No syntax errors`. Then a smoke fetch (server running): `curl -s -H "Authorization: Bearer <token>" "http://localhost/gpt/backend/public/api/v1/workflows/31/generate-maf" | head -c 200` should return JSON with `"filename":"..._maf.py"`. If no token handy, skip the curl and rely on Step 4.

- [ ] **Step 4: Generate the real GEO #31 script via the generator directly (proves generate() end-to-end) and py_compile it:**

```bash
cd backend && php -r '
require "vendor/autoload.php"; $c=(require "config/ai_config.php"); $db=$c["contexts_database"]??$c["database"];
$pdo=new PDO("mysql:host=".$db["host"].";dbname=".$db["database"].";charset=".$db["charset"],$db["username"],$db["password"],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$r=new AgentTeam\Services\WorkflowRepository($pdo);
$g=new AgentTeam\Services\MAFGenerator($pdo,$r,$r->getGraphRepository(),new AgentTeam\Services\AgentRepository($pdo));
$o=$g->generate(31,"3"); file_put_contents("/tmp/geo_maf.py",$o["code"]); echo $o["filename"],"\n";'
python3 -m py_compile /tmp/geo_maf.py && echo "py_compile OK"
```

Expected: `geo_..._maf.py` + `py_compile OK`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes.php backend/src/AgentTeam/Controllers/WorkflowController.php
git commit -m "feat(maf): GET /workflows/{id}/generate-maf route + generateMaf controller; real GEO #31 generates + py_compiles"
```

---

### Task 6: Frontend Output-node submenu

Produces a "Microsoft Agent Framework — Python" submenu mirroring the ADK one (Setup / Generate / Info / Run / Display Code), writing `<name>_maf.py` to `python/scripts/`.

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/index.html` (cache-buster bump)

**Interfaces:**
- Consumes: `GET /workflows/{id}/generate-maf` (+ `?download=1`); the same runner (`/api/run-file`, `/health`), `window.localFs`, `this._syncRunnerEnv()`.
- Produces: `_showMafMenu`, `generateMafScript`, `_runMafScript`, `_showMafCodeModal`, `_showMafSetupModal`, `_showMafInfoModal`.

- [ ] **Step 1: Add the MAF menu + methods.** Mirror the ADK methods (`workflow-editor.js`): `_showAdkMenu` (3087–3161) → `_showMafMenu`; `generateAdkScript` (2836–2894) → `generateMafScript`; `_showAdkCodeModal` (3256–3329) → `_showMafCodeModal`; `_runAdkScript` (3338–3401) → `_runMafScript`; setup/info modals. In every copy, replace `generate-adk`→`generate-maf`, `adk-`→`maf-` action names, `_adk.py`→`_maf.py` messaging, and the Setup command text with `pip install "agent-framework>=1.10,<2" httpx python-dotenv`. Wire the MAF menu button next to the existing ADK/LangGraph buttons in the Output-node menu (find where `_showAdkMenu` is invoked and add a sibling "Microsoft Agent Framework" entry).

- [ ] **Step 2: Bump the cache-buster.** In `frontend/index.html`, find `assets/js/workflow-editor.js?v=<N>` and increment `<N>` (per the repo convention — editing that JS requires the bump or the browser serves stale code).

- [ ] **Step 3: Lint.** Run: `node --check frontend/assets/js/workflow-editor.js` — no errors.

- [ ] **Step 4: Manual smoke (user, in-browser).** Open a workflow → Output node → "Microsoft Agent Framework" → Generate; confirm `synergyAI/python/scripts/<name>_maf.py` is written and Display Code shows it. (No automated test — frontend has no harness here; verify by hand.)

- [ ] **Step 5: Commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(maf): Output-node 'Microsoft Agent Framework' submenu (Setup/Generate/Info/Run/Display) writing <name>_maf.py to python/scripts"
```

---

## Self-Review

**Spec coverage:** Functional API (T2), `_make_client` with `OpenAIChatCompletionClient`+base_url (T1), keys-from-.env `load_dotenv` (T1), fan-out/fan-in via `asyncio.gather` (T2), storage/prompt parity (T2), skills mandatory + deliverable capture + full skill FS (T3), MCP (T4), route/controller (T5), frontend + output location (T6), version pin (Global Constraints + requirements already committed). No override of form values — temperature/max_tokens are intentionally NOT emitted into the client (MAF client constructors take them via per-run options, out of scope here; document as a follow-up if a workflow needs them — do NOT silently inject). All spec sections map to a task.

**Placeholder scan:** PART A of `skillRunnerBlock` is a "copy verbatim from LangGraphGenerator" instruction, not a placeholder — the source is exact (`LangGraphGenerator.php` synchronous `_run_skill_script` + FS helpers); the implementer copies that block. Every new method has full code. No TBD/TODO.

**Type consistency:** `emitMaf` block order is fixed in T2 Step 3 (header, client, [MCP|catalog={}], docConverter, [skill runtime], agents, globals, orchestration, entry). `_run_node`/`_build_input`/`_run_skill_step`/`_make_skill_tool`/`_LAST_SKILL_OUTPUTS`/`catalog`/`AGENTS`/`LAYERS`/`PARENTS`/`OUTPUT_NODE_ID`/`DEFAULT_PROMPT` names are consistent across T2–T4. `generate()`/`emitMaf()`/`skillRunnerBlockForTest()` signatures match the ADK mirror.

**Ordering caveat resolved:** `DEFAULT_PROMPT` (globals) is emitted before `orchestration` (which defines `main` with `DEFAULT_PROMPT` as its default), which is emitted before the `__main__` entry — see T2 Step 3.

Relates to: `docs/superpowers/specs/2026-07-05-maf-generator-design.md`, [[project_adk_compiler]], [[project_skill_pipeline_execution]], [[feedback_no_override_form_params]].
