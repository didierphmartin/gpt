# A2A Compile Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Code generation options" form (A2A on/off) to the LangGraph Generate menu; with A2A on, the PHP LangGraph compiler emits a folder with one self-contained A2A agent server per node under `agents/` and an `orchestrator.py` that drives the graph over the Agent2Agent protocol, with playbook gates surfaced as `input-required`.

**Architecture:** `LangGraphGenerator::generate()` is split into `analyzeForEmit()` (all facts) and two emitters: the existing single-file emitter and a new `generateA2A()` that returns a file manifest. Each agent file reuses the existing Python blocks (LLM factory, MCP client, tool builder, skills, playbook runtime, dispatcher tool) plus a new A2A server block (Agent Card, `AgentExecutor` with pause/resume legs, gate bridge, uvicorn entry). The orchestrator reuses the LangGraph state graph but runs each agent node as an A2A task through `a2a.client.create_client`, spawning and supervising the agent processes. The runner accepts `<folder>/orchestrator.py`; the editor gains the options form, multi-file write, and a file selector in the code modal.

**Tech Stack:** PHP 8 (generators, PHPUnit 10), Python 3.13 in the runner venv (`a2a-sdk` 1.1.0 with `starlette`/`uvicorn` already installed, `langgraph`, `langchain`), FastAPI runner (`langchain_runner/main.py`), vanilla JS editor (`frontend/assets/js/workflow-editor.js`), File System Access API via `window.localFs`.

**Spec:** `docs/superpowers/specs/2026-09-04-a2a-compile-mode-design.md`

## Global Constraints

- Targets: LangGraph only. ADK/MAF/NOOA menus and outputs unchanged.
- Folder layout: `python/scripts/<safeName>_a2a/orchestrator.py` and `python/scripts/<safeName>_a2a/agents/<nodeId>_<slug>.py`; no agent file for start/output nodes.
- Every emitted file: module docstring via `PythonEmitHelpers::workflowDocBlock`, banners before every block, `PythonEmitHelpers::nodeCommentBlock` before every node definition, a docstring on every function and class, inline comments on non-obvious behaviour (ports, env overrides, gate timeout, in-memory wait, self-containment).
- SDK facts (verified by spike 2026-09-04, a2a-sdk 1.1.0): server = `Starlette(routes=create_agent_card_routes(card) + create_jsonrpc_routes(handler, rpc_url="/"))`; the executor MUST `enqueue_event(new_task_from_user_message(context.message))` when `context.current_task is None` before any status update; `execute()` must RETURN when the task enters `input-required` and is called again for the follow-up message (same `task_id`); client = `await create_client(url, ClientConfig(streaming=True, httpx_client=...))`, `client.send_message(SendMessageRequest(message=Message(...)))` yields `StreamResponse` with one of `task|message|status_update|artifact_update`; data parts are `google.protobuf.Value` built with `a2a.helpers.proto_helpers.new_data_part` and read with `get_data_parts`.
- Ports: `A2A_BASE_PORT` (default 8701) + index of the agent in `ORDER`; per-agent URL override `A2A_AGENT_<nodeId>_URL`; gate timeout `A2A_GATE_TIMEOUT_S` (default 900); readiness timeout 60 s.
- Gate policy when no human answers in the orchestrator: same as the single-file script (`PLAYBOOK_GATE_MODE` = auto | deny | prompt; auto when stdin is not a TTY).
- Single-file output must not change when A2A is off (`LangGraphGeneratorPlaybookTest`, `GeneratedDocParityTest` stay green).
- Tests run with: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/<File>.php`. Known pre-existing failures to ignore: `AdkGeneratorEmitTest` (3), `AdkGeneratorCompileTest` (2), `MafGeneratorEmitTest` (5), `PythonEmitHelpersPinTest::testSkillFsSyncBlockUnchanged`.
- Runner source lives in `gpt/langchain_runner/`; the running copy is `~/Documents/synergyAI/python/`; after editing the source run `cd langchain_runner && python3 setup.py --force --skip-venv`. Python for live checks: `~/Documents/synergyAI/python/.venv/bin/python`.
- Commits: Didier commits only when he asks. The commit steps below name what belongs together; skip them unless he has asked for commits.
- Frontend edits require bumping `workflow-editor.js?v=` in `frontend/index.html`.

---

### Task 1: Split analysis from emission and add the A2A layout helper

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php:245-1187` (`generate()`)
- Test: `backend/tests/Unit/LangGraphA2AGeneratorTest.php` (new)

**Interfaces:**
- Produces: `LangGraphGenerator::generate(int $workflowId, ?string $userId = null, array $options = []): array` — `$options['a2a']` truthy selects the manifest path (Task 4).
- Produces: `private function analyzeForEmit(int $workflowId, ?string $userId): array` returning the keys `workflow, workflowId, userId, wfName, safeName, gdata, byId, order, edges, startPrompt, startDocuments, providerDefaults, serverRegistry, toolCatalog, availableById, dispatchTargets, routedBy, agentData, playbookData, usedCatalog, usedServers, missing, edgeList`.
- Produces: `public static function a2aLayout(array $facts): array` returning `['root' => '<safeName>_a2a', 'agents' => [nid => ['file' => 'agents/<nid>_<slug>.py', 'slug' => ..., 'port' => 8701+i, 'display' => ..., 'kind' => 'agent'|'dispatcher'|'playbook']]]` in `ORDER` order, agents and playbooks only.

- [ ] **Step 1: Write the failing test for the layout helper**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * LangGraph compiler, A2A mode: one self-contained A2A agent server per
 * agent/playbook node under agents/, one orchestrator.py driving them.
 */
class LangGraphA2AGeneratorTest extends TestCase
{
    public const PLAYBOOK = "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n";

    public static function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}}}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** Dispatcher-demo shape: start -> dispatcher -> {IT claims, Human resources -> playbook} -> output. */
    public static function graph(): array
    {
        $agent = fn(string $name, string $type = 'standard', array $tools = []) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => $tools, 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims', 'standard', ['mcp_get_news'])],
                ['id' => '4', 'node_type' => '', 'config' => $agent('Human resources')],
                ['id' => '5', 'node_type' => 'playbook', 'config' => ['type' => 'playbook', 'name' => 'Playbook HR',
                    'playbook' => self::PLAYBOOK, 'agent_provider' => 'deepseek', 'model' => 'deepseek-v4-flash', 'writes_enabled' => true]],
                ['id' => '6', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
                ['from' => '3', 'to' => '6'], ['from' => '4', 'to' => '5'], ['from' => '5', 'to' => '6'],
            ],
        ];
    }

    public static function generator(): LangGraphGenerator
    {
        $t = new self('x');
        $wfRepo = $t->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $t->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn(self::graph());
        $agentRepo = $t->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator(self::pdo(), $wfRepo, $graphRepo, $agentRepo);
    }

    /** Facts as analyzeForEmit() returns them (private): reached through reflection. */
    public static function facts(): array
    {
        $gen = self::generator();
        $m = new \ReflectionMethod($gen, 'analyzeForEmit');
        $m->setAccessible(true);
        return $m->invoke($gen, 44, '3');
    }

    public function testLayoutNamesOneAgentFilePerAgentOrPlaybookNode(): void
    {
        $layout = LangGraphGenerator::a2aLayout(self::facts());
        $this->assertSame('dispatcher_demo_a2a', $layout['root']);
        $this->assertSame(['2', '3', '4', '5'], array_keys($layout['agents']), 'ORDER order, no start/output');
        $this->assertSame('agents/2_techbuddy.py', $layout['agents']['2']['file']);
        $this->assertSame('agents/4_human-resources.py', $layout['agents']['4']['file']);
        $this->assertSame('agents/5_playbook-hr.py', $layout['agents']['5']['file']);
        $this->assertSame([8701, 8702, 8703, 8704], array_column($layout['agents'], 'port'));
        $this->assertSame('dispatcher', $layout['agents']['2']['kind']);
        $this->assertSame('agent', $layout['agents']['3']['kind']);
        $this->assertSame('playbook', $layout['agents']['5']['kind']);
    }

    public function testSingleFileOutputUnchangedWithoutOption(): void
    {
        $code = self::generator()->generate(44, '3')['code'];
        $this->assertStringContainsString('"""Standalone LangGraph workflow: Dispatcher demo', $code);
        $this->assertStringContainsString('PLAYBOOKS = {', $code);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php`
Expected: FAIL — `analyzeForEmit` does not exist (ReflectionException) and `a2aLayout` undefined.

- [ ] **Step 3: Extract `analyzeForEmit()` and add `a2aLayout()`**

In `LangGraphGenerator.php`, change the signature of `generate()` and cut its body at the `// ---- emit code ----` comment (line 656):

```php
    public function generate(int $workflowId, ?string $userId = null, array $options = []): array
    {
        $facts = $this->analyzeForEmit($workflowId, $userId);
        if (!empty($options['a2a'])) {
            return $this->generateA2A($facts);   // Task 4
        }
        // The emitter below was written against local variables; expose the
        // facts under their original names (EXTR_SKIP: never clobber $this).
        extract($facts, EXTR_SKIP);
        // ---- emit code ----
        $lines = [];
        ... (the existing emission code, unchanged, down to `return ['filename' => $filename, 'code' => $code];`)
    }

    /**
     * Everything the emitters need, computed once: workflow identity, graph
     * (byId/order/edges/layers), start node, provider defaults, the MCP
     * registry and per-agent tool catalog, dispatcher targets, agent and
     * playbook definitions, documentation descriptors. No Python is produced
     * here. Shared by the single-file and the A2A emitters.
     */
    private function analyzeForEmit(int $workflowId, ?string $userId): array
    {
        ... (the former body of generate() from `ini_set('serialize_precision', '-1');` down to the
             `$edgeList` loop that precedes `// ---- emit code ----`, unchanged)
        return compact('workflow', 'workflowId', 'userId', 'wfName', 'safeName', 'gdata', 'byId', 'order', 'edges',
            'startPrompt', 'startDocuments', 'providerDefaults', 'serverRegistry', 'toolCatalog', 'availableById',
            'dispatchTargets', 'routedBy', 'agentData', 'playbookData', 'usedCatalog', 'usedServers', 'missing', 'edgeList');
    }

    /** Kebab-case ASCII slug for file names (max 40 chars). */
    private static function slug(string $name): string
    {
        $s = strtolower(trim((string) preg_replace('/[^a-z0-9]+/i', '-', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name) ?: $name), '-'));
        return substr($s !== '' ? $s : 'node', 0, 40);
    }

    /**
     * File names, ports and kinds of the A2A agents, in ORDER: one per
     * agent/playbook node. Port = A2A base (8701) + index; the emitted
     * orchestrator lets the environment override both.
     */
    public static function a2aLayout(array $facts): array
    {
        $agents = [];
        $i = 0;
        foreach ($facts['order'] as $nid) {
            if (isset($facts['agentData'][$nid])) {
                $ad = $facts['agentData'][$nid];
                $kind = !empty($ad['dispatch']) ? 'dispatcher' : 'agent';
                $display = $ad['display'];
            } elseif (isset($facts['playbookData'][$nid])) {
                $kind = 'playbook';
                $display = $facts['playbookData'][$nid]['display'];
            } else {
                continue;
            }
            $agents[$nid] = ['file' => "agents/{$nid}_" . self::slug($display) . '.py', 'slug' => self::slug($display),
                'port' => 8701 + $i, 'display' => $display, 'kind' => $kind];
            $i++;
        }
        return ['root' => $facts['safeName'] . '_a2a', 'agents' => $agents];
    }
