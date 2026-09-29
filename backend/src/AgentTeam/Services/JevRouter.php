<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Routing decisions from TypeSafe AI's Jev, for dispatcher nodes.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A PROVIDER
 * =============================================
 * Jev is a "System One" model: text in, a probability distribution out. It
 * cannot generate text, so it is not a chat provider. Its key is stored where
 * LLM keys are (a ROUTER row in system_llm_settings, api_format 'router', and
 * per-user rows in user_api_keys), but every chat path skips router rows --
 * they all assume a provider can answer a prompt, and Jev cannot. The key a
 * run uses comes from JevKeyResolver and is passed in; this class never reads
 * the environment.
 *
 * What it CAN do is the one thing a dispatcher node actually needs: pick one
 * option from a closed set. That matters beyond speed. An LLM answering a
 * closed question through a forced route_to tool call can still name a branch
 * that does not exist, which is why DispatchRouting::resolve() carries
 * case-insensitive matching and a prose fallback. Jev's answer is CONSTRAINED
 * to the options supplied -- "never a value outside them" -- so a hallucinated
 * branch is not merely unlikely, it is unrepresentable.
 *
 * THE UNCLEAR OPTION IS LOAD-BEARING
 * ==================================
 * Measured on workflow 44 (three well-separated teams) BEFORE this was added:
 * every input saturated. "hello" routed to IT claims with confidence 0.97;
 * "Something is wrong and I need help" to IT claims at 0.99. That is the
 * constraint working as designed -- forced to choose among three teams, it
 * chooses. So a confidence threshold alone catches nothing.
 *
 * Because answers can only be options we supply, "I cannot tell" has to BE an
 * option. With one added, the same inputs return unclear at 1.00 while genuine
 * requests still route at >= 0.95. Two different failure modes, two signals:
 *
 *   unclear            -> absent signal. Route nowhere; hand off to a human
 *                         (the existing "did not route" path).
 *   confidence < floor -> divided signal. A branch is defensible but so is the
 *                         other one ("upgrade to the annual plan": Sales 0.73 /
 *                         Billing 0.27, confidence 0.46). Escalate to the LLM
 *                         dispatcher, which can weigh it AND write the notes
 *                         the chosen child receives -- something Jev cannot do.
 *
 * On workflow 43's overlapping Billing/Sales menu, clean requests came back at
 * >= 0.95 and the two genuinely straddling ones at 0.46 and 0.51, so the floor
 * separates them cleanly. It is a starting point tuned from ~20 requests on two
 * workflows, not a constant: expose it, do not hardcode a belief.
 */
final class JevRouter
{
    /** POST target. Captured from typesafe-sdk 0.7.2 rather than inferred. */
    private const URL = 'https://api.typesafe.ai/v1/systemone';

    /** Pinned by name, not by version: the API resolves it (answered jev-1.13.0 when written). */
    private const MODEL = 'jev-latest';

    /** The synthetic option that lets "I cannot tell" be sayable. Never a real branch name. */
    public const UNCLEAR = 'unclear';

    private const UNCLEAR_DESC = 'The request does not say enough to choose, or it genuinely spans '
        . 'several of the options. Pick this rather than guessing.';

    /**
     * Below this, the decision is treated as divided and handed to the LLM.
     * 0.6 sits above every straddling case measured (0.46, 0.51) and well below
     * every clean one (>= 0.95).
     */
    public const DEFAULT_CONFIDENCE_FLOOR = 0.6;

    public function __construct(
        private ?string $apiKey = null,
        private ?Client $http = null,
        private float $confidenceFloor = self::DEFAULT_CONFIDENCE_FLOOR
    ) {
        // null = not configured. The key comes from JevKeyResolver (user row,
        // else the global router row); .env TYPESAFE_API_KEY is deliberately
        // NOT read, or it would bypass that precedence.
        $this->apiKey ??= '';
        // 10s: a measured p50 of ~160ms and max of 385ms means a request still
        // running after ten seconds is broken, not slow. Failing fast matters
        // because the caller's fallback is a working LLM route, not an error.
        $this->http ??= new Client(['timeout' => 10]);
    }

    /** Configured = a key is present. Without one, callers keep the LLM path untouched. */
    public function isAvailable(): bool
    {
        return $this->apiKey !== '';
    }

