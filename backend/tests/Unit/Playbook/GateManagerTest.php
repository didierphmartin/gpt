<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\{
    GateManager,
    PlaybookActionSpace,
    PlaybookDocument,
    PlaybookInterpreter,
    PlaybookNativeTools,
    PlaybookTranscript,
};

final class GateManagerTest extends PlaybookDbTestCase
{
    private function doc(): PlaybookDocument
    {
        return PlaybookDocument::fromArray([
            'title' => 'T',
            'trigger' => ['kind' => 'request', 'description' => 'd'],
            'instructions' => 'Ask for approval, then reset the password. Stop when resolved.',
            'policy' => ['writes_enabled' => true, 'on_unbound' => 'prompt_handoff'],
        ]);
    }

    private function gateRow(int $gateId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_gates WHERE id = ?');
        $stmt->execute([$gateId]);
        return $stmt->fetch(\PDO::FETCH_ASSOC);
    }

    private function lastGateId(int $runId): int
    {
        $stmt = $this->pdo->prepare('SELECT MAX(id) FROM playbook_run_gates WHERE run_id = ?');
        $stmt->execute([$runId]);
        return (int)$stmt->fetchColumn();
    }

    public function testApprovalApprovedTransitionsStatusAndClosesGateWithActor(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['id' => 'req1'], []);
        $answer = ['decision' => 'approved', 'comment' => 'looks fine', 'actor' => 'mgr@example.com'];

        $statusDuringAsk = null;
        $bridge = new FakeGateBridge([$answer], function () use (&$statusDuringAsk, $id) {
            $statusDuringAsk = $this->state->getRun($id)['status'];
        });
        $gm = new GateManager($this->state, $bridge);

        $result = $gm->execute($id, 0, 'request_approval', [
            'approver' => 'mgr', 'question' => 'reset the password?', 'context' => 'locked out',
        ]);

        $this->assertSame(['ok' => true, 'decision' => $answer], $result);
        $this->assertSame('awaiting_approval', $statusDuringAsk);
        $this->assertSame('running', $this->state->getRun($id)['status']);

        $row = $this->gateRow($this->lastGateId($id));
        $this->assertSame('approval', $row['kind']);
        $this->assertSame('approver', $row['asked_of']);
        $this->assertNotNull($row['closed_at']);
        $this->assertSame('mgr@example.com', $row['actor']);
        $this->assertSame($answer, json_decode($row['decision'], true));
    }

    public function testApprovalTimeoutReturnsTimeoutGuidanceAndClosesGate(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['id' => 'req1'], []);
        $bridge = new FakeGateBridge([]); // empty queue => ask() returns null
        $gm = new GateManager($this->state, $bridge);

        $result = $gm->execute($id, 0, 'request_approval', [
            'approver' => 'mgr', 'question' => 'reset the password?',
        ]);

        $this->assertSame([
            'ok' => false,
            'timeout' => true,
            'guidance' => 'No human answered in time. Leave an internal note and resolve as uncompleted.',
        ], $result);

        $row = $this->gateRow($this->lastGateId($id));
        $this->assertNotNull($row['closed_at']);
        $this->assertSame(['decision' => 'timeout'], json_decode($row['decision'], true));
        $this->assertSame('running', $this->state->getRun($id)['status']);
    }

    public function testSensitiveFormFieldIsRedactedInStoredDecisionButIntactInReturn(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['id' => 'req1'], []);
        $answer = ['password' => 'hunter2', 'username' => 'bob', 'actor' => 'req1'];
        $bridge = new FakeGateBridge([$answer]);
        $gm = new GateManager($this->state, $bridge);

        $args = [
            'prompt' => 'Set your new password',
            'fields' => [
                ['name' => 'password', 'label' => 'New password', 'type' => 'text', 'sensitive' => true],
                ['name' => 'username', 'label' => 'Username', 'type' => 'text'],
            ],
        ];

        $result = $gm->execute($id, 0, 'trigger_form', $args);

        // Returned to the caller verbatim.
        $this->assertSame($answer, $result['decision']);
        $this->assertSame('hunter2', $result['decision']['password']);

        // Stored decision has the sensitive field redacted; other fields intact.
        $row = $this->gateRow($this->lastGateId($id));
        $stored = json_decode($row['decision'], true);
        $this->assertSame(GateManager::REDACTED, $stored['password']);
        $this->assertSame('bob', $stored['username']);
    }

    // --- Interpreter-level: request_approval then, after 'approved', okta__reset_password ---

    private function scriptedLlm(array $rounds, ?array &$capturedRounds = null): \Closure
    {
        $queue = $rounds;
        $counter = 0;
        $capturedRounds = [];
        return function (array $messages, array $toolDefs) use (&$queue, &$counter, &$capturedRounds) {
            $capturedRounds[] = $messages;
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

    public function testInterpreterRunsApprovalGateBeforeResetAndFeedsDecisionForward(): void
    {
        $mcp = new FakeMcpExecutor();
        $native = new PlaybookNativeTools($this->state);
        $bridge = new FakeGateBridge([
            ['decision' => 'approved', 'comment' => 'go ahead', 'actor' => 'mgr@example.com'],
        ]);
        $gates = new GateManager($this->state, $bridge);

        $actions = [
            ['name' => '#Reset Okta Password', 'kind' => 'bound', 'target' => 'okta.reset_password'],
            ['name' => '#Resolve Request', 'kind' => 'native', 'target' => 'resolve_request'],
        ];
        $space = new PlaybookActionSpace($actions, $native, $mcp, $this->state, [
            'writes_enabled' => true, 'on_unbound' => 'prompt_handoff',
        ], $gates);

        $doc = $this->doc();
        $id = $this->state->createRun(1, $doc, ['id' => 'req1'], []);

        $rounds = [
            [['name' => 'request_approval', 'arguments' => ['approver' => 'mgr', 'question' => 'reset password for u1?']]],
            [['name' => 'okta__reset_password', 'arguments' => ['user_id' => 'u1']]],
            [['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'reset after approval']]],
        ];

        $llm = $this->scriptedLlm($rounds, $captured);
        $transcript = new PlaybookTranscript($this->dir);
        $interpreter = new PlaybookInterpreter($space, $this->state, $transcript, $llm, 40, null);

        $result = $interpreter->runLeg($id, 0, $doc, [], ['id' => 'req1'], 'Reset u1 password, needs approval first.');

        $this->assertSame('resolved', $result['status']);

        // Gate ran before the reset, in the order the LLM asked for them.
        $ledger = $this->state->ledgerAll($id);
        $toolSequence = array_map(fn($row) => $row['tool'], $ledger);
        $this->assertSame(['request_approval', 'okta.reset_password', 'resolve_request'], $toolSequence);
        $this->assertSame('ok', $ledger[0]['outcome']);

        // The gate result did not end the leg (v1 immediate-mode contract): the loop
        // carried straight on into the reset, no 'gate_ended_leg' short-circuit.
        $this->assertCount(3, $captured);

        // Round 2 (post-gate) messages must carry the approval decision forward as the
        // tool result the LLM sees before it calls okta__reset_password.
        $round2Messages = $captured[1];
        $toolMessages = array_values(array_filter($round2Messages, fn($m) => $m['role'] === 'tool' && $m['name'] === 'request_approval'));
        $this->assertNotEmpty($toolMessages);
        $decoded = json_decode($toolMessages[0]['content'], true);
        $this->assertTrue($decoded['ok']);
        $this->assertTrue($decoded['gate']);
        $this->assertSame('approved', $decoded['decision']['decision']);
        $this->assertSame('mgr@example.com', $decoded['decision']['actor']);
    }
}