```

Note `$missing` and `$edgeList` are computed before the emit marker today; verify with `grep -n '\$missing = \[\]\|\$edgeList = \[\]' backend/src/AgentTeam/Services/LangGraphGenerator.php` that both sit above line 656 and move them into `analyzeForEmit()` with the rest. `generateA2A()` does not exist yet: add a stub that throws `new RuntimeException('A2A emitter not wired yet')` so the file lints; Task 4 replaces it.

- [ ] **Step 4: Run the new test and the two regression suites**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php tests/Unit/LangGraphGeneratorPlaybookTest.php tests/Unit/GeneratedDocParityTest.php`
Expected: OK (2 + 6 + 5 tests).

- [ ] **Step 5: Commit (when asked)**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/LangGraphA2AGeneratorTest.php
git commit -m "refactor(langgraph): split analyzeForEmit() from emission; add a2aLayout()"
```

---

### Task 2: Emit one self-contained A2A agent file per node

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (new methods `emitA2AAgentFile`, `a2aNodeLogicBlock`, `a2aAgentServerBlock`, `a2aAgentDocBlock`)
- Test: `backend/tests/Unit/LangGraphA2AGeneratorTest.php`

**Interfaces:**
- Consumes: `analyzeForEmit()` facts, `a2aLayout()` (Task 1); existing blocks `toolBuilderBlock()`, `dispatchBlock()`, `playbookRuntimeBlock()`, `datetimeInjectorBlock()`, `documentConverterBlock()` (PythonEmitHelpers), `mcpClientBlock()`, the `_make_llm` line list (lines 745-800 of the single-file emitter: extract them into `private static function llmFactoryLines(): array` in this task so both emitters share them), `PythonEmitHelpers::workflowDocBlock`, `nodeCommentBlock`, `WorkflowGraphAnalyzer::docNodes`.
- Produces: `private function emitA2AAgentFile(array $facts, array $layout, string $nid): string` — full Python source of `agents/<nid>_<slug>.py`.
- Emitted Python contract (used by Task 3): the agent serves JSON-RPC at `http://<host>:<port>/`, card at `/.well-known/agent-card.json`; a task's completed artifact named `result` has one text part (the node output) and one data part `{"route": "<child id>"|"", "notes": "...", "status": "<playbook status or 'ok'>"}`; a gate is `input-required` with a data part `{"gate": kind, "tool": name, "args": {...}}`; the follow-up message carries a data part `{"decision": ..., "comment": ..., "fields": {...}}` (decision `unavailable` = no human).

- [ ] **Step 1: Write the failing tests**

Append to `LangGraphA2AGeneratorTest`:

```php
    private function agentFile(string $nid): string
    {
        $gen = self::generator();
        $facts = self::facts();
        $m = new \ReflectionMethod($gen, 'emitA2AAgentFile');
        $m->setAccessible(true);
        return $m->invoke($gen, $facts, LangGraphGenerator::a2aLayout($facts), $nid);
    }

    private function assertCompiles(string $code, string $label): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 'a2a') . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        $this->assertSame(0, $rc, "{$label}: " . implode("\n", $out));
    }

    public function testAgentFileIsASelfContainedA2AServer(): void
    {
        $code = $this->agentFile('3');
        foreach (['"""A2A agent "IT claims" -- node 3 of workflow "Dispatcher demo"',
                  'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes',
                  'new_task_from_user_message', 'class NodeExecutor(AgentExecutor)', 'def build_agent_card',
                  'AGENT_CARD = build_agent_card(', 'Skill id:   node-3', 'def _make_llm(', 'def _call_mcp_tool(',
                  'def build_tools_from_catalog', 'async def run_node(', 'uvicorn.run(', '"--port"',
                  '# ---- node 3: IT claims (agent-template)', 'NODE = {', '"kind": "agent"',
                  '<== this agent', 'A2A SERVING', 'A2A_GATE_TIMEOUT_S'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        // Only this node's tools are baked.
        $this->assertStringContainsString('"get_news"', $code);
        $this->assertStringNotContainsString('get_pto_balance', $code);
        // No playbook runtime in a plain agent file.
        $this->assertStringNotContainsString('def build_playbook_tools', $code);
        $this->assertCompiles($code, 'agent 3');
    }

    public function testDispatcherAgentFileCarriesTheMenu(): void
    {
        $code = $this->agentFile('2');
        $this->assertStringContainsString('"kind": "dispatcher"', $code);
        $this->assertStringContainsString('"dispatch": [{"id": "3", "name": "IT claims"}, {"id": "4", "name": "Human resources"}]', $code);
        $this->assertStringContainsString('async def _run_dispatcher(', $code);
        $this->assertStringContainsString('## Routing', $code);
        $this->assertCompiles($code, 'agent 2');
    }

    public function testPlaybookAgentFileBridgesGatesToA2A(): void
    {
        $code = $this->agentFile('5');
        $this->assertStringContainsString('"kind": "playbook"', $code);
        $this->assertStringContainsString('def build_playbook_tools', $code);
        $this->assertStringContainsString('"workday__get_pto_balance"', $code);
        $this->assertStringContainsString('def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:', $code);
        $this->assertStringContainsString('_playbook_gate = _a2a_gate', $code);
        $this->assertStringContainsString('requires_input(', $code);
        $this->assertCompiles($code, 'agent 5');
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php`
Expected: FAIL — `emitA2AAgentFile` does not exist.

- [ ] **Step 3: Share the LLM factory lines**

Move the `$lines[] = 'def _make_llm(...` sequence (from the `def _make_llm` line through the final `raise RuntimeError(f"Unknown provider ...")` line of that function in the single-file emitter) into:

```php
    /** The `_make_llm(provider, model, temperature, max_tokens, thinking)` factory, one emitted line per entry. */
    private static function llmFactoryLines(): array
    {
        $lines = [];
        ... (the moved `$lines[] = '...'` statements, verbatim)
        return $lines;
    }
```

and replace them in the single-file emitter with `foreach (self::llmFactoryLines() as $l) { $lines[] = $l; }`. Run `LangGraphGeneratorPlaybookTest` to confirm nothing changed.

- [ ] **Step 4: Add the agent-file emitter**

