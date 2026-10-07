<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use AgentTeam\Services\DecisionRouter;
use GuzzleHttp\Client;

/** Builds the adapter for a resolved decision provider (DecisionKeyResolver::resolve()). */
final class DecisionRouters
{
    public static function make(array $resolved, float $floor, ?Client $http = null): ?DecisionRouter
    {
        $protocol = $resolved['protocol'] ?? null;
        if (!is_array($protocol)) {
            return null;
        }
        $class = $protocol['adapter'];
        $model = trim((string) ($resolved['row']['model'] ?? ''));
        return new $class($resolved['key'] !== '' ? $resolved['key'] : null, $http, $floor, (string) $resolved['url'], $model);
    }

    /** The outcome an unbuildable or keyless provider reports, without calling anyone. */
    public static function unavailable(array $resolved, string $providerKey): array
    {
        return ['outcome' => 'unavailable', 'target' => null, 'confidence' => null, 'probabilities' => [],
                'ms' => null, 'usage' => [], 'reason' => DecisionKeyResolver::unavailableReason($resolved, $providerKey)];
    }
}
