<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use AgentTeam\Services\JevRouter;
use GuzzleHttp\Client;
use PDO;
use Quantis\AIPortfolioAssistant\Services\JevKeyResolver;
use Quantis\AIPortfolioAssistant\Services\JevUsage;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;

/**
 * Jev routing for the browser run path.
 *
 * The canvas Run button executes workflows in the browser, which must never
 * hold the Jev key. It asks the server to route (POST /dispatch/jev) and to say
 * whether a key exists (GET /dispatch/jev/status); the key is resolved here, per
 * calling user, and never returned.
 */
class DispatchController
{
    public function __construct(
        private PDO $db,
        private array $config,
        private ?Client $http = null,
        private ?UsageLogger $usage = null
    ) {
    }

    /** Whether the plan allows Jev, whether a key exists and where it comes from. Never the key. */
    public function jevStatus(array $request): array
    {
        $resolved = JevKeyResolver::resolve($this->db, $this->config, $this->userId($request));

        return [
            'success' => true,
            'allowed' => $resolved['source'] !== 'not_allowed',
            'available' => $resolved['key'] !== '',
            'source' => $resolved['source'],
            'status_code' => 200,
        ];
    }

    /** Route one request to one of the targets with Jev. */
    public function route(array $request): array
    {
        $input = $request['body'] ?? [];
        $text = $input['request'] ?? null;
        $targets = $input['targets'] ?? null;
        $question = $input['question'] ?? null;
        $floor = JevRouter::DEFAULT_CONFIDENCE_FLOOR;

        if (!is_string($text) || trim($text) === '') {
            return $this->bad('request is required');
        }
        if (!is_array($targets)) {
            return $this->bad('targets must be an array');
        }
        if (!is_string($question)) {
            return $this->bad('question must be a string');
        }
        if (array_key_exists('min_confidence', $input) && $input['min_confidence'] !== null) {
            if (!is_numeric($input['min_confidence'])) {
                return $this->bad('min_confidence must be a number');
            }
            $floor = max(0.0, min(1.0, (float) $input['min_confidence']));
        }

        $resolved = JevKeyResolver::resolve($this->db, $this->config, $this->userId($request));
        $out = (new JevRouter($resolved['key'], $this->http, $floor))->route($text, $targets, $question);
        if ($resolved['key'] === '') {
            $out['reason'] = JevKeyResolver::unavailableReason($resolved['source']);
        }
        // One usage row per call TypeSafe answered; refused calls record nothing.
        JevUsage::record($this->usage ?? new UsageLogger($this->db, true, $this->config['contexts_database'] ?? $this->config['database'] ?? null), $this->userId($request), $out);

        $target = is_array($out['target'] ?? null)
            ? ['id' => $out['target']['id'] ?? null, 'name' => $out['target']['name'] ?? null]
            : null;

        return [
            'success' => true,
            'outcome' => $out['outcome'],
            'target' => $target,
            'confidence' => $out['confidence'],
            'ms' => $out['ms'],
            'reason' => $out['reason'],
            'status_code' => 200,
        ];
    }

    private function userId(array $request): ?int
    {
        return isset($request['user_id']) ? (int) $request['user_id'] : null;
    }

    private function bad(string $message): array
    {
        return ['success' => false, 'message' => $message, 'status_code' => 400];
    }
}
