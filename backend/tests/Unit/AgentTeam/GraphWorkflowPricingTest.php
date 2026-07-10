<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use AgentTeam\Services\GraphWorkflowRunner;

/**
 * Forecast/trace contract: getProviderPricing returns the DB price when
 * configured, and [null, null] (→ UI "—") when pricing is unavailable —
 * never a hardcoded number, never a throw.
 */
class GraphWorkflowPricingTest extends TestCase
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
        $ref = new \ReflectionClass(GraphWorkflowRunner::class);
        $runner = $ref->newInstanceWithoutConstructor();

        $dbProp = $ref->getProperty('db');
        $dbProp->setAccessible(true);
        $dbProp->setValue($runner, $pdo);

        $cacheProp = $ref->getProperty('pricingCache');
        $cacheProp->setAccessible(true);
        $cacheProp->setValue($runner, []);

        $method = $ref->getMethod('getProviderPricing');
        $method->setAccessible(true);
        return $method->invoke($runner, $provider);
    }

    public function testReturnsDbPriceWhenConfigured(): void
    {
        $pair = $this->invokePricing(
            $this->pdoReturning(['price_input_per_1m' => '2.5000', 'price_output_per_1m' => '10.0000']),
            'openai'
        );
        $this->assertSame([2.5, 10.0], $pair);
    }

    public function testReturnsNullPairWhenUnavailable(): void
    {
        $pair = $this->invokePricing($this->pdoReturning(null), 'gemini');
        $this->assertSame([null, null], $pair);
    }
}
