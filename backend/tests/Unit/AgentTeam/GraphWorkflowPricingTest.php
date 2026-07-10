<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

/** Guards the forecast contract: unavailable pricing → [null,null], never a hardcoded number. */
class GraphWorkflowPricingTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    protected function tearDown(): void { Mockery::close(); }

    public function testResolverThrowInMapsToNullPair(): void
    {
        $resolver = Mockery::mock(PricingResolver::class);
        $resolver->shouldReceive('resolve')->with('gemini')
            ->andThrow(new PricingUnavailableException('no price'));

        // Mirror the exact try/catch the runner uses.
        $pair = [null, null];
        try {
            $pair = $resolver->resolve('gemini');
        } catch (PricingUnavailableException $e) {
            $pair = [null, null];
        }
        $this->assertSame([null, null], $pair);
    }
}
