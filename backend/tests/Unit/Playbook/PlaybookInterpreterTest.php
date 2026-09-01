<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\{
    PlaybookActionSpace,
    PlaybookDocument,
    PlaybookInterpreter,
    PlaybookNativeTools,
    PlaybookTranscript,
};

final class PlaybookInterpreterTest extends PlaybookDbTestCase
{
    private function doc(array $policy = []): PlaybookDocument
    {
        return PlaybookDocument::fromArray([
            'title' => 'Password Reset',
            'trigger' => ['kind' => 'request', 'description' => 'user locked out'],
            'instructions' => "Search for the user. Check their recent activity and factors. "
                . "Verify their identity with security questions. Reset the password and email them. "
                . "Tell the requester it is done. Stop when resolved.",
            'policy' => $policy + ['writes_enabled' => true, 'on_unbound' => 'prompt_handoff'],
        ]);
    }

    private function actions(): array
    {
        return [
            ['name' => '#Search Okta User by Email', 'kind' => 'bound', 'target' => 'okta.search_users'],
            ['name' => '#Search Okta System Log', 'kind' => 'bound', 'target' => 'okta.search_system_log'],
            ['name' => '#List User Factors', 'kind' => 'bound', 'target' => 'okta.list_user_factors'],
            ['name' => '#Verify Security Answers', 'kind' => 'bound', 'target' => 'okta.verify_security_answers'],
            ['name' => '#Reset Okta Password', 'kind' => 'bound', 'target' => 'okta.reset_password'],
            ['name' => '#Send Direct Message', 'kind' => 'native', 'target' => 'send_direct_message'],
            ['name' => '#Leave Internal Note', 'kind' => 'native', 'target' => 'leave_internal_note'],
            ['name' => '#Resolve Request', 'kind' => 'native', 'target' => 'resolve_request'],
        ];
    }

    private function space(array $policy = []): array
    {
        $mcp = new FakeMcpExecutor();
        $native = new PlaybookNativeTools($this->state);
        $space = new PlaybookActionSpace($this->actions(), $native, $mcp, $this->state, $policy + [
            'writes_enabled' => true,
            'on_unbound' => 'prompt_handoff',
        ]);
        return [$space, $mcp];
    }

    /**
     * @param array<int,array<int,array{name:string,arguments:array}>> $rounds queue of rounds;
     *   each round is a list of tool calls (>1 entry = "parallel" tool_calls in one LLM turn).
     */
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

