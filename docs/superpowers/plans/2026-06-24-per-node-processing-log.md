# Per-Node Processing Log (Observability v2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the node form's Logs tab into a live + replayable per-node activity timeline for both executors, and persist each node's outcome the instant it happens.

**Architecture:** A pure formatter (`NodeLogFormat`) produces consistent milestone strings; a `nodeLog()` helper on the runner writes them to `error_log` AND emits a new `node_log` event through the existing persist-then-emit pipeline (JSONL + SSE). Milestone calls are added to both executors. The parallel executor is refactored to emit each node's `node_complete`/`node_trace`/terminal `node_log` the moment it finishes (not in a deferred final loop). The frontend appends `node_log` events into a per-node `activity[]` and renders the Logs tab as a chronological timeline, live and on replay.

**Tech Stack:** PHP 8 (PSR-4 `AgentTeam\` → `src/AgentTeam/`), PHPUnit 10, vanilla JS frontend (drawflow). Spec: `docs/superpowers/specs/2026-06-24-per-node-processing-log-design.md`. Builds on `2026-06-24-workflow-node-observability-design.md` (v1: `WorkflowRunLog`, `emitNodeEvent` persist-then-emit, `_applyRunEventToNodeData` hydration).

## Global Constraints

- PHP src namespace `AgentTeam\` → `backend/src/AgentTeam/`; test namespace `Quantis\AIPortfolioAssistant\Tests\` → `backend/tests/`. Run tests from `backend/` with `php vendor/bin/phpunit <path>` (the bare `vendor/bin/phpunit` may be permission-denied on this host; prefix `php`).
- `node_log` event payload fields: `level` (`info|warn|error`), `phase` (`llm|tool|skill|analysis|done|error`), `message` (string), `data` (object, optional). `node_id`/`drawflow_id`/`timestamp` are added by `emitNodeEvent`.
- `nodeLog()` and all logging MUST never throw into the run path (delegates to `emitNodeEvent`, already failure-tolerant).
- Frontend `nodeExecutionData` is keyed by `this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id` — use this exact expression so live and hydrated data agree (v1 invariant).
- Do NOT remove existing `error_log()` calls. `nodeLog()` is additive.
- No new persistence layer or endpoint. No verbose per-round token/HTTP spam.
- Commit after every task.

---

### Task 1: `NodeLogFormat` — pure milestone message formatter

**Files:**
- Create: `backend/src/AgentTeam/Services/NodeLogFormat.php`
- Test: `backend/tests/Unit/AgentTeam/NodeLogFormatTest.php`

**Interfaces:**
- Produces (all `public static` on `AgentTeam\Services\NodeLogFormat`):
  - `callingProvider(string $provider, ?string $model): string`
  - `modelRequestedTool(string $tool): string`
  - `modelRespondedText(): string`
  - `runningSkill(string $dir): string`
  - `skillFinished(?int $exitCode, ?int $bytes): string`
  - `skillTimedOut(int $seconds): string`
  - `completed(int $tokens, ?float $costUsd): string`
  - `httpError(int $httpCode, string $message): string`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/AgentTeam/NodeLogFormatTest.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\NodeLogFormat;

class NodeLogFormatTest extends TestCase
{
    public function testCallingProviderWithModel(): void
    {
        $this->assertSame('calling grok (grok-4-fast)', NodeLogFormat::callingProvider('grok', 'grok-4-fast'));
    }

    public function testCallingProviderWithoutModel(): void
    {
        $this->assertSame('calling grok', NodeLogFormat::callingProvider('grok', null));
        $this->assertSame('calling grok', NodeLogFormat::callingProvider('grok', ''));
    }

    public function testModelRequestedTool(): void
    {
        $this->assertSame('model requested run_skill_script', NodeLogFormat::modelRequestedTool('run_skill_script'));
    }

    public function testModelRespondedText(): void
    {
        $this->assertSame('model responded with text', NodeLogFormat::modelRespondedText());
    }

    public function testRunningSkill(): void
    {
        $this->assertSame('running skill GEO/geo-content', NodeLogFormat::runningSkill('GEO/geo-content'));
    }

    public function testSkillFinished(): void
    {
        $this->assertSame('skill finished (exit 0, 1240 bytes)', NodeLogFormat::skillFinished(0, 1240));
        $this->assertSame('skill finished (exit unknown, 0 bytes)', NodeLogFormat::skillFinished(null, null));
    }

    public function testSkillTimedOut(): void
    {
        $this->assertSame('skill timed out after 300s', NodeLogFormat::skillTimedOut(300));
    }

    public function testCompletedWithCost(): void
    {
        $this->assertSame('completed (1840 tok, $0.0041)', NodeLogFormat::completed(1840, 0.0041));
    }

    public function testCompletedWithoutCost(): void
    {
        $this->assertSame('completed (1840 tok)', NodeLogFormat::completed(1840, null));
    }

    public function testHttpError(): void
    {
        $this->assertSame(
            'HTTP 400 — Thinking mode does not support this tool_choice',
            NodeLogFormat::httpError(400, 'Thinking mode does not support this tool_choice')
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/NodeLogFormatTest.php`
Expected: FAIL — `Class "AgentTeam\Services\NodeLogFormat" not found`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/AgentTeam/Services/NodeLogFormat.php`:

```php
<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Pure formatters for per-node processing-log lines (the node_log event's
 * `message`). Kept separate so both executors emit identical wording and the
 * strings are unit-testable without constructing the runner.
 */
final class NodeLogFormat
{
    public static function callingProvider(string $provider, ?string $model): string
    {
        return ($model !== null && $model !== '')
            ? "calling {$provider} ({$model})"
            : "calling {$provider}";
    }

    public static function modelRequestedTool(string $tool): string
    {
        return "model requested {$tool}";
    }

    public static function modelRespondedText(): string
    {
        return 'model responded with text';
    }

    public static function runningSkill(string $dir): string
    {
        return "running skill {$dir}";
    }

    public static function skillFinished(?int $exitCode, ?int $bytes): string
    {
        $exit = $exitCode === null ? 'unknown' : (string) $exitCode;
        return "skill finished (exit {$exit}, " . (int) $bytes . ' bytes)';
    }

    public static function skillTimedOut(int $seconds): string
    {
        return "skill timed out after {$seconds}s";
    }

    public static function completed(int $tokens, ?float $costUsd): string
    {
        return $costUsd !== null
            ? sprintf('completed (%d tok, $%.4f)', $tokens, $costUsd)
            : sprintf('completed (%d tok)', $tokens);
    }

    public static function httpError(int $httpCode, string $message): string
    {
        return "HTTP {$httpCode} — {$message}";
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/NodeLogFormatTest.php`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/NodeLogFormat.php backend/tests/Unit/AgentTeam/NodeLogFormatTest.php
git commit -m "feat: NodeLogFormat — pure milestone message formatter"
```

---

### Task 2: `nodeLog()` helper on the runner

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` (add a private method near `emitNodeEvent`, ~line 168)

**Interfaces:**
- Consumes: `emitNodeEvent` (v1).
- Produces: `private function nodeLog(array $node, string $level, string $phase, string $message, array $data = []): void` — used by Tasks 3 and 5.

**Why no unit test:** constructing the runner needs a live PDO + repositories (same as v1's emit methods). Verified by `php -l` + the Task 6 manual run.

- [ ] **Step 1: Add the helper immediately after `emitNodeEvent`**

In `GraphWorkflowRunner.php`, right after the closing brace of `emitNodeEvent` (the method that ends with `$this->streamContext->emit($data);` then `}`), add:

```php
    /**
     * Narrate one per-node processing milestone: write it to the server log
     * (unchanged low-level record) AND emit a structured node_log event that
     * v1's pipeline persists to the run JSONL and streams over SSE. Never
     * throws into the run path.
     */
    private function nodeLog(array $node, string $level, string $phase, string $message, array $data = []): void
    {
        error_log("[GraphWorkflowRunner] node " . ($node['id'] ?? '?') . " {$phase}: {$message}");
        $this->emitNodeEvent('node_log', $node, [
            'level'   => $level,
            'phase'   => $phase,
            'message' => $message,
            'data'    => $data,
        ]);
    }
```

- [ ] **Step 2: Lint**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "feat: nodeLog() helper — error_log + node_log event"
```

---

### Task 3: Parallel executor milestones

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — `executeAgentsInParallel` round loop (~1782–1864) and `roundTripClientToolInParallel` (~2131–2146)

**Interfaces:**
- Consumes: `nodeLog()` (Task 2), `NodeLogFormat` (Task 1).
- Produces: `node_log` events for the parallel path's milestones.

**Why no unit test:** live-LLM path; verified by `php -l` + Task 6 manual run.

- [ ] **Step 1: Add `llm` + `tool`/`analysis` milestones in the round loop**

In `executeAgentsInParallel`, in the `foreach ($responses as $nodeId => $response)` loop:

Replace the error branch (currently):

```php
                if (!$response['success']) {
                    $state['completed'] = true;
                    $state['output'] = 'Error: ' . ($response['error'] ?? 'Unknown error');
                    $state['success'] = false;
                    continue;
                }
```

with (adds an `error` milestone; terminal emit itself comes in Task 4):

```php
                if (!$response['success']) {
                    $state['completed'] = true;
                    $state['output'] = 'Error: ' . ($response['error'] ?? 'Unknown error');
                    $state['success'] = false;
                    $this->nodeLog($state['node'], 'error', 'error',
                        $response['error'] ?? 'Unknown error');
                    continue;
                }
```

Then, just inside the `if (!empty($parsed['tool_calls'])) {` block, right after its existing
`error_log("[GraphWorkflowRunner] Agent {$agent->getName()} requested ...")` line, add:

```php
                    $this->nodeLog($state['node'], 'info', 'llm',
                        \AgentTeam\Services\NodeLogFormat::modelRequestedTool(
                            $parsed['tool_calls'][0]['function']['name']
                                ?? $parsed['tool_calls'][0]['name'] ?? 'a tool'));
```

And in the `else { // No tool calls - agent is done` branch, right after
`$state['usage'] = $parsed['usage'] ?? null;`, add:

```php
                    $this->nodeLog($state['node'], 'info', 'llm',
                        \AgentTeam\Services\NodeLogFormat::modelRespondedText());
```

- [ ] **Step 2: Add `skill` start/finish milestones in `roundTripClientToolInParallel`**

In `roundTripClientToolInParallel`, right before `$this->emitNodeEvent('client_tool_call', …)`, add:

```php
        $this->nodeLog($node, 'info', 'skill',
            \AgentTeam\Services\NodeLogFormat::runningSkill($dirName ?? 'skill'),
            ['dir_name' => $dirName]);
```

Replace the timeout branch (currently):

```php
        $bridgeResult = $bridge->awaitResult($toolCallId);
        if ($bridgeResult === null) {
            error_log("[GraphWorkflowRunner] parallel client-tool bridge timed out for tool_call_id={$toolCallId}");
            return json_encode(['error' => 'Browser timed out running skill script. Keep the workflow editor open during the run.']);
        }
```

with:

```php
        $bridgeResult = $bridge->awaitResult($toolCallId);
        if ($bridgeResult === null) {
            error_log("[GraphWorkflowRunner] parallel client-tool bridge timed out for tool_call_id={$toolCallId}");
            $this->nodeLog($node, 'error', 'skill', \AgentTeam\Services\NodeLogFormat::skillTimedOut(300));
            return json_encode(['error' => 'Browser timed out running skill script. Keep the workflow editor open during the run.']);
        }
        $stdoutBytes = strlen(is_string($bridgeResult['output']['stdout'] ?? null) ? $bridgeResult['output']['stdout'] : '');
        $this->nodeLog($node, 'info', 'skill',
            \AgentTeam\Services\NodeLogFormat::skillFinished($bridgeResult['output']['exit_code'] ?? null, $stdoutBytes));
```

- [ ] **Step 3: Lint**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "feat: parallel executor emits node_log milestones (llm/skill)"
```

---

### Task 4: Parallel immediate terminal emit (Part C)

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — `executeAgentsInParallel` round loop terminal points + final collection loop (~1782–1926)

**Interfaces:**
- Consumes: `nodeLog()` (Task 2), `NodeLogFormat` (Task 1), `emitNodeEvent`/`recordExecutionTrace`/`computeNodeCost` (existing).
- Produces: a private `finalizeParallelNode(int $nodeId, array $state, array &$results): void` that emits `node_complete` + `node_trace` + a terminal `node_log`, accumulates tokens once, fills `$results[$nodeId]`, and is idempotent via a `$this->parallelEmitted` set.

**Why no unit test:** live-LLM path; verified by `php -l` + Task 6 manual (including the abort-mid-run check).

- [ ] **Step 1: Add an emitted-set field**

Near the other private fields (e.g. just after `private array $skillResultByNode = [];`), add:

```php
    /** @var array<int,bool> parallel nodes already finalized/emitted this run */
    private array $parallelEmitted = [];
```

- [ ] **Step 2: Add the `finalizeParallelNode` helper**

Add this private method directly above `executeAgentsInParallel`:

```php
    /**
     * Finalize one parallel node: accumulate its tokens once, record the
     * result, and emit node_complete + node_trace + a terminal node_log.
     * Idempotent — a node is emitted at most once whether it finishes inside
     * the round loop (immediate) or is swept by the final loop (defensive).
     */
    private function finalizeParallelNode(int $nodeId, array $state, array &$results): void
    {
        if (!empty($this->parallelEmitted[$nodeId])) {
            return;
        }
        $this->parallelEmitted[$nodeId] = true;

        $agent = $state['agent'];
        $usage = $state['usage'] ?? null;
        $inputTokens = $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0;
        $outputTokens = $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0;
        $this->totalInputTokens += $inputTokens;
        $this->totalOutputTokens += $outputTokens;

        $success = (bool) ($state['success'] ?? false);
        $output = $state['output'] ?? null;
        $cost = $this->computeNodeCost($agent->getProvider(), $inputTokens, $outputTokens);

        $results[$nodeId] = [
            'type' => 'agent',
            'agent_id' => $agent->getId(),
            'agent_name' => $agent->getName(),
            'input' => $state['input'] ?? '',
            'output' => $output,
            'success' => $success,
            'usage' => $usage,
        ];

        if ($success) {
            $this->nodeLog($state['node'], 'info', 'done',
                \AgentTeam\Services\NodeLogFormat::completed($inputTokens + $outputTokens, $cost));
        }

        $this->emitNodeEvent('node_complete', $state['node'], [
            'agent_name' => $agent->getName(),
            'success' => $success,
            'output' => $output,
            'input_tokens' => $inputTokens,
            'output_tokens' => $outputTokens,
            'cost_usd' => $cost,
        ]);

        $this->recordExecutionTrace($state['node'], $agent->getProvider(),
            method_exists($agent, 'getModel') ? $agent->getModel() : null,
            $success, $output, $inputTokens, $outputTokens);
    }
```

- [ ] **Step 3: Call it at the two terminal points in the round loop**

In the error branch (the `if (!$response['success'])` block from Task 3), after the
`$this->nodeLog(... 'error' ...)` line and before `continue;`, add:

```php
                    $this->finalizeParallelNode((int) $nodeId, $state, $results);
```

In the `else { // No tool calls - agent is done }` branch, after the
`$this->nodeLog(... modelRespondedText ...)` line you added in Task 3 and after the existing
`error_log("[GraphWorkflowRunner] Agent {$agent->getName()} completed in {$responseTime}ms");`,
add:

```php
                    $this->finalizeParallelNode((int) $nodeId, $state, $results);
```

- [ ] **Step 4: Replace the final collection loop body to defer to the helper**

Replace the entire final collection loop (from `// Collect final results` through the closing
`}` of its `foreach`, i.e. the block currently spanning the
`foreach ($agentStates as $nodeId => $finalState) { … recordExecutionTrace(…); }`) with:

```php
        // Collect final results. Most nodes already finalized inside the round
        // loop (immediate emit); this sweep handles any never-completed node
        // (e.g. still pending at maxRounds) so it still reports an outcome.
        error_log("[GraphWorkflowRunner] Final agentStates keys: " . implode(',', array_keys($agentStates)));
        foreach ($agentStates as $nodeId => $finalState) {
            if (!empty($this->parallelEmitted[$nodeId])) {
                continue;
            }
            // Never completed: surface the last assistant text (or an explicit
            // message) instead of an empty result, and mark it failed.
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
                $this->nodeLog($finalState['node'], 'error', 'error',
                    'did not finish within the tool-round limit');
            }
            $this->finalizeParallelNode((int) $nodeId, $finalState, $results);
        }
```

- [ ] **Step 5: Reset the emitted-set at run start**

In `run()` (near `$this->skillResultByNode = [];`, ~line 223), add:

```php
        $this->parallelEmitted = [];
```

- [ ] **Step 6: Lint + grep checks**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

Run: `cd backend && grep -n "finalizeParallelNode\|parallelEmitted" src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: field declared + reset in `run()` + 1 helper def + 3 call sites (2 round-loop, 1 final sweep); `parallelEmitted` guard in helper and final loop. Confirm there is no longer a second `$this->totalInputTokens +=` inside the final loop (token accumulation now lives only in `finalizeParallelNode`).

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "feat: parallel nodes emit outcome immediately (survive hang/abort)"
```

---

### Task 5: Sequential executor milestones

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — `runAgentNode` (~812–874) and `runAgentWithClientToolBridge` (~1083–1200)

**Interfaces:**
- Consumes: `nodeLog()` (Task 2), `NodeLogFormat` (Task 1).
- Produces: `node_log` milestones for the sequential path.

**Why no unit test:** live-LLM path; verified by `php -l` + Task 6 manual run.

- [ ] **Step 1: `llm` + `done` milestones in `runAgentNode`**

In `runAgentNode`, immediately before the `$result = $this->runAgentWithClientToolBridge(` call,
add:

```php
        $this->nodeLog($node, 'info', 'llm',
            \AgentTeam\Services\NodeLogFormat::callingProvider($agent->getProvider(), $agent->getModel()));
```

After that call returns and `$rawOutput` is computed (right after the
`$rawOutput = $result['text'] ?? $result['output'] ?? '';` line), add:

```php
        $this->nodeLog($node, 'info', 'analysis', 'generating final output');
```

- [ ] **Step 2: `skill` start/finish milestones in `runAgentWithClientToolBridge`**

In `runAgentWithClientToolBridge`, right before its `$this->emitNodeEvent('client_tool_call', …)`
call, add:

```php
            $this->nodeLog($node, 'info', 'skill',
                \AgentTeam\Services\NodeLogFormat::runningSkill(
                    $runContext['skill_metadata']['dir_name'] ?? 'skill'));
```

Replace the sequential bridge timeout branch (currently):

```php
            $bridgeResult = $bridge->awaitResult($toolCallId);
            if ($bridgeResult === null) {
                error_log("[GraphWorkflowRunner] bridge timed out waiting for tool_call_id={$toolCallId}");
                throw new \RuntimeException("Browser timed out running skill script. Make sure the workflow editor stayed open during the run.");
            }
```

with:

```php
            $bridgeResult = $bridge->awaitResult($toolCallId);
            if ($bridgeResult === null) {
                error_log("[GraphWorkflowRunner] bridge timed out waiting for tool_call_id={$toolCallId}");
                $this->nodeLog($node, 'error', 'skill', \AgentTeam\Services\NodeLogFormat::skillTimedOut(300));
                throw new \RuntimeException("Browser timed out running skill script. Make sure the workflow editor stayed open during the run.");
            }
            $seqStdoutBytes = strlen(is_string($bridgeResult['output']['stdout'] ?? null) ? $bridgeResult['output']['stdout'] : '');
            $this->nodeLog($node, 'info', 'skill',
                \AgentTeam\Services\NodeLogFormat::skillFinished($bridgeResult['output']['exit_code'] ?? null, $seqStdoutBytes));
```

- [ ] **Step 3: Lint**

Run: `cd backend && php -l src/AgentTeam/Services/GraphWorkflowRunner.php`
Expected: `No syntax errors detected`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php
git commit -m "feat: sequential executor emits node_log milestones"
```

---

### Task 6: Frontend — activity timeline in the Logs tab

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — live SSE switch (~`case 'node_complete':`, around line 9600), `_applyRunEventToNodeData` (added in v1 Task 7), and the Logs-tab renderer (`getNodeLogsHtml`/`_renderNodeLogs`, ~line 12110+)

**Interfaces:**
- Consumes: `node_log` events; `this.nodeExecutionData`, `this.dbNodeToDrawflowMap`, `this.updateModalInputOutput`, `this.editingNodeId`, `this.escapeHtml`.
- Produces: a per-node `activity[]` and a chronological Logs-tab timeline (live + replay).

**Verification:** `node --check` + manual (no JS test runner).

- [ ] **Step 1: Live `node_log` SSE handler**

In `handleWorkflowEvent`'s `switch`, add a `case 'node_log':` (next to `node_complete`):

```javascript
        case 'node_log': {
            const dfId = this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id;
            if (dfId != null) {
                if (!this.nodeExecutionData[dfId]) this.nodeExecutionData[dfId] = {};
                if (!Array.isArray(this.nodeExecutionData[dfId].activity)) this.nodeExecutionData[dfId].activity = [];
                this.nodeExecutionData[dfId].activity.push({
                    ts: event.timestamp || 0,
                    level: event.level || 'info',
                    phase: event.phase || '',
                    message: event.message || '',
                });
                this.updateModalInputOutput(dfId);
            }
            break;
        }
```

- [ ] **Step 2: Hydration branch (replay)**

In `_applyRunEventToNodeData(event)` (the method v1 added), add a `case 'node_log':` to its
`switch (event.type)` that mirrors Step 1's append:

```javascript
            case 'node_log':
                if (!Array.isArray(nd.activity)) nd.activity = [];
                nd.activity.push({
                    ts: event.timestamp || 0,
                    level: event.level || 'info',
                    phase: event.phase || '',
                    message: event.message || '',
                });
                break;
```

(`nd` is the per-node object already resolved at the top of `_applyRunEventToNodeData`.)

- [ ] **Step 3: Render the timeline in the Logs tab**

Locate `getNodeLogsHtml(nodeId)` (or `_renderNodeLogs`). Add a timeline block built from
`activity[]` merged with the existing skill `logs[]`, sorted by `ts`. Insert this just below
the status badge / error box and above (or merged with) the existing skill-log entries:

```javascript
        // Per-node activity timeline (node_log events), interleaved with skill
        // runs by timestamp. Empty array => render nothing (no behavior change
        // for nodes that produced no activity).
        const nd = this.nodeExecutionData[nodeId] || {};
        const activity = Array.isArray(nd.activity) ? nd.activity : [];
        const timelineRows = activity
            .slice()
            .sort((a, b) => (a.ts || 0) - (b.ts || 0))
            .map(a => {
                const color = a.level === 'error' ? '#e5534b' : (a.level === 'warn' ? '#d9a23a' : '#8a8f98');
                const icon = a.phase === 'skill' ? '▶' : (a.phase === 'done' ? '✓' : (a.phase === 'error' ? '✗' : '→'));
                return `<div style="font-family:monospace;font-size:12px;color:${color};white-space:pre-wrap;">`
                    + `${icon} ${this.escapeHtml(a.message)}</div>`;
            })
            .join('');
        const timelineHtml = timelineRows
            ? `<div style="margin:6px 0;padding:6px;background:#1116;border-radius:4px;">${timelineRows}</div>`
            : '';
```

Then include `${timelineHtml}` in the returned markup for the Logs tab, before the existing
skill-log entries section.

- [ ] **Step 4: Syntax check**

Run: `node --check frontend/assets/js/workflow-editor.js`
Expected: no output (valid).

Run: `grep -n "case 'node_log'\|\.activity" frontend/assets/js/workflow-editor.js`
Expected: the live handler case, the hydration case, and the render block all present.

- [ ] **Step 5: Commit**

```bash
git add frontend/assets/js/workflow-editor.js
git commit -m "feat: node form Logs tab renders live + replayed activity timeline"
```

- [ ] **Step 6: Manual verification (user-run, with the live app)**

1. Hard-reload the editor; run GEO Parallel Audit (single run, let it finish).
2. Open a node's form → Logs tab while it runs: confirm a live timeline appears
   (`calling … → model requested run_skill_script → running skill … → skill finished … → completed …`).
3. Confirm an erroring node (e.g. a provider that 400s) shows an immediate red `✗ HTTP 400 — …`
   line, and that the line **survives an abort**: stop the run, reload the tab, reopen the
   node form → the timeline is still there (served from the JSONL).
4. Run a sequential workflow → confirm the same timeline appears.
5. Tail the run file to confirm the new events:
   ```bash
   cd backend && grep -o '"type":"node_log"[^}]*"phase":"[a-z]*"' "$(ls -t storage/workflow-runs/*.jsonl | head -1)" | head
   ```

---

## Self-Review

**Spec coverage:**
- A1 `node_log` schema → Task 2 (emit) + Task 6 (consume). A2 `nodeLog()` helper → Task 2.
- Part B milestones (both executors) → Task 3 (parallel) + Task 5 (sequential), strings from Task 1 `NodeLogFormat`.
- Part C immediate terminal emit + no double-emit/double-count → Task 4 (`parallelEmitted` set, token accumulation moved into `finalizeParallelNode`, final loop skips emitted).
- Part D frontend `activity[]` + live handler + hydration + timeline → Task 6.
- Testing item (pure formatter) → Task 1; manual abort-survival check → Task 6 Step 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `NodeLogFormat` static signatures used in Tasks 3/5 match Task 1. `nodeLog(array,string,string,string,array)` consistent across Tasks 2/3/4/5. `finalizeParallelNode(int,array,array&)` + `parallelEmitted` consistent within Task 4. `activity[]` item shape `{ts,level,phase,message}` identical in Task 6 Steps 1/2/3. Frontend keying matches the Global Constraints expression. ✓

**Risk note:** Task 4 is the highest-risk change (refactors the terminal/token path). Its grep check in Step 6 explicitly guards against a leftover second token accumulation. The final whole-branch review should focus there.
