<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

/**
 * The A' interpreter loop: the LLM re-decides each round from the running
 * transcript of tool calls/results — there is no pre-computed action queue.
 * Each round: call the LLM with the current messages + tool defs; execute
 * any tool calls it asks for through the PlaybookActionSpace; append the
 * results to the message history; repeat until the LLM stops calling tools,
 * a result is terminal (resolve_request) / gate_ended_leg (Task 8), or the
 * round budget is exhausted.
 */
final class PlaybookInterpreter
{
    private const SYSTEM_PROMPT_TEMPLATE = <<<'PROMPT'
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
REQUESTER: {requester_json}
APPROVERS: {approvers_json}
PROMPT;

    private const MESSAGE_TOOL_NAMES = ['send_direct_message', 'send_channel_message', 'send_email'];

    public function __construct(
        private readonly PlaybookActionSpace $space,
        private readonly PlaybookRunState $state,
        private readonly PlaybookTranscript $transcript,
        private readonly \Closure $llm,
        private readonly int $maxRounds = 40,
        private readonly ?\Closure $onEvent = null,
    ) {}

    public function runLeg(
        int $runId,
        int $leg,
        PlaybookDocument $doc,
        array $variables,
        array $requester,
        string $requestText
    ): array {
        $toolDefs = $this->space->toolDefinitions();

        $messages = [
            ['role' => 'system', 'content' => $this->buildSystemPrompt($doc, $requester)],
            ['role' => 'user', 'content' => $this->buildUserMessage($requestText, $variables)],
        ];

        $this->transcript->append($runId, ['type' => 'leg_started', 'leg' => $leg]);
        $this->transcript->append($runId, ['type' => 'prompt', 'leg' => $leg, 'text' => $requestText]);

        for ($round = 1; $round <= $this->maxRounds; $round++) {
            $this->emit(['type' => 'round', 'leg' => $leg, 'round' => $round]);

            $response = ($this->llm)($messages, $toolDefs);
            $text = $response['text'] ?? null;
            $toolCalls = $response['tool_calls'] ?? [];

            if (empty($toolCalls)) {
                return $this->endLeg($runId, $leg, $this->currentStatus($runId), $text ?? '');
            }

            // Normalize once so the assistant message and its matching tool-result
            // message(s) below always agree on the same id, even if the LLM
            // closure omitted one (defensive — the real WorkflowLlmClient path
            // always supplies one via normalizeToolCalls()).
            foreach ($toolCalls as $i => $toolCall) {
                if (!isset($toolCall['id'])) {
                    $toolCalls[$i]['id'] = uniqid('tc_');
                }
            }

            $messages[] = $this->buildAssistantMessage($text, $toolCalls);

            $terminal = false;
            foreach ($toolCalls as $toolCall) {
                $name = (string)$toolCall['name'];
                $args = (array)($toolCall['arguments'] ?? []);

                $this->transcript->append($runId, [
                    'type' => 'tool_call', 'leg' => $leg, 'round' => $round, 'name' => $name, 'args' => $args,
                ]);
                $this->emit(['type' => 'tool_call', 'leg' => $leg, 'round' => $round, 'name' => $name, 'args' => $args]);

                if (in_array($name, self::MESSAGE_TOOL_NAMES, true)) {
                    // Live delivery gets the real text; only the DB copy (written by
                    // PlaybookNativeTools via the ActionSpace) is redacted when sensitive.
                    $this->emit([
                        'type' => 'message',
                        'text' => (string)($args['text'] ?? ''),
                        'sensitive' => (bool)($args['sensitive'] ?? false),
                    ]);
                }

                $result = $this->space->execute($runId, $leg, $name, $args);

                $this->transcript->append($runId, [
                    'type' => 'tool_result', 'leg' => $leg, 'round' => $round, 'name' => $name, 'result' => $result,
                ]);
                $this->emit(['type' => 'tool_result', 'leg' => $leg, 'round' => $round, 'name' => $name, 'result' => $result]);

                $messages[] = [
                    'role' => 'tool',
                    'tool_call_id' => $toolCall['id'] ?? uniqid('tc_'),
                    'name' => $name,
                    'content' => json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                ];

                if (($result['terminal'] ?? false) === true || ($result['gate_ended_leg'] ?? false) === true) {
                    $terminal = true;
                }
            }

            if ($terminal) {
                return $this->endLeg($runId, $leg, $this->currentStatus($runId), $text ?? '');
            }
        }

        // Round budget exhausted.
        $this->state->setStatus($runId, 'failed');
        $this->space->execute($runId, $leg, 'leave_internal_note', [
            'text' => "Round budget of {$this->maxRounds} exhausted without resolving the request.",
        ]);
        return $this->endLeg($runId, $leg, 'failed', '');
    }

    private function endLeg(int $runId, int $leg, string $status, string $output): array
    {
        $this->transcript->append($runId, ['type' => 'leg_ended', 'leg' => $leg, 'status' => $status]);
        $this->emit(['type' => 'final', 'leg' => $leg, 'status' => $status, 'text' => $output]);
        return ['status' => $status, 'output' => $output];
    }

    private function currentStatus(int $runId): string
    {
        $run = $this->state->getRun($runId);
        return (string)($run['status'] ?? 'failed');
    }

    private function buildAssistantMessage(?string $text, array $toolCalls): array
    {
        $calls = [];
        foreach ($toolCalls as $toolCall) {
            $calls[] = [
                'id' => $toolCall['id'] ?? uniqid('tc_'),
                'type' => 'function',
                'function' => [
                    'name' => $toolCall['name'],
                    'arguments' => json_encode(
                        (array)($toolCall['arguments'] ?? []),
                        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                    ),
                ],
            ];
        }
        return ['role' => 'assistant', 'content' => $text, 'tool_calls' => $calls];
    }

    private function buildSystemPrompt(PlaybookDocument $doc, array $requester): string
    {
        $policyJson = json_encode($doc->policy, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $requesterJson = json_encode($requester, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        // Empty object, not [], when the document has no approvers — {} reads
        // unambiguously to the model as "none", where [] could be misread as
        // a list placeholder still to be filled in.
        $approversJson = empty($doc->approvers)
            ? '{}'
            : json_encode($doc->approvers, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return str_replace(
            ['{instructions}', '{policy_json}', '{requester_json}', '{approvers_json}'],
            [$doc->instructions, $policyJson, $requesterJson, $approversJson],
            self::SYSTEM_PROMPT_TEMPLATE
        );
    }

    private function buildUserMessage(string $requestText, array $variables): string
    {
        $lines = ['REQUEST:', $requestText];
        if (!empty($variables)) {
            $lines[] = 'VARIABLES: ' . json_encode($variables, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        return implode("\n", $lines);
    }

    private function emit(array $event): void
    {
        if ($this->onEvent !== null) {
            ($this->onEvent)($event);
        }
    }
}
