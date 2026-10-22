<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use GuzzleHttp\Exception\RequestException;

/**
 * Routing decisions from OpenAI's Decisions API (GPT-6 Luna), for dispatcher nodes.
 *
 * The `openai` protocol adapter (DecisionProtocols). Same contract as JevRouter:
 * POST /v1/decisions answers a `choice` question with one of the values supplied,
 * never a value outside them, and bills no output. Everything JevRouter's
 * docblock says about the menu holds here too -- above all the synthetic
 * `unclear` option, without which every input saturates onto some branch.
 *
 * Wire differences from Jev (developers.openai.com/api/docs/guides/decisions):
 * `input` instead of `state`; `questions` and `answers` are arrays matched by
 * `name`; choices are [{value, description}] (2..255); an answer may come back
 * as type `refusal`.
 */
final class OpenAIDecisionRouter implements DecisionRouter
{
    public const URL = 'https://api.openai.com/v1/decisions';

    /** The only model the Decisions API serves (public beta, 2026-10). */
    public const MODEL = 'gpt-6-luna';

    public const UNCLEAR = JevRouter::UNCLEAR;

    private const UNCLEAR_DESC = 'The request does not say enough to choose, or it genuinely spans '
        . 'several of the options. Pick this rather than guessing.';

    /** The API's limit on choices per question, the unclear option included. */
    private const MAX_CHOICES = 255;

    public function __construct(
        private ?string $apiKey = null,
        private ?Client $http = null,
        private float $confidenceFloor = JevRouter::DEFAULT_CONFIDENCE_FLOOR,
        // A gateway in front of OpenAI (DecisionKeyResolver url); '' = URL.
        private string $url = '',
        private string $model = ''
    ) {
        $this->apiKey ??= '';
        $this->url = trim($this->url) !== '' ? trim($this->url) : self::URL;
        $this->model = trim($this->model) !== '' ? trim($this->model) : self::MODEL;
        $this->http ??= new Client(['timeout' => 10]);
    }

    public function isAvailable(): bool
    {
        return $this->apiKey !== '';
    }

    public function route(string $request, array $targets, string $question): array
    {
        $blank = ['target' => null, 'confidence' => null, 'probabilities' => [], 'ms' => null, 'usage' => []];
        if (!$this->isAvailable()) {
            return $blank + ['outcome' => 'unavailable', 'reason' => 'no OpenAI key'];
        }
        $named = [];
        foreach ($targets as $t) {
            $name = trim((string) ($t['name'] ?? ''));
            if ($name === '' || strcasecmp($name, self::UNCLEAR) === 0) {
                return $blank + ['outcome' => 'error', 'reason' => "unusable target name: '{$name}'"];
            }
            $named[$name] = $t;
        }
        if (count($named) < 2) {
            return $blank + ['outcome' => 'error', 'reason' => 'a menu needs at least two targets'];
        }
        if (count($named) + 1 > self::MAX_CHOICES) {
            return $blank + ['outcome' => 'error', 'reason' => 'a menu allows at most ' . (self::MAX_CHOICES - 1) . ' targets'];
        }

        $choices = [];
        foreach ($named as $name => $t) {
            $desc = trim((string) ($t['description'] ?? ''));
            $choices[] = ['value' => $name, 'description' => $desc !== '' ? mb_substr($desc, 0, 400) : $name];
        }
        $choices[] = ['value' => self::UNCLEAR, 'description' => self::UNCLEAR_DESC];

        $body = [
            'model' => $this->model,
            'input' => $request,
            'questions' => [
                ['type' => 'choice', 'name' => 'route', 'instructions' => $question, 'choices' => $choices],
            ],
        ];

        $t0 = microtime(true);
        try {
            $res = $this->http->post($this->url, [
                'headers' => ['Authorization' => 'Bearer ' . $this->apiKey, 'Accept' => 'application/json'],
                'json' => $body,
            ]);
            $decoded = json_decode((string) $res->getBody(), true);
        } catch (RequestException $e) {
            return $blank + ['outcome' => 'error', 'reason' => self::apiError($e)];
        } catch (GuzzleException | \JsonException $e) {
            return $blank + ['outcome' => 'error', 'reason' => $e->getMessage()];
        }
        $ms = (int) round((microtime(true) - $t0) * 1000);

        $answer = null;
        foreach (is_array($decoded['answers'] ?? null) ? $decoded['answers'] : [] as $a) {
            if (is_array($a) && ($a['name'] ?? null) === 'route') {
                $answer = $a;
                break;
            }
        }
        $usage = is_array($decoded['usage'] ?? null) ? $decoded['usage'] : [];
        if (is_array($answer) && ($answer['type'] ?? null) === 'refusal') {
            return ['outcome' => 'error', 'ms' => $ms, 'usage' => $usage, 'reason' => 'the model refused to answer'] + $blank;
        }
        if (!is_array($answer) || !isset($answer['choice'])) {
            return ['outcome' => 'error', 'ms' => $ms, 'usage' => $usage, 'reason' => 'no choice in the response'] + $blank;
        }
        $choice = (string) $answer['choice'];
        $conf   = isset($answer['confidence']) ? (float) $answer['confidence'] : null;
        $probs  = is_array($answer['probabilities'] ?? null) ? $answer['probabilities'] : [];
        $common = ['confidence' => $conf, 'probabilities' => $probs, 'ms' => $ms, 'usage' => $usage];

        if ($choice === self::UNCLEAR) {
            return $common + ['outcome' => 'unclear', 'target' => null,
                              'reason' => 'the request names no branch'];
        }
        if (!isset($named[$choice])) {
            return $common + ['outcome' => 'error', 'target' => null,
                              'reason' => "answer '{$choice}' is not on the menu"];
        }
        if ($conf !== null && $conf < $this->confidenceFloor) {
            return $common + ['outcome' => 'low_confidence', 'target' => $named[$choice],
                              'reason' => sprintf('confidence %.2f below floor %.2f', $conf, $this->confidenceFloor)];
        }
        return $common + ['outcome' => 'routed', 'target' => $named[$choice], 'reason' => null];
    }

    /**
     * An HTTP error as OpenAI states it ("OpenAI HTTP 429 (insufficient_quota): You have no
     * credits..."), instead of Guzzle's message, which truncates the body mid-sentence.
     */
    private static function apiError(RequestException $e): string
    {
        $res = $e->getResponse();
        if ($res === null) {
            return $e->getMessage();
        }
        $err = json_decode((string) $res->getBody(), true)['error'] ?? null;
        $out = 'OpenAI HTTP ' . $res->getStatusCode();
        if (!is_array($err)) {
            return $out;
        }
        $code = (string) ($err['code'] ?? $err['type'] ?? '');
        $msg  = trim((string) ($err['message'] ?? ''));
        return $out . ($code !== '' ? " ({$code})" : '') . ($msg !== '' ? ": {$msg}" : '');
    }
}