    /**
     * Choose one target for `$request`, or say why not.
     *
     * @param array $targets DispatchRouting::targets() shape: [['id' => int, 'name' => string,
     *                       'description' => string], …]
     * @param string $question What the dispatcher is deciding — the node's own prompt, so the
     *                         node stays configurable instead of this class inventing the question.
     *
     * @return array{outcome: 'routed'|'unclear'|'low_confidence'|'unavailable'|'error',
     *               target: ?array, confidence: ?float, probabilities: array,
     *               ms: ?int, usage: array, reason: ?string}
     *         'routed' is the only outcome that decides. Every other one tells the caller to
     *         fall back rather than pretending: 'unclear' -> hand off, 'low_confidence' ->
     *         LLM dispatcher, 'unavailable'/'error' -> LLM dispatcher.
     */
    public function route(string $request, array $targets, string $question): array
    {
        $blank = ['target' => null, 'confidence' => null, 'probabilities' => [], 'ms' => null, 'usage' => []];
        if (!$this->isAvailable()) {
            return $blank + ['outcome' => 'unavailable', 'reason' => 'no Jev key'];
        }
        $named = [];
        foreach ($targets as $t) {
            $name = trim((string) ($t['name'] ?? ''));
            if ($name === '' || strcasecmp($name, self::UNCLEAR) === 0) {
                // A branch literally named "unclear" would collide with the escape
                // hatch and make its answer ambiguous. Refuse the whole call rather
                // than route on a menu we cannot read back.
                return $blank + ['outcome' => 'error', 'reason' => "unusable target name: '{$name}'"];
            }
            $named[$name] = $t;
        }
        if (count($named) < 2) {
            return $blank + ['outcome' => 'error', 'reason' => 'a menu needs at least two targets'];
        }

        $criteria = [];
        foreach ($named as $name => $t) {
            // The child's own role is the best description of what it owns; fall
            // back to the name so a target with no prompt is still selectable.
            $desc = trim((string) ($t['description'] ?? ''));
            $criteria[$name] = $desc !== '' ? mb_substr($desc, 0, 400) : $name;
        }
        $criteria[self::UNCLEAR] = self::UNCLEAR_DESC;

        $body = [
            'state' => ['request' => $request],
            'model' => self::MODEL,
            'questions' => [
                'route' => ['type' => 'choice', 'instructions' => $question, 'criteria' => $criteria],
            ],
        ];

        $t0 = microtime(true);
        try {
            $res = $this->http->post(self::URL, [
                'headers' => ['Authorization' => 'Bearer ' . $this->apiKey, 'Accept' => 'application/json'],
                'json' => $body,
            ]);
            $decoded = json_decode((string) $res->getBody(), true);
        } catch (GuzzleException | \JsonException $e) {
            return $blank + ['outcome' => 'error', 'reason' => $e->getMessage()];
        }
        $ms = (int) round((microtime(true) - $t0) * 1000);

        $answer = $decoded['answers']['route'] ?? null;
        if (!is_array($answer) || !isset($answer['choice'])) {
            return $blank + ['outcome' => 'error', 'ms' => $ms, 'reason' => 'no choice in the response'];
        }
        $choice = (string) $answer['choice'];
        $conf   = isset($answer['confidence']) ? (float) $answer['confidence'] : null;
        $probs  = is_array($answer['probabilities'] ?? null) ? $answer['probabilities'] : [];
        $usage  = is_array($decoded['usage'] ?? null) ? $decoded['usage'] : [];
        $common = ['confidence' => $conf, 'probabilities' => $probs, 'ms' => $ms, 'usage' => $usage];

        if ($choice === self::UNCLEAR) {
            return $common + ['outcome' => 'unclear', 'target' => null,
                              'reason' => 'the request names no branch'];
        }
        if (!isset($named[$choice])) {
            // Should be unreachable: the answer is constrained to what we sent.
            // Treated as an error rather than trusted, because the whole reason
            // to use Jev here is that this cannot happen.
            return $common + ['outcome' => 'error', 'target' => null,
                              'reason' => "answer '{$choice}' is not on the menu"];
        }
        if ($conf !== null && $conf < $this->confidenceFloor) {
            return $common + ['outcome' => 'low_confidence', 'target' => $named[$choice],
                              'reason' => sprintf('confidence %.2f below floor %.2f', $conf, $this->confidenceFloor)];
        }
        return $common + ['outcome' => 'routed', 'target' => $named[$choice], 'reason' => null];
    }
}
