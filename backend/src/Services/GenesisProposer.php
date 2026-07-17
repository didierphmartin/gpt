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
The user EXPLICITLY requested this promotion — demand is already established, so do NOT judge whether the procedure is "worth" a skill. Generalize the best skill you can from the material (uniform run histories are fine: parameterize by inspecting the structure). Return {"skill_name": null} ONLY when the material is truly unusable — empty, or containing no identifiable action at all.
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

    /** A saved, reused prompt is a proto-skill: its text is the trigger material. */
    public static function buildPromptLibraryPrompt(string $name, string $content, array $catalog): string
    {
        return "You analyse ONE saved prompt from the user's prompt library — a prompt they saved to reuse — "
            . "and propose a skill that encapsulates the procedure it invokes.\n"
            . "The prompt text is the best possible evidence of the trigger: derive the WHEN from how the "
            . "prompt is phrased, and the DO from what it instructs. Lift concrete values (topics, formats, "
            . "currencies, counts) into parameters with the observed values as defaults/examples.\n\n"
            . "SAVED PROMPT \"" . $name . "\":\n---\n" . self::truncate($content, self::MAX_TRANSCRIPT_CHARS) . "\n---\n\n"
            . "EXISTING SKILL CATALOG (name — description):\n" . self::catalogBlock($catalog) . "\n\n"
            . self::OUTPUT_CONTRACT;
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
