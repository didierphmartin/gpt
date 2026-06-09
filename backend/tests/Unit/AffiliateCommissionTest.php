<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\AffiliateCommission;

class AffiliateCommissionTest extends TestCase
{
    public function testPercentCommission(): void
    {
        $this->assertSame(20.0, AffiliateCommission::compute('percent', 20.0, 100.0));
    }

    public function testFixedCommissionIgnoresSaleAmount(): void
    {
        $this->assertSame(10.0, AffiliateCommission::compute('fixed', 10.0, 250.0));
    }

    public function testPercentRoundsToCents(): void
    {
        $this->assertSame(3.33, AffiliateCommission::compute('percent', 10.0, 33.33));
    }

    public function testNegativeSaleClampsToZero(): void
    {
        $this->assertSame(0.0, AffiliateCommission::compute('percent', 20.0, -5.0));
    }

    public function testResolveUsesOverrideWhenPresent(): void
    {
        $eff = AffiliateCommission::resolve(
            ['commission_type' => 'fixed', 'commission_value' => 5.0],   // account override
            ['commission_type' => 'percent', 'commission_value' => 20.0] // product default
        );
        $this->assertSame(['fixed', 5.0], $eff);
    }

    public function testResolveFallsBackToProductWhenNoOverride(): void
    {
        $eff = AffiliateCommission::resolve(
            ['commission_type' => null, 'commission_value' => null],
            ['commission_type' => 'percent', 'commission_value' => 20.0]
        );
        $this->assertSame(['percent', 20.0], $eff);
    }

    public function testInvalidTypeThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        AffiliateCommission::compute('bogus', 1.0, 1.0);
    }
}
