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

        // "where" = the step/line of the Instructions the action first appears
        // on, quoted, so the author can find and fix the faulty statement.
        $where = fn(string $name): string => self::locate($doc->instructions, $name);

        // #Actions written in the prose but absent from "Actions used" never
        // get an action-space entry (they silently fall to the unbound
        // policy at run time) — point at the exact line.
        $listed = array_map(fn($n) => strtolower(trim($n)), $doc->actionsUsed);
        $seen = [];
        $step = '';
        foreach (preg_split('/\r?\n/', $doc->instructions) as $i => $line) {
            $step = self::stepOf($line, $step);
            if (!preg_match_all('/#[A-Z][\w\'’]*(?: [A-Z][\w\'’]*){0,5}(?: \([A-Za-z ]+\))?/u', $line, $mm)) continue;
            foreach ($mm[0] as $found) {
                $k = strtolower($found);
                if (isset($seen[$k])) continue;
                // Skip if it is (a prefix of) a listed action on this line.
                $covered = false;
                foreach ($listed as $l) { if (str_starts_with($l, $k) || str_starts_with($k, $l)) { $covered = true; break; } }
                if ($covered) continue;
                $seen[$k] = true;
                $warnings[] = "{$found} is used in the Instructions but not listed under \"Actions used\", so it will not be bound"
                    . ' — ' . self::describeLine($i, $line, $step) . '.';
            }
        }

        foreach ($ordered as $name) {
            if ($positions[$name] === PHP_INT_MAX) {
                $notices[] = "{$name} is listed under \"Actions used\" but never appears in the Instructions.";
            }
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
                $warnings[] = "Unbound action {$name}: at run time the '{$doc->policy['on_unbound']}' policy applies" . $where($name) . '.';
                continue;
            }
            if (str_starts_with($target, 'agent.')) {
                $agent = substr($target, 6);
                if (in_array($agent, $availableAgents, true)) {
                    $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target, 'auto' => false];
                } else {
                    $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target, 'auto' => false];
                    $errors[] = "{$name} is bound to {$target} but no such agent exists" . $where($name) . '.';
                }
                continue;
            }
            if (in_array($target, $availableTools, true)) {
                $actions[] = ['name' => $name, 'kind' => 'bound', 'target' => $target, 'auto' => false];
            } else {
                $actions[] = ['name' => $name, 'kind' => 'unbound', 'target' => $target, 'auto' => false];
                $errors[] = "{$name} is bound to {$target} but that tool is not available on any connected MCP server" . $where($name) . '.';
            }
        }
        return ['actions' => $actions, 'gates' => array_values(array_unique($gates)),
                'checklist' => $ordered, 'errors' => $errors, 'warnings' => $warnings, 'notices' => $notices];
    }

    /** " — step 7: \"7. #Foo …\"" for the first Instructions line containing $name, else "". */
    private static function locate(string $instructions, string $name): string
    {
        $step = '';
        foreach (preg_split('/\r?\n/', $instructions) as $i => $line) {
            $step = self::stepOf($line, $step);
            if (stripos($line, $name) !== false) return ' — ' . self::describeLine($i, $line, $step);
        }
        return '';
    }

    /** The author's step number on this line ("7", "2.1"), else the enclosing one carried in. */
    private static function stepOf(string $line, string $current): string
    {
        return preg_match('/^\s*(\d+(?:\.\d+)*)[.)]?\s/', $line, $m) ? $m[1] : $current;
    }

    /** 'step 7: "…"' on a numbered line; 'step 4, line 7: "…"' for a sub-line; 'line N: "…"' outside any step. */
    private static function describeLine(int $index, string $line, string $step): string
    {
        $t = trim($line);
        $numbered = preg_match('/^\d+(?:\.\d+)*[.)]?\s/', $t);
        $label = $numbered ? "step {$step}" : ($step !== '' ? "step {$step}, line " . ($index + 1) : 'Instructions line ' . ($index + 1));
        if (mb_strlen($t) > 90) $t = mb_substr($t, 0, 87) . '…';
        return $label . ': "' . $t . '"';
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
