<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * GenesisProposer — pure prompt-building + response-parsing for the one-shot
 * "propose a skill from this conversation / workflow" reflection (L0 of
 * docs/specs/2026-07-14-skill-genesis-design.md). The LLM call itself is made
 * by the caller (GenesisController via ChatController::agent) so provider
 * settings, user keys and quota checks apply uniformly.
 */
final class GenesisProposer
{
    /** Cap transcript/run material so the reflection stays one cheap call. */
    private const MAX_TRANSCRIPT_CHARS = 12000;
    private const MAX_RUNS = 20;

    private const OUTPUT_CONTRACT = <<<'TXT'
Respond with ONE JSON object only — no markdown fences, no commentary:
{
  "skill_name": "<kebab-case name, max 60 chars>",
  "description": "<WHEN <trigger> DO <steps> — one paragraph, trigger-shaped, generalized (parameters, not literals)>",
  "eval_queries": [{"query": "<realistic user prompt>", "should_trigger": true|false}, ...  6-12 items, mix of positives (paraphrases of the real trigger) and negatives (adjacent but out-of-scope)],
  "parameter_schema": {"<param>": {"type": "string", "examples": ["..."], "default": "..."}} or null,
  "merge_target": "<existing skill name from the catalog that already covers this>" or null,
  "rationale": "<one sentence: why this is a repeatable procedure worth a skill>"
}
If an existing catalog skill already covers this procedure, you MUST set merge_target instead of inventing a near-duplicate name.
If the material contains no repeatable multi-step procedure, return {"skill_name": null}.
TXT;

    /** @param array<array{role:string,content:mixed}> $messages */
    public static function buildConversationPrompt(array $messages, array $catalog): string
    {
        $lines = [];
        foreach ($messages as $m) {
            $role = strtoupper((string) ($m['role'] ?? 'user'));
            $content = is_string($m['content'] ?? null) ? $m['content'] : json_encode($m['content'] ?? '');
            if (trim((string) $content) === '') continue;
            $lines[] = "$role: $content";
        }
        $transcript = self::truncate(implode("\n\n", $lines), self::MAX_TRANSCRIPT_CHARS);

        return "You analyse ONE conversation between a user and an AI assistant and decide whether it "
            . "contains a repeatable multi-step PROCEDURE the user is likely to want again — and if so, "
            . "propose a skill that encapsulates it.\n\n"
            . "EXISTING SKILL CATALOG (name — description):\n" . self::catalogBlock($catalog) . "\n\n"
            . "CONVERSATION TRANSCRIPT:\n---\n" . $transcript . "\n---\n\n"
            . self::OUTPUT_CONTRACT;
    }