    public function testTShapedScenarioResolvesInOrderWithTranscriptAndMessageEvent(): void
    {
        [$space, $mcp] = $this->space();
        $doc = $this->doc();
        $id = $this->state->createRun(1, $doc, ['id' => 'req1'], []);

        $rounds = [
            [['name' => 'okta__search_users', 'arguments' => ['email' => 'a@b.com']]],
            [
                ['name' => 'okta__search_system_log', 'arguments' => ['user_id' => 'u1']],
                ['name' => 'okta__list_user_factors', 'arguments' => ['user_id' => 'u1']],
            ],
            [['name' => 'okta__verify_security_answers', 'arguments' => ['user_id' => 'u1', 'answers' => ['a', 'b']]]],
            [['name' => 'okta__reset_password', 'arguments' => ['user_id' => 'u1', 'send_email' => true]]],
            [['name' => 'send_direct_message', 'arguments' => ['text' => 'Your password has been reset.', 'sensitive' => true]]],
            [
                ['name' => 'leave_internal_note', 'arguments' => ['text' => 'Reset password for u1 after verifying identity.']],
                ['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'Password reset and requester notified.']],
            ],
        ];

        $events = [];
        $onEvent = function (array $e) use (&$events) { $events[] = $e; };

        $llm = $this->scriptedLlm($rounds, $captured);
        $transcript = new PlaybookTranscript($this->dir);
        $interpreter = new PlaybookInterpreter($space, $this->state, $transcript, $llm, 40, $onEvent);

        $result = $interpreter->runLeg($id, 0, $doc, [], ['id' => 'req1'], 'I am locked out of my account.');

        $this->assertSame('resolved', $result['status']);

        $ledger = $this->state->ledgerAll($id);
        $toolSequence = array_map(fn($row) => $row['tool'], $ledger);
        $this->assertSame([
            'okta.search_users',
            'okta.search_system_log',
            'okta.list_user_factors',
            'okta.verify_security_answers',
            'okta.reset_password',
            'send_direct_message',
            'leave_internal_note',
            'resolve_request',
        ], $toolSequence);

        // send_email=true made it through to the reset args.
        $resetRow = $ledger[4];
        $this->assertStringContainsString('"send_email":true', $resetRow['args']);

        // Transcript: leg_started first, leg_ended last.
        $events2 = $transcript->read($id);
        $this->assertNotEmpty($events2);
        $this->assertSame('leg_started', $events2[0]['type']);
        $this->assertSame('leg_ended', $events2[count($events2) - 1]['type']);
        $this->assertSame('prompt', $events2[1]['type']);
        $this->assertSame('I am locked out of my account.', $events2[1]['text']);

        // onEvent 'message' fired with the REAL (unredacted) text, even though the
        // ledger/db copy is redacted because sensitive=true.
        $messageEvents = array_values(array_filter($events, fn($e) => $e['type'] === 'message'));
        $this->assertCount(1, $messageEvents);
        $this->assertSame('Your password has been reset.', $messageEvents[0]['text']);
        $this->assertTrue($messageEvents[0]['sensitive']);

        // DB copy of the message is redacted.
        $stmt = $this->pdo->prepare('SELECT text, sensitive FROM playbook_run_messages WHERE run_id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame(1, (int)$row['sensitive']);
        $this->assertStringNotContainsString('Your password has been reset.', $row['text']);

        // System prompt is the verbatim constant with {instructions}/{policy_json} filled in.
        $expectedSystemPrompt = str_replace(
            ['{instructions}', '{policy_json}'],
            [$doc->instructions, json_encode($doc->policy, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)],
            <<<'PROMPT'
You are a playbook interpreter for an IT service desk. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
{instructions}
POLICY: {policy_json}
PROMPT
        );
        $this->assertSame($expectedSystemPrompt, $captured[0][0]['content']);
        $this->assertSame('system', $captured[0][0]['role']);
    }

    public function testRoundBudgetExhaustionMarksFailedAndLeavesNote(): void
    {
        [$space, $mcp] = $this->space();
        $doc = $this->doc();
        $id = $this->state->createRun(1, $doc, ['id' => 'req1'], []);

        // Always calls a (non-terminal) tool, never resolves.
        $llm = function (array $messages, array $toolDefs): array {
            return [
                'text' => null,
                'tool_calls' => [
                    ['id' => 'call_x', 'name' => 'leave_internal_note', 'arguments' => ['text' => 'still working']],
                ],
            ];
        };

        $transcript = new PlaybookTranscript($this->dir);
        $interpreter = new PlaybookInterpreter($space, $this->state, $transcript, $llm, 2, null);

        $result = $interpreter->runLeg($id, 0, $doc, [], ['id' => 'req1'], 'Help me.');

        $this->assertSame('failed', $result['status']);
        $this->assertSame('failed', $this->state->getRun($id)['status']);

        $notesStmt = $this->pdo->prepare('SELECT text FROM playbook_run_notes WHERE run_id = ? ORDER BY id ASC');
        $notesStmt->execute([$id]);
        $notes = $notesStmt->fetchAll(\PDO::FETCH_COLUMN);
        // 2 rounds of "still working" plus a final exhaustion note.
        $this->assertCount(3, $notes);
        $this->assertStringContainsString('exhausted', strtolower($notes[2]));
    }

    public function testSecondRoundMessagesIncludeFirstRoundToolResult(): void
    {
        [$space, $mcp] = $this->space();
        $doc = $this->doc();
        $id = $this->state->createRun(1, $doc, ['id' => 'req1'], []);

        $rounds = [
            [['name' => 'okta__search_users', 'arguments' => ['email' => 'a@b.com']]],
            [['name' => 'resolve_request', 'arguments' => ['outcome' => 'success', 'summary' => 'done']]],
        ];

        $llm = $this->scriptedLlm($rounds, $captured);
        $transcript = new PlaybookTranscript($this->dir);
        $interpreter = new PlaybookInterpreter($space, $this->state, $transcript, $llm, 40, null);

        $result = $interpreter->runLeg($id, 0, $doc, [], ['id' => 'req1'], 'Find and help this user.');
        $this->assertSame('resolved', $result['status']);

        $this->assertCount(2, $captured);
        $round2Messages = $captured[1];

        // round 2 messages must include the assistant tool_calls message from round 1
        // and the resulting role:'tool' message carrying round 1's result JSON.
        $roles = array_map(fn($m) => $m['role'], $round2Messages);
        $this->assertContains('assistant', $roles);
        $this->assertContains('tool', $roles);

        $toolMessages = array_values(array_filter($round2Messages, fn($m) => $m['role'] === 'tool'));
        $this->assertNotEmpty($toolMessages);
        $decoded = json_decode($toolMessages[0]['content'], true);
        $this->assertIsArray($decoded);
        $this->assertSame('okta__search_users', $toolMessages[0]['name']);
    }
}