```php
    /**
     * One self-contained A2A agent server for node $nid. Reuses the same
     * Python blocks as the single-file script (LLM factory, MCP client, tool
     * builder, skills, playbook runtime, dispatcher tool) and adds the A2A
     * server block. Self-contained on purpose: the file can be copied to
     * another host alone (see the design's "duplication" decision).
     */
    private function emitA2AAgentFile(array $facts, array $layout, string $nid): string
    {
        $entry = $layout['agents'][$nid];
        $kind = $entry['kind'];
        $isPlaybook = $kind === 'playbook';
        $def = $isPlaybook ? $facts['playbookData'][$nid] : $facts['agentData'][$nid];
        $wfName = $facts['wfName'];
        $sep = '# ' . str_repeat('=', 62);
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);

        // Tool catalog restricted to this node.
        $catalog = [];
        if (!$isPlaybook) {
            foreach ($def['tool_names'] as $tn) {
                if (isset($facts['usedCatalog'][$tn])) {
                    $catalog[$tn] = $facts['usedCatalog'][$tn];
                }
            }
        }
        $servers = [];
        foreach ($catalog as $c) {
            if (isset($facts['serverRegistry'][$c['server_url']])) $servers[$c['server_url']] = $facts['serverRegistry'][$c['server_url']];
        }
        if ($isPlaybook) {
            foreach ($def['actions'] as $a) {
                if (($a['kind'] ?? '') === 'mcp' && isset($facts['serverRegistry'][$a['server_url']])) $servers[$a['server_url']] = $facts['serverRegistry'][$a['server_url']];
            }
        }

        $L = [];
        // ---- module docstring (standard body + agent-specific sections) ----
        $L[] = '"""A2A agent ' . $j($entry['display']) . " -- node {$nid} of workflow " . $j($wfName);
        $L[] = '';
        foreach (explode("\n", $esc($this->a2aDocBody($facts, $layout, $nid))) as $dl) $L[] = $dl;
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, re, subprocess, sys, threading, time, uuid';
        $L[] = 'from typing import Annotated, Any, Literal, TypedDict';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/agents/; the runner .env is three levels up (python/.env).';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(_HERE))), ".env"))';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'import uvicorn';
        $L[] = 'from starlette.applications import Starlette';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $L[] = 'from langchain_core.tools import StructuredTool';
        $L[] = 'from langgraph.graph import END';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = 'from pydantic import BaseModel, Field, create_model';
        $L[] = 'from a2a import types as T';
        $L[] = 'from a2a.server.agent_execution import AgentExecutor, RequestContext';
        $L[] = 'from a2a.server.events import EventQueue';
        $L[] = 'from a2a.server.request_handlers import DefaultRequestHandler';
        $L[] = 'from a2a.server.tasks import InMemoryTaskStore, TaskUpdater';
        $L[] = 'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes';
        $L[] = 'from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts, get_text_parts';
        $L[] = '';
        $L[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $L[] = '';
        $L[] = $sep; $L[] = '# LLM FACTORY'; $L[] = '# Provider/model -> LangChain chat model (same rules as the single-file script).'; $L[] = $sep;
        foreach (self::llmFactoryLines() as $l) $L[] = $l;
        $L[] = '';
        $L[] = $sep; $L[] = '# MCP SERVER REGISTRY + TOOL CATALOG (this node only)'; $L[] = $sep;
        $L[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($servers, true);
        $L[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($catalog, true);
        $L[] = '';
        $L[] = $sep; $L[] = '# MCP CLIENT -- JSON-RPC 2.0 over HTTP (shared block)'; $L[] = $sep;
        $L[] = PythonEmitHelpers::mcpClientBlock();
        $L[] = $sep; $L[] = '# TOOL BUILDER + SKILL RUNTIME (shared blocks)'; $L[] = $sep;
        $L[] = self::toolBuilderBlock();
        $L[] = self::dispatchBlock();
        $L[] = self::datetimeInjectorBlock();
        if ($isPlaybook) {
            $L[] = self::playbookRuntimeBlock();
        }
        $L[] = 'NODE_DURATIONS = {}';
        $L[] = '';
        // ---- node definition ----
        $L[] = $sep; $L[] = '# NODE DEFINITION -- frozen from the workflow editor'; $L[] = $sep;
        $docNodes = $this->a2aDocNodes($facts, $layout);
        foreach ($docNodes as $dn) {
            if ($dn['id'] === $nid) { foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($dn)) as $cl) $L[] = $cl; }
        }
        $L[] = 'NODE = {';
        $L[] = '    "id": ' . $j($nid) . ',';
        $L[] = '    "kind": ' . $j($kind) . ',';
        $L[] = '    "display": ' . $j($entry['display']) . ',';
        $L[] = '    "provider": ' . $j($def['provider']) . ',';
        $L[] = '    "model": ' . $j($def['model']) . ',';
        $L[] = '    "temperature": ' . json_encode((float) $def['temperature']) . ',';
        $L[] = '    "max_tokens": ' . (int) $def['max_tokens'] . ',';
        $L[] = '    "thinking": ' . (in_array($def['thinking'] ?? null, ['on', 'off'], true) ? '"' . $def['thinking'] . '"' : 'None') . ',';
        if ($isPlaybook) {
            $L[] = '    "title": ' . $j($def['title']) . ',';
            $L[] = '    "domain": ' . $j($def['domain']) . ',';
            $L[] = '    "writes_enabled": ' . ($def['writes_enabled'] ? 'True' : 'False') . ',';
            $L[] = '    "policy": ' . PythonEmitHelpers::jsonToPython($def['policy'], true) . ',';
            $L[] = '    "approvers": ' . PythonEmitHelpers::jsonToPython($def['approvers'], true) . ',';
            $L[] = '    "requester": ' . PythonEmitHelpers::jsonToPython($def['requester'], true) . ',';
            $L[] = '    "instructions": """';
            foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $def['instructions'])) as $pl) $L[] = $pl;
            $L[] = '""",';
            $L[] = '    "actions": ' . PythonEmitHelpers::jsonToPython($def['actions'], false) . ',';
        } else {
            $L[] = '    "system_prompt": """';
            foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $def['system_prompt'])) as $pl) $L[] = $pl;
            $L[] = '""",';
            $L[] = '    "tool_names": ' . $j(array_values($def['tool_names'])) . ',';
            $L[] = '    "skills": ' . $j($def['skills'] ?? []) . ',';
            $L[] = '    "dispatch": [' . implode(', ', array_map(fn($t) => '{"id": ' . $j((string) $t['id']) . ', "name": ' . $j($t['name']) . '}', $def['dispatch'] ?? [])) . '],';
        }
        $L[] = '}';
        $L[] = '';
        $L[] = self::a2aNodeLogicBlock();
        $L[] = self::a2aAgentServerBlock();
        return implode("\n", $L) . "\n";
    }

    /** docNodes descriptors for the A2A layout: every node, with the agent file recorded under 'file'. */
    private function a2aDocNodes(array $facts, array $layout): array
    {
        $docAgents = []; $docExtra = [];
        foreach ($facts['agentData'] as $n => $ad) {
            $docAgents[$n] = ['name' => $ad['display'], 'provider' => $ad['provider'], 'model' => $ad['model'], 'temperature' => $ad['temperature'],
                'max_tokens' => $ad['max_tokens'], 'thinking' => $ad['thinking'], 'tools' => $ad['tool_names'], 'skills' => $ad['skills']];
            if (!empty($ad['dispatch'])) $docExtra[$n]['dispatch'] = array_column($ad['dispatch'], 'name');
        }
        foreach ($facts['playbookData'] as $n => $pd) {
            $mcp = count(array_filter($pd['actions'], fn($a) => ($a['kind'] ?? '') === 'mcp'));
            $docExtra[$n]['playbook'] = ['title' => $pd['title'], 'writes' => $pd['writes_enabled'], 'bound' => $mcp, 'unbound' => count($pd['actions']) - $mcp];
            $docAgents[$n] = ['name' => $pd['display'], 'provider' => $pd['provider'], 'model' => $pd['model'], 'temperature' => $pd['temperature'],
                'max_tokens' => $pd['max_tokens'], 'thinking' => $pd['thinking'], 'tools' => [], 'skills' => []];
        }
        $nodes = \AgentTeam\Services\WorkflowGraphAnalyzer::docNodes($facts['byId'], $facts['order'], $facts['edges'], $docAgents, $docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'output']);
        foreach ($nodes as &$n) { $n['file'] = $layout['agents'][$n['id']]['file'] ?? ''; }
        return $nodes;
    }

    /** Module-docstring body of an agent file: standard sections + NODE + A2A SERVING + TO RUN. */
    private function a2aDocBody(array $facts, array $layout, string $nid): string
    {
        $nodes = $this->a2aDocNodes($facts, $layout);
        foreach ($nodes as &$n) { if ($n['id'] === $nid) $n['name'] .= '   <== this agent'; }
        $entry = $layout['agents'][$nid];
        $body = PythonEmitHelpers::workflowDocBlock([
            'target' => 'LangGraph A2A agent (Python) -- one A2A server for this node; the orchestrator drives the graph',
            'dispatch_supported' => true,
            'workflow' => ['id' => $facts['workflowId'], 'name' => $facts['wfName']],
            'nodes' => $nodes, 'edges' => $facts['edgeList'], 'layers' => $facts['gdata']['layers'] ?? [],
            'data_flow' => self::a2aAgentDataFlowDoc(),
            'run' => ['deps' => ['pip install "a2a-sdk[http-server]>=1.1,<2" langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv uvicorn'],
                      'usage' => 'python ' . $entry['file'] . ' --port ' . $entry['port'] . '   # from the workflow folder; A2A_HOST/A2A_PORT also honoured',
                      'extra' => ['# Card: http://127.0.0.1:' . $entry['port'] . '/.well-known/agent-card.json  --  JSON-RPC at /']],
            'storage' => ['enabled' => false, 'folder' => null],
        ]);
        return $body . "\n\nA2A SERVING\n===========\n"
            . "  Skill id:   node-{$nid}\n"
            . "  Task in:    one text part = the node input the orchestrator built (original prompt + parent outputs)\n"
            . "  Task out:   artifact 'result' = text part (node output) + data part {route, notes, status}\n"
            . "  Gates:      the task moves to input-required with data {gate, tool, args}; the orchestrator answers on\n"
            . "              the same task with data {decision, comment, fields}; the run resumes in memory\n"
            . "              (A2A_GATE_TIMEOUT_S, default 900 s, then the gate fails and the playbook continues).\n"
            . "  One task at a time: runs are serialised with a lock; a second task waits for the first.";
    }

    /** DATA FLOW text for agent files. */
    private static function a2aAgentDataFlowDoc(): string
    {
        return <<<'TXT'
This file serves ONE node of the workflow as an A2A agent. The orchestrator
(orchestrator.py in the parent folder) builds the node input, sends it as a
task, streams the status updates, answers gates, and reads the result
artifact. Inside this process the node runs exactly as in the single-file
script: an AGENT node = LangChain ReAct loop over its MCP tools plus
mandatory skill steps; a DISPATCHER node = one forced route_to call whose
choice travels back as the artifact's "route"; a PLAYBOOK node = the playbook
runtime (native verbs, gates, write-policed MCP actions), whose transcript is
the text part of the result.
TXT;
    }
```

- [ ] **Step 5: Add the node-logic block**

```php
    /** run_node(): the node body, shared by the three kinds; called by the executor. */
    private static function a2aNodeLogicBlock(): string
    {
        return <<<'PY'
# ==============================================================
# NODE LOGIC
# run_node() executes this node once for one request text and returns
# {"text", "route", "notes", "status"}. It is the single-file script's
# node function with the LangGraph state replaced by plain arguments.
# ==============================================================
PLAYBOOK_MAX_ROUNDS = 40


def _llm():
    """The chat model for this node, built from NODE (provider/model/sampling/thinking)."""
    return _make_llm(NODE["provider"], NODE["model"], float(NODE["temperature"]), int(NODE["max_tokens"]), thinking=NODE.get("thinking"))


async def run_node(request_text: str, trace) -> dict:
    """Run the node on `request_text` (the orchestrator's framed input).

    trace(line) is an async callback that reports progress to the A2A client.
    Returns {"text": str, "route": str|"" , "notes": str, "status": str}.
    Exceptions propagate to the executor, which fails the task.
    """
    kind = NODE["kind"]
    if kind == "playbook":
        return await _run_playbook_kind(request_text, trace)
    catalog = build_tools_from_catalog()
    tools = [catalog[t] for t in NODE["tool_names"] if t in catalog]
    msgs = [SystemMessage(content=inject_datetime(NODE["system_prompt"])), HumanMessage(content=request_text)]
    await trace(f"{NODE['display']!r} -- {len(tools)} tools (provider={NODE['provider']}, model={NODE['model']})")
    if kind == "dispatcher":
        return await _run_dispatcher_kind(request_text, msgs)
    agent = create_react_agent(_llm(), tools)
    result = await agent.ainvoke({"messages": msgs})
    final = result["messages"][-1]
    text = final.content if isinstance(final, AIMessage) else str(final)
    if isinstance(text, list):
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    for skill in NODE.get("skills", []):
        text = await _run_skill_step(skill, text, _llm())
        await trace(f"after skill {skill.get('dir') or 'inline'!r}: {len(text)} chars")
    return {"text": text, "route": "", "notes": "", "status": "ok"}


async def _run_dispatcher_kind(request_text: str, msgs) -> dict:
    """Dispatcher: one forced route_to call; the chosen child id travels back as "route"."""
    ad = {"display": NODE["display"], "dispatch": NODE["dispatch"]}
    state = {"node_outputs": {}, "user_prompt": request_text}
    out = await _run_dispatcher("self", ad, state, msgs, _llm())
    route = out.get("routes", {}).get("self", "")
    text = out["node_outputs"]["self"]["text"]
    notes = text.split("## Dispatcher notes\n", 1)[1] if "## Dispatcher notes\n" in text else ""
    return {"text": text, "route": "" if route == END else str(route), "notes": notes, "status": "ok" if route != END else "unrouted"}


async def _run_playbook_kind(request_text: str, trace) -> dict:
    """Playbook: the playbook runtime; gates go through _a2a_gate (see the A2A block)."""
    run = _PlaybookRun(bool(NODE.get("writes_enabled")), NODE.get("policy") or {})
    tools = build_playbook_tools(NODE, run)
    await trace(f"{NODE['display']!r} playbook -- {len(tools)} tools (writes={'on' if run.writes_enabled else 'off'})")
    system = PLAYBOOK_SYSTEM_PROMPT.format(
        domain=NODE.get("domain") or "this organization", instructions=NODE["instructions"],
        policy_json=json.dumps(run.policy, ensure_ascii=False),
        requester_json=json.dumps(NODE.get("requester") or {}, ensure_ascii=False),
        approvers_json=json.dumps(NODE["approvers"], ensure_ascii=False) if NODE.get("approvers") else "{}")
    msgs = [SystemMessage(content=inject_datetime(system)), HumanMessage(content="REQUEST:\n" + request_text)]
    agent = create_react_agent(_llm(), tools)
    text = ""
    try:
        result = await agent.ainvoke({"messages": msgs}, config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})
        final = result["messages"][-1]
        text = final.content if isinstance(final, AIMessage) else str(final)
        if isinstance(text, list):
            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    except Exception as e:
        run.status = "failed"
        run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")
    transcript = render_playbook_transcript(NODE["title"], run.events, text, run.status)
    return {"text": transcript, "route": "", "notes": "", "status": run.status}


PY;
    }
```

