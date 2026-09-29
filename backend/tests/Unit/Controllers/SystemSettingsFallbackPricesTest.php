<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\SystemSettingsController;

/**
 * The config fallback's default prices belong to the default model only. A
 * model set in config gets that model's catalog price, or none when the
 * catalog does not list it -- never the default model's price.
 */
class SystemSettingsFallbackPricesTest extends TestCase
{
    private function providers(array $config): array
    {
        $controller = new SystemSettingsController(new \PDO('sqlite::memory:'), $config);
        $m = new \ReflectionMethod($controller, 'getProvidersFromConfig');
        $m->setAccessible(true);
        $byKey = [];
        foreach ($m->invoke($controller)['providers'] as $p) {
            $byKey[$p['provider_key']] = $p;
        }
        return $byKey;
    }

    public function testDefaultModelGetsDefaultPrices(): void
    {
        $p = $this->providers(['claude' => ['api_key' => '']])['claude'];
        $this->assertSame('claude-sonnet-5', $p['model']);
        $this->assertSame(2.0, $p['price_input_per_1m']);
        $this->assertSame(10.0, $p['price_output_per_1m']);
    }

    public function testConfiguredCatalogModelGetsItsCatalogPrices(): void
    {
        $p = $this->providers(['claude' => ['model' => 'claude-opus-5-5']])['claude'];
        $this->assertSame('claude-opus-5-5', $p['model']);
        $this->assertSame(4.0, $p['price_input_per_1m']);
        $this->assertSame(20.0, $p['price_output_per_1m']);
    }

    public function testConfiguredModelOutsideTheCatalogHasNoPrices(): void
    {
        $p = $this->providers(['openai' => ['model' => 'not-a-catalog-model']])['openai'];
        $this->assertNull($p['price_input_per_1m']);
        $this->assertNull($p['price_output_per_1m']);
    }

    public function testConfiguredPricesStillWin(): void
    {
        $p = $this->providers(['gemini' => ['model' => 'gemini-3.5-flash', 'price_input_per_1m' => 9, 'price_output_per_1m' => 8]])['gemini'];
        $this->assertSame(9.0, $p['price_input_per_1m']);
        $this->assertSame(8.0, $p['price_output_per_1m']);
    }
}