    /**
     * @param array{id:int|string,name:string,description?:?string,steps?:mixed} $workflow
     * @param array<array{input_variables:mixed}> $runs
     */
    public static function buildWorkflowPrompt(array $workflow, array $runs, array $catalog): string
    {
        $runLines = [];
        foreach (array_slice($runs, 0, self::MAX_RUNS) as $i => $r) {
            $iv = $r['input_variables'] ?? [];
            if (is_string($iv)) $iv = json_decode($iv, true) ?: [];
            $runLines[] = 'run ' . ($i + 1) . ' inputs: '
                . json_encode($iv, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        }

        return "You analyse the run history of ONE user-built workflow and propose a skill that wraps it, "
            . "PARAMETERIZED so a chat prompt can trigger it with different inputs.\n"
            . "Diff the runs: whatever VARIED across inputs becomes a parameter (observed values are the "
            . "examples); whatever stayed CONSTANT stays baked in. If the runs are uniform, propose "
            . "parameters by inspecting what in the workflow's purpose is most likely to vary, and mark "
            . "them as inspection-based in the rationale.\n\n"
            . "WORKFLOW: #{$workflow['id']} \"{$workflow['name']}\""
            . (isset($workflow['description']) && $workflow['description'] !== null && $workflow['description'] !== ''
                ? " — {$workflow['description']}" : '') . "\n\n"
            . self::structureBlock($workflow['steps'] ?? null) . "\n\n"
            . "RUN HISTORY:\n" . self::truncate(implode("\n", $runLines), self::MAX_TRANSCRIPT_CHARS) . "\n\n"
            . "EXISTING SKILL CATALOG (name — description):\n" . self::catalogBlock($catalog) . "\n\n"
            . self::OUTPUT_CONTRACT;
    }

    /** Renders the workflow's graph (steps column) as a compact one-line-per-step summary. */
    private static function structureBlock(mixed $stepsRaw): string
    {
        if (is_string($stepsRaw)) {
            $steps = json_decode($stepsRaw, true);
        } elseif (is_array($stepsRaw)) {
            $steps = $stepsRaw;
        } else {
            $steps = null;
        }

        if (!is_array($steps) || empty($steps)) {
            return 'STRUCTURE: (not available)';
        }

        $lines = [];
        foreach (array_values($steps) as $i => $step) {
            $lines[] = self::formatStep($i, $step);
        }

        return "STRUCTURE:\n" . self::truncate(implode("\n", $lines), self::MAX_TRANSCRIPT_CHARS);
    }

    /** One-line summary of a single workflow step; defensive about unknown/missing shape. */
    private static function formatStep(int $index, mixed $step): string
    {
        $n = $index + 1;
        if (!is_array($step)) {
            return "step $n: " . self::truncate((string) json_encode($step, JSON_UNESCAPED_SLASHES), 160);
        }

        $type = $step['type'] ?? $step['agent'] ?? null;
        $name = $step['name'] ?? null;
        $label = trim(implode(' ', array_filter([
            is_string($name) && $name !== '' ? $name : null,
            is_string($type) && $type !== '' ? "($type)" : null,
        ])));
        if ($label === '') $label = "(step $n)";

        $excerptSource = $step['instructions'] ?? $step['config'] ?? null;
        if ($excerptSource === null) {
            $excerptSource = json_encode($step, JSON_UNESCAPED_SLASHES);
        } elseif (!is_string($excerptSource)) {
            $excerptSource = json_encode($excerptSource, JSON_UNESCAPED_SLASHES);
        }
        $excerpt = self::truncate((string) $excerptSource, 160);

        return "step $n: $label — $excerpt";
    }

    /** Parse + validate the LLM's proposal. Null = no usable proposal. */
    public static function parseProposal(string $llmText): ?array
    {
        if (!preg_match('/\{.*\}/s', $llmText, $m)) {
            return null;
        }
        $data = json_decode($m[0], true);
        if (!is_array($data)) return null;

        $mergeTarget = (isset($data['merge_target']) && is_string($data['merge_target']) && $data['merge_target'] !== '')
            ? $data['merge_target'] : null;

        $hasSkillName = isset($data['skill_name']) && is_string($data['skill_name']) && $data['skill_name'] !== '';
        $isMerge = !$hasSkillName && $mergeTarget !== null;

        if (!$hasSkillName && !$isMerge) {
            return null; // includes the explicit {"skill_name": null} no-procedure answer
        }
        if (!isset($data['description']) || !is_string($data['description']) || trim($data['description']) === '') {
            return null;
        }

        // Merge proposals carry the name in merge_target; non-merge proposals carry it in skill_name.
        $rawName = $isMerge ? $mergeTarget : $data['skill_name'];
        $name = strtolower(trim($rawName));
        $name = preg_replace('/[^a-z0-9]+/', '-', $name);
        $name = trim(preg_replace('/-+/', '-', $name), '-');
        $name = substr($name, 0, 60);
        if ($name === '') return null;

        $evals = [];
        foreach ((array) ($data['eval_queries'] ?? []) as $q) {
            if (is_array($q) && isset($q['query'], $q['should_trigger']) && is_string($q['query'])) {
                $evals[] = ['query' => $q['query'], 'should_trigger' => (bool) $q['should_trigger']];
            }
        }

        return [
            'skill_name' => $name,
            'description' => trim($data['description']),
            'eval_queries' => $evals,
            'parameter_schema' => is_array($data['parameter_schema'] ?? null) ? $data['parameter_schema'] : null,
            'merge_target' => $mergeTarget,
            'rationale' => is_string($data['rationale'] ?? null) ? $data['rationale'] : '',
            'is_merge' => $isMerge,
        ];
    }

    private static function catalogBlock(array $catalog): string
    {
        if (empty($catalog)) return '(catalog empty)';
        $lines = [];
        foreach ($catalog as $s) {
            if (!is_array($s) || empty($s['name'])) continue;
            $lines[] = '- ' . $s['name'] . ' — ' . (string) ($s['description'] ?? '');
        }
        return $lines ? implode("\n", $lines) : '(catalog empty)';
    }

    private static function truncate(string $text, int $max): string
    {
        if (mb_strlen($text) <= $max) return $text;
        return mb_substr($text, 0, $max) . "\n[…truncated…]";
    }
}
