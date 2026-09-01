<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

final class PlaybookNativeTools
{
    public function __construct(
        private readonly PlaybookRunState $state,
    ) {}

    public function definitions(): array
    {
        return [
            [
                'type' => 'function',
                'function' => [
                    'name' => 'send_direct_message',
                    'description' => 'Send a message directly to the requester',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'text' => ['type' => 'string', 'description' => 'Message text'],
                            'sensitive' => ['type' => 'boolean', 'description' => 'Mark as sensitive for redaction'],
                        ],
                        'required' => ['text'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'send_channel_message',
                    'description' => 'Send a message to a channel',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'channel' => ['type' => 'string', 'description' => 'Channel name'],
                            'text' => ['type' => 'string', 'description' => 'Message text'],
                        ],
                        'required' => ['channel', 'text'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'send_email',
                    'description' => 'Send an email',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'to' => ['type' => 'string', 'description' => 'Email recipient'],
                            'subject' => ['type' => 'string', 'description' => 'Email subject'],
                            'text' => ['type' => 'string', 'description' => 'Email body'],
                        ],
                        'required' => ['to', 'subject', 'text'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'leave_internal_note',
                    'description' => 'Leave an internal note on the run',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'text' => ['type' => 'string', 'description' => 'Note text'],
                        ],
                        'required' => ['text'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'set_priority',
                    'description' => 'Set the priority of the request',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'priority' => ['type' => 'string', 'description' => 'Priority level'],
                            'reason' => ['type' => 'string', 'description' => 'Reason for priority'],
                        ],
                        'required' => ['priority', 'reason'],
                    ],
                ],
            ],
            [
                'type' => 'function',
                'function' => [
                    'name' => 'resolve_request',
                    'description' => 'Mark the request as resolved',
                    'parameters' => [
                        'type' => 'object',
                        'properties' => [
                            'outcome' => ['type' => 'string', 'description' => 'Resolution outcome'],
                            'summary' => ['type' => 'string', 'description' => 'Resolution summary'],
                        ],
                        'required' => ['outcome', 'summary'],
                    ],
                ],
            ],
        ];
    }

    public function execute(int $runId, int $leg, string $name, array $args): array
    {
        return match ($name) {
            'send_direct_message' => $this->sendDirectMessage($runId, $args),
            'send_channel_message' => $this->sendChannelMessage($runId, $args),
            'send_email' => $this->sendEmail($runId, $args),
            'leave_internal_note' => $this->leaveInternalNote($runId, $args),
            'set_priority' => $this->setPriority($runId, $args),
            'resolve_request' => $this->resolveRequest($runId, $args),
            default => ['ok' => false, 'error' => "Unknown tool: $name"],
        };
    }

    private function sendDirectMessage(int $runId, array $args): array
    {
        $text = $args['text'] ?? '';
        $sensitive = $args['sensitive'] ?? false;
        $this->state->addMessage($runId, 'to_requester', null, $text, (bool)$sensitive);
        return ['ok' => true];
    }

    private function sendChannelMessage(int $runId, array $args): array
    {
        $channel = $args['channel'] ?? '';
        $text = $args['text'] ?? '';
        $this->state->addMessage($runId, 'to_channel', $channel, $text, false);
        return ['ok' => true];
    }

    private function sendEmail(int $runId, array $args): array
    {
        $to = $args['to'] ?? '';
        $subject = $args['subject'] ?? '';
        $text = $args['text'] ?? '';
        $this->state->addMessage($runId, 'to_email', $to, $text, false);
        return ['ok' => true];
    }

    private function leaveInternalNote(int $runId, array $args): array
    {
        $text = $args['text'] ?? '';
        $this->state->addNote($runId, $text, 'agent');
        return ['ok' => true];
    }

    private function setPriority(int $runId, array $args): array
    {
        $priority = $args['priority'] ?? '';
        $reason = $args['reason'] ?? '';
        $noteText = "priority → $priority: $reason";
        $this->state->addNote($runId, $noteText, 'agent');
        return ['ok' => true];
    }

    private function resolveRequest(int $runId, array $args): array
    {
        $this->state->setStatus($runId, 'resolved');
        return ['ok' => true, 'terminal' => true];
    }
}
