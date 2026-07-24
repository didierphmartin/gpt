# Parallel Agent Delegation (CrewAI-style `run_agents_parallel`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ✅ AS-BUILT RECONCILIATION (shipped 2026-07-24)
>
> This document is the **pre-work plan**. The feature shipped in 8 commits (`f21e70b..1ea88a2`), reviewed clean, and was fast-forward-merged to local `main` (not pushed). The plan below is accurate for Tasks 1/2/4 **except** where noted here — read these deltas before trusting any code block as "what shipped":
>
> 1. **Task 3 was re-scoped: full dedup → PARTIAL dedup.** The graph runner does NOT extract its round loop. It keeps its own loop, skill-await, logging, and cost, and delegates ONLY the provider round via a new public `ParallelAgentExecutor::runConcurrentRound()`. It then deletes its four duplicated provider methods. The Task 3 section below (full-dedup) is superseded by `.superpowers/sdd/task-3-brief.md`.
> 2. **`ParallelRunObserver` + `ParallelClientToolBridge` do not exist in the shipped code.** They were built in Task 1, then **removed** in a final cleanup once the re-scope left them unused. Ignore every mention of them below. `ParallelAgentExecutor::__construct` and `AgentRunner::createParallelExecutor()` take no observer/bridge params.
> 3. **Task 2 result shape (fix):** every `results[]` item — including all four pre-flight error branches — carries the full 7 keys `index, agent, task, success, result, error, execution_id`. The Step-3 code below under-specified `task`/`result` on error paths; shipped code includes them, with a regression test.
> 4. **Task 4 (added):** TS `runAgentsParallel` rejects manager-type targets pre-flight (worker/standard only), mirroring PHP — not present in the original Step-3 code below.
> 5. **Task 1 (added):** the capped `curl_multi` round was split into a testable `dispatchChunk()` seam, with a test asserting the cap chunks + preserves keys.
>
> **Authoritative as-built record:** `.superpowers/sdd/progress.md` (per-task ledger), the git commits `f21e70b..1ea88a2`, and `.superpowers/sdd/task-*-report.md`.
>
> **Open follow-ups (not done):** (a) a live 2-node parallel-workflow smoke test — the graph fan-out path, `force_skill` injection, and >6-node chunking are the only runtime surfaces not unit-covered; (b) minor: a no-API-key sub-agent spins to the round cap before erroring (pre-existing graph behavior, left untouched).

**Goal:** Make `run_agents_parallel` actually execute its batch of delegated agents concurrently (fork-join) in both the PHP and TypeScript backends, and expose it to manager agents — so a manager that batches independent sub-agents runs them at once instead of one-at-a-time.

**Architecture:** PHP has no in-process threads, so concurrency comes from the round-based `curl_multi` engine that already powers workflow-graph fan-out inside `GraphWorkflowRunner`. We extract that engine into a standalone, unit-testable `ParallelAgentExecutor` (LLM rounds + server-tool execution + optional per-sub-agent `agent_executions` records + a concurrency cap), then call it from `AgentDelegationFunctions::runAgentsParallel`. We also rewire `GraphWorkflowRunner` to reuse the same executor (collapsing the two drifting parallel paths). *(As-built: this became a **partial** reuse — the graph delegates only the provider round, not the whole loop. See the AS-BUILT banner.)* TypeScript's `runner.run()` is already async and creates execution records natively, so there `run_agents_parallel` is a `Promise.all` (with a concurrency cap) over the existing `delegateToAgent` — no engine needed.

**Tech Stack:** PHP 8.1 (PHPUnit 10.5 + Mockery), TypeScript (Node `node:test` run via `tsx`), `curl_multi`, `ProviderRequestFactory` (unified multi-provider request/response), MySQL (`agent_executions`).

## Global Constraints

- PHP files: `declare(strict_types=1);`, namespace `AgentTeam\Services` for the new executor, `AgentTeam\Functions` for delegation. Follow existing file style.
- Providers are addressed ONLY through `Quantis\AIPortfolioAssistant\Providers\ProviderRequestFactory::buildRequest()` / `::parseResponse()`. Do not add provider-specific branches.
- Default concurrency cap: **6** concurrent LLM calls per round. Never fire an unbounded `curl_multi` batch.
- PHP and TS must stay behavior-compatible (per project history, the two run paths drift — keep the tool schema, tool name, and result shape identical across both).
- Sub-agent targets for `run_agents_parallel` are worker/standard agents only. Do NOT support nested managers in a parallel batch (matches CrewAI async-task behavior).
- PHP test command: `php vendor/bin/phpunit <path>` (run from `backend/`). TS test command: `npx tsx --test <path>` (run from `backend_typescript/`).
- No new npm/composer dependencies.

---

## File Structure

