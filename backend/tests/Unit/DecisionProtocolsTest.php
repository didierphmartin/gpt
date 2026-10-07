<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\DecisionRouter;
use AgentTeam\Services\JevRouter;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\DecisionProtocols;

/** The registry is the one place that knows a decision vendor by name. */
final class DecisionProtocolsTest extends TestCase
{
    public function testTypesafeIsRegisteredWithItsDefaults(): void
    {
        $p = DecisionProtocols::get('typesafe');
        $this->assertNotNull($p);
        $this->assertSame(JevRouter::URL, $p['url']);
        $this->assertSame(JevRouter::MODEL, $p['model']);
        $this->assertSame(['key' => 'TYPESAFE_API_KEY', 'url' => 'TYPESAFE_BASE_URL'], $p['legacy_env']);
        $this->assertTrue(is_subclass_of($p['adapter'], DecisionRouter::class));
    }

    public function testUnknownAndNullAreNotRegistered(): void
    {
        $this->assertNull(DecisionProtocols::get('acme'));
        $this->assertNull(DecisionProtocols::get(null));
        $this->assertNull(DecisionProtocols::get(''));
    }

    public function testTheCatalogNeverExposesClassNames(): void
    {
        $cat = DecisionProtocols::catalog();
        $this->assertSame('typesafe', $cat[0]['id']);
        $this->assertSame(['id', 'label', 'url', 'model', 'console_url'], array_keys($cat[0]));
    }
}
