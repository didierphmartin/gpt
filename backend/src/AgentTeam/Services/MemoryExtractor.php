<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Decides whether anything from a chat turn is worth saving as durable
 * memory, and emits proposed additions for the two scopes.
 *
 * Single non-streaming Claude API call. Designed to be called from the
 * tail of a request (after fastcgi_finish_request) so latency doesn't
 * affect the user. Returns null on any failure — callers must be OK
 * with "no update this turn" as a normal outcome.
 */
class MemoryExtractor
{
    private const ENDPOINT = 'https://api.anthropic.com/v1/messages';
    private const API_VERSION = '2023-06-01';
    private const MAX_TOKENS = 512;

    private string $apiKey;
    private Client $http;

    public function __construct(string $apiKey)
    {
        $this->apiKey = $apiKey;
        $this->http = new Client(['timeout' => 30]);
    }

    /**
     * @return array{memory_additions: string[], user_additions: string[], reason: string}|null
     */
    public function extract(
        string $model,
        string $currentMemory,
        string $currentUser,
        string $lastUserMsg,
        string $lastAssistantMsg
    ): ?array {
        if ($this->apiKey === '') {
            return null;
        }

        $system = $this->buildSystemPrompt();
        $userContent = $this->buildUserContent($currentMemory, $currentUser, $lastUserMsg, $lastAssistantMsg);

        try {
            $response = $this->http->post(self::ENDPOINT, [
                'headers' => [
                    'x-api-key' => $this->apiKey,
                    'anthropic-version' => self::API_VERSION,
                    'content-type' => 'application/json',
                ],
                'json' => [
                    'model' => $model,
                    'max_tokens' => self::MAX_TOKENS,
                    'system' => $system,
                    'messages' => [
                        ['role' => 'user', 'content' => $userContent],
                    ],
                ],
            ]);
        } catch (GuzzleException $e) {
            error_log('[MemoryExtractor] API call failed: ' . $e->getMessage());
            return null;
        }

        $body = json_decode((string) $response->getBody(), true);
        $text = $body['content'][0]['text'] ?? '';
        if ($text === '') {
            return null;
        }

        return $this->parseJson($text);
    }

    /**
     * Second-stage semantic guard: given current memory and candidate additions,
     * drop any addition that is already covered — even as a paraphrase or subset —
     * by the existing content. Returns a filtered array (may be empty).
     *
     * Runs only when the first-stage extractor proposed additions, so no cost
     * on the common "nothing to save" turns.
     *
     * @param string[] $additions
     * @return string[]
     */
    public function filterDuplicates(string $model, string $currentContent, array $additions): array
    {
        if ($this->apiKey === '' || empty($additions) || trim($currentContent) === '') {
            return $additions;
        }

        $system = "You decide which candidate facts are genuinely new vs. already covered by existing memory. "
            . "A candidate is ALREADY COVERED if the existing memory states it — even using different words, "
            . "even as a subset, even as a near-paraphrase, even if the existing line is more general. "
            . "Default to COVERED when in doubt. Respond with ONLY a JSON array of the 0-based indices of "
            . "candidates that are GENUINELY NEW (not covered). Example: [0, 2] means candidates 0 and 2 are new. "
            . "Empty array means none are new.";

        $candidateLines = [];
        foreach ($additions as $i => $a) {
            $candidateLines[] = "[{$i}] " . $a;
        }
        $userContent = "EXISTING MEMORY:\n{$currentContent}\n\nCANDIDATES:\n" . implode("\n", $candidateLines);

        try {
            $response = $this->http->post(self::ENDPOINT, [
                'headers' => [
                    'x-api-key' => $this->apiKey,
                    'anthropic-version' => self::API_VERSION,
                    'content-type' => 'application/json',
                ],
                'json' => [
                    'model' => $model,
                    'max_tokens' => 128,
                    'system' => $system,
                    'messages' => [
                        ['role' => 'user', 'content' => $userContent],
                    ],
                ],
            ]);
        } catch (GuzzleException $e) {
            error_log('[MemoryExtractor] filterDuplicates call failed: ' . $e->getMessage());
            return $additions;
        }

        $body = json_decode((string) $response->getBody(), true);
        $text = trim((string) ($body['content'][0]['text'] ?? ''));
        if ($text === '') {
            return $additions;
        }

        if (str_starts_with($text, '```')) {
            $text = preg_replace('/^```(?:json)?\s*|\s*```$/m', '', $text) ?? $text;
            $text = trim($text);
        }

        // Haiku sometimes emits the array followed by an explanation. Pluck the first JSON array.
        if (preg_match('/\[(?:\s*\d+\s*(?:,\s*\d+\s*)*)?\]/', $text, $m)) {
            $text = $m[0];
        }

        $indices = json_decode($text, true);
        if (!is_array($indices)) {
            error_log('[MemoryExtractor] filterDuplicates non-JSON: ' . mb_substr($text, 0, 200));
            return $additions;
        }

        $kept = [];
        foreach ($indices as $i) {
            if (is_int($i) && isset($additions[$i])) {
                $kept[] = $additions[$i];
            }
        }
        return $kept;
    }

