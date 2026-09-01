<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

/**
 * Immediate-mode human gates (slice 1b): trigger_form / request_approval /
 * prompt_handoff / await_message. execute() opens a playbook_run_gates row,
 * moves the run into the matching waiting status, blocks on the bridge, then
 * closes the row and returns the run to 'running' before handing the
 * decision back to the interpreter loop as an ordinary tool result.
 */
final class GateManager
{
    public const REDACTED = '«redacted»';

    private const KIND_MAP = [
        'trigger_form' => ['kind' => 'form', 'asked_of' => 'requester', 'status' => 'awaiting_requester'],
        'request_approval' => ['kind' => 'approval', 'asked_of' => 'approver', 'status' => 'awaiting_approval'],
        'prompt_handoff' => ['kind' => 'handoff', 'asked_of' => 'operator', 'status' => 'handed_off'],
        'await_message' => ['kind' => 'await_message', 'asked_of' => 'requester', 'status' => 'awaiting_requester'],
    ];

    public function __construct(
        private readonly PlaybookRunState $state,
        private readonly GateBridgeInterface $bridge,
        private readonly int $timeoutMs = 900000,
    ) {}

    public function definitions(): array
    {
        return [
            [
                'type' => 'function',
                'function' => [
                    'name' => 'trigger_form',
                    'description' => 'Present a form to the requester and wait for it to be submitted',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'prompt' => ['type' => 'string', 'description' => 'Instructions shown above the form'],
                            'fields' => [
                                'type' => 'array',
                                'description' => 'Form fields to collect',
                                'items' => [
                                    'type' => 'object',
                                    'properties' => [
                                        'name' => ['type' => 'string'],
                                        'label' => ['type' => 'string'],
                                        'type' => ['type' => 'string'],
                                        'options' => ['type' => 'array', 'items' => ['type' => 'string']],
                                        'sensitive' => ['type' => 'boolean', 'description' => 'Redact this field\'s value when stored'],
                                    ],
                                    'required' => ['name', 'label', 'type'],
                                ],
                            ],
                        ],
                        'required' => ['prompt', 'fields'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'request_approval',
                    'description' => 'Ask an approver to approve or deny an action and wait for their decision',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'approver' => ['type' => 'string', 'description' => 'Who must approve'],
                            'question' => ['type' => 'string', 'description' => 'What is being approved'],
                            'context' => ['type' => 'string', 'description' => 'Supporting context for the decision'],
                        ],
                        'required' => ['approver', 'question'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'prompt_handoff',
                    'description' => 'Hand off to a human team or person and wait for their response',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'team_or_person' => ['type' => 'string', 'description' => 'Who to hand off to'],
                            'reason' => ['type' => 'string', 'description' => 'Why this needs a human'],
                            'summary' => ['type' => 'string', 'description' => 'Summary of the situation so far'],
                        ],
                        'required' => ['team_or_person', 'reason'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'await_message',
                    'description' => 'Wait for a message from the requester before continuing',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'prompt' => ['type' => 'string', 'description' => 'What to wait for'],
                        ],
                        'required' => ['prompt'],
                    ],
                ],
            ],
        ];
    }

    public function execute(int $runId, int $leg, string $name, array $args): array
    {
        $mapping = self::KIND_MAP[$name] ?? null;
        if ($mapping === null) {
            return ['ok' => false, 'error' => "Unknown gate: $name"];
        }

        $gateId = $this->state->gateOpen($runId, $leg, $mapping['kind'], $args, $mapping['asked_of']);
        $this->state->setStatus($runId, $mapping['status']);

        $answer = $this->bridge->ask($runId, $mapping['kind'], $args, $this->timeoutMs);

        if ($answer === null) {
            $this->state->gateClose($gateId, ['decision' => 'timeout'], '');
            $this->state->setStatus($runId, 'running');
            return [
                'ok' => false,
                'timeout' => true,
                'guidance' => 'No human answered in time. Leave an internal note and resolve as uncompleted.',
            ];
        }

        $actor = (string)($answer['actor'] ?? '');
        $this->state->gateClose($gateId, self::redactSensitiveFields($args, $answer), $actor);
        $this->state->setStatus($runId, 'running');

        return ['ok' => true, 'decision' => $answer];
    }

    /**
     * Replace values of any `fields[].sensitive === true` name inside $decision with
     * the redaction marker. Used both for what GateManager stores and for what
     * PlaybookActionSpace ledgers — the caller always still gets $decision verbatim.
     */
    public static function redactSensitiveFields(array $args, array $decision): array
    {
        $sensitiveNames = [];
        foreach ((array)($args['fields'] ?? []) as $field) {
            if (is_array($field) && !empty($field['sensitive'])) {
                $sensitiveNames[] = (string)($field['name'] ?? '');
            }
        }
        if (empty($sensitiveNames)) {
            return $decision;
        }

        $redacted = $decision;
        foreach ($sensitiveNames as $fieldName) {
            if (array_key_exists($fieldName, $redacted)) {
                $redacted[$fieldName] = self::REDACTED;
            }
        }
        return $redacted;
    }
}
