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
}
