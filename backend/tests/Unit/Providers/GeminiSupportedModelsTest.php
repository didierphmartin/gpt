<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Providers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Providers\GeminiProvider;

/** GeminiProvider's model list must be the catalog's gemini ids, in order. */
class GeminiSupportedModelsTest extends TestCase
{
    public function testSupportedModelsMatchTheCatalog(): void
    {
        $catalog = json_decode((string)file_get_contents(__DIR__ . '/../../../resources/model_catalog.json'), true);
        $ids = array_column($catalog['providers']['gemini'], 'id');
        $const = new \ReflectionClassConstant(GeminiProvider::class, 'SUPPORTED_MODELS');
        $this->assertSame($ids, $const->getValue());
    }
}
