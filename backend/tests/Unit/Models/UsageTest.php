<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Models;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Models\Usage;

class UsageTest extends TestCase
{
    public function testCanCreateUsage(): void
    {
        $usage = new Usage(100, 200, 5, 0.5, 1500);

        $this->assertEquals(100, $usage->getInputTokens());
        $this->assertEquals(200, $usage->getOutputTokens());
        $this->assertEquals(300, $usage->getTotalTokens());
        $this->assertEquals(5, $usage->getFunctionCalls());
        $this->assertEquals(0.5, $usage->getEstimatedCost());
        $this->assertEquals(1500, $usage->getResponseTimeMs());
    }

    public function testCanCreateWithDefaults(): void
    {
        $usage = new Usage();

        $this->assertEquals(0, $usage->getInputTokens());
        $this->assertEquals(0, $usage->getOutputTokens());
        $this->assertEquals(0, $usage->getTotalTokens());
    }

    public function testFromResponse(): void
    {
        $response = [
            'usage' => [
                'input_tokens' => 150,
                'output_tokens' => 300,
                'function_calls' => 2,
            ],
        ];

        $usage = Usage::fromResponse($response);

        $this->assertEquals(150, $usage->getInputTokens());
        $this->assertEquals(300, $usage->getOutputTokens());
        $this->assertEquals(2, $usage->getFunctionCalls());
    }

    public function testFromResponseWithMissingData(): void
    {
        $usage = Usage::fromResponse([]);

        $this->assertEquals(0, $usage->getInputTokens());
        $this->assertEquals(0, $usage->getOutputTokens());
    }

    public function testAdd(): void
    {
        $usage1 = new Usage(100, 200, 1, 0.1, 500);
        $usage2 = new Usage(50, 100, 2, 0.05, 300);

        $combined = $usage1->add($usage2);

        $this->assertEquals(150, $combined->getInputTokens());
        $this->assertEquals(300, $combined->getOutputTokens());
        $this->assertEquals(3, $combined->getFunctionCalls());
        $this->assertEqualsWithDelta(0.15, $combined->getEstimatedCost(), 0.0001);
        $this->assertEquals(800, $combined->getResponseTimeMs());
    }

    public function testCalculateCost(): void
    {
        $usage = new Usage(1000000, 500000); // 1M input, 500k output

        // Claude Sonnet pricing: $3/1M input, $15/1M output
        $cost = $usage->calculateCost(3.0, 15.0);

        // 1M * 3/1M = $3, 0.5M * 15/1M = $7.5 = $10.50 total
        $this->assertEquals(10.5, $cost);
        $this->assertEquals(10.5, $usage->getEstimatedCost());
    }

    public function testToArray(): void
    {
        $usage = new Usage(100, 200, 3, 0.5, 1000);
        $array = $usage->toArray();

        $this->assertEquals([
            'input_tokens' => 100,
            'output_tokens' => 200,
            'total_tokens' => 300,
            'function_calls' => 3,
            'estimated_cost' => 0.5,
            'response_time_ms' => 1000,
        ], $array);
    }

    public function testGetTotalTokens(): void
    {
        $usage = new Usage(123, 456);

        $this->assertEquals(579, $usage->getTotalTokens());
    }
}