Note: `_run_dispatcher(n, ad, state, msgs, llm)` (dispatchBlock) reads `parents(n)`; in the agent file define, right after `NODE_DURATIONS = {}`, `def parents(_n): return []` so the dispatcher falls back to `state["user_prompt"]`, which is the framed request text. Add that line in Step 4 after `NODE_DURATIONS = {}`.

- [ ] **Step 6: Add the A2A server block**

```php
    /** Agent Card, executor with pause/resume legs, gate bridge, CLI entry. */
    private static function a2aAgentServerBlock(): string
    {
        return <<<'PY'
# ==============================================================
# A2A SERVING
# Agent Card, the AgentExecutor (one task = one node run, paused at
# gates), the gate bridge used by the playbook runtime, and the uvicorn
# entry point. Verified against a2a-sdk 1.1.0.
# ==============================================================
A2A_GATE_TIMEOUT_S = int(os.environ.get("A2A_GATE_TIMEOUT_S", "900"))   # how long a gate waits for the orchestrator's answer


def build_agent_card(url: str) -> "T.AgentCard":
    """The Agent Card served at /.well-known/agent-card.json: what this node is and how to talk to it.

    The card advertises ONE skill (this node's role); tools, prompts and credentials stay private.
    """
    desc = (NODE.get("system_prompt") or NODE.get("instructions") or "").strip().replace("\n", " ")
    return T.AgentCard(
        name=NODE["display"],
        description=(desc[:300] + ("…" if len(desc) > 300 else "")) or f"Workflow node {NODE['id']}",
        version=WORKFLOW_VERSION,
        supported_interfaces=[T.AgentInterface(url=url, protocol_binding="JSONRPC", protocol_version="1.0")],
        capabilities=T.AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"], default_output_modes=["text/plain"],
        skills=[T.AgentSkill(id=f"node-{NODE['id']}", name=NODE["display"],
                             description=f"{NODE['kind']} node of workflow {WORKFLOW_NAME!r}",
                             tags=[NODE["kind"], NODE["provider"]])],
    )


class _NodeRun:
    """One node run that may pause at gates.

    `updater` is swapped on every A2A leg (first request, then each follow-up)
    so events go to the queue of the request currently being served -- the
    SDK closes a request's queue as soon as execute() returns.
    """
    def __init__(self, updater: TaskUpdater):
        self.updater = updater
        self.answer: asyncio.Future | None = None   # pending gate answer
        self.paused = asyncio.Event()                # set when the run enters input-required
        self.task: asyncio.Task | None = None
        self.loop = asyncio.get_event_loop()

    async def gate(self, kind: str, name: str, args: dict) -> dict:
        """Raise a gate: publish input-required, wait for the answer, resume. Returns the single-file gate result shape."""
        self.answer = self.loop.create_future()
        question = args.get("question") or args.get("prompt") or args.get("reason") or name
        print(f"[gate] {kind}: {question}", flush=True)
        await self.updater.requires_input(self.updater.new_agent_message(
            [T.Part(text=str(question)), new_data_part({"gate": kind, "tool": name, "args": args})]))
        self.paused.set()
        try:
            ans = await asyncio.wait_for(self.answer, A2A_GATE_TIMEOUT_S)
        except asyncio.TimeoutError:
            self.answer = None
            return {"ok": False, "timeout": True,
                    "guidance": "No answer arrived in time. Leave an internal note and resolve as uncompleted."}
        self.answer = None
        await self.updater.start_work()
        decision = str(ans.get("decision") or "answered")
        if decision == "unavailable":
            return {"ok": False, "timeout": True,
                    "guidance": "No human is available for this run. Continue with what you already know and note the gap with leave_internal_note."}
        d = {"decision": decision, "comment": str(ans.get("comment") or ""), "actor": str(ans.get("actor") or "a2a-client")}
        if isinstance(ans.get("fields"), dict):
            d["fields"] = ans["fields"]
        return {"ok": True, "decision": d}


_ACTIVE: _NodeRun | None = None      # the run currently executing (one at a time, see _RUN_LOCK)
_RUNS: dict[str, _NodeRun] = {}      # task id -> paused/active run
_RUN_LOCK = asyncio.Lock()           # serialises node runs: the gate bridge relies on a single active run


def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:
    """Gate bridge for the playbook runtime (called from a tool, i.e. a worker thread):
    forwards to the active run's async gate and blocks the thread until the answer arrives."""
    active = _ACTIVE
    if active is None:
        return {"ok": False, "timeout": True, "guidance": "No A2A task is active for this gate."}
    fut = asyncio.run_coroutine_threadsafe(active.gate(kind, name, args), active.loop)
    return fut.result(timeout=A2A_GATE_TIMEOUT_S + 5)


if NODE["kind"] == "playbook":
    _playbook_gate = _a2a_gate   # the playbook runtime calls _playbook_gate(run, kind, name, args)


class NodeExecutor(AgentExecutor):
    """A2A executor: a new task starts a node run; a follow-up message answers its gate."""

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        global _ACTIVE
        tid, cid = context.task_id, context.context_id
        run = _RUNS.get(tid)
        if run is not None and run.answer is not None and not run.answer.done():
            # Resume leg: point the run at this request's queue and hand over the answer.
            run.updater = TaskUpdater(event_queue, tid, cid)
            run.paused.clear()
            data = get_data_parts(context.message.parts)
            answer = dict(data[0]) if data and isinstance(data[0], dict) else {"decision": context.get_user_input() or "answered"}
            run.answer.set_result(answer)
        else:
            if context.current_task is None:
                # SDK 1.x: the executor enqueues the initial Task itself (submitted, history = the user message).
                await event_queue.enqueue_event(new_task_from_user_message(context.message))
            run = _NodeRun(TaskUpdater(event_queue, tid, cid))
            _RUNS[tid] = run
            await run.updater.start_work()
            request_text = context.get_user_input()
            run.task = asyncio.create_task(self._serve(run, request_text))
        # Return when the run pauses at a gate or finishes; the SDK closes this request's queue after that.
        pause = asyncio.create_task(run.paused.wait())
        done, _ = await asyncio.wait({run.task, pause}, return_when=asyncio.FIRST_COMPLETED)
        pause.cancel()
        if run.task in done:
            _RUNS.pop(tid, None)
            run.task.result()   # re-raise a failure so the SDK marks the task failed

    async def _serve(self, run: _NodeRun, request_text: str) -> None:
        """Run the node under the lock, publish progress, deliver the result artifact."""
        global _ACTIVE
        async with _RUN_LOCK:
            _ACTIVE = run
            t0 = time.monotonic()
            try:
                async def trace(line: str):
                    print(f"[node] {line}", flush=True)
                    await run.updater.update_status(T.TaskState.TASK_STATE_WORKING, run.updater.new_agent_message([T.Part(text=line)]))
                out = await run_node(request_text, trace)
                await run.updater.add_artifact(
                    [T.Part(text=out["text"]), new_data_part({"route": out["route"], "notes": out["notes"], "status": out["status"]})],
                    name="result")
                await run.updater.complete()
                print(f"[node] done -- {len(out['text'])} chars, status={out['status']} ({time.monotonic() - t0:.1f}s)", flush=True)
            except Exception as e:
                print(f"[node] FAILED: {e}", flush=True)
                await run.updater.failed(run.updater.new_agent_message([T.Part(text=f"node failed: {e}")]))
                raise
            finally:
                _ACTIVE = None

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Cancel the run behind a task (the SDK marks the task canceled)."""
        run = _RUNS.pop(context.task_id, None)
        if run and run.task:
            run.task.cancel()


def main() -> None:
    """CLI entry: `python <this file> --host 127.0.0.1 --port 8701` (env A2A_HOST / A2A_PORT are the defaults)."""
    ap = argparse.ArgumentParser(description=f"A2A agent server for workflow node {NODE['id']} ({NODE['display']})")
    ap.add_argument("--host", default=os.environ.get("A2A_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("A2A_PORT", "8700")))
    a = ap.parse_args()
    url = f"http://{a.host}:{a.port}/"
    card = build_agent_card(url)
    handler = DefaultRequestHandler(agent_executor=NodeExecutor(), task_store=InMemoryTaskStore(), agent_card=card)
    app = Starlette(routes=create_agent_card_routes(card) + create_jsonrpc_routes(handler, rpc_url="/"))
    print(f"[agent {NODE['display']}] serving {url}", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
PY;
    }
```

The server block above ends with `main()`; it must NOT contain the `if __name__` guard. Remove those two lines from the nowdoc and instead, in `emitA2AAgentFile()`, emit after `self::a2aAgentServerBlock()`:

```php
        $L[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($wfName);
        $L[] = 'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr($facts['workflowId'] . '-' . date('Ymd'));
        $L[] = '# Default card (port from A2A_PORT or the layout); main() rebuilds it for the real host/port.';
        $L[] = 'AGENT_CARD = build_agent_card(f"http://127.0.0.1:{os.environ.get(\'A2A_PORT\', \'' . $entry['port'] . '\')}/")';
        $L[] = '';
        $L[] = 'if __name__ == "__main__":';
        $L[] = '    main()';
```

`build_agent_card()` reads `WORKFLOW_NAME`/`WORKFLOW_VERSION` at call time, so defining them after the function and before the call is correct.

- [ ] **Step 7: Run the tests**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php tests/Unit/LangGraphGeneratorPlaybookTest.php`
Expected: OK. If py_compile fails, print the file (`$this->fail($code)` temporarily) and fix the emitted Python.

- [ ] **Step 8: Commit (when asked)**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/LangGraphA2AGeneratorTest.php
git commit -m "feat(langgraph): emit self-contained A2A agent server per node"
```

---

### Task 3: Emit the orchestrator

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (new `emitA2AOrchestrator`, `a2aOrchestratorBlock`, `a2aOrchestratorDataFlowDoc`)
- Test: `backend/tests/Unit/LangGraphA2AGeneratorTest.php`

**Interfaces:**
- Consumes: facts + layout (Task 1), the agent contract (Task 2), existing blocks `stateBlock()`, `contextBuilderBlock()`, `parentsChildrenBlock()`, `datetimeInjectorBlock()`, `PythonEmitHelpers::documentConverterBlock()`.
- Produces: `private function emitA2AOrchestrator(array $facts, array $layout): string`.

- [ ] **Step 1: Write the failing tests**

```php
    private function orchestrator(): string
    {
        $gen = self::generator();
        $facts = self::facts();
        $m = new \ReflectionMethod($gen, 'emitA2AOrchestrator');
        $m->setAccessible(true);
        return $m->invoke($gen, $facts, LangGraphGenerator::a2aLayout($facts));
    }

    public function testOrchestratorDrivesAgentsOverA2A(): void
    {
        $code = $this->orchestrator();
        foreach (['"""A2A orchestrator for workflow "Dispatcher demo"', 'AGENT ENDPOINTS', 'A2A RUN',
                  'from a2a.client import create_client, ClientConfig', 'class AgentSupervisor', 'async def _run_remote_node(',
                  'def _handle_gate(', 'add_conditional_edges', 'A2A_AGENT_2_URL', '"file": "agents/2_techbuddy.py"',
                  '"port": 8701', '--keep-serving', '--no-spawn', 'TASK_STATE_INPUT_REQUIRED', '[gate] ', '[gate-answer] ',
                  '# ---- node 2: techBuddy (agent-template)', 'elif ntype in ("agent", "playbook"):', 'PLAYBOOK_GATE_MODE'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        $this->assertStringNotContainsString('def build_playbook_tools', $code, 'the orchestrator runs no node logic itself');
        $this->assertCompiles($code, 'orchestrator');
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php --filter testOrchestratorDrivesAgentsOverA2A tests/Unit/LangGraphA2AGeneratorTest.php`
Expected: FAIL — method missing.

