# Workflow Node Observability + Parallel Skill-Tool Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skill-bound nodes work in parallel fan-out, and persist every node's input/output/logs so a run is debuggable from the node form even after it dies, loops, or the editor is reopened.

**Architecture:** A single persist-then-emit chokepoint in the runner writes every workflow event to a per-run JSONL file (`storage/workflow-runs/{runId}.jsonl`); a read endpoint serves it; the frontend replays it into the node form when live SSE data is absent. Separately, the parallel executor gains the `run_skill_script` client tool (with a forced first-round `tool_choice`) that the sequential path already has.

**Tech Stack:** PHP 8 (PSR-4, `AgentTeam\` → `src/AgentTeam/`), PHPUnit 10 + Mockery, FastRoute, vanilla JS frontend (drawflow). Spec: `docs/superpowers/specs/2026-06-24-workflow-node-observability-design.md`.

## Global Constraints

- PHP src namespace `AgentTeam\` maps to `backend/src/AgentTeam/`; test namespace `Quantis\AIPortfolioAssistant\Tests\` maps to `backend/tests/`. Run tests from `backend/` with `vendor/bin/phpunit`.
- `runId` is always a 32-char lowercase hex string (`bin2hex(random_bytes(16))`); validate with `/^[a-f0-9]{32}$/`.
- Run log directory default: `backend/storage/workflow-runs/` (overridable via `$config['workflow_runs_dir']`).
- Do NOT change the provider `buildHttpRequest` interface, the `maxRounds = 10` value, or the `traceStore` DB schema.
- Logging/IO must never abort a run or a request — catch and `error_log` its own failures.
- The frontend has no JS test runner; frontend tasks are verified manually (steps provided).
- Commit after every task.

---

### Task 1: `WorkflowRunLog` — per-run JSONL read/write (Part A core)

**Files:**
- Create: `backend/src/AgentTeam/Services/WorkflowRunLog.php`
- Test: `backend/tests/Unit/AgentTeam/WorkflowRunLogTest.php`

**Interfaces:**
- Produces:
  - `WorkflowRunLog::__construct(string $baseDir)`
  - `WorkflowRunLog::defaultDir(array $config = []): string`
  - `append(string $runId, array $event): void` — appends one JSON line; creates dir on demand; invalid runId is a no-op (logged), never throws into the caller.
  - `read(string $runId): ?array` — returns the decoded events array, `[]` if the file exists but is empty, `null` if the file does not exist or runId is invalid.
  - `pathFor(string $runId): string`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/AgentTeam/WorkflowRunLogTest.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\WorkflowRunLog;

class WorkflowRunLogTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/wrl-' . bin2hex(random_bytes(6));
    }

    protected function tearDown(): void
    {
        if (is_dir($this->dir)) {
            foreach (glob($this->dir . '/*') ?: [] as $f) { @unlink($f); }
            @rmdir($this->dir);
        }
    }

    private function validRunId(): string
    {
        return bin2hex(random_bytes(16)); // 32 hex chars
    }

    public function testAppendThenReadRoundTripsEvents(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $runId = $this->validRunId();

        $log->append($runId, ['type' => 'workflow_start', 'run_id' => $runId]);
        $log->append($runId, ['type' => 'node_start', 'node_id' => 5, 'input' => 'hello']);
        $log->append($runId, ['type' => 'node_complete', 'node_id' => 5, 'output' => 'world']);

        $events = $log->read($runId);
        $this->assertIsArray($events);
        $this->assertCount(3, $events);
        $this->assertSame('node_start', $events[1]['type']);
        $this->assertSame('hello', $events[1]['input']);
        $this->assertSame('world', $events[2]['output']);
    }

    public function testReadMissingRunReturnsNull(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $this->assertNull($log->read($this->validRunId()));
    }

    public function testReadInvalidRunIdReturnsNull(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $this->assertNull($log->read('../etc/passwd'));
    }

    public function testAppendInvalidRunIdIsNoOp(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $log->append('not-a-valid-id', ['type' => 'x']); // must not throw
        $this->assertFalse(is_dir($this->dir) && count(glob($this->dir . '/*') ?: []) > 0);
    }

    public function testDefaultDirFromConfigOverride(): void
    {
        $this->assertSame('/custom/runs', WorkflowRunLog::defaultDir(['workflow_runs_dir' => '/custom/runs']));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && vendor/bin/phpunit tests/Unit/AgentTeam/WorkflowRunLogTest.php`
Expected: FAIL — `Class "AgentTeam\Services\WorkflowRunLog" not found`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/AgentTeam/Services/WorkflowRunLog.php`:

```php
<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Per-run append-only event log. One JSONL file per workflow run, written
 * as events are emitted, so a run is debuggable after it ends, dies, loops,
 * or its SSE stream drops. Read back by the node form via the events endpoint.
 */
class WorkflowRunLog
{
    private string $baseDir;

    public function __construct(string $baseDir)
    {
        $this->baseDir = rtrim($baseDir, '/');
    }

    public static function defaultDir(array $config = []): string
    {
        // __DIR__ = backend/src/AgentTeam/Services ; dirname(...,3) = backend
        return $config['workflow_runs_dir'] ?? (dirname(__DIR__, 3) . '/storage/workflow-runs');
    }

    public function pathFor(string $runId): string
    {
        return $this->baseDir . '/' . $runId . '.jsonl';
    }

    private function isValidRunId(string $runId): bool
    {
        return (bool) preg_match('/^[a-f0-9]{32}$/', $runId);
    }

    public function append(string $runId, array $event): void
    {
        if (!$this->isValidRunId($runId)) {
            error_log("[WorkflowRunLog] refusing append for invalid runId");
            return;
        }
        try {
            if (!is_dir($this->baseDir)) {
                @mkdir($this->baseDir, 0775, true);
            }
            $line = json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($line === false) {
                error_log("[WorkflowRunLog] json_encode failed for runId={$runId}");
                return;
            }
            file_put_contents($this->pathFor($runId), $line . "\n", FILE_APPEND | LOCK_EX);
        } catch (\Throwable $e) {
            error_log("[WorkflowRunLog] append failed for runId={$runId}: " . $e->getMessage());
        }
    }

    public function read(string $runId): ?array
    {
        if (!$this->isValidRunId($runId)) {
            return null;
        }
        $path = $this->pathFor($runId);
        if (!is_file($path)) {
            return null;
        }
        $events = [];
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $decoded = json_decode($line, true);
            if (is_array($decoded)) {
                $events[] = $decoded;
            }
        }
        return $events;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && vendor/bin/phpunit tests/Unit/AgentTeam/WorkflowRunLogTest.php`
Expected: PASS (5 tests, OK).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/WorkflowRunLog.php backend/tests/Unit/AgentTeam/WorkflowRunLogTest.php
git commit -m "feat: WorkflowRunLog — per-run JSONL event read/write"
```

---

### Task 2: Persist-then-emit in the runner (Part A inversion)

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` (add field + constructor wiring ~lines 57–84; `emitNodeEvent` ~168; `emitWorkflowEvent`; `workflow_start` emit ~283)

**Interfaces:**
- Consumes: `WorkflowRunLog` from Task 1.
- Produces: every emitted event is appended to `{runId}.jsonl`; `workflow_start` payload now carries `run_id`.

**Why no unit test here:** constructing `GraphWorkflowRunner` requires a live `PDO` plus three repositories, so its private emit methods aren't practically unit-testable. The write/read logic they delegate to is fully covered by Task 1. This task is verified by `php -l` and the manual run in Task 7.

- [ ] **Step 1: Add the field and a getter near the other private fields**

In `GraphWorkflowRunner.php`, after line 61 (`private array $skillResultByNode = [];`) add:

```php
    // Per-run JSONL event log (docs/superpowers/specs/2026-06-24-...). Every
    // emitted event is persisted here before SSE, so a run is debuggable
    // after it ends/dies even with no browser attached.
    private WorkflowRunLog $runLog;
```

- [ ] **Step 2: Initialize it in the constructor**

In the constructor body (after line 83 `$this->schemaRepository = new WorkflowSchemaRepository($db);`) add:

```php
        $this->runLog = new WorkflowRunLog(WorkflowRunLog::defaultDir($config));
```

- [ ] **Step 3: Invert `emitNodeEvent` to persist-then-emit**

Replace the body of `emitNodeEvent` (starts line 168). The current body returns early when `streamContext` is null. New body:

```php
    private function emitNodeEvent(string $type, array $node, ?array $extra = null): void
    {
        $data = [
            'type' => $type,
            'node_id' => $node['id'],
            'node_type' => $node['node_type'],
            'drawflow_id' => $node['drawflow_node_id'] ?? null,
            'agent_id' => $node['agent_id'] ?? null,
            'agent_name' => $extra['agent_name'] ?? null,
            'timestamp' => microtime(true),
        ];

        if ($extra) {
            $data = array_merge($data, $extra);
        }

        // Persist first so the event survives even with no SSE / a dead run.
        if ($this->runId !== '') {
            $this->runLog->append($this->runId, $data);
        }

        if ($this->streamContext) {
            $this->streamContext->emit($data);
        }
    }
```

- [ ] **Step 4: Invert `emitWorkflowEvent` the same way**

Replace the body of `emitWorkflowEvent` (the early `if (!$this->streamContext) return;` version) with:

```php
    private function emitWorkflowEvent(string $type, Workflow $workflow, ?array $extra = null): void
    {
        $data = [
            'type' => $type,
            'workflow_id' => $workflow->getId(),
            'workflow_name' => $workflow->getName(),
            'timestamp' => microtime(true),
        ];

        if ($extra) {
            $data = array_merge($data, $extra);
        }

        if ($this->runId !== '') {
            $this->runLog->append($this->runId, $data);
        }

        if ($this->streamContext) {
            $this->streamContext->emit($data);
        }
    }
```

- [ ] **Step 5: Add `run_id` to the `workflow_start` payload**

At the `workflow_start` emit (line 283), add `run_id`:

```php
            // Emit workflow_start event
            $this->emitWorkflowEvent('workflow_start', $workflow, [
                'run_id' => $this->runId,
                'execution_id' => $this->executionId,
                'total_nodes' => count($nodes),
            ]);
```

- [ ] **Step 6: Lint**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "feat: persist every workflow event to per-run JSONL before SSE"
```

---

### Task 3: Surface skill stdout/logs via a `node_trace` event

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — `recordExecutionTrace` (ends ~line 985)

**Interfaces:**
- Consumes: persist-then-emit `emitNodeEvent` from Task 2; `$this->skillResultByNode`.
- Produces: a `node_trace` event (carrying `skill_stdout`, `skill_log_messages`, `final_text`, `success`, `error_text`, `exit_code`) persisted to the JSONL and streamed live.

**Why no unit test here:** same constructor constraint as Task 2; verified by lint + Task 7 manual run.

- [ ] **Step 1: Emit `node_trace` at the end of `recordExecutionTrace`**

In `recordExecutionTrace`, immediately after the `$this->traceStore->insert([...]);` call closes, add:

```php
        // Mirror the skill stdout/logs into the per-run event log so the node
        // form can show them after the fact (the DB trace isn't read back by
        // the frontend). emitNodeEvent persists + streams.
        $this->emitNodeEvent('node_trace', $node, [
            'skill_dir'          => $config['bound_skill']['dir_name'] ?? null,
            'skill_exit_code'    => $out['exit_code'] ?? null,
            'skill_stdout'       => $out['stdout'] ?? null,
            'skill_log_messages' => $out['log_messages'] ?? null,
            'final_text'         => $outputText,
            'success'            => $success,
            'error_text'         => $success ? null : $outputText,
        ]);
```

(`$config`, `$out`, `$outputText`, `$success` are all already in scope in that method.)

- [ ] **Step 2: Lint**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "feat: emit node_trace with skill stdout/logs into run log"
```

---

### Task 4: Read endpoint — `GET /workflows/runs/{runId}/events`

**Files:**
- Modify: `backend/src/AgentTeam/Controllers/WorkflowController.php` (add `runEvents` method near `executions`, ~line 848)
- Modify: `backend/src/routes.php` (after line 332)

**Interfaces:**
- Consumes: `WorkflowRunLog::read` / `WorkflowRunLog::defaultDir` from Task 1; controller `$request` shape (`user_id`, `params`).
- Produces: JSON `{ run_id, events: [...] }`; 401 unauth, 400 bad id, 404 missing run.

**Why no separate controller unit test:** the method is a thin wrapper over `WorkflowRunLog::read` (covered in Task 1) and instantiating the controller needs a `PDO`. Verified by Task 1's read tests plus the manual curl in Step 4.

- [ ] **Step 1: Add the controller method**

In `WorkflowController.php`, after the `executions` method, add:

```php
    /**
     * GET /api/v1/workflows/runs/{runId}/events
     * Return the persisted per-run event log (JSONL) for the node form to
     * replay. Run files are addressable only by their unguessable 128-bit id.
     */
    public function runEvents(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            http_response_code(401);
            return ['error' => 'Authentication required'];
        }

        $runId = (string) ($request['params']['runId'] ?? '');
        if (!preg_match('/^[a-f0-9]{32}$/', $runId)) {
            http_response_code(400);
            return ['error' => 'Invalid runId'];
        }

        $log = new \AgentTeam\Services\WorkflowRunLog(
            \AgentTeam\Services\WorkflowRunLog::defaultDir($this->config)
        );
        $events = $log->read($runId);
        if ($events === null) {
            http_response_code(404);
            return ['error' => 'Run not found'];
        }

        return ['run_id' => $runId, 'events' => $events];
    }
```

- [ ] **Step 2: Register the route**

In `backend/src/routes.php`, immediately after line 332 (`...'executions'])`), add:

```php
        $r->get('/api/v1/workflows/runs/{runId:[a-f0-9]{32}}/events', ['AgentTeam:WorkflowController', 'runEvents']);
