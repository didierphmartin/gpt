<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * A decision-model adapter: asks one vendor's API a closed question (which of
 * these targets?) and never writes text. One class per protocol, registered in
 * DecisionProtocols. Every adapter takes the same constructor:
 *   (?string $apiKey, ?Client $http, float $confidenceFloor, string $url, string $model)
 * where '' url/model mean the protocol default.
 */
interface DecisionRouter
{
    /** Configured = a key is present. */
    public function isAvailable(): bool;

    /**
     * @param array $targets [['id' => int|string, 'name' => string, 'description' => string], …]
     * @return array{outcome: 'routed'|'unclear'|'low_confidence'|'unavailable'|'error',
     *               target: ?array, confidence: ?float, probabilities: array,
     *               ms: ?int, usage: array, reason: ?string}
     *         'routed' is the only outcome that decides; ms is set only when the vendor answered.
     */
    public function route(string $request, array $targets, string $question): array;
}
