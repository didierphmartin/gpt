<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use AgentTeam\Services\JevRouter;
use GuzzleHttp\Client;
use PDO;
use Quantis\AIPortfolioAssistant\Services\DecisionKeyResolver;
use Quantis\AIPortfolioAssistant\Services\DecisionProviders;
use Quantis\AIPortfolioAssistant\Services\DecisionRouters;
use Quantis\AIPortfolioAssistant\Services\DecisionUsage;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;

/**
 * Decision-model routing for the browser run path.
 *
 * The canvas Run button executes workflows in the browser, which must never
 * hold a decision provider's key. It asks the server which providers exist
 * (GET /dispatch/providers), whether one has a key (GET /dispatch/{key}/status)
 * and to route (POST /dispatch/route); the key is resolved here, per calling
 * user, and never returned. The /dispatch/jev URLs remain as aliases.
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

    /** GET /dispatch/providers: every decision provider and whether this user can route with it. Never a key. */
    public function providers(array $request): array
    {
        $userId = $this->userId($request);
        $list = [];
        foreach (DecisionProviders::rows($this->db) as $row) {
            $key = (string) $row['provider_key'];
            $resolved = DecisionKeyResolver::resolve($this->db, $this->config, $userId, $key);
            $protocol = $resolved['protocol'];
            $stem = DecisionProviders::envStem($key);
            $routable = $resolved['key'] !== '';
            $list[] = [
                'key' => $key,
                'label' => (string) ($row['display_name'] ?: $key),
                'protocol' => $row['protocol'] ?? null,
                'model' => (string) ($row['model'] ?? ''),
                'default_url' => $protocol !== null ? (trim((string) ($row['base_url'] ?? '')) ?: $protocol['url']) : '',
                'allowed' => !in_array($resolved['source'], ['not_allowed', 'unknown'], true),
                'has_key' => $routable,
                'source' => $resolved['source'],
                'routable' => $routable,
                'reason' => $routable ? null : DecisionKeyResolver::unavailableReason($resolved, $key),
                'key_env' => $stem . '_API_KEY',
                'url_env' => $stem . '_BASE_URL',
                'legacy_env' => $protocol['legacy_env'] ?? null,
            ];
        }
        return ['success' => true, 'default' => DecisionKeyResolver::defaultProvider($this->db, $userId),
                'providers' => $list, 'status_code' => 200];
    }

    /** GET /dispatch/{key}/status */
    public function status(array $request): array
    {
        return $this->statusOf((string) ($request['params']['key'] ?? ''), $request);
    }

    /** GET /dispatch/jev/status (alias kept for pages loaded before the rename). */
    public function jevStatus(array $request): array
    {
        return $this->statusOf('jev', $request);
    }

    private function statusOf(string $key, array $request): array
    {
        $resolved = DecisionKeyResolver::resolve($this->db, $this->config, $this->userId($request), $key);
        return [
            'success' => true,
            'provider' => $key,
            'allowed' => !in_array($resolved['source'], ['not_allowed', 'unknown'], true),
            'available' => $resolved['key'] !== '',
            'source' => $resolved['source'],
            'status_code' => 200,
        ];
    }

    /** POST /dispatch/jev (alias): route with provider 'jev' unless the body names one. */
    public function jevRoute(array $request): array
    {
        $request['body'] = ($request['body'] ?? []) + ['provider' => 'jev'];
        return $this->route($request);
    }

    /** POST /dispatch/route: route one request to one of the targets with the named decision provider. */
    public function route(array $request): array
    {
        $input = $request['body'] ?? [];
        $provider = is_string($input['provider'] ?? null) ? trim($input['provider']) : '';
        $text = $input['request'] ?? null;
        $targets = $input['targets'] ?? null;
        $question = $input['question'] ?? null;
        $floor = JevRouter::DEFAULT_CONFIDENCE_FLOOR;

        if ($provider === '') {
            return $this->bad('provider is required');
        }
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

        $userId = $this->userId($request);
        $resolved = DecisionKeyResolver::resolve($this->db, $this->config, $userId, $provider);
        $router = $resolved['key'] !== '' ? DecisionRouters::make($resolved, $floor, $this->http) : null;
        $out = $router !== null ? $router->route($text, $targets, $question) : DecisionRouters::unavailable($resolved, $provider);
        // One usage row per call the vendor answered; refused calls record nothing.
        DecisionUsage::record(
            $this->usage ?? new UsageLogger($this->db, true, $this->config['contexts_database'] ?? $this->config['database'] ?? null),
            $userId, $provider, (string) ($resolved['row']['model'] ?? ''), $out
        );

        $target = is_array($out['target'] ?? null)
            ? ['id' => $out['target']['id'] ?? null, 'name' => $out['target']['name'] ?? null]
            : null;

        return [
            'success' => true,
            'provider' => $provider,
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
