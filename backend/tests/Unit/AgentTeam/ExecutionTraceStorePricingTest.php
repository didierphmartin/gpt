<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use AgentTeam\Services\ExecutionTraceStore;

/**
 * Forecast/trace contract: pricing returns the DB price when configured,
 * and [null, null] (→ UI "—") when pricing is unavailable — never a
 * hardcoded number, never a throw. Mirrors GraphWorkflowPricingTest.
 */
class ExecutionTraceStorePricingTest extends TestCase
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

    private function invokePricing(\PDO $pdo, string $provider): array
    {
        $ref = new \ReflectionClass(ExecutionTraceStore::class);
        $store = $ref->newInstanceWithoutConstructor();
        foreach (['db' => $pdo, 'pricingCache' => []] as $prop => $val) {
            $p = $ref->getProperty($prop);
            $p->setAccessible(true);
            $p->setValue($store, $val);
        }
        $m = $ref->getMethod('pricing');
        $m->setAccessible(true);
        return $m->invoke($store, $provider);
    }

    public function testReturnsDbPriceWhenConfigured(): void
    {
        $pair = $this->invokePricing(
            $this->pdoReturning(['price_input_per_1m' => '0.2000', 'price_output_per_1m' => '0.5000']),
            'grok'
        );
        $this->assertSame([0.2, 0.5], $pair);
    }

    public function testReturnsNullPairWhenUnavailable(): void
    {
        $pair = $this->invokePricing($this->pdoReturning(null), 'gemini');
        $this->assertSame([null, null], $pair);
    }
}
