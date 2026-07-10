<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

/**
 * Single source of truth for LLM token pricing: system_llm_settings.
 * Returns [input_per_1m, output_per_1m] for a provider, or throws.
 * A price of 0 is valid (e.g. self-hosted). NULL / missing / query error throws.
 */
final class PricingResolver
{
    private const ALIASES = ['anthropic' => 'claude', 'google' => 'gemini'];

    /** @var array<string, array{0: float, 1: float}> */
    private array $cache = [];

    public function __construct(private \PDO $pdo)
    {
    }

    /**
     * @return array{0: float, 1: float} [inputPer1M, outputPer1M]
     * @throws PricingUnavailableException
     */
    public function resolve(string $provider): array
    {
        $key = self::ALIASES[strtolower($provider)] ?? strtolower($provider);
        if (isset($this->cache[$key])) {
            return $this->cache[$key];
        }

        try {
            $stmt = $this->pdo->prepare(
                'SELECT price_input_per_1m, price_output_per_1m
                 FROM system_llm_settings WHERE provider_key = :k LIMIT 1'
            );
            $stmt->execute([':k' => $key]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC) ?: null;
        } catch (\Throwable $e) {
            throw new PricingUnavailableException(
                "Pricing lookup failed for provider '{$key}' in system_llm_settings: " . $e->getMessage(),
                0,
                $e
            );
        }

        return $this->cache[$key] = self::classifyRow($row, $key);
    }

    /**
     * Pure classifier: a fetched row (or null) → rates or throw. DB-free for testing.
     *
     * @param array<string, mixed>|null $row
     * @return array{0: float, 1: float}
     * @throws PricingUnavailableException
     */
    public static function classifyRow(?array $row, string $key): array
    {
        if ($row === null) {
            throw new PricingUnavailableException(
                "No price configured for provider '{$key}' in system_llm_settings"
            );
        }
        if ($row['price_input_per_1m'] === null || $row['price_output_per_1m'] === null) {
            throw new PricingUnavailableException(
                "Null price for provider '{$key}' in system_llm_settings (set price_input_per_1m / price_output_per_1m)"
            );
        }
        return [(float) $row['price_input_per_1m'], (float) $row['price_output_per_1m']];
    }
}
