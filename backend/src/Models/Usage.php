<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Models;

/**
 * Represents API usage statistics
 */
class Usage
{
    private int $inputTokens;
    private int $outputTokens;
    private int $functionCalls;
    private float $estimatedCost;
    private int $responseTimeMs;

    public function __construct(
        int $inputTokens = 0,
        int $outputTokens = 0,
        int $functionCalls = 0,
        float $estimatedCost = 0.0,
        int $responseTimeMs = 0
    ) {
        $this->inputTokens = $inputTokens;
        $this->outputTokens = $outputTokens;
        $this->functionCalls = $functionCalls;
        $this->estimatedCost = $estimatedCost;
        $this->responseTimeMs = $responseTimeMs;
    }

    /**
     * Create from API response
     */
    public static function fromResponse(array $response): self
    {
        $usage = $response['usage'] ?? [];

        return new self(
            $usage['input_tokens'] ?? 0,
            $usage['output_tokens'] ?? 0,
            $usage['function_calls'] ?? 0,
            0.0, // Cost calculated separately
            0
        );
    }

    public function getInputTokens(): int
    {
        return $this->inputTokens;
    }

    public function getOutputTokens(): int
    {
        return $this->outputTokens;
    }

    public function getTotalTokens(): int
    {
        return $this->inputTokens + $this->outputTokens;
    }

    public function getFunctionCalls(): int
    {
        return $this->functionCalls;
    }

    public function getEstimatedCost(): float
    {
        return $this->estimatedCost;
    }

    public function getResponseTimeMs(): int
    {
        return $this->responseTimeMs;
    }

    /**
     * Add usage from another instance
     */
    public function add(Usage $other): self
    {
        return new self(
            $this->inputTokens + $other->inputTokens,
            $this->outputTokens + $other->outputTokens,
            $this->functionCalls + $other->functionCalls,
            $this->estimatedCost + $other->estimatedCost,
            $this->responseTimeMs + $other->responseTimeMs
        );
    }

    /**
     * Calculate cost based on pricing
     */
    public function calculateCost(float $inputPricePerMillion, float $outputPricePerMillion): float
    {
        $inputCost = ($this->inputTokens / 1_000_000) * $inputPricePerMillion;
        $outputCost = ($this->outputTokens / 1_000_000) * $outputPricePerMillion;

        $this->estimatedCost = $inputCost + $outputCost;
        return $this->estimatedCost;
    }

    /**
     * Convert to array
     */
    public function toArray(): array
    {
        return [
            'input_tokens' => $this->inputTokens,
            'output_tokens' => $this->outputTokens,
            'total_tokens' => $this->getTotalTokens(),
            'function_calls' => $this->functionCalls,
            'estimated_cost' => $this->estimatedCost,
            'response_time_ms' => $this->responseTimeMs,
        ];
    }
}
