<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Providers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Providers\DeepSeekProvider;

/**
 * DeepSeek renamed deepseek-v4-flash to deepseek-flash (DeepSeek-V4.1-Flash).
 * It still runs in V4 thinking mode, so the V4 handling (explicit thinking,
 * no sampling params) must recognise the new id as well as deepseek-v4-*.
 */
class DeepSeekThinkingModelTest extends TestCase
{
    public function testThinkingModelIds(): void
    {
        $this->assertTrue(DeepSeekProvider::isThinkingModel('deepseek-v4-pro'));
        $this->assertTrue(DeepSeekProvider::isThinkingModel('deepseek-v4-flash'));
        $this->assertTrue(DeepSeekProvider::isThinkingModel('deepseek-flash'));
        $this->assertFalse(DeepSeekProvider::isThinkingModel('deepseek-chat'));
        $this->assertFalse(DeepSeekProvider::isThinkingModel('deepseek-reasoner'));
    }

    public function testDeepSeekFlashRequestUsesThinkingAndDropsTemperature(): void
    {
        $r = DeepSeekProvider::buildHttpRequest('deepseek-flash', [['role' => 'user', 'content' => 'hi']], [], ['api_key' => 'K'], 50, 0.1);
        $this->assertSame(['type' => 'enabled'], $r['payload']['thinking']);
        $this->assertArrayNotHasKey('temperature', $r['payload']);
    }

    public function testLegacyModelKeepsTemperature(): void
    {
        $r = DeepSeekProvider::buildHttpRequest('deepseek-chat', [['role' => 'user', 'content' => 'hi']], [], ['api_key' => 'K'], 50, 0.1);
        $this->assertArrayNotHasKey('thinking', $r['payload']);
        $this->assertSame(0.1, $r['payload']['temperature']);
    }
}
