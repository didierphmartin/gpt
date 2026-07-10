<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

class PricingResolverTest extends TestCase
{
    public function testClassifyReturnsRatesForValidRow(): void
    {
        $rates = PricingResolver::classifyRow(
            ['price_input_per_1m' => '2.5000', 'price_output_per_1m' => '10.0000'],
            'openai'
        );
        $this->assertSame([2.5, 10.0], $rates);
    }

    public function testClassifyTreatsZeroAsValid(): void
    {
        $rates = PricingResolver::classifyRow(
            ['price_input_per_1m' => '0.0000', 'price_output_per_1m' => '0.0000'],
            'gamma4'
        );
        $this->assertSame([0.0, 0.0], $rates);
    }

    public function testClassifyThrowsOnMissingRow(): void
    {
        $this->expectException(PricingUnavailableException::class);
        $this->expectExceptionMessage("provider 'gemini'");
        PricingResolver::classifyRow(null, 'gemini');
    }

    public function testClassifyThrowsOnNullPrice(): void
    {
        $this->expectException(PricingUnavailableException::class);
        PricingResolver::classifyRow(
            ['price_input_per_1m' => null, 'price_output_per_1m' => '4.0000'],
            'kimi'
        );
    }
}
