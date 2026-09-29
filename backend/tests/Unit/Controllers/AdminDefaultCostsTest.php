<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AdminController;

/**
 * LLM prices come from backend/resources/model_catalog.json, so the Costs
 * page's default LLM entries only name the provider and its pricing page.
 */
class AdminDefaultCostsTest extends TestCase
{
    public function testDefaultLlmEntriesCarryNoPrices(): void
    {
        $ref = new \ReflectionClass(AdminController::class);
        $controller = $ref->newInstanceWithoutConstructor();
        $m = $ref->getMethod('getDefaultCosts');
        $m->setAccessible(true);
        $costs = $m->invoke($controller);

        $this->assertCount(6, $costs['llm']);
        foreach ($costs['llm'] as $p) {
            $this->assertSame([], $p['tiers'], $p['provider']);
            $this->assertNotEmpty($p['displayName']);
            $this->assertNotEmpty($p['pricingUrl']);
        }
        // Voice/avatar keep their tiers.
        $this->assertNotEmpty($costs['voice'][0]['tiers']);
    }

    public function testRefreshAllCostsSkipsTheLlmCategory(): void
    {
        $src = (string)file_get_contents((new \ReflectionClass(AdminController::class))->getFileName());
        $start = strpos($src, 'public function refreshAllCosts(');
        $end = strpos($src, 'public function refreshProviderCosts(');
        $body = substr($src, $start, $end - $start);
        $this->assertStringContainsString("foreach (['voice', 'avatar'] as \$category)", $body);
        $this->assertStringNotContainsString("'llm', 'voice', 'avatar'", $body);
    }
}