```

- [ ] **Step 3: Lint both files**

Run: `cd backend && php -l src/AgentTeam/Controllers/WorkflowController.php && php -l src/routes.php`
Expected: `No syntax errors detected` for both.

- [ ] **Step 4: Manual round-trip check**

Write a throwaway events file and read it back through `WorkflowRunLog` to confirm wiring (no HTTP/auth needed):

Run:
```bash
cd backend && php -r '
require "vendor/autoload.php";
$dir = sys_get_temp_dir()."/wrl-manual";
$log = new AgentTeam\Services\WorkflowRunLog($dir);
$id = bin2hex(random_bytes(16));
$log->append($id, ["type"=>"node_start","node_id"=>1,"input"=>"hi"]);
$log->append($id, ["type"=>"node_complete","node_id"=>1,"output"=>"bye"]);
var_export($log->read($id));
echo "\nmissing => "; var_export($log->read(bin2hex(random_bytes(16))));
'
```
Expected: an array of 2 events printed, then `missing => NULL`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Controllers/WorkflowController.php backend/src/routes.php
git commit -m "feat: GET /workflows/runs/{runId}/events endpoint"
```

---

### Task 5: `SkillToolChoice::forProvider` — provider-shaped tool_choice (Part B helper)

**Files:**
- Create: `backend/src/AgentTeam/Services/SkillToolChoice.php`
- Test: `backend/tests/Unit/AgentTeam/SkillToolChoiceTest.php`

