<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

final class PlaybookAnalyzer
{
    /** #Action name (case-insensitive, trimmed) => native tool id */
    public const NATIVE_VERBS = [
        '#send direct message' => 'send_direct_message',
        '#send channel message' => 'send_channel_message',
        '#send email' => 'send_email',
        '#leave internal note' => 'leave_internal_note',
        '#resolve request' => 'resolve_request',
        '#escalate request' => 'set_priority',
        '#request approval' => 'request_approval',
        '#prompt for handoff' => 'prompt_handoff',
        '#trigger form' => 'trigger_form',
    ];
    private const GATE_BY_NATIVE = [
        'request_approval' => 'approval', 'prompt_handoff' => 'handoff', 'trigger_form' => 'form',
    ];

    /** @param string[] $availableTools "server.tool" ids @param string[] $availableAgents agent names */
    public function analyze(PlaybookDocument $doc, array $availableTools, array $availableAgents = []): array
    {
        $actions = []; $gates = []; $errors = []; $warnings = [];
        // Checklist = #Actions in prose order (longest-name-first match so
        // "#Reset User Factors (Custom)" wins over "#Reset User Factor").
        $names = $doc->actionsUsed;
        usort($names, fn($a, $b) => strlen($b) <=> strlen($a));
        $positions = [];
        foreach ($names as $name) {
            $pos = stripos($doc->instructions, $name);
            $positions[$name] = $pos === false ? PHP_INT_MAX : $pos;
        }
        $ordered = $doc->actionsUsed;
        usort($ordered, fn($a, $b) => $positions[$a] <=> $positions[$b]);

        foreach ($ordered as $name) {
            $key = strtolower(trim($name));
            if (isset(self::NATIVE_VERBS[$key])) {
                $native = self::NATIVE_VERBS[$key];
                $actions[] = ['name' => $name, 'kind' => 'native', 'target' => $native];
                if (isset(self::GATE_BY_NATIVE[$native])) $gates[] = self::GATE_BY_NATIVE[$native];
                continue;
            }
            $target = $doc->bindings[$name] ?? null;
            if ($target === null) {
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => null];
                $warnings[] = "Unbound action {$name}: at run time the '{$doc->policy['on_unbound']}' policy applies.";
                continue;
            }
            if (str_starts_with($target, 'agent.')) {
                $agent = substr($target, 6);
                if (in_array($agent, $availableAgents, true)) {
                    $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target];
                } else {
                    $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target];
                    $errors[] = "{$name} is bound to {$target} but no such agent exists.";
                }
                continue;
            }
            if (in_array($target, $availableTools, true)) {
                $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target];
            } else {
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target];
                $errors[] = "{$name} is bound to {$target} but that tool is not available on any connected MCP server.";
            }
        }
        return ['actions' => $actions, 'gates' => array_values(array_unique($gates)),
                'checklist' => $ordered, 'errors' => $errors, 'warnings' => $warnings];
    }
}
