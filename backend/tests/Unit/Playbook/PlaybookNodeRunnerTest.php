<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PDO;
use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PlaybookNodeRunner;

/**
 * Task 12: the server-side playbook node runner. Everything that would
 * otherwise hit MySQL or a real LLM provider is swapped for a fake via the
 * runner's constructor factories ($llmFactory/$mcpFactory/$bridgeFactory/
 * $pdoFactory) — see PlaybookNodeRunner's CONTROLLER RULING comment.
 */
final class PlaybookNodeRunnerTest extends TestCase
{
    private function makeSqlitePdo(): PDO
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec("CREATE TABLE playbook_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, playbook_title TEXT,
            document TEXT, status TEXT DEFAULT 'pending', requester TEXT, variables TEXT, pending_gate TEXT,
            current_leg INT DEFAULT 0, coverage TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT)");
        $pdo->exec("CREATE TABLE playbook_run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            direction TEXT, audience TEXT, text TEXT, sensitive INT DEFAULT 0, created_at TEXT)");
        $pdo->exec("CREATE TABLE playbook_run_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            author TEXT DEFAULT 'agent', text TEXT, created_at TEXT)");
        $pdo->exec("CREATE TABLE playbook_run_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            seq INT, action_name TEXT, tool TEXT, args TEXT, outcome TEXT, result_summary TEXT, returned_ids TEXT,
            sensitive INT DEFAULT 0, duration_ms INT, created_at TEXT)");
        $pdo->exec("CREATE TABLE playbook_run_gates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            kind TEXT, args TEXT, asked_of TEXT, opened_at TEXT, closed_at TEXT, decision TEXT, actor TEXT)");
        return $pdo;
    }

    /** @param array<int,array<int,array{name:string,arguments:array}>> $rounds */
    private function scriptedLlm(array $rounds): \Closure
    {
        $queue = $rounds;
        $counter = 0;
        return function (array $messages, array $toolDefs) use (&$queue, &$counter) {
            if (empty($queue)) {
                return ['text' => 'nothing left to do', 'tool_calls' => []];
            }
            $round = array_shift($queue);
            $toolCalls = [];
            foreach ($round as $call) {
                $counter++;
                $toolCalls[] = [
                    'id' => 'call_' . $counter,
                    'name' => $call['name'],
                    'arguments' => $call['arguments'] ?? [],
                ];
            }
            return ['text' => null, 'tool_calls' => $toolCalls];
        };
    }

    private function simplePlaybook(): array
    {
        return [
            'title' => 'Simple Resolve',
            'trigger' => ['kind' => 'request', 'description' => 'test trigger'],
            'instructions' => '#Send Direct Message to the requester, then #Leave Internal Note, then #Resolve Request.',
            'actions_used' => ['#Send Direct Message', '#Leave Internal Note', '#Resolve Request'],
            'policy' => ['writes_enabled' => true],
        ];
    }

    public function testT1ShapedRunResolves(): void
    {
        $pdo = $this->makeSqlitePdo();
        $emitted = [];
        $emit = function (array $event) use (&$emitted) { $emitted[] = $event; };

        $llm = $this->scriptedLlm([
            [
                ['name' => 'send_direct_message', 'arguments' => ['text' => 'All set.']],
                ['name' => 'leave_internal_note', 'arguments' => ['text' => 'Handled via test.']],
                ['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']],
            ],
        ]);

        $runner = new PlaybookNodeRunner(
            config: [],
            llmFactory: fn(array $nodeConfig) => $llm,
            mcpFactory: fn(PDO $pdo, int $userId) => new FakeMcpExecutor(),
            bridgeFactory: fn(\Closure $emit) => new FakeNodeRunnerBridge($emit),
            pdoFactory: fn() => $pdo,
        );

        $result = $runner->run(1, ['playbook' => $this->simplePlaybook()], 'Please help me.', $emit);

        $this->assertSame('resolved', $result['status']);
        $this->assertIsInt($result['run_id']);
        $this->assertStringContainsString("[playbook run {$result['run_id']}: resolved]", $result['output']);

        $row = $pdo->query('SELECT status FROM playbook_runs WHERE id = ' . $result['run_id'])->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('resolved', $row['status']);
    }

    public function testGateRequestEmittedAndApprovedThenResolves(): void
    {
        $pdo = $this->makeSqlitePdo();
        $emitted = [];
        $emit = function (array $event) use (&$emitted) { $emitted[] = $event; };

        $llm = $this->scriptedLlm([
            [['name' => 'request_approval', 'arguments' => ['approver' => 'boss', 'question' => 'OK to proceed?']]],
            [
                ['name' => 'leave_internal_note', 'arguments' => ['text' => 'Approved and handled.']],
                ['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']],
            ],
        ]);

        $runner = new PlaybookNodeRunner(
            config: [],
            llmFactory: fn(array $nodeConfig) => $llm,
            mcpFactory: fn(PDO $pdo, int $userId) => new FakeMcpExecutor(),
            bridgeFactory: fn(\Closure $emit) => new FakeNodeRunnerBridge($emit),
            pdoFactory: fn() => $pdo,
        );

        $result = $runner->run(1, ['playbook' => $this->simplePlaybook()], 'Please help me.', $emit);

        $this->assertSame('resolved', $result['status']);

        $gateEvents = array_values(array_filter($emitted, fn($e) => ($e['type'] ?? null) === 'gate_request'));
        $this->assertCount(1, $gateEvents);
        $this->assertSame('approval', $gateEvents[0]['kind']);
        $this->assertSame($result['run_id'], $gateEvents[0]['run_id']);
    }

    public function testUnattendedRunStopsAtFirstGate(): void
    {
        $pdo = $this->makeSqlitePdo();
        $calls = 0;
        $inner = $this->scriptedLlm([
            [['name' => 'request_approval', 'arguments' => ['approver' => 'boss', 'question' => 'OK to proceed?']]],
            [['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]],
        ]);
        $llm = function (array $m, array $t) use ($inner, &$calls) { $calls++; return $inner($m, $t); };

        $runner = new PlaybookNodeRunner(
            config: [],
            llmFactory: fn(array $nodeConfig) => $llm,
            mcpFactory: fn(PDO $pdo, int $userId) => new FakeMcpExecutor(),
            bridgeFactory: fn(\Closure $emit) => new FakeNodeRunnerBridge($emit),
            pdoFactory: fn() => $pdo,
        );

        $result = $runner->run(1, ['playbook' => $this->simplePlaybook()], 'Please help me.', function (array $e) {}, unattended: true);

        $this->assertSame('handed_off', $result['status']);
        $this->assertSame('approval', $result['gate']);
        $this->assertSame(1, $calls);
    }

    private function runUnattended(array $rounds, PDO $pdo, ?FakeMcpExecutor $mcp = null): array
    {
        $llm = $this->scriptedLlm($rounds);
        $mcp ??= new FakeMcpExecutor();
        $runner = new PlaybookNodeRunner(
            config: [],
            llmFactory: fn(array $nodeConfig) => $llm,
            mcpFactory: fn(PDO $pdo, int $userId) => $mcp,
            bridgeFactory: fn(\Closure $emit) => new FakeNodeRunnerBridge($emit),
            pdoFactory: fn() => $pdo,
        );
        return $runner->run(1, ['playbook' => $this->simplePlaybook()], 'Please help me.', function (array $e) {}, unattended: true);
    }

    public function testUnattendedGateThenResolveInSameTurnStaysHandedOff(): void
    {
        $pdo = $this->makeSqlitePdo();
        $result = $this->runUnattended([
            [['name' => 'request_approval', 'arguments' => ['approver' => 'boss', 'question' => 'OK to proceed?']],
             ['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]],
        ], $pdo);

        $this->assertSame('handed_off', $result['status']);
        $this->assertSame('approval', $result['gate']);
        $row = $pdo->query('SELECT status, resolved_at FROM playbook_runs WHERE id = ' . $result['run_id'])->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('handed_off', $row['status']);
    }

    public function testUnattendedGateSkipsTheRestOfTheTurn(): void
    {
        $pdo = $this->makeSqlitePdo();
        $result = $this->runUnattended([
            [['name' => 'request_approval', 'arguments' => ['approver' => 'boss', 'question' => 'OK to proceed?']],
             ['name' => 'leave_internal_note', 'arguments' => ['text' => 'SHOULD-NOT-RUN']],
             ['name' => 'send_direct_message', 'arguments' => ['text' => 'SHOULD-NOT-SEND']]],
        ], $pdo);

        $this->assertSame('handed_off', $result['status']);
        $notes = $pdo->query("SELECT COUNT(*) FROM playbook_run_notes WHERE text LIKE '%SHOULD-NOT-RUN%'")->fetchColumn();
        $this->assertSame(0, (int)$notes);
        $msgs = $pdo->query("SELECT COUNT(*) FROM playbook_run_messages WHERE text LIKE '%SHOULD-NOT-SEND%'")->fetchColumn();
        $this->assertSame(0, (int)$msgs);
        $this->assertStringNotContainsString('SHOULD-NOT-RUN', $result['output']);
    }

    public function testUnattendedFirstGateWins(): void
    {
        $pdo = $this->makeSqlitePdo();
        $result = $this->runUnattended([
            [['name' => 'prompt_handoff', 'arguments' => ['reason' => 'needs a human']],
             ['name' => 'request_approval', 'arguments' => ['approver' => 'boss', 'question' => 'OK?']]],
        ], $pdo);

        $this->assertSame('handed_off', $result['status']);
        $this->assertSame('handoff', $result['gate']);
        $gates = $pdo->query('SELECT kind FROM playbook_run_gates')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame(['handoff'], $gates);
    }
}