**Interfaces:**
- Produces: `SkillToolChoice::forProvider(string $provider): ?array` — the `tool_choice` payload that forces `run_skill_script`, shaped per provider; `null` for providers that don't support payload-level forcing (Gemini and unknowns).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/AgentTeam/SkillToolChoiceTest.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\SkillToolChoice;

class SkillToolChoiceTest extends TestCase
{
    public function testOpenAiFamilyShape(): void
    {
        $expected = ['type' => 'function', 'function' => ['name' => 'run_skill_script']];
        foreach (['openai', 'grok', 'deepseek', 'kimi', 'OpenAI'] as $p) {
            $this->assertSame($expected, SkillToolChoice::forProvider($p), "provider {$p}");
        }
    }

    public function testClaudeShape(): void
    {
        $expected = ['type' => 'tool', 'name' => 'run_skill_script'];
        foreach (['claude', 'anthropic'] as $p) {
            $this->assertSame($expected, SkillToolChoice::forProvider($p), "provider {$p}");
        }
    }

    public function testGeminiAndUnknownReturnNull(): void
    {
        $this->assertNull(SkillToolChoice::forProvider('gemini'));
        $this->assertNull(SkillToolChoice::forProvider('google'));
        $this->assertNull(SkillToolChoice::forProvider('something-else'));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && vendor/bin/phpunit tests/Unit/AgentTeam/SkillToolChoiceTest.php`
Expected: FAIL — `Class "AgentTeam\Services\SkillToolChoice" not found`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/AgentTeam/Services/SkillToolChoice.php`:

```php
<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Builds the provider-specific `tool_choice` payload that forces an agent to
 * call run_skill_script on its first parallel round. Mirrors how the
 * sequential path forces the skill (GraphWorkflowRunner::runAgentNode), but
 * as a pure value so the parallel path can inject it into an already-built
 * request payload without touching the provider request interface.
 */
class SkillToolChoice
{
    public const TOOL_NAME = 'run_skill_script';

    public static function forProvider(string $provider): ?array
    {
        switch (strtolower($provider)) {
            case 'openai':
            case 'grok':
            case 'deepseek':
            case 'kimi':
                return ['type' => 'function', 'function' => ['name' => self::TOOL_NAME]];
            case 'claude':
            case 'anthropic':
                return ['type' => 'tool', 'name' => self::TOOL_NAME];
            default:
                // Gemini uses function_calling_config (not payload tool_choice);
                // unknown providers fall back to the prompt instruction.
                return null;
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && vendor/bin/phpunit tests/Unit/AgentTeam/SkillToolChoiceTest.php`
Expected: PASS (3 tests, OK).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/SkillToolChoice.php backend/tests/Unit/AgentTeam/SkillToolChoiceTest.php
git commit -m "feat: SkillToolChoice — provider-shaped tool_choice for run_skill_script"
```

---

### Task 6: Wire the skill tool into the parallel executor (Part B fix)

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — parallel agent init (~lines 1706–1728), `makeParallelLLMCalls` (~lines 1882–1900), final collection loop (~lines 1833–1851)

**Interfaces:**
- Consumes: `getBoundSkillScripts` and `buildRunSkillScriptTool` (both already exist), `SkillToolChoice::forProvider` (Task 5).
- Produces: skill-bound fan-out nodes are handed `run_skill_script`, forced to call it on round 0, and a node still pending at `maxRounds` finishes with non-empty output + `success=false`.

**Why no unit test here:** exercising the parallel loop needs live LLM calls. The bug-prone pure piece (provider shape) is unit-tested in Task 5; the rest is verified by lint + Task 7 manual run.

- [ ] **Step 1: Inject the tool + set the force flag during init**

In `executeAgentsInParallel`, replace the tool-building lines (currently ~1706–1708):

```php
            // Get tools for this agent
            $toolsFilter = !empty($config['tools']) ? $config['tools'] : ($agent->getTools() ?? []);
            $tools = $this->buildToolsForParallelAgent($agent, $toolsFilter);
```

with:

```php
            // Get tools for this agent
            $toolsFilter = !empty($config['tools']) ? $config['tools'] : ($agent->getTools() ?? []);
            $tools = $this->buildToolsForParallelAgent($agent, $toolsFilter);

            // If the node is bound to a folder-backed skill, declare
            // run_skill_script here too (the sequential path does this in
            // runAgentNode). Without it the agent has no way to run its
            // skill in a fan-out and loops empty tool-call rounds to the cap.
            $forceSkillFirstRound = false;
            $skillScripts = $this->getBoundSkillScripts($config);
            $skillDirName = $config['bound_skill']['dir_name'] ?? null;
            if (!empty($skillScripts) && is_string($skillDirName) && $skillDirName !== '') {
                $tools[] = $this->buildRunSkillScriptTool([
                    'dir_name' => $skillDirName,
                    'scripts'  => $skillScripts,
                ]);
                $forceSkillFirstRound = true;
            }
```

- [ ] **Step 2: Store the force flag in the agent state**

In the `$agentStates[$nodeId] = [ ... ]` array literal (~lines 1715–1728), add one key (e.g. after `'tools_filter' => $toolsFilter,`):

```php
                'force_skill' => $forceSkillFirstRound,
```

- [ ] **Step 3: Inject `tool_choice` into the round-0 payload**

In `makeParallelLLMCalls`, the request is built then encoded (~lines 1883–1889). Replace:

```php
            $request = $this->buildAgentLLMRequestWithTools($state['agent'], $state['messages'], $state['tools']);
            if (!$request) continue;
```

with:

```php
            $request = $this->buildAgentLLMRequestWithTools($state['agent'], $state['messages'], $state['tools']);
            if (!$request) continue;

            // Force the skill call until it has run once. The parallel path
            // builds requests via ProviderRequestFactory (no tool_choice
            // param), so inject the provider-shaped value into the payload.
            if (!empty($state['force_skill']) && empty($state['skill_ran'])) {
                $toolChoice = \AgentTeam\Services\SkillToolChoice::forProvider($request['provider']);
                if ($toolChoice !== null) {
                    $request['payload']['tool_choice'] = $toolChoice;
                }
            }
```

- [ ] **Step 4: Graceful exhaustion in the final collection loop**

In the final `foreach ($agentStates as $nodeId => $finalState)` loop (~line 1833), the runner reads `$finalState['output']` / `$finalState['success']`. A node still pending at `maxRounds` never set those. Just before building `$results[$nodeId]` (right after `$agent = $finalState['agent'];`), add:

```php
            // A node still pending at maxRounds never completed. Surface the
            // last assistant text (or an explicit message) instead of an empty
            // result, and mark it failed — so the node form shows *something*.
            if (empty($finalState['completed'])) {
                $lastText = '';
                foreach (array_reverse($finalState['messages'] ?? []) as $m) {
                    if (($m['role'] ?? '') === 'assistant' && is_string($m['content'] ?? null) && $m['content'] !== '') {
                        $lastText = $m['content'];
                        break;
                    }
                }
                $finalState['output'] = $lastText !== ''
                    ? $lastText
                    : 'Agent did not finish within the tool-round limit (likely stuck calling its skill).';
                $finalState['success'] = false;
            }
```

- [ ] **Step 5: Lint**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "fix: give skill-bound parallel nodes run_skill_script + forced first call"
```

---

### Task 7: Frontend readback — store runId + hydrate node form from persisted events

**Files:**
- Modify: `backend/../frontend/assets/js/workflow-editor.js`
  - `workflow_start` handler (~line 9565) — capture `run_id`
  - new methods `hydrateNodeDataFromRun` + `_applyRunEventToNodeData`
  - `showAgentEditForm` (~line 10958) — hydrate when in-memory data is missing

**Interfaces:**
- Consumes: `GET /api/v1/workflows/runs/{runId}/events` (Task 4); `this.apiBase`, `this.getAuthHeaders()`, `this.dbNodeToDrawflowMap`, `this.nodeExecutionData`, `this.editingNodeId`, `updateModalInputOutput`.
- Produces: opening a node form after a run (or after reload / a dead run) shows input/output/logs replayed from the JSONL.

**Verification:** manual (no JS test runner). Steps below.

- [ ] **Step 1: Capture `run_id` on `workflow_start`**

In the `case 'workflow_start':` handler (~line 9565), where it clears `this.nodeExecutionData = {}`, add capture + persistence right after the clear:

```javascript
        case 'workflow_start':
            // Clear previous execution data for fresh run
            this.nodeExecutionData = {};
            if (event.run_id) {
                this.currentRunId = event.run_id;
                try {
                    const wfKey = this.currentWorkflowId || 'unsaved';
                    localStorage.setItem('lastRunId:' + wfKey, event.run_id);
                } catch (e) { /* localStorage may be unavailable; non-fatal */ }
            }
```

(If the handler has more lines after the clear, keep them — only insert the `if (event.run_id)` block.)

- [ ] **Step 2: Add the replay + hydrate methods**

Add these two methods to the editor class (anywhere among the other methods, e.g. just before `updateModalInputOutput`):

```javascript
    // Map one persisted run event into this.nodeExecutionData, mirroring the
    // live SSE handlers, so a node form can be populated from the JSONL log.
    _applyRunEventToNodeData(event) {
        const dfId = this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id;
        if (dfId == null) return;
        if (!this.nodeExecutionData[dfId]) this.nodeExecutionData[dfId] = {};
        const nd = this.nodeExecutionData[dfId];

        switch (event.type) {
            case 'node_start':
                if (event.input != null) nd.input = event.input;
                break;
            case 'node_complete':
                if (event.output !== undefined) nd.output = event.output;
                nd.inputTokens = event.input_tokens || 0;
                nd.outputTokens = event.output_tokens || 0;
                nd.totalTokens = nd.inputTokens + nd.outputTokens;
                nd.costUsd = (event.cost_usd !== undefined && event.cost_usd !== null) ? Number(event.cost_usd) : null;
                nd.agentName = event.agent_name || nd.agentName || null;
                nd.success = event.success !== false;
                break;
            case 'node_trace':
                if (!Array.isArray(nd.logs)) nd.logs = [];
                nd.logs.push({
                    dirName: event.skill_dir || '',
                    script: '',
                    argv: [],
                    exitCode: event.skill_exit_code ?? 0,
                    stdout: event.skill_stdout || '',
                    logMessages: event.skill_log_messages || '',
                    durationMs: 0,
                });
                if (event.success === false && event.error_text) nd.error = event.error_text;
                break;
            default:
                break; // client_tool_call logs already arrive live; ignore here
        }
    }

    // Fetch the persisted event log for a run and replay it into
    // nodeExecutionData. Cached per runId so reopening a form is cheap.
    async hydrateNodeDataFromRun(runId) {
        if (!runId) return false;
        if (this._hydratedRunId === runId) return true;
        try {
            const resp = await fetch(`${this.apiBase}/workflows/runs/${runId}/events`, {
                headers: this.getAuthHeaders(),
                credentials: 'include',
            });
            if (!resp.ok) return false;
            const data = await resp.json();
            const events = Array.isArray(data?.events) ? data.events : [];
            for (const ev of events) this._applyRunEventToNodeData(ev);
            this._hydratedRunId = runId;
            return true;
        } catch (e) {
            console.warn('[WorkflowEditor] hydrateNodeDataFromRun failed:', e);
            return false;
        }
    }
```

- [ ] **Step 3: Hydrate when opening a node form with no live data**

In `showAgentEditForm(agentId, nodeId)` (~line 10958), near the top where `this.editingNodeId` is set, add a hydration attempt when this node has no in-memory run data. Insert after `this.editingNodeId` is assigned:

```javascript
        // If we have no live execution data for this node (e.g. the editor was
        // reopened, the SSE dropped, or the run died), pull it from the
        // persisted run log so Input/Output/Logs are still debuggable.
        const _hasLive = this.nodeExecutionData?.[nodeId] &&
            (this.nodeExecutionData[nodeId].input != null ||
             this.nodeExecutionData[nodeId].output != null ||
             Array.isArray(this.nodeExecutionData[nodeId].logs));
        if (!_hasLive) {
            const wfKey = this.currentWorkflowId || 'unsaved';
            const runId = this.currentRunId || (() => {
                try { return localStorage.getItem('lastRunId:' + wfKey); } catch (e) { return null; }
            })();
            if (runId) {
                this.hydrateNodeDataFromRun(runId).then((ok) => {
                    if (ok) this.updateModalInputOutput(nodeId);
                });
            }
        }
```

(Use the variable name the method actually receives for the node id — it is `nodeId` in the current signature. If the modal keys by drawflow id elsewhere, keep using `nodeId` here to match `this.editingNodeId`.)

- [ ] **Step 4: Manual verification — the real run**

1. Start the app; open the workflow editor and load "GEO Parallel Audit".
2. Run it. Confirm in `backend/storage/workflow-runs/` a `{runId}.jsonl` file appears and grows during the run.
3. Confirm the two previously-stuck nodes (Content E-E-A-T / Platform Optimization) now emit a `client_tool_call` and finish with non-empty output (check the node form Output tab and the JSONL).
4. After the run completes, **reload the browser tab**, reopen the editor, and open one of those node forms. Confirm Input, Output, and Logs are populated (served from the JSONL via the events endpoint — verify a `GET /api/v1/workflows/runs/{runId}/events` request in the network panel).
5. Tail the run file to confirm event types:
   ```bash
   cd backend && tail -n 5 "$(ls -t storage/workflow-runs/*.jsonl | head -1)"
   ```
   Expected: lines with `"type":"node_start"` (has `input`), `"type":"node_trace"` (has `skill_stdout`), `"type":"node_complete"` (has `output`).

- [ ] **Step 5: Commit**

```bash
git add frontend/assets/js/workflow-editor.js
git commit -m "feat: hydrate node form from persisted run log when live data absent"
```

---

## Self-Review

**Spec coverage:**
- A1 persist-then-emit → Task 2. A2 run log file → Task 1. A3 `node_trace` skill logs → Task 3. A4 `run_id` to client → Task 2 Step 5 + Task 7 Step 1. A5 read endpoint → Task 4. A6 frontend hydration → Task 7. ✓
- B1 inject tool → Task 6 Step 1. B2 forced `tool_choice` payload injection → Task 5 + Task 6 Step 3. B3 graceful exhaustion → Task 6 Step 4. ✓
- Testing items 1–4 → WorkflowRunLog tests (Task 1) + SkillToolChoice tests (Task 5); runner-wiring verified by lint + the Task 7 manual run, as the spec's manual-verification clause allows. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `WorkflowRunLog::{append,read,defaultDir,pathFor}` and `SkillToolChoice::forProvider`/`TOOL_NAME` are used with the exact signatures defined in Tasks 1 and 5. `read()` returns `?array` (null = missing) consistently in Tasks 1 and 4. State key `force_skill` / `skill_ran` consistent across Task 6 steps. ✓

**Risk note (carried from spec):** run-log disk growth and retention/cleanup are intentionally out of scope — follow-up task.