    /**
     * Compact content to fit within a budget while preserving required lines.
     *
     * @param string[] $mustKeep Lines the extractor already decided to keep — never drop these.
     */
    public function compact(string $model, string $content, int $budget, array $mustKeep = []): ?string
    {
        if ($this->apiKey === '' || $content === '') {
            return null;
        }

        $system = "You are a memory compactor. Rewrite the given memory block so it fits within {$budget} characters. "
            . "Preserve facts in the REQUIRED section verbatim. Drop the oldest or least-useful lines from the EXISTING section to make room. "
            . "Merge duplicate or near-duplicate lines. Output ONLY the compacted text, no preamble, no quotes, no markdown fences.";

        $requiredBlock = empty($mustKeep) ? '(none)' : implode("\n", $mustKeep);
        $userContent = "REQUIRED (keep verbatim):\n{$requiredBlock}\n\nEXISTING (may be trimmed):\n{$content}";

        try {
            $response = $this->http->post(self::ENDPOINT, [
                'headers' => [
                    'x-api-key' => $this->apiKey,
                    'anthropic-version' => self::API_VERSION,
                    'content-type' => 'application/json',
                ],
                'json' => [
                    'model' => $model,
                    'max_tokens' => (int) ceil($budget / 2),
                    'system' => $system,
                    'messages' => [
                        ['role' => 'user', 'content' => $userContent],
                    ],
                ],
            ]);
        } catch (GuzzleException $e) {
            error_log('[MemoryExtractor] compact call failed: ' . $e->getMessage());
            return null;
        }

        $body = json_decode((string) $response->getBody(), true);
        $text = trim((string) ($body['content'][0]['text'] ?? ''));
        if ($text === '') {
            return null;
        }

        if (mb_strlen($text) > $budget) {
            $text = mb_substr($text, 0, $budget);
        }
        return $text;
    }

    private function buildSystemPrompt(): string
    {
        return <<<PROMPT
You are a memory curator for a long-running conversational assistant.

After each turn, you decide whether anything in the user's message or the assistant's reply is worth saving as durable memory for future conversations.

Two scopes exist:

USER — **anything about the person themselves**:
  - role, profession, expertise, areas of study
  - personal biographical facts: age, location, timezone, languages spoken, family status, life circumstances
  - hobbies, lifestyle, physical activities, habits
  - communication preferences, persistent likes/dislikes
  - tools they personally prefer to use
  Rule of thumb: if it describes WHO the user is or how they live, it goes here.

MEMORY — **facts about the user's projects, work, or environment**:
  - codebases, tech stack, conventions, tools in use on a specific project
  - ongoing work, milestones, decisions, constraints
  - systems, services, or data they reference
  - domain-specific facts relevant to their professional work
  Rule of thumb: if it describes WHAT the user is working on or the environment they operate in, it goes here.

When a fact could arguably fit both (e.g. "I'm a cardiology resident" — profession AND work context), prefer USER.
Never put biographical facts (age, location, hobbies, lifestyle, languages, family) into MEMORY.

**IMPORTANT**: classify each new fact by its nature, NOT by imitating where similar facts appear in the existing blocks. Previous turns may have misclassified items — do not perpetuate those mistakes. A biographical fact always goes to USER, even if the current MEMORY block already contains biographical lines.

Rules:
- Save only facts that are non-obvious AND likely useful across future conversations.
- **Aggressive duplicate rejection**: before adding anything, read the CURRENT MEMORY and CURRENT USER blocks line by line. If the new fact is already stated there — even in different words, even as a subset, even as a near-paraphrase — DO NOT propose it. When in doubt, omit.
  Examples of what counts as duplicate:
    existing: "User is a polymath interested in biomedical and computer science topics"
    proposed: "User has research interests across health and CS" → DUPLICATE, reject
    existing: "User prefers concise answers without hedging"
    proposed: "User likes direct replies, no fillers" → DUPLICATE, reject
- Skip transient task details ("I'm about to run X", "the error said Y") — those belong in the conversation, not memory.
- Each addition is a short single-line statement, no bullets, no preamble.
- If nothing genuinely new is worth saving, return empty arrays. That is the normal, expected outcome for most turns.

Respond with ONLY a JSON object, no markdown fences, no prose:
{
  "memory_additions": ["short fact 1", "short fact 2"],
  "user_additions":   ["short preference 1"],
  "reason": "one short phrase explaining what you saved, or 'nothing worth saving'"
}
PROMPT;
    }

    private function buildUserContent(string $currentMemory, string $currentUser, string $lastUserMsg, string $lastAssistantMsg): string
    {
        $currentMemory = $currentMemory !== '' ? $currentMemory : '(empty)';
        $currentUser = $currentUser !== '' ? $currentUser : '(empty)';
        $lastAssistantMsg = mb_substr($lastAssistantMsg, 0, 4000);
        $lastUserMsg = mb_substr($lastUserMsg, 0, 4000);

        return <<<CONTENT
=== CURRENT MEMORY ===
{$currentMemory}

=== CURRENT USER ===
{$currentUser}

=== LAST USER MESSAGE ===
{$lastUserMsg}

=== LAST ASSISTANT REPLY ===
{$lastAssistantMsg}
CONTENT;
    }

    /**
     * @return array{memory_additions: string[], user_additions: string[], reason: string}|null
     */
    private function parseJson(string $text): ?array
    {
        $text = trim($text);
        if (str_starts_with($text, '```')) {
            $text = preg_replace('/^```(?:json)?\s*|\s*```$/m', '', $text) ?? $text;
            $text = trim($text);
        }

        $data = json_decode($text, true);
        if (!is_array($data)) {
            error_log('[MemoryExtractor] non-JSON response: ' . mb_substr($text, 0, 200));
            return null;
        }

        $memoryAdditions = array_values(array_filter(
            (array) ($data['memory_additions'] ?? []),
            fn($v) => is_string($v) && trim($v) !== ''
        ));
        $userAdditions = array_values(array_filter(
            (array) ($data['user_additions'] ?? []),
            fn($v) => is_string($v) && trim($v) !== ''
        ));
        $reason = is_string($data['reason'] ?? null) ? $data['reason'] : '';

        return [
            'memory_additions' => $memoryAdditions,
            'user_additions' => $userAdditions,
            'reason' => mb_substr($reason, 0, 255),
        ];
    }
}