**PHP**
- Create `backend/src/AgentTeam/Services/ParallelAgentExecutor.php` — the extracted concurrency engine. Owns the round loop, `curl_multi` batching (capped), server-tool execution, provider config, and optional execution-record writes. Depends on `AgentRunner` (for `ToolsManager` + execution-record wrappers), `PDO`, and `config`. Collaborators (`ParallelRunObserver`, `ParallelClientToolBridge`) are injected and nullable.
- ~~Create `backend/src/AgentTeam/Services/ParallelRunObserver.php`~~ — **NOT in shipped code** (built then removed, banner #2).
- ~~Create `backend/src/AgentTeam/Services/ParallelClientToolBridge.php`~~ — **NOT in shipped code** (built then removed, banner #2).
- Modify `backend/src/AgentTeam/Services/AgentRunner.php` — add public `recordExecutionStart()`, `recordExecutionComplete()`, and `createParallelExecutor()` factory. Add `run_agents_parallel` to the manager tool set in `buildToolsForAgent()`.
- Modify `backend/src/AgentTeam/Functions/AgentDelegationFunctions.php` — replace the sequential `foreach` in `runAgentsParallel()` (currently lines 439–535) with state-building + a call to the executor.
- Modify `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` — `executeAgentsInParallel()` keeps Phase A (node/edge → state) and delegates the round loop (Phase B/C) to `ParallelAgentExecutor` via a graph-backed observer + client-tool-bridge adapter.

**TypeScript**
- Modify `backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts` — add `run_agents_parallel` to `toolNames()`, `getAllFunctions()`, and implement `runAgentsParallel()` (`Promise.all` + concurrency cap). Managers auto-receive it (they get `toolDefinitions()`) and `AgentToolsExecutor` auto-routes it (it keys off `toolNames()`).

**Tests**
- Create `backend/tests/Unit/AgentTeam/ParallelAgentExecutorTest.php`
- Create `backend/tests/Unit/AgentTeam/RunAgentsParallelTest.php`
- Create `backend_typescript/tests/RunAgentsParallel.test.ts`

---

## Task 1: PHP `ParallelAgentExecutor` — extract the concurrency engine

> **As-built:** shipped in `2f4f5fe` + `53ea8b0`. The `ParallelRunObserver`/`ParallelClientToolBridge` files described here were created here but **later removed** (see banner #2) — the shipped constructor is `__construct(AgentRunner, PDO, array $config, bool $recordExecutions = false, int $maxConcurrency = 6)`. The capped round was additionally split into a `protected dispatchChunk()` seam with a cap/key-preservation test (banner #5).

**Files:**
- Create: `backend/src/AgentTeam/Services/ParallelRunObserver.php`
- Create: `backend/src/AgentTeam/Services/ParallelClientToolBridge.php`
- Create: `backend/src/AgentTeam/Services/ParallelAgentExecutor.php`
- Modify: `backend/src/AgentTeam/Services/AgentRunner.php` (add public execution-record wrappers + `createParallelExecutor()`)
- Test: `backend/tests/Unit/AgentTeam/ParallelAgentExecutorTest.php`

**Interfaces:**
- Consumes: `AgentTeam\Models\Agent`; `AgentRunner::getToolsManager()`; `ProviderRequestFactory::buildRequest()/parseResponse()`; `AgentRunner::createExecution()/completeExecution()` (private — wrapped below).
- Produces:
  - `ParallelAgentExecutor::run(array $states, int $maxRounds = 10): array` — `$states` is a list of `['key'=>string|int, 'agent'=>Agent, 'input'=>string, 'messages'=>array, 'tools'=>array, 'tools_filter'=>?array]`. Returns `key => ['agent_id'=>?int,'agent_name'=>string,'input'=>string,'output'=>?string,'success'=>bool,'usage'=>?array,'execution_id'=>?int]`.
  - `ParallelAgentExecutor::buildToolsFor(Agent $agent, ?array $toolsFilter): array`.
  - `AgentRunner::createParallelExecutor(bool $recordExecutions, ?ParallelRunObserver $observer = null, ?ParallelClientToolBridge $bridge = null): ParallelAgentExecutor`.
  - `AgentRunner::recordExecutionStart(Agent $agent, int $userId, string $input): int`.
  - `AgentRunner::recordExecutionComplete(int $executionId, array $response, float $responseTimeMs): void`.
  - `protected ParallelAgentExecutor::callLLMs(array $states): array` — one concurrent round; overridable in tests. Returns `key => ['success'=>bool,'parsed'=>?array,'error'=>?string]`.

- [ ] **Step 1: Write the failing test**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Models\Agent;
use AgentTeam\Services\ParallelAgentExecutor;
use PHPUnit\Framework\TestCase;
use Mockery;

/** Executor subclass with the curl round replaced by a scripted fake. */
class FakeExecutor extends ParallelAgentExecutor
{
    /** @var array<int, array<string,array>> round index => (key => response) */
    public array $script = [];
    public int $round = 0;
    public array $seenBatchSizes = [];

    protected function callLLMs(array $states): array
    {
        $this->seenBatchSizes[] = count($states);
        $out = $this->script[$this->round] ?? [];
        $this->round++;
        // Only answer the keys still pending this round.
        return array_intersect_key($out, $states);
    }
}

final class ParallelAgentExecutorTest extends TestCase
{
    protected function tearDown(): void { Mockery::close(); }

    private function agent(int $id, string $name): Agent
    {
        return new Agent(['id' => $id, 'name' => $name, 'agent_type' => 'worker',
            'provider' => 'claude', 'instructions' => 'x']);
    }

    private function makeExecutor(): FakeExecutor
    {
        // ToolsManager stub: echoes a fixed string for any server tool.
        $tools = Mockery::mock();
        $tools->shouldReceive('execute')->andReturn('TOOL_OK');
        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getToolsManager')->andReturn($tools);
        $db = Mockery::mock(\PDO::class);
        // recordExecutions=false, no observer, no client bridge.
        return new FakeExecutor($runner, $db, [], false, null, null);
    }

    public function testTwoAgentsCompleteConcurrentlyInOneRound(): void
    {
        $exec = $this->makeExecutor();
        $exec->script = [
            0 => [
                'a' => ['success' => true, 'parsed' => ['text' => 'A done', 'tool_calls' => [], 'usage' => null]],
                'b' => ['success' => true, 'parsed' => ['text' => 'B done', 'tool_calls' => [], 'usage' => null]],
            ],
        ];
        $states = [
            ['key' => 'a', 'agent' => $this->agent(1, 'A'), 'input' => 'ta',
             'messages' => [['role' => 'user', 'content' => 'ta']], 'tools' => [], 'tools_filter' => null],
            ['key' => 'b', 'agent' => $this->agent(2, 'B'), 'input' => 'tb',
             'messages' => [['role' => 'user', 'content' => 'tb']], 'tools' => [], 'tools_filter' => null],
        ];
        $res = $exec->run($states);

        $this->assertTrue($res['a']['success']);
        $this->assertSame('A done', $res['a']['output']);
        $this->assertTrue($res['b']['success']);
        $this->assertSame('B done', $res['b']['output']);
        // Both were dispatched in the SAME batch (concurrency, not sequential).
        $this->assertSame([2], $exec->seenBatchSizes);
    }

    public function testToolCallDrivesAnotherRound(): void
    {
        $exec = $this->makeExecutor();
        $exec->script = [
            0 => ['a' => ['success' => true, 'parsed' => ['text' => null, 'usage' => null,
                'tool_calls' => [['id' => 't1', 'function' => ['name' => 'search', 'arguments' => '{}']]]]]],
            1 => ['a' => ['success' => true, 'parsed' => ['text' => 'final', 'tool_calls' => [], 'usage' => null]]],
        ];
        $states = [
            ['key' => 'a', 'agent' => $this->agent(1, 'A'), 'input' => 'ta',
             'messages' => [['role' => 'user', 'content' => 'ta']], 'tools' => [], 'tools_filter' => null],
        ];
        $res = $exec->run($states);

        $this->assertSame('final', $res['a']['output']);
        $this->assertSame(2, $exec->round); // took two rounds
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/ParallelAgentExecutorTest.php`
Expected: FAIL — `Class "AgentTeam\Services\ParallelAgentExecutor" not found`.

- [ ] **Step 3: Create the two collaborator interfaces**

Create `backend/src/AgentTeam/Services/ParallelRunObserver.php`:

```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use AgentTeam\Models\Agent;

/** Sink for parallel-run lifecycle events. Both callers implement this. */
interface ParallelRunObserver
{
    public function onAgentStart(string $key, Agent $agent, string $input): void;
    public function onAgentComplete(string $key, Agent $agent, bool $success, ?string $output, ?array $usage): void;
    public function log(string $key, string $level, string $phase, string $message): void;
}
```

Create `backend/src/AgentTeam/Services/ParallelClientToolBridge.php`:

```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/** Round-trips a browser-side (Pyodide) tool call. Graph supplies this; delegation passes null. */
interface ParallelClientToolBridge
{
    public function isClientSideTool(string $name): bool;
    /** Dispatch the tool call to the browser (non-blocking). */
    public function emit(array $toolCall, string $key, string $assistantText): void;
    /** Block until the browser posts the result back. */
    public function await(array $toolCall, string $key): string;
}
```

- [ ] **Step 4: Create the executor with the round loop and provider helpers**

Create `backend/src/AgentTeam/Services/ParallelAgentExecutor.php`. Move these four methods **verbatim** out of `GraphWorkflowRunner.php` into this class, changing only the noted `$this->` targets:

- `makeParallelLLMCalls()` (GraphWorkflowRunner lines 2044–2153) — but wrap its handle-adding loop in `array_chunk($agentStates, $this->maxConcurrency)` so each chunk is a separate `curl_multi` batch, merging `$responses` across chunks (this is the concurrency cap). Keep it as the body of the new `protected function callLLMs()`.
- `buildAgentLLMRequestWithTools()` (lines 2160–2189) — unchanged; it already calls `$this->getProviderConfigForParallel()` and `ProviderRequestFactory`.
- `parseParallelLLMResponse()` (lines 2195–2205) — unchanged.
- `getProviderConfigForParallel()` (lines 2338–end of method) — unchanged; reads `$this->db` and `$this->config`, both now executor fields.

Then write the new orchestration (this is the heart — real code, adapted from the round loop at GraphWorkflowRunner lines 1867–2004, with `$this->emit*`/`nodeLog`/`finalizeParallelNode` replaced by observer calls and the result map):

```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use AgentTeam\Models\Agent;
use Quantis\AIPortfolioAssistant\Providers\ProviderRequestFactory;
use PDO;

class ParallelAgentExecutor
{
    public function __construct(
        private AgentRunner $agentRunner,
        private PDO $db,
        private array $config,
        private bool $recordExecutions = false,
        private ?ParallelRunObserver $observer = null,
        private ?ParallelClientToolBridge $bridge = null,
        private int $maxConcurrency = 6
    ) {}

    /** @param array $states list of ['key','agent','input','messages','tools','tools_filter'] */
    public function run(array $states, int $maxRounds = 10): array
    {
        $agentStates = [];
        foreach ($states as $s) {
            $key = $s['key'];
            $agent = $s['agent'];
            $executionId = null;
            if ($this->recordExecutions && $agent->getId() !== null) {
                $executionId = $this->agentRunner->recordExecutionStart(
                    $agent, (int) ($s['user_id'] ?? 0), $s['input']);
            }
            $this->observer?->onAgentStart((string) $key, $agent, $s['input']);
            $agentStates[$key] = [
                'key' => $key,
                'agent' => $agent,
                'input' => $s['input'],
                'messages' => $s['messages'],
                'tools' => $s['tools'],
                'tools_filter' => $s['tools_filter'] ?? null,
                'execution_id' => $executionId,
                'completed' => false,
                'output' => '',
                'success' => false,
                'usage' => null,
                'start_time' => microtime(true),
            ];
        }

        $results = [];
        for ($round = 0; $round < $maxRounds; $round++) {
            $pending = array_filter($agentStates, fn($s) => !$s['completed']);
            if (empty($pending)) break;

            $responses = $this->callLLMs($pending);

            foreach ($responses as $key => $response) {
                $state = &$agentStates[$key];
                if (!($response['success'] ?? false)) {
                    $state['completed'] = true;
                    $state['success'] = false;
                    $state['output'] = 'Error: ' . ($response['error'] ?? 'Unknown error');
                    $this->finalize($key, $state, $results);
                    continue;
                }
                $parsed = $response['parsed'];
                if (!empty($parsed['tool_calls'])) {
                    $state['messages'][] = [
                        'role' => 'assistant',
                        'content' => $parsed['text'] ?? null,
                        'tool_calls' => $parsed['tool_calls'],
                    ];
                    foreach ($parsed['tool_calls'] as $tc) {
                        $name = $tc['function']['name'] ?? $tc['name'] ?? 'function';
                        if ($this->bridge && $this->bridge->isClientSideTool($name)) {
                            $this->bridge->emit($tc, (string) $key, $parsed['text'] ?? '');
                            $content = $this->bridge->await($tc, (string) $key);
                        } else {
                            $content = $this->executeServerTool($tc, $state['tools_filter']);
                        }
                        $state['messages'][] = [
                            'role' => 'tool',
                            'tool_call_id' => $tc['id'] ?? null,
                            'name' => $name,
                            'content' => is_string($content) ? $content : json_encode($content),
                        ];
                    }
                    // needs another round
                } else {
                    $state['completed'] = true;
                    $state['success'] = true;
                    $state['output'] = $parsed['text'] ?? '';
                    $state['usage'] = $parsed['usage'] ?? null;
                    $this->finalize($key, $state, $results);
                }
            }
            unset($state);
        }

        // Any agent that never finished within the round cap.
        foreach ($agentStates as $key => $state) {
            if (isset($results[$key])) continue;
            $state['success'] = false;
            $state['output'] = $state['output'] !== ''
                ? $state['output']
                : 'Agent did not finish within the tool-round limit.';
            $this->finalize($key, $state, $results);
        }
        return $results;
    }

    private function finalize(string|int $key, array $state, array &$results): void
    {
        $agent = $state['agent'];
        if ($this->recordExecutions && $state['execution_id']) {
            $rt = (microtime(true) - $state['start_time']) * 1000;
            $this->agentRunner->recordExecutionComplete((int) $state['execution_id'], [
                'text' => $state['output'] ?? '',
                'usage' => $state['usage'] ?? [],
                'tool_calls' => [],
            ], $rt);
        }
        $this->observer?->onAgentComplete((string) $key, $agent,
            (bool) $state['success'], $state['output'], $state['usage']);
        $results[$key] = [
            'agent_id' => $agent->getId(),
            'agent_name' => $agent->getName(),
            'input' => $state['input'] ?? '',
            'output' => $state['output'] ?? null,
            'success' => (bool) $state['success'],
            'usage' => $state['usage'] ?? null,
            'execution_id' => $state['execution_id'] ?? null,
        ];
    }

    public function buildToolsFor(Agent $agent, ?array $toolsFilter): array
    {
        $all = $this->agentRunner->getToolsManager()->getToolDefinitions();
        if (empty($toolsFilter)) return $all;
        return array_values(array_filter($all, fn($t) => in_array($t['name'], $toolsFilter, true)));
    }

    private function executeServerTool(array $toolCall, ?array $toolsFilter): string
    {
        $name = $toolCall['function']['name'] ?? '';
        $args = json_decode($toolCall['function']['arguments'] ?? '{}', true) ?? [];
        try {
            $result = $this->agentRunner->getToolsManager()->execute($name, $args);
            return is_string($result) ? $result : json_encode($result);
        } catch (\Exception $e) {
            return json_encode(['error' => $e->getMessage()]);
        }
    }

    /** One concurrent round via curl_multi (capped). Overridable in tests. */
    protected function callLLMs(array $agentStates): array
    {
        // ---- moved verbatim from GraphWorkflowRunner::makeParallelLLMCalls (2044-2153),
        //      with the handle-adding loop wrapped in array_chunk(..., $this->maxConcurrency)
        //      and $responses merged across chunks. See Step 4 notes above. ----
    }

    // ---- moved verbatim from GraphWorkflowRunner (adjust $this-> fields only) ----
    // private function buildAgentLLMRequestWithTools(Agent $agent, array $messages, array $tools): ?array  (2160-2189)
    // private function parseParallelLLMResponse(string $response, string $provider): array                 (2195-2205)
    // private function getProviderConfigForParallel(string $name): ?array                                  (2338-end)
}
```

- [ ] **Step 5: Add execution-record wrappers + factory to `AgentRunner`**

In `backend/src/AgentTeam/Services/AgentRunner.php`, add public methods (they wrap the existing private `createExecution()`/`completeExecution()`):

```php
    /** Public wrapper so ParallelAgentExecutor can log per-sub-agent executions. */
    public function recordExecutionStart(Agent $agent, int $userId, string $input): int
    {
        return $this->createExecution($agent, $userId, $input, []);
    }

    public function recordExecutionComplete(int $executionId, array $response, float $responseTimeMs): void
    {
        $this->completeExecution($executionId, $response, $responseTimeMs);
    }

    public function createParallelExecutor(
        bool $recordExecutions,
        ?\AgentTeam\Services\ParallelRunObserver $observer = null,
        ?\AgentTeam\Services\ParallelClientToolBridge $bridge = null
    ): \AgentTeam\Services\ParallelAgentExecutor {
        return new \AgentTeam\Services\ParallelAgentExecutor(
            $this, $this->db, $this->config, $recordExecutions, $observer, $bridge);
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/ParallelAgentExecutorTest.php`
Expected: PASS (2 tests, both green).

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/ParallelAgentExecutor.php \
        backend/src/AgentTeam/Services/ParallelRunObserver.php \
        backend/src/AgentTeam/Services/ParallelClientToolBridge.php \
        backend/src/AgentTeam/Services/AgentRunner.php \
        backend/tests/Unit/AgentTeam/ParallelAgentExecutorTest.php
git commit -m "feat(agentteam): extract ParallelAgentExecutor concurrency engine"
```

---

## Task 2: PHP — wire `run_agents_parallel` to the executor + expose it to managers

> **As-built:** shipped in `014885d` + `8070bf5`. Correction to the Step-3 code below: all four pre-flight error branches must include `'task'` and `'result'` keys so every `results[]` item has the full 7-key shape (banner #3). Shipped code does this and has a regression test asserting per-item key presence.

**Files:**
- Modify: `backend/src/AgentTeam/Functions/AgentDelegationFunctions.php:439-535` (`runAgentsParallel`)
- Modify: `backend/src/AgentTeam/Services/AgentRunner.php` (`buildToolsForAgent`, manager branch ~lines 526-560)
- Test: `backend/tests/Unit/AgentTeam/RunAgentsParallelTest.php`

**Interfaces:**
- Consumes: `AgentRunner::createParallelExecutor()`, `ParallelAgentExecutor::run()`, `ParallelAgentExecutor::buildToolsFor()` (Task 1); `AgentRunner::getFreshRepository()`; `Agent::buildSystemPrompt()`.
- Produces: `runAgentsParallel(array $params, $context): array` returns `['success'=>bool,'total_agents'=>int,'successful'=>int,'failed'=>int,'results'=>array,'message'=>string]` (unchanged shape). Each `results[]` item: `['index'=>int,'agent'=>string,'task'=>string,'success'=>bool,'result'=>?string,'error'=>?string,'execution_id'=>?int]`.

- [ ] **Step 1: Write the failing test**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Functions\AgentDelegationFunctions;
use AgentTeam\Models\Agent;
use PHPUnit\Framework\TestCase;
use Mockery;

final class RunAgentsParallelTest extends TestCase
{
    protected function tearDown(): void { Mockery::close(); }

    public function testRunsBatchThroughExecutorAndMapsResults(): void
    {
        $worker1 = new Agent(['id' => 5, 'name' => 'Researcher', 'agent_type' => 'worker', 'provider' => 'claude']);
        $worker2 = new Agent(['id' => 6, 'name' => 'Writer', 'agent_type' => 'worker', 'provider' => 'claude']);

        $repo = Mockery::mock(\AgentTeam\Services\AgentRepository::class);
        $repo->shouldReceive('findByName')->with('Researcher', Mockery::any())->andReturn($worker1);
        $repo->shouldReceive('findByName')->with('Writer', Mockery::any())->andReturn($worker2);
        $repo->shouldReceive('findById')->andReturnNull();

        // Fake executor: returns canned per-key results without any network.
        $executor = Mockery::mock(\AgentTeam\Services\ParallelAgentExecutor::class);
        $executor->shouldReceive('buildToolsFor')->andReturn([]);
        $executor->shouldReceive('run')->once()->andReturn([
            0 => ['agent_id' => 5, 'agent_name' => 'Researcher', 'output' => 'R', 'success' => true, 'usage' => null, 'execution_id' => 101],
            1 => ['agent_id' => 6, 'agent_name' => 'Writer', 'output' => 'W', 'success' => true, 'usage' => null, 'execution_id' => 102],
        ]);

        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getFreshRepository')->andReturn($repo);
        $runner->shouldReceive('createParallelExecutor')->andReturn($executor);

        $fns = new AgentDelegationFunctions($repo, $runner);
        $out = $fns->runAgentsParallel([
            'delegations' => [
                ['agent_name' => 'Researcher', 'task' => 'find X'],
                ['agent_name' => 'Writer', 'task' => 'write Y'],
            ],
        ], ['user_id' => 1, 'current_agent_id' => 1]);

        $this->assertTrue($out['success']);
        $this->assertSame(2, $out['successful']);
        $this->assertSame(0, $out['failed']);
        $this->assertSame('R', $out['results'][0]['result']);
        $this->assertSame('Writer', $out['results'][1]['agent']);
        $this->assertSame(102, $out['results'][1]['execution_id']);
    }

    public function testEmptyDelegationsIsAnError(): void
    {
        $repo = Mockery::mock(\AgentTeam\Services\AgentRepository::class);
        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $fns = new AgentDelegationFunctions($repo, $runner);
        $out = $fns->runAgentsParallel(['delegations' => []], ['user_id' => 1]);
        $this->assertFalse($out['success']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/RunAgentsParallelTest.php`
Expected: FAIL — `runAgentsParallel` still calls `delegateToAgent` sequentially (no `createParallelExecutor`), so the `createParallelExecutor` expectation is unmet.

- [ ] **Step 3: Rewrite `runAgentsParallel`**

Replace the body of `runAgentsParallel()` (`AgentDelegationFunctions.php:439-535`) with:

```php
    public function runAgentsParallel(array $params, $context = null): array
    {
        $delegations = $params['delegations'] ?? [];
        if (empty($delegations) || !is_array($delegations)) {
            return ['success' => false, 'error' => 'No delegations provided'];
        }

        $userId = $this->extractUserId($context);
        $currentAgentId = $this->extractCurrentAgentId($context);
        $streamContext = $this->extractStreamContext($context);

        if ($streamContext) {
            $streamContext->emit([
                'type' => 'parallel_start',
                'count' => count($delegations),
                'agents' => array_map(fn($d) => $d['agent_name'] ?? 'unknown', $delegations),
                'timestamp' => microtime(true),
            ]);
        }

        $repo = $this->runner->getFreshRepository();
        $executor = $this->runner->createParallelExecutor(true); // record executions; no observer/bridge
        $manager = $currentAgentId ? $repo->findById($currentAgentId) : null;

        // Build one state per valid delegation; collect index errors separately.
        $states = [];
        $indexByKey = [];
        $errors = [];
        foreach ($delegations as $index => $d) {
            $agentName = $d['agent_name'] ?? null;
            $task = $d['task'] ?? null;
            if (!$agentName || !$task) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName ?? 'unknown',
                    'success' => false, 'error' => 'Missing agent_name or task', 'execution_id' => null];
                continue;
            }
            $agent = $repo->findByName($agentName, $userId);
            if (!$agent || !$agent->isEnabled()) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName,
                    'success' => false, 'error' => "Agent not found or disabled: {$agentName}", 'execution_id' => null];
                continue;
            }
            if ($agent->isManager()) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName,
                    'success' => false, 'error' => 'Cannot run a manager agent in a parallel batch', 'execution_id' => null];
                continue;
            }
            if ($manager && !$manager->canDelegateToAgent($agent->getId())) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName,
                    'success' => false, 'error' => "Manager cannot delegate to '{$agentName}'", 'execution_id' => null];
                continue;
            }

            $input = $task;
            $ctx = trim($d['context'] ?? '');
            if ($ctx !== '') $input = "## Context from Previous Analysis\n{$ctx}\n\n## Your Task\n{$task}";

            $states[] = [
                'key' => $index,
                'agent' => $agent,
                'input' => $input,
                'user_id' => $userId,
                'messages' => [
                    ['role' => 'system', 'content' => $agent->buildSystemPrompt()],
                    ['role' => 'user', 'content' => $input],
                ],
                'tools' => $executor->buildToolsFor($agent, $agent->getTools() ?: null),
                'tools_filter' => $agent->getTools() ?: null,
            ];
            $indexByKey[$index] = $task;
        }

        $execResults = !empty($states) ? $executor->run($states) : [];

        // Merge executor results with pre-flight errors, preserving delegation order.
        $results = [];
        $successCount = 0;
        $failCount = 0;
        foreach ($delegations as $index => $d) {
            if (isset($errors[$index])) {
                $results[] = $errors[$index];
                $failCount++;
                continue;
            }
            $r = $execResults[$index] ?? ['success' => false, 'output' => null, 'execution_id' => null];
            $ok = (bool) ($r['success'] ?? false);
            $results[] = [
                'index' => $index,
                'agent' => $d['agent_name'],
                'task' => $indexByKey[$index] ?? ($d['task'] ?? ''),
                'success' => $ok,
                'result' => $r['output'] ?? null,
                'error' => $ok ? null : ($r['error'] ?? 'Agent did not complete'),
                'execution_id' => $r['execution_id'] ?? null,
            ];
            $ok ? $successCount++ : $failCount++;
        }

        if ($streamContext) {
            $streamContext->emit(['type' => 'parallel_complete',
                'successful' => $successCount, 'failed' => $failCount, 'timestamp' => microtime(true)]);
        }

        return [
            'success' => $failCount === 0,
            'total_agents' => count($delegations),
            'successful' => $successCount,
            'failed' => $failCount,
            'results' => $results,
            'message' => "Completed {$successCount} of " . count($delegations) . " delegations",
        ];
    }
```

- [ ] **Step 4: Expose `run_agents_parallel` to managers**

In `AgentRunner.php::buildToolsForAgent()`, inside the `if ($agent->getAgentType() === 'manager')` block (after the `complete_task` registration, ~line 557), add:

```php
            // Give managers run_agents_parallel to fan out independent sub-agents at once.
            if (isset($delegationFuncs['run_agents_parallel'])) {
                $func = $delegationFuncs['run_agents_parallel'];
                $tools['run_agents_parallel'] = [
                    'name' => 'run_agents_parallel',
                    'description' => $func['schema']['description'],
                    'input_schema' => $func['schema']['input_schema'],
                ];
            }
```

(`Agent::buildSystemPrompt()` already instructs managers to use `run_agents_parallel` — no prompt change needed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/RunAgentsParallelTest.php`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Functions/AgentDelegationFunctions.php \
        backend/src/AgentTeam/Services/AgentRunner.php \
        backend/tests/Unit/AgentTeam/RunAgentsParallelTest.php
git commit -m "feat(agentteam): run_agents_parallel executes concurrently + exposed to managers"
```

---

## Task 3: PHP — rewire `GraphWorkflowRunner` fan-out onto the shared executor

> ## ⛔ SUPERSEDED — this full-dedup version was NOT built
> During execution this task was deliberately re-scoped to **partial dedup** (see banner #1). What actually shipped (`5edf27a`): the graph keeps its entire round loop, skill emit/await, `nodeLog`, `finalizeParallelNode`, and cost accounting, and only replaces its private `makeParallelLLMCalls()` call with `$this->getParallelExecutor()->runConcurrentRound($pendingAgents)`, then deletes its four duplicated provider methods (`makeParallelLLMCalls`, `buildAgentLLMRequestWithTools`, `parseParallelLLMResponse`, `getProviderConfigForParallel`). No observer/bridge adapters, no `run()` reuse. The intended, verified behavior change: graph fan-out is now capped at 6 concurrent LLM calls/round (was unbounded). **The authoritative spec for what shipped is `.superpowers/sdd/task-3-brief.md`.** The steps below are retained only as a record of the original (abandoned) approach.

This consolidates the two drifting parallel paths. Parallel delegation (Tasks 1–2) already works without this; this task removes the duplicate engine and is gated on the existing graph fan-out still behaving identically.

**Files:**
- Modify: `backend/src/AgentTeam/Services/GraphWorkflowRunner.php` (`executeAgentsInParallel` 1694–2039; delete the now-duplicated `makeParallelLLMCalls`/`buildAgentLLMRequestWithTools`/`parseParallelLLMResponse`/`getProviderConfigForParallel`/`executeToolForParallel` once moved)
- Test: `backend/tests/Unit/AgentTeam/` (existing suite as regression gate) + new adapter unit test

**Interfaces:**
- Consumes: `ParallelAgentExecutor` (Task 1), `AgentRunner::createParallelExecutor()`.
- Produces: `GraphWorkflowRunner` implements `ParallelRunObserver` and `ParallelClientToolBridge` (or holds private adapter classes) so the executor emits `node_start`/`node_complete`/`nodeLog` and round-trips browser skills exactly as before. `executeAgentsInParallel()` return shape (`nodeId => [...]`) is unchanged.

- [ ] **Step 1: Capture the current behavior as a characterization test**

Add a regression test that asserts the existing graph fan-out result shape for a two-node parallel graph, using a `GraphWorkflowRunner` subclass that overrides the LLM round with canned responses (same seam approach as Task 1). Assert `node_start`/`node_complete` events fire per node and `nodeOutputs` are populated for both nodes.

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/ --filter Graph`
Expected: PASS against current code (records today's behavior before the refactor).

- [ ] **Step 2: Make `GraphWorkflowRunner` provide observer + bridge adapters**

Add a private observer adapter that forwards to the existing `emitNodeEvent`/`nodeLog`/`finalizeParallelNode` (the `$node` for a key is looked up from the states the runner built in Phase A), and a private bridge adapter that forwards to `emitClientToolCallInParallel`/`awaitClientToolResultInParallel`/`isClientSideToolName`. Both are thin pass-throughs — no new logic.

- [ ] **Step 3: Replace Phase B/C of `executeAgentsInParallel` with an executor call**

Keep Phase A (lines 1706–1865 — node/edge → agentState). Then, instead of the inline round loop (1867–2039), build the executor state list from the Phase-A states and call:

```php
        $executor = $this->agentRunner->createParallelExecutor(
            false,                       // graph path does not create per-node execution rows (unchanged behavior)
            new GraphParallelObserver($this, $nodesByKey),
            new GraphParallelBridge($this)
        );
        $execResults = $executor->run($executorStates, $maxRounds);
        // map $execResults (key => [...]) back into $results[$nodeId] via finalizeParallelNode-equivalent
```

Delete the five methods now living in `ParallelAgentExecutor`.

- [ ] **Step 4: Run the regression + full AgentTeam suite**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AgentTeam/`
Expected: PASS — the characterization test from Step 1 and all pre-existing AgentTeam unit tests are green (same event sequence, same output map).

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/GraphWorkflowRunner.php backend/tests/Unit/AgentTeam/
git commit -m "refactor(agentteam): graph fan-out reuses ParallelAgentExecutor (dedup)"
```

---

## Task 4: TypeScript — add `run_agents_parallel` (Promise.all + concurrency cap)

> **As-built:** shipped in `8c690ec` + `e96e4e5`. Added beyond the Step-3 code below: `runOne` resolves the target via the repository and rejects manager-type agents pre-flight with a full 7-key error item (worker/standard only, banner #4), plus a CAP-boundary test. Managers auto-receive the tool and `AgentToolsExecutor` auto-routes it (no edits to `AgentRunner.ts`/`AgentToolsExecutor.ts` were needed).

TS `runner.run()` is async and already writes execution records, so concurrency + logging come free. Managers auto-receive the tool (they get `toolDefinitions()`) and `AgentToolsExecutor` auto-routes it (it keys off `toolNames()`).

**Files:**
- Modify: `backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts`
- Test: `backend_typescript/tests/RunAgentsParallel.test.ts`

**Interfaces:**
- Consumes: `this.delegateToAgent(params, context)` (existing), `AgentRepository`, `DelegationContext`.
- Produces: `runAgentsParallel(params: any, context: DelegationContext): Promise<any>` returning `{ success, total_agents, successful, failed, results }` where `results[]` = `{ index, agent, task, success, result, error, execution_id }`. `toolNames()` and `getAllFunctions()` include `run_agents_parallel`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDelegationFunctions } from '../src/AgentTeam/AgentDelegationFunctions';

const worker = (id: number, name: string) =>
  ({ id, name, agentType: 'worker', enabled: true, description: '', provider: 'claude', tools: [], canDelegateTo: [] } as any);

function fakes() {
  const repo: any = {
    findById: async (id: number) => (id === 1 ? { id: 1, name: 'Mgr', agentType: 'manager', canDelegateTo: [] } : null),
    findByName: async (n: string) => (n === 'A' ? worker(5, 'A') : n === 'B' ? worker(6, 'B') : null),
    findWorkerAgents: async () => [worker(5, 'A'), worker(6, 'B')],
  };
  const order: string[] = [];
  const runner: any = {
    // Each run resolves on a later microtask; record start/end order to prove concurrency.
    run: async (agent: any) => {
      order.push(`start:${agent.name}`);
      await new Promise((r) => setImmediate(r));
      order.push(`end:${agent.name}`);
      return { success: true, text: `${agent.name}-done`, tools_used: [], execution_id: agent.id * 10 };
    },
  };
  return { repo, runner, order };
}

test('runAgentsParallel runs delegations concurrently and maps results', async () => {
  const { repo, runner, order } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const out = await d.runAgentsParallel(
    { delegations: [ { agent_name: 'A', task: 'ta' }, { agent_name: 'B', task: 'tb' } ] },
    { user_id: 1, current_agent_id: 1 },
  );
  assert.equal(out.success, true);
  assert.equal(out.successful, 2);
  assert.equal(out.results[0].result, 'A-done');
  assert.equal(out.results[1].execution_id, 60);
  // Both started before either finished => truly concurrent, not sequential.
  assert.deepEqual(order.slice(0, 2), ['start:A', 'start:B']);
});

test('runAgentsParallel rejects an empty batch', async () => {
  const { repo, runner } = fakes();
  const d = new AgentDelegationFunctions(repo, runner);
  const out = await d.runAgentsParallel({ delegations: [] }, { user_id: 1 });
  assert.equal(out.success, false);
});

test('run_agents_parallel is a registered tool name', () => {
  assert.ok(AgentDelegationFunctions.toolNames().includes('run_agents_parallel'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend_typescript && npx tsx --test tests/RunAgentsParallel.test.ts`
Expected: FAIL — `d.runAgentsParallel is not a function` / `toolNames` lacks `run_agents_parallel`.

- [ ] **Step 3: Add the tool name, schema, and implementation**

In `AgentDelegationFunctions.ts`:

Update `toolNames()`:

```ts
  static toolNames(): string[] {
    return ['delegate_to_agent', 'list_available_agents', 'complete_task', 'run_agents_parallel'];
  }
```

Add to the object returned by `getAllFunctions()` (alongside the others):

```ts
      run_agents_parallel: {
        schema: {
          description:
            'Run multiple agents in parallel and collect their results. Useful for gathering information from multiple specialists simultaneously. Results are returned together once all agents complete.',
          input_schema: {
            type: 'object',
            properties: {
              delegations: {
                type: 'array',
                description: 'Array of delegation objects, each with agent_name and task',
                items: {
                  type: 'object',
                  properties: {
                    agent_name: { type: 'string', description: 'Name of the agent to delegate to' },
                    task: { type: 'string', description: 'The task for this agent' },
                    context: { type: 'string', description: 'Optional context for this agent' },
                  },
                  required: ['agent_name', 'task'],
                },
              },
            },
            required: ['delegations'],
          },
        },
        handler: (p, c) => this.runAgentsParallel(p, c),
      },
```

Add the method (concurrency-capped `Promise.all` over the existing `delegateToAgent`):

```ts
  async runAgentsParallel(params: any, context: DelegationContext): Promise<any> {
    const delegations: any[] = Array.isArray(params?.delegations) ? params.delegations : [];
    if (delegations.length === 0) return { success: false, error: 'No delegations provided' };

    if (context.stream_context) {
      context.stream_context.emit?.({
        type: 'parallel_start',
        count: delegations.length,
        agents: delegations.map((d) => d?.agent_name ?? 'unknown'),
        timestamp: Date.now() / 1000,
      });
    }

    const CAP = 6;
    const results: any[] = new Array(delegations.length);

    const runOne = async (d: any, index: number) => {
      const agentName = d?.agent_name;
      const task = d?.task;
      if (!agentName || !task) {
        results[index] = { index, agent: agentName ?? 'unknown', task: task ?? '',
          success: false, result: null, error: 'Missing agent_name or task', execution_id: null };
        return;
      }
      const r = await this.delegateToAgent(
        { agent_name: agentName, task, context: d?.context ?? '' }, context);
      results[index] = {
        index, agent: agentName, task,
        success: !!r.success,
        result: r.result ?? null,
        error: r.success ? null : (r.error ?? 'Unknown error'),
        execution_id: r.execution_id ?? null,
      };
    };

    // Window the batch so at most CAP sub-agents are in flight at once.
    for (let i = 0; i < delegations.length; i += CAP) {
      const slice = delegations.slice(i, i + CAP);
      await Promise.all(slice.map((d, j) => runOne(d, i + j)));
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;

    if (context.stream_context) {
      context.stream_context.emit?.({ type: 'parallel_complete', successful, failed, timestamp: Date.now() / 1000 });
    }

    return {
      success: failed === 0,
      total_agents: delegations.length,
      successful,
      failed,
      results,
      message: `Completed ${successful} of ${delegations.length} delegations`,
    };
  }
```

Also update the class docblock line 18 (`run_agents_parallel is intentionally NOT ported`) to reflect that it is now ported.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend_typescript && npx tsx --test tests/RunAgentsParallel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + existing delegation tests still green**

Run: `cd backend_typescript && npm run typecheck && npx tsx --test tests/AgentDelegationFunctions.test.ts tests/AgentToolsExecutor.test.ts`
Expected: typecheck clean; existing delegation + executor tests still pass (the new tool routes through `AgentToolsExecutor` because it keys off `toolNames()`).

- [ ] **Step 6: Commit**

```bash
git add backend_typescript/src/AgentTeam/AgentDelegationFunctions.ts \
        backend_typescript/tests/RunAgentsParallel.test.ts
git commit -m "feat(agentteam-ts): run_agents_parallel via concurrency-capped Promise.all"
```

---

## Self-Review Notes

- **Spec coverage:** Concurrency engine (Task 1), PHP wiring + manager exposure (Task 2), dedup of the two parallel paths (Task 3), TS parity (Task 4). Execution-record replication decision → Task 1 `recordExecutions` flag, on for delegation (Task 2), off for graph (Task 3, preserves current behavior). Concurrency cap → Task 1 `array_chunk` (PHP) + Task 4 windowed `Promise.all` (TS). Worker-only batch → Task 2 manager-rejection guard.
- **Known pre-existing issue:** `tests/Unit/AgentTeam/AgentDelegationFunctionsTest.php` currently has 5 errors/1 failure because its Mockery `AgentRunner` doesn't stub `getFreshRepository()`. Not caused by this work; if a task run surfaces it, add `->shouldReceive('getFreshRepository')->andReturn($repo)` to those mocks — do not treat it as a regression from this plan.
- **Type consistency:** executor result keys (`agent_id`, `agent_name`, `input`, `output`, `success`, `usage`, `execution_id`) are identical in Task 1 producer and Task 2/3 consumers. TS `results[]` keys match the PHP `results[]` keys.
- **Risk:** Task 3 is the only task touching a working feature (graph fan-out). It is gated behind a characterization test and the full AgentTeam suite. Tasks 1, 2, 4 deliver working parallel delegation even if Task 3 is deferred.