- [ ] **Step 3: Add the orchestrator emitter**

```php
    /** orchestrator.py: the graph, the agent endpoint table, the supervisor and the A2A node runner. */
    private function emitA2AOrchestrator(array $facts, array $layout): string
    {
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $sep = '# ' . str_repeat('=', 62);
        $nodes = $this->a2aDocNodes($facts, $layout);
        $docById = [];
        foreach ($nodes as $dn) $docById[$dn['id']] = $dn;
        $endpoints = [];
        foreach ($layout['agents'] as $nid => $e) {
            $endpoints[] = sprintf('  %-6s %-24s %-32s http://127.0.0.1:%d/   (env A2A_AGENT_%s_URL)', $nid, $e['display'], $e['file'], $e['port'], $nid);
        }
        $body = PythonEmitHelpers::workflowDocBlock([
            'target' => 'LangGraph A2A orchestrator (Python) -- StateGraph over A2A tasks, one agent process per node',
            'dispatch_supported' => true,
            'workflow' => ['id' => $facts['workflowId'], 'name' => $facts['wfName']],
            'nodes' => $nodes, 'edges' => $facts['edgeList'], 'layers' => $facts['gdata']['layers'] ?? [],
            'data_flow' => self::a2aOrchestratorDataFlowDoc(),
            'run' => ['deps' => ['pip install "a2a-sdk[http-server]>=1.1,<2" langgraph langchain-core httpx python-dotenv'],
                      'usage' => 'python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]',
                      'extra' => ['# A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.']],
            'storage' => ['enabled' => $facts['workflow']->isOutputStorageEnabled(), 'folder' => $facts['workflow']->getOutputFolder()],
        ]);
        $body .= "\n\nAGENT ENDPOINTS  (id, name, file, default URL; env override)\n===============\n" . implode("\n", $endpoints)
            . "\n\nA2A RUN\n=======\n"
            . "  1. AgentSupervisor starts every local agent (python <file> --port N) and waits for its card.\n"
            . "  2. Each agent node = one A2A task: the framed input goes in as text, status updates are\n"
            . "     relayed as [<agent>] lines, an input-required status is a GATE (answered on the console,\n"
            . "     or by PLAYBOOK_GATE_MODE when no terminal), the 'result' artifact is the node output\n"
            . "     (+ data {route, notes, status}; a dispatcher's route drives the conditional edge).\n"
            . "  3. Start and Output run locally; the Output merges parent outputs verbatim.\n"
            . "  4. Agents are stopped at the end unless --keep-serving; --no-spawn expects them reachable.";

        $L = [];
        $L[] = '"""A2A orchestrator for workflow ' . $j($facts['wfName']);
        $L[] = '';
        foreach (explode("\n", $esc($body)) as $dl) $L[] = $dl;
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, re, subprocess, sys, threading, time, uuid';
        $L[] = 'from typing import Annotated, Any, TypedDict';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/; the runner .env is two levels up (python/.env).';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'from langgraph.graph import END, START, StateGraph';
        $L[] = 'from a2a import types as T';
        $L[] = 'from a2a.client import create_client, ClientConfig';
        $L[] = 'from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts';
        $L[] = '';
        $L[] = 'WORKFLOW_ID = ' . (int) $facts['workflowId'];
        $L[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($facts['wfName']);
        $L[] = 'OUTPUT_STORAGE_ENABLED = ' . ($facts['workflow']->isOutputStorageEnabled() ? 'True' : 'False');
        $L[] = 'OUTPUT_FOLDER = ' . (($facts['workflow']->getOutputFolder() ?? '') !== '' ? PythonEmitHelpers::pyStr((string) $facts['workflow']->getOutputFolder()) : 'None');
        $L[] = 'DEFAULT_PROMPT = ' . PythonEmitHelpers::pyStr($facts['startPrompt']);
        $L[] = 'START_DOCUMENTS = ' . PythonEmitHelpers::jsonToPython($facts['startDocuments'] ?: []);
        $L[] = 'A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "8701"))   # agent i listens on A2A_BASE_PORT + i';
        $L[] = '';
        $L[] = $sep; $L[] = '# AGENTS -- the endpoint table (one A2A server per agent/playbook node)'; $L[] = $sep;
        $L[] = 'AGENTS = {';
        $i = 0;
        foreach ($layout['agents'] as $nid => $e) {
            foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) $L[] = $cl;
            $dispatch = $e['kind'] === 'dispatcher' ? array_map(fn($t) => ['id' => (string) $t['id'], 'name' => $t['name']], $facts['agentData'][$nid]['dispatch']) : [];
            $L[] = '    ' . $j($nid) . ': {"display": ' . $j($e['display']) . ', "file": ' . $j($e['file']) . ', "kind": ' . $j($e['kind'])
                . ', "port": ' . $e['port'] . ', "index": ' . $i . ', "dispatch": ' . $j($dispatch) . '},';
            $i++;
        }
        $L[] = '}';
        $L[] = '';
        $L[] = $sep; $L[] = '# GRAPH STRUCTURE (same shape as the single-file script)'; $L[] = $sep;
        $L[] = 'EDGES = ' . PythonEmitHelpers::jsonToPython($facts['edgeList']);
        $L[] = 'ORDER = ' . PythonEmitHelpers::jsonToPython($facts['order']);
        $typeMap = [];
        foreach ($facts['order'] as $nid) $typeMap[$nid] = isset($layout['agents'][$nid]) ? ($layout['agents'][$nid]['kind'] === 'playbook' ? 'playbook' : 'agent') : self::nodeType($facts['byId'][$nid]);
        $L[] = 'NODE_TYPES = ' . PythonEmitHelpers::jsonToPython($typeMap, true);
        $L[] = '';
        $L[] = self::parentsChildrenBlock();
        $L[] = self::stateBlock();
        $L[] = self::datetimeInjectorBlock();
        $L[] = self::contextBuilderBlock();
        $L[] = PythonEmitHelpers::documentConverterBlock();
        $L[] = self::a2aOrchestratorBlock();
        return implode("\n", $L) . "\n";
    }

    /** DATA FLOW text for the orchestrator. */
    private static function a2aOrchestratorDataFlowDoc(): string
    {
        return <<<'TXT'
The orchestrator owns the graph and the human; the agents own the models,
tools and playbooks. Every agent node is one A2A task on that node's
server: the orchestrator sends the framed input (original prompt + labelled
parent outputs), relays status updates, answers gates, and takes the
'result' artifact as the node output. A dispatcher's chosen child comes back
in the artifact's data part and drives a LangGraph conditional edge, so only
that child runs. Start and Output nodes are local (no LLM).
TXT;
    }
```

- [ ] **Step 4: Add the orchestrator runtime block**

