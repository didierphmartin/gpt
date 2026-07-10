<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

class UsageLoggerCostTest extends TestCase
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
        $logger = new UsageLogger($this->pdoReturning(
            ['price_input_per_1m' => '2.5000', 'price_output_per_1m' => '10.0000']
        ), true);
        // 1,000,000 in @2.50 + 1,000,000 out @10.00 = 12.50
        $this->assertSame(12.5, $logger->calculateCost('openai', 'gpt-4o', 1_000_000, 1_000_000));
    }

    public function testCalculateCostThrowsWhenUnconfigured(): void
    {
        $logger = new UsageLogger($this->pdoReturning(null), true);
        $this->expectException(PricingUnavailableException::class);
        $logger->calculateCost('gemini', 'gemini-3-flash-preview', 1000, 1000);
    }
}
