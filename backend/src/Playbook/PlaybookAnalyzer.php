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
        $actions = []; $gates = []; $errors = []; $warnings = []; $notices = [];
        // Checklist = #Actions in prose order. Find positions longest-name-first
        // on a working copy of the instructions, masking each match (blanking it
        // out) as it's found, so a shorter name occurring only as a prefix/substring
        // of a longer one (e.g. "#Reset User Factor" inside "#Reset User Factors
        // (Custom)") isn't mistaken for its own, earlier occurrence.
        $names = $doc->actionsUsed;
        usort($names, fn($a, $b) => strlen($b) <=> strlen($a));
        $working = $doc->instructions;
        $positions = [];
        foreach ($names as $name) {
            $pos = stripos($working, $name);
            $positions[$name] = $pos === false ? PHP_INT_MAX : $pos;
            if ($pos !== false) {
                $working = substr_replace($working, str_repeat(' ', strlen($name)), $pos, strlen($name));
            }
        }
        $ordered = $doc->actionsUsed;
        usort($ordered, fn($a, $b) => $positions[$a] <=> $positions[$b]);

        foreach ($ordered as $name) {
            $key = strtolower(trim($name));
            if (isset(self::NATIVE_VERBS[$key])) {
                $native = self::NATIVE_VERBS[$key];
                $actions[] = ['name' => $name, 'kind' => 'native', 'target' => $native, 'auto' => false];
                if (isset(self::GATE_BY_NATIVE[$native])) $gates[] = self::GATE_BY_NATIVE[$native];
                continue;
            }
            $hasExplicit = array_key_exists($name, $doc->bindings);
            $target = $doc->bindings[$name] ?? null;
            if ($target === null) {
                // Markdown/Console text is the source format: when the author
                // gave NO binding (key absent), translate the #Action to a
                // connected tool by name-matching. An explicit null stays
                // deliberately unbound.
                $auto = $hasExplicit ? null : $this->autoBind($name, $availableTools);
                if ($auto !== null) {
                    $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $auto, 'auto' => true];
                    // Informational, not a problem: goes to 'notices', never 'warnings'.
                    $notices[] = "Auto-bound {$name} → {$auto} (matched by name; add an explicit binding to override).";
                    continue;
                }
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => null, 'auto' => false];
                $warnings[] = "Unbound action {$name}: at run time the '{$doc->policy['on_unbound']}' policy applies.";
                continue;
            }
            if (str_starts_with($target, 'agent.')) {
                $agent = substr($target, 6);
                if (in_array($agent, $availableAgents, true)) {
                    $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target, 'auto' => false];
                } else {
                    $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target, 'auto' => false];
                    $errors[] = "{$name} is bound to {$target} but no such agent exists.";
                }
                continue;
            }
            if (in_array($target, $availableTools, true)) {
                $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target, 'auto' => false];
            } else {
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target, 'auto' => false];
                $errors[] = "{$name} is bound to {$target} but that tool is not available on any connected MCP server.";
            }
        }
        return ['actions' => $actions, 'gates' => array_values(array_unique($gates)),
                'checklist' => $ordered, 'errors' => $errors, 'warnings' => $warnings, 'notices' => $notices];
    }

    /**
     * Deterministic name-match of a prose #Action to one connected
     * "server.tool". Tokens are lowercased, de-pluralized words; a match
     * needs score >= 2 and a strictly unique best candidate. Server-name
     * tokens in the action name weigh double ("Okta" in "#Reset Password
     * (Okta)" is a strong signal). Returns the tool id or null.
     */
    private function autoBind(string $actionName, array $availableTools): ?string
    {
        $stop = ['custom', 'the', 'a', 'an', 'by', 'for', 'to', 'and', 'of', 'action'];
        $tok = function (string $t) use ($stop): array {
            $words = preg_split('/[^a-z0-9]+/', strtolower($t)) ?: [];
            $out = [];
            foreach ($words as $w) {
                if ($w === '' || in_array($w, $stop, true)) continue;
                $out[] = rtrim($w, 's') ?: $w;
            }
            return array_values(array_unique($out));
        };
        $actionTokens = $tok($actionName);
        if ($actionTokens === []) return null;

        $best = null; $bestScore = 0; $tie = false;
        foreach ($availableTools as $id) {
            $dot = strpos($id, '.');
            $server = $dot === false ? '' : substr($id, 0, $dot);
            $tool = $dot === false ? $id : substr($id, $dot + 1);
            // Integer-scaled: server token = 4, tool token = 2, +1 when the
            // action covers the WHOLE tool name (breaks ties like
            // "#Reset User Factor" between reset_factor and list_user_factors
            // in favor of the fully-covered reset_factor).
            $score = 0;
            foreach ($tok($server) as $st) {
                if (in_array($st, $actionTokens, true)) $score += 4;
            }
            $toolTokens = $tok($tool);
            $toolHits = 0;
            foreach ($toolTokens as $tt) {
                if (in_array($tt, $actionTokens, true)) $toolHits++;
            }
            $score += 2 * $toolHits;
            if ($toolTokens !== [] && $toolHits === count($toolTokens)) $score += 1;
            if ($score > $bestScore) { $best = $id; $bestScore = $score; $tie = false; }
            elseif ($score === $bestScore && $score > 0) { $tie = true; }
        }
        return ($bestScore >= 4 && !$tie) ? $best : null;
    }
}