```php
    /** Supervisor, remote node runner, gate handler, graph wiring, CLI entry. */
    private static function a2aOrchestratorBlock(): string
    {
        return <<<'PY'
# ==============================================================
# AGENT SUPERVISOR
# Starts one python process per local agent, relays its stdout with a
# [<agent>] prefix, waits for the Agent Card, stops them at the end.
# ==============================================================
def agent_url(nid: str) -> str:
    """The agent's base URL: env A2A_AGENT_<id>_URL wins, else local port A2A_BASE_PORT + index."""
    env = os.environ.get(f"A2A_AGENT_{nid}_URL", "").strip()
    return env if env else f"http://127.0.0.1:{A2A_BASE_PORT + AGENTS[nid]['index']}/"


def _is_local(url: str) -> bool:
    return url.startswith("http://127.0.0.1") or url.startswith("http://localhost")


class AgentSupervisor:
    """Owns the agent subprocesses for one run."""
    def __init__(self, spawn: bool = True):
        self.spawn = spawn
        self.procs: dict[str, subprocess.Popen] = {}

    def start(self) -> None:
        """Spawn every local agent whose URL is ours to serve, then wait for all cards (60 s)."""
        for nid, ad in AGENTS.items():
            url = agent_url(nid)
            if not (self.spawn and _is_local(url)):
                continue
            port = int(url.rsplit(":", 1)[1].strip("/"))
            path = os.path.join(_HERE, ad["file"])
            proc = subprocess.Popen([sys.executable, "-u", path, "--port", str(port)], cwd=_HERE,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.procs[nid] = proc
            threading.Thread(target=self._relay, args=(ad["display"], proc), daemon=True).start()
        deadline = time.monotonic() + 60
        for nid in AGENTS:
            url = agent_url(nid)
            while True:
                try:
                    if httpx.get(url.rstrip("/") + "/.well-known/agent-card.json", timeout=2).status_code == 200:
                        break
                except Exception:
                    pass
                proc = self.procs.get(nid)
                if proc is not None and proc.poll() is not None:
                    raise RuntimeError(f"agent {AGENTS[nid]['display']!r} exited with code {proc.returncode} before serving {url}")
                if time.monotonic() > deadline:
                    raise RuntimeError(f"agent {AGENTS[nid]['display']!r} did not serve its card at {url} within 60s")
                time.sleep(0.3)
            print(f"[supervisor] {AGENTS[nid]['display']!r} ready at {url}", flush=True)

    @staticmethod
    def _relay(name: str, proc: subprocess.Popen) -> None:
        """Copy an agent's stdout to ours, line by line, prefixed with its name."""
        for line in proc.stdout:
            print(f"[{name}] {line.rstrip()}", flush=True)

    def stop(self) -> None:
        """Terminate the agents we started (5 s grace, then kill)."""
        for nid, proc in self.procs.items():
            if proc.poll() is None:
                proc.terminate()
        for nid, proc in self.procs.items():
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self.procs:
            print("[supervisor] agents stopped", flush=True)


# ==============================================================
# GATE HANDLER
# An agent's input-required status reaches the human here. Terminal:
# ask on the console. Otherwise PLAYBOOK_GATE_MODE: auto (default) approves
# approvals and acknowledges handoffs, forms/await are 'unavailable';
# deny denies; prompt forces the console. Every gate and answer is also
# printed as a JSON line so the app can render them.
# ==============================================================
def _handle_gate(agent_name: str, task_id: str, gate: dict) -> dict:
    """Return the answer data part for one gate: {decision, comment, fields?}."""
    kind = str(gate.get("gate") or "gate")
    args = gate.get("args") or {}
    question = args.get("question") or args.get("prompt") or args.get("reason") or kind
    print("[gate] " + json.dumps({"agent": agent_name, "task": task_id, "kind": kind, "question": question, "args": args}, ensure_ascii=False), flush=True)
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or ("prompt" if sys.stdin.isatty() else "auto")
    if mode == "prompt":
        print(f"\n✋ [{agent_name}] {kind}: {question}", flush=True)
        if kind == "approval":
            ans = input("approve/deny [comment]: ").strip()
            answer = {"decision": "denied" if ans.lower().startswith("d") else "approved",
                      "comment": ans.split(" ", 1)[1] if " " in ans else "", "actor": "console"}
        elif kind == "form":
            fields = {}
            for f in args.get("fields") or []:
                if isinstance(f, dict) and f.get("name"):
                    fields[f["name"]] = input(f"  {f.get('label') or f['name']}: ").strip()
            answer = {"decision": "submitted", "fields": fields, "actor": "console"}
        else:
            answer = {"decision": "answered", "comment": input("your answer: ").strip(), "actor": "console"}
    elif mode == "deny":
        answer = {"decision": "denied", "comment": "denied by PLAYBOOK_GATE_MODE=deny", "actor": "policy"}
    elif kind == "approval":
        answer = {"decision": "approved", "comment": "auto-approved (non-interactive run)", "actor": "policy"}
    elif kind == "handoff":
        answer = {"decision": "acknowledged", "comment": "handed off; no human available in this non-interactive run", "actor": "policy"}
    else:
        answer = {"decision": "unavailable", "comment": "no human available in this non-interactive run", "actor": "policy"}
    print("[gate-answer] " + json.dumps({"agent": agent_name, "task": task_id, **answer}, ensure_ascii=False), flush=True)
    return answer


# ==============================================================
# REMOTE NODE RUNNER
# One A2A task per agent node: send, stream, answer gates, collect the
# 'result' artifact.
# ==============================================================
def _stream_kind(ev: "T.StreamResponse") -> str:
    for k in ("task", "message", "status_update", "artifact_update"):
        if ev.HasField(k):
            return k
    return ""


async def _run_remote_node(nid: str, request_text: str) -> dict:
    """Run node `nid` on its A2A server. Returns {"text", "route", "notes", "status"}."""
    ad = AGENTS[nid]
    url = agent_url(nid)
    t0 = time.monotonic()
    text_parts: list[str] = []
    data: dict = {}
    async with httpx.AsyncClient(timeout=None) as hc:
        client = await create_client(url, ClientConfig(streaming=True, httpx_client=hc))
        req = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), role=T.Role.ROLE_USER, parts=[T.Part(text=request_text)]))
        task_id = ctx_id = None
        pending = req
        while pending is not None:
            gate_payload = None
            async for ev in client.send_message(pending):
                kind = _stream_kind(ev)
                if kind == "task":
                    task_id, ctx_id = ev.task.id, ev.task.context_id
                elif kind == "status_update":
                    su = ev.status_update
                    task_id, ctx_id = su.task_id, su.context_id
                    if su.status.HasField("message"):
                        for line in get_text_parts(su.status.message.parts):
                            if line and su.status.state != T.TaskState.TASK_STATE_INPUT_REQUIRED:
                                print(f"[{ad['display']}] {line}", flush=True)
                    if su.status.state == T.TaskState.TASK_STATE_INPUT_REQUIRED:
                        parts = get_data_parts(su.status.message.parts) if su.status.HasField("message") else []
                        gate_payload = dict(parts[0]) if parts and isinstance(parts[0], dict) else {"gate": "gate", "args": {}}
                        break
                    if su.status.state in (T.TaskState.TASK_STATE_FAILED, T.TaskState.TASK_STATE_CANCELED, T.TaskState.TASK_STATE_REJECTED):
                        raise RuntimeError(f"agent {ad['display']!r} task {task_id} ended in {T.TaskState.Name(su.status.state)}")
                elif kind == "artifact_update":
                    art = ev.artifact_update.artifact
                    text_parts.extend(get_text_parts(art.parts))
                    for d in get_data_parts(art.parts):
                        if isinstance(d, dict):
                            data.update(d)
            if gate_payload is None:
                pending = None
            else:
                answer = _handle_gate(ad["display"], task_id, gate_payload)
                pending = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), task_id=task_id, context_id=ctx_id, role=T.Role.ROLE_USER,
                                                                 parts=[T.Part(text=str(answer.get("decision", ""))), new_data_part(answer)]))
        await client.close()
    dt = time.monotonic() - t0
    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt
    print(f"[node] [{nid}] {ad['display']!r} done over A2A -- {sum(len(t) for t in text_parts)} chars ({dt:.1f}s)", flush=True)
    return {"text": "\n".join(text_parts), "route": str(data.get("route") or ""), "notes": str(data.get("notes") or ""), "status": str(data.get("status") or "ok")}


# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over A2A tasks
# ==============================================================
NODE_DURATIONS = {}
_RUN_T0 = None


async def run(user_prompt: str) -> str:
    """Build the graph (agent nodes call their A2A servers), run it, return the final output."""
    sg = StateGraph(WFState)
    for nid in ORDER:
        ntype = NODE_TYPES.get(nid, "")
        if ntype == "start":
            def make_start(n=nid):
                def _run(state):
                    text = state.get("user_prompt", "")
                    if START_DOCUMENTS:
                        doc_parts = []
                        for doc in START_DOCUMENTS:
                            name = doc.get("name", "Document")
                            path = doc.get("path", "")
                            try:
                                doc_parts.append(f"### {name}\n\n{_convert_doc_to_markdown(path)}")
                            except Exception as e:
                                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
                        text = "## Attached Documents\n\n" + "\n\n---\n\n".join(doc_parts) + "\n\n---\n\n" + text
                    print(f"[node] [{n}] start -- {len(text)} chars", flush=True)
                    return {"node_outputs": {n: {"source": "start", "text": text}}}
                return _run
            sg.add_node(nid, make_start())
        elif ntype in ("agent", "playbook"):
            def make_remote(n=nid):
                async def _run(state):
                    ad = AGENTS[n]
                    outs = state.get("node_outputs", {})
                    if ad["kind"] == "playbook":
                        inputs = [outs[p]["text"] for p in parents(n) if p in outs]
                        request = "\n\n".join(inputs) or state.get("user_prompt", "")
                    else:
                        request = build_context(state.get("user_prompt", ""), parents(n), outs)
                    out = await _run_remote_node(n, request)
                    result = {"node_outputs": {n: {"source": ad["display"], "text": out["text"]}}}
                    if ad["dispatch"]:
                        # Dispatcher: the agent chose a child (or none) -> conditional edge input.
                        route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END
                        if route == END:
                            print(f"[node] [{n}] ⚠ dispatcher did not route; ending the run", flush=True)
                            result["final_output"] = out["text"]
                        result["routes"] = {n: route}
                    return result
                return _run
            sg.add_node(nid, make_remote())
        elif ntype == "output":
            def make_output(n=nid):
                def _run(state):
                    pids = parents(n)
                    outs = state.get("node_outputs", {})
                    if len(pids) == 1 and pids[0] in outs:
                        final = outs[pids[0]]["text"]
                    else:
                        blocks = [f"## {outs[p]['source']}\n\n{outs[p]['text']}" for p in pids if p in outs]
                        final = "\n\n---\n\n".join(blocks)
                    print(f"[node] [{n}] output -- {len(final)} chars", flush=True)
                    return {"final_output": final}
                return _run
            sg.add_node(nid, make_output())
        else:
            sg.add_node(nid, lambda s: {})
    # Wire edges; a dispatcher's menu children hang off a conditional edge (only the chosen one runs).
    pos = {n: i for i, n in enumerate(ORDER)}
    sg.add_edge(START, ORDER[0])
    for nid in ORDER:
        menu = {t["id"] for t in AGENTS.get(nid, {}).get("dispatch", [])}
        for child in children(nid):
            if child in pos and pos[child] > pos[nid] and child not in menu:
                sg.add_edge(nid, child)
        if menu:
            def make_router(n=nid):
                def _route(state):
                    return state.get("routes", {}).get(n) or END
                return _route
            sg.add_conditional_edges(nid, make_router(), {t: t for t in menu} | {END: END})
    for nid in ORDER:
        if not children(nid):
            sg.add_edge(nid, END)
    graph = sg.compile()
    print("[info] Running...", flush=True)
    global _RUN_T0
    _RUN_T0 = time.monotonic()
    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
    return result.get("final_output", "")


def _save_output(output: str) -> str | None:
    """Honour the Output node's storage setting (same rule as the single-file script)."""
    if not OUTPUT_STORAGE_ENABLED:
        return None
    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")
    if not os.path.isabs(folder):
        folder = os.path.join(root, folder)
    os.makedirs(folder, exist_ok=True)
    m = re.search(r"(?is)<!doctype html.*?</html\s*>", output) or re.search(r"(?is)<html[\s>].*?</html\s*>", output)
    ext = "html" if m else "md"
    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]
    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime('%Y%m%d-%H%M%S')}.{ext}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(m.group(0) if m else output)
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"A2A orchestrator for workflow {WORKFLOW_NAME!r}")
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    ap.add_argument("--keep-serving", action="store_true", help="leave the agent servers running after the run")
    ap.add_argument("--no-spawn", action="store_true", help="do not start agents; expect their URLs to be reachable")
    a = ap.parse_args()
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}", flush=True)
    sup = AgentSupervisor(spawn=not a.no_spawn)
    try:
        sup.start()
        output = asyncio.run(run(prompt))
    finally:
        if not a.keep_serving:
            sup.stop()
    print("\n" + "=" * 60 + "\nFINAL OUTPUT\n" + "=" * 60 + "\n" + output, flush=True)
    saved = _save_output(output)
    print("\n" + "=" * 74 + "\nRUN SUMMARY\n" + "-" * 74, flush=True)
    if NODE_DURATIONS:
        w = max(len(n) for n in NODE_DURATIONS)
        print("  Time per node (A2A round trip):", flush=True)
        for name, secs in sorted(NODE_DURATIONS.items(), key=lambda kv: -kv[1]):
            print(f"    {name:<{w}}   {secs:7.1f}s", flush=True)
    print(f"  Total wall-clock: {time.monotonic() - _RUN_T0:.1f}s" if _RUN_T0 else "  Total wall-clock: n/a", flush=True)
    print(f"  Final output: {len(output)} chars", flush=True)
    print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)
    print("=" * 74, flush=True)
PY;
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php`
Expected: OK (6 tests).

