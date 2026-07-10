<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\Services\UsageTracker;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

class UsageTrackerCostTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    protected function tearDown(): void { Mockery::close(); }

    private function pdoReturning(?array $row): \PDO
    {
        $stmt = Mockery::mock(\PDOStatement::class);
        $stmt->shouldReceive('execute')->andReturn(true);
        $stmt->shouldReceive('fetch')->andReturn($row === null ? false : $row);
        $pdo = Mockery::mock(\PDO::class);
        $pdo->shouldReceive('prepare')->andReturn($stmt);
        return $pdo;
    }

    public function testCalculateCostUsesDbPrice(): void
    {
        $tracker = new UsageTracker($this->pdoReturning(
            ['price_input_per_1m' => '0.2000', 'price_output_per_1m' => '0.5000']
        ), true);
        // 1M in @0.20 + 1M out @0.50 = 0.70
        $this->assertSame(0.7, $tracker->calculateCost('grok', 'grok-4-fast', 1_000_000, 1_000_000));
    }

    public function testCalculateCostThrowsWhenUnconfigured(): void
    {
        $tracker = new UsageTracker($this->pdoReturning(null), true);
        $this->expectException(PricingUnavailableException::class);
        $tracker->calculateCost('gemini', 'x', 1000, 1000);
    }
}