- [ ] **Step 6: Commit (when asked)**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/LangGraphA2AGeneratorTest.php
git commit -m "feat(langgraph): emit the A2A orchestrator (supervisor, remote node runner, gates)"
```

---

### Task 4: Manifest generation and the `?a2a=1` endpoint

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (replace the `generateA2A` stub)
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (`generatePython`)
- Test: `backend/tests/Unit/LangGraphA2AGeneratorTest.php`

**Interfaces:**
- Produces: `generate($id, $userId, ['a2a' => true])` returns `['root' => 'dispatcher_demo_a2a', 'files' => [['path' => 'orchestrator.py', 'code' => ...], ['path' => 'agents/2_techbuddy.py', 'code' => ...], ...]]` with `orchestrator.py` first.
- Produces: HTTP `GET /api/v1/workflows/{id}/generate-python?a2a=1` → `{"success": true, "data": {"root": ..., "files": [...]}}` (JSON even with `download=1`).

- [ ] **Step 1: Write the failing test**

```php
    public function testA2AOptionReturnsAManifest(): void
    {
        $m = self::generator()->generate(44, '3', ['a2a' => true]);
        $this->assertSame('dispatcher_demo_a2a', $m['root']);
        $this->assertSame(['orchestrator.py', 'agents/2_techbuddy.py', 'agents/3_it-claims.py', 'agents/4_human-resources.py', 'agents/5_playbook-hr.py'],
            array_column($m['files'], 'path'));
        foreach ($m['files'] as $f) {
            $this->assertStringContainsString('PROVENANCE', $f['code'], $f['path']);
            $this->assertStringContainsString('GRAPH EDGES', $f['code'], $f['path']);
            $this->assertCompiles($f['code'], $f['path']);
        }
        $this->assertStringContainsString('<== this agent', $m['files'][1]['code']);
        $this->assertStringContainsString('AGENT ENDPOINTS', $m['files'][0]['code']);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php --filter testA2AOptionReturnsAManifest tests/Unit/LangGraphA2AGeneratorTest.php`
Expected: FAIL — RuntimeException 'A2A emitter not wired yet'.

- [ ] **Step 3: Implement `generateA2A()` and the controller branch**

```php
    /** A2A mode: orchestrator first, then one agent file per agent/playbook node (see a2aLayout). */
    private function generateA2A(array $facts): array
    {
        $layout = self::a2aLayout($facts);
        $files = [['path' => 'orchestrator.py', 'code' => $this->emitA2AOrchestrator($facts, $layout)]];
        foreach ($layout['agents'] as $nid => $e) {
            $files[] = ['path' => $e['file'], 'code' => $this->emitA2AAgentFile($facts, $layout, $nid)];
        }
        return ['root' => $layout['root'], 'files' => $files];
    }
```

In `WorkflowController::generatePython()` replace `$result = $gen->generate($workflowId, (string) $userId);` with:

```php
            $a2a = ($request['query']['a2a'] ?? '0') === '1';
            $result = $gen->generate($workflowId, (string) $userId, ['a2a' => $a2a]);
            if ($a2a) {
                // Multi-file output: always JSON (the editor writes the folder itself).
                return ['success' => true, 'data' => $result, 'status_code' => 200];
            }
```

Update the endpoint docblock above `generatePython` to mention `?a2a=1` and the manifest shape.

- [ ] **Step 4: Run the whole LangGraph test set**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php tests/Unit/LangGraphGeneratorPlaybookTest.php tests/Unit/GeneratedDocParityTest.php`
Expected: OK.

- [ ] **Step 5: Generate the live Dispatcher demo manifest and compile every file**

```bash
cd backend && cat > /tmp/gen_a2a.php <<'EOF'
<?php
require '/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/vendor/autoload.php';
$config = require '/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/config/ai_config.php';
$d = $config['contexts_database'];
$pdo = new PDO("mysql:host={$d['host']};dbname={$d['database']};charset={$d['charset']}", $d['username'], $d['password'],
  [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC, PDO::ATTR_TIMEOUT=>30]);
$gen = new \AgentTeam\Services\LangGraphGenerator($pdo, new \AgentTeam\Services\WorkflowRepository($pdo),
    new \AgentTeam\Services\WorkflowGraphRepository($pdo), new \AgentTeam\Services\AgentRepository($pdo));
$m = $gen->generate((int)($argv[1] ?? 44), '3', ['a2a' => true]);
$root = getenv('HOME') . '/Documents/synergyAI/python/scripts/' . $m['root'];
foreach ($m['files'] as $f) { $p = "$root/{$f['path']}"; @mkdir(dirname($p), 0777, true); file_put_contents($p, $f['code']); echo "$p\n"; }
EOF
php -d xdebug.mode=off /tmp/gen_a2a.php 44 && for f in ~/Documents/synergyAI/python/scripts/dispatcher_demo_a2a/orchestrator.py ~/Documents/synergyAI/python/scripts/dispatcher_demo_a2a/agents/*.py; do python3 -m py_compile "$f" && echo "ok $f"; done
```
Expected: five files written, all compile.

- [ ] **Step 6: Commit (when asked)**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php backend/src/AgentTeam/Controllers/WorkflowController.php backend/tests/Unit/LangGraphA2AGeneratorTest.php
git commit -m "feat(langgraph): A2A manifest generation + ?a2a=1 endpoint"
```

---

### Task 5: Runner accepts a folder-scoped orchestrator and pins the SDK

**Files:**
- Modify: `langchain_runner/main.py:199-219` (`_resolve_script_path`)
- Modify: `langchain_runner/requirements.txt`
- Test: `langchain_runner/tests/test_resolve_script_path.py` (new)

**Interfaces:**
- Produces: `_resolve_script_path("dispatcher_demo_a2a/orchestrator.py")` resolves to `SCRIPTS_DIR/dispatcher_demo_a2a/orchestrator.py`; one folder level only.

- [ ] **Step 1: Write the failing test**

```python
import os, sys, pathlib, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main as runner


def _scripts(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    (scripts / "demo_a2a" / "agents").mkdir(parents=True)
    (scripts / "flat.py").write_text("print(1)")
    (scripts / "demo_a2a" / "orchestrator.py").write_text("print(2)")
    (scripts / "demo_a2a" / "agents" / "1_a.py").write_text("print(3)")
    monkeypatch.setattr(runner, "SCRIPTS_DIR", scripts)
    return scripts


def test_flat_file_still_resolves(tmp_path, monkeypatch):
    scripts = _scripts(tmp_path, monkeypatch)
    assert runner._resolve_script_path("flat.py") == (scripts / "flat.py").resolve()


def test_one_folder_level_resolves(tmp_path, monkeypatch):
    scripts = _scripts(tmp_path, monkeypatch)
    assert runner._resolve_script_path("demo_a2a/orchestrator.py") == (scripts / "demo_a2a" / "orchestrator.py").resolve()


@pytest.mark.parametrize("bad", ["../x.py", "demo_a2a/agents/1_a.py", ".hidden/x.py", "/abs/x.py", "demo_a2a/orchestrator.txt", "a\\b.py"])
def test_bad_paths_rejected(tmp_path, monkeypatch, bad):
    _scripts(tmp_path, monkeypatch)
    with pytest.raises((ValueError, FileNotFoundError)):
        runner._resolve_script_path(bad)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd langchain_runner && ../../gpt/langchain_runner/.venv/bin/python -m pytest tests/test_resolve_script_path.py -q` (use `~/Documents/synergyAI/python/.venv/bin/python -m pytest` if the source venv lacks pytest; install with `pip install pytest` in that venv if needed)
Expected: `test_one_folder_level_resolves` FAILS with ValueError "Invalid script filename".

- [ ] **Step 3: Implement**

Replace `_resolve_script_path` in `langchain_runner/main.py`:

```python
def _resolve_script_path(filename: str) -> Path:
    """Resolve a filename into an absolute path under SCRIPTS_DIR.

    Accepts a plain file ("workflow.py") or ONE folder level
    ("workflow_a2a/orchestrator.py" -- the A2A compile mode's entry point).
    Guards against traversal: no backslashes, no leading dots in any segment,
    at most two segments, must end with .py, and the resolved path must stay
    under the scripts directory. Raises ValueError on a bad filename,
    FileNotFoundError if the file doesn't exist.
    """
    if not filename or "\\" in filename or filename.startswith("/"):
        raise ValueError(f"Invalid script filename: {filename!r}")
    segments = filename.split("/")
    if len(segments) > 2 or any((not s) or s.startswith(".") for s in segments):
        raise ValueError(f"Invalid script filename: {filename!r}")
    if not filename.endswith(".py"):
        raise ValueError(f"Only .py files can be executed: {filename!r}")
    candidate = SCRIPTS_DIR.joinpath(*segments).resolve()
    scripts_root = SCRIPTS_DIR.resolve()
    if scripts_root not in candidate.parents:
        raise ValueError(f"Path escapes scripts directory: {filename!r}")
    if not candidate.exists():
        raise FileNotFoundError(f"Script not found: {candidate}")
    return candidate
```

Append to `langchain_runner/requirements.txt`:

```
# A2A compile mode (LangGraph): each generated agent is an A2A server
# (a2a-sdk + starlette/uvicorn); the orchestrator is an A2A client.
a2a-sdk[http-server]>=1.1,<2
```

- [ ] **Step 4: Run the tests, then copy the runner to its install location**

Run: `cd langchain_runner && ~/Documents/synergyAI/python/.venv/bin/python -m pytest tests/test_resolve_script_path.py -q`
Expected: 8 passed.
Run: `cd langchain_runner && python3 setup.py --force --skip-venv && grep -n "one folder level" ~/Documents/synergyAI/python/main.py`
Expected: the new docstring appears in the installed copy. Restart the runner (`~/Documents/synergyAI/python/.venv/bin/python ~/Documents/synergyAI/python/main.py`) if it is running.

- [ ] **Step 5: Commit (when asked)**

```bash
git add langchain_runner/main.py langchain_runner/requirements.txt langchain_runner/tests/test_resolve_script_path.py
git commit -m "feat(runner): run <folder>/orchestrator.py; pin a2a-sdk"
```

---

### Task 6: Editor: options form, multi-file write, file selector, Run path

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` (`_showLangGraphMenu` generate/run/display-code bindings, `downloadGeneratedPython`, `_generateAndWriteScript`, `_runLangGraphScript`, `_showLangGraphCodeModal`; new `_showCodegenOptionsModal`, `_codegenOptions`, `_saveCodegenOptions`, `_writeManifest`)
- Modify: `frontend/assets/i18n/en.json`, `es.json`, `fr.json` (keys under `workflow.output`)
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: `GET .../generate-python?a2a=1` → `{success, data:{root, files:[{path, code}]}}` (Task 4); runner `filename: "<root>/orchestrator.py"` (Task 5).
- Produces: `_codegenOptions()` → `{a2a: boolean}`; `_showLangGraphCodeModal(savedPath, providedCode, filename)` also accepts `providedCode` as an array of `{path, code}`.

- [ ] **Step 1: Options modal + per-workflow memory**

Add to the `WorkflowEditor` class (next to `_showLangGraphCodeModal`):

```javascript
    /** Code-generation options remembered per workflow (browser-local). Shape: { a2a: boolean }. */
    _codegenOptions() {
        try {
            const raw = localStorage.getItem(`wf:${this.currentWorkflowId}:codegen`);
            const o = raw ? JSON.parse(raw) : {};
            return { a2a: !!o.a2a };
        } catch (_) { return { a2a: false }; }
    }

    _saveCodegenOptions(opts) {
        try { localStorage.setItem(`wf:${this.currentWorkflowId}:codegen`, JSON.stringify({ a2a: !!opts.a2a })); } catch (_) { /* private mode */ }
    }

    /**
     * "Code generation options" form shown by the LangGraph Generate item.
     * Resolves with the chosen options, or null when cancelled.
     */
    _showCodegenOptionsModal() {
        return new Promise((resolve) => {
            const cur = this._codegenOptions();
            const backdrop = document.createElement('div');
            backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
            backdrop.innerHTML = `
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" role="dialog" aria-modal="true">
                    <h3 class="text-lg font-semibold text-gray-900 mb-4">${this.escapeHtml(this.t('workflow.output.codegenTitle') || 'Code generation options')}</h3>
                    <label class="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" class="codegen-a2a mt-1 h-4 w-4" ${cur.a2a ? 'checked' : ''}>
                        <span>
                            <span class="block text-sm font-medium text-gray-900">${this.escapeHtml(this.t('workflow.output.codegenA2A') || 'A2A')}</span>
                            <span class="block text-xs text-gray-500">${this.escapeHtml(this.t('workflow.output.codegenA2AHelp') || 'Generate one A2A agent server per node plus an orchestrator, linked over the Agent2Agent protocol.')}</span>
                        </span>
                    </label>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="codegen-cancel px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded">${this.escapeHtml(this.t('common.cancel') || 'Cancel')}</button>
                        <button class="codegen-go px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded">${this.escapeHtml(this.t('workflow.output.codegenGenerate') || 'Generate')}</button>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            const done = (val) => { backdrop.remove(); resolve(val); };
            backdrop.querySelector('.codegen-cancel').addEventListener('click', () => done(null));
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
            backdrop.querySelector('.codegen-go').addEventListener('click', () => {
                const opts = { a2a: backdrop.querySelector('.codegen-a2a').checked };
                this._saveCodegenOptions(opts);
                done(opts);
            });
        });
    }
```

In `_showLangGraphMenu`, change the agent-menu `generate` binding to:

```javascript
        menu.querySelector('[data-action="generate"]')?.addEventListener('click', async () => {
            menu.remove();
            if (isIngestion) { this.downloadGeneratedPython(); return; }
            const opts = await this._showCodegenOptionsModal();
            if (opts) this.downloadGeneratedPython(opts);
        });
```

- [ ] **Step 2: Manifest fetch + folder write**

Add:

```javascript
    /**
     * Fetch the A2A manifest and write it under python/scripts/<root>/ (orchestrator.py
     * + agents/*.py) through the File System Access root. Returns { root, files } or null.
     */
    async _writeManifest() {
        const resp = await fetch(`${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?a2a=1`, { headers: this.getAuthHeaders() });
        if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
        const j = await resp.json();
        const data = j?.data;
        if (!data?.root || !Array.isArray(data.files)) throw new Error('Unexpected manifest response');
        for (const f of data.files) {
            const rel = `python/scripts/${data.root}/${f.path}`;
            const dirPath = rel.slice(0, rel.lastIndexOf('/'));
            const dir = await window.localFs.resolvePath(dirPath, { create: true });
            if (!dir) throw new Error(`Could not create ${dirPath}`);
            const fh = await dir.getFileHandle(f.path.slice(f.path.lastIndexOf('/') + 1), { create: true });
            const w = await fh.createWritable();
            await w.write(f.code);
            await w.close();
        }
        await this._syncRunnerEnv();
        console.log(`[WorkflowEditor] Saved ${data.files.length} A2A files under python/scripts/${data.root}/`);
        return data;
    }
```

In `downloadGeneratedPython(opts = null)`: after the runner-entry probe and the overlay creation, branch:

```javascript
        const a2a = !!(opts ? opts.a2a : this._codegenOptions().a2a);
        try {
            if (a2a) {
                const data = await this._writeManifest();
                const rootName = (await window.localFs.getRootHandle())?.name || 'synergyAI';
                generated = { path: `${rootName}/python/scripts/${data.root}/`, code: data.files };
            } else {
                ... (existing single-file body unchanged)
            }
```

The existing post-`finally` line `if (generated) this._showLangGraphCodeModal(generated.path, generated.code);` then receives the file list.

- [ ] **Step 3: File selector in the code modal**

In `_showLangGraphCodeModal(savedPath = '', providedCode = null, filename = '')`, right after `let code = providedCode;` handle the list:

```javascript
        const files = Array.isArray(providedCode) ? providedCode : null;
        if (files) code = files[0]?.code || '';
```

In the modal HTML, after the header `div`, add the selector (only when `files`):

```javascript
                ${files ? `<div class="flex items-center gap-2 mb-2">
                    <label class="text-xs text-gray-500">File</label>
                    <select class="code-file-select text-xs border border-gray-300 rounded px-2 py-1 font-mono">
                        ${files.map((f, i) => `<option value="${i}">${this.escapeHtml(f.path)}</option>`).join('')}
                    </select></div>` : ''}
```

Wrap the line-number rendering in a function `render(text)` (the existing `codeLines`/`gutterCh`/`preEl.innerHTML` block) and call it once; then:

```javascript
        const sel = backdrop.querySelector('.code-file-select');
        if (sel) sel.addEventListener('change', () => { code = files[Number(sel.value)].code; render(code); });
```

so Copy always copies the currently shown `code`.

- [ ] **Step 4: Run and Display Code follow the option**

In `_runLangGraphScript`, replace `const filename = await this._generateAndWriteScript('generate-python', 'workflow.py');` with:

```javascript
        let filename;
        if (this._codegenOptions().a2a) {
            try { const data = await this._writeManifest(); filename = `${data.root}/orchestrator.py`; }
            catch (e) { alert(`Could not generate the A2A folder: ${e?.message || e}`); return; }
        } else {
            filename = await this._generateAndWriteScript('generate-python', 'workflow.py');
        }
```

In the menu's `display-code` binding for the agent menu:

```javascript
        menu.querySelector('[data-action="display-code"]')?.addEventListener('click', async () => {
            menu.remove();
            if (!isIngestion && this._codegenOptions().a2a) {
                try {
                    const resp = await fetch(`${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?a2a=1`, { headers: this.getAuthHeaders() });
                    const j = await resp.json();
                    this._showLangGraphCodeModal('', j?.data?.files || [], '');
                } catch (e) { alert(`Could not fetch the generated code: ${e?.message || e}`); }
                return;
            }
            this._showLangGraphCodeModal();
        });
```

- [ ] **Step 5: i18n keys and cache-buster**

Add under `workflow.output` in `en.json` (and translated in `es.json` / `fr.json`):

```json
      "codegenTitle": "Code generation options",
      "codegenA2A": "A2A",
      "codegenA2AHelp": "Generate one A2A agent server per node plus an orchestrator, linked over the Agent2Agent protocol.",
      "codegenGenerate": "Generate"
```

es: "Opciones de generación de código" / "A2A" / "Genera un servidor de agente A2A por nodo más un orquestador, enlazados con el protocolo Agent2Agent." / "Generar". fr: "Options de génération de code" / "A2A" / "Génère un serveur d'agent A2A par nœud plus un orchestrateur, reliés par le protocole Agent2Agent." / "Générer".

Bump `frontend/index.html`: `workflow-editor.js?v=20260904-a2a`. Run `node --check frontend/assets/js/workflow-editor.js`.

- [ ] **Step 6: Browser verification**

Open `http://localhost/gpt/frontend/index.html`, Workflows → Dispatcher demo → Output node → langGraph - Python → Generate: the options modal appears; tick A2A → Generate. Expected: the code modal opens with a file selector listing `orchestrator.py` and four `agents/*.py`, "Saved to …/python/scripts/dispatcher_demo_a2a/". Check the console for `[WorkflowEditor] Saved 5 A2A files`. Untick A2A and Generate again: the single-file modal as before.

- [ ] **Step 7: Commit (when asked)**

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/i18n/en.json frontend/assets/i18n/es.json frontend/assets/i18n/fr.json frontend/index.html
git commit -m "feat(editor): code generation options form (A2A), multi-file write, code modal file selector"
```

---

### Task 7: Live run of the Dispatcher demo over A2A, fixes, notes

**Files:**
- Modify (as needed by findings): `backend/src/AgentTeam/Services/LangGraphGenerator.php`
- Modify: `~/.claude/projects/-Applications-XAMPP-xamppfiles-htdocs-gpt/memory/project_langgraph_playbook_dispatcher.md` and `MEMORY.md`

- [ ] **Step 1: Run the orchestrator from a terminal (non-interactive gates)**

```bash
cd ~/Documents/synergyAI/python && php -d xdebug.mode=off /tmp/gen_a2a.php 44 >/dev/null && \
.venv/bin/python -u scripts/dispatcher_demo_a2a/orchestrator.py "I want to take some vacations from October 13 to October 17, my email is didierphmartin@hotmail.com" < /dev/null 2>&1 | tee /tmp/a2a_run.log | grep -E "^\[supervisor\]|^\[node\]|^\[gate|^\[techBuddy\]|^\[Human resources\]|^\[Playbook HR\]|FINAL OUTPUT|Total wall|Traceback|Error" | cut -c1-200
```
Expected: four `[supervisor] ... ready`, techBuddy routed to Human resources (route in the data part), no `[IT claims]`/`[Devices management]` node lines, `[gate] {"kind": "approval", ...}` followed by `[gate-answer] {... "approved" ...}`, the playbook transcript in FINAL OUTPUT, RUN SUMMARY with per-agent times, `[supervisor] agents stopped`.

- [ ] **Step 2: Fix what the run reveals**

Fix the emitter (never the generated files: see the "never patch compiled files" rule), regenerate with `/tmp/gen_a2a.php`, rerun Step 1 until it passes. Add a unit assertion to `LangGraphA2AGeneratorTest` for each emitter fix.

- [ ] **Step 3: Run through the runner**

Start the runner if needed (`~/Documents/synergyAI/python/.venv/bin/python ~/Documents/synergyAI/python/main.py`), then in the editor: Output node → langGraph - Python → Run with A2A remembered ON. Expected: the run modal streams the same lines as Step 1 and ends with RUN SUMMARY.

- [ ] **Step 4: Full regression**

Run: `cd backend && php -d xdebug.mode=off vendor/bin/phpunit --no-configuration --bootstrap vendor/autoload.php tests/Unit/LangGraphA2AGeneratorTest.php tests/Unit/LangGraphGeneratorPlaybookTest.php tests/Unit/GeneratedDocParityTest.php tests/Unit/PythonEmitHelpersPinTest.php tests/Unit/PythonEmitHelpersTest.php tests/Unit/Playbook`
Expected: only the known pre-existing pin failure (`testSkillFsSyncBlockUnchanged`).

- [ ] **Step 5: Record the outcome in memory**

Append to `project_langgraph_playbook_dispatcher.md` a paragraph "A2A compile mode (date)": files, ports, gate protocol, how to run, spike facts about a2a-sdk 1.1 (initial Task enqueue, execute() returns at input-required), and what remains (other targets, app-side gate UI, durable checkpointing). Update the MEMORY.md hook line.

- [ ] **Step 6: Commit (when asked)**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php backend/tests/Unit/LangGraphA2AGeneratorTest.php
git commit -m "fix(langgraph-a2a): live-run fixes from the Dispatcher demo"
```
