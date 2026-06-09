<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Models\Conversation;
use Quantis\AIPortfolioAssistant\Services\LLMManager;
use Quantis\AIPortfolioAssistant\Services\ToolsManager;

class AIPortfolioAssistantTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    protected function tearDown(): void
    {
        Mockery::close();
    }

    public function testCanBeCreatedWithArray(): void
    {
        $assistant = new AIPortfolioAssistant([
            'claude' => ['api_key' => 'test-key'],
        ]);

        $this->assertInstanceOf(AIPortfolioAssistant::class, $assistant);
    }

    public function testCanBeCreatedWithConfiguration(): void
    {
        $config = new Configuration([
            'claude' => ['api_key' => 'test-key'],
        ]);

        $assistant = new AIPortfolioAssistant($config);

        $this->assertInstanceOf(AIPortfolioAssistant::class, $assistant);
    }

    public function testCanBeCreatedWithDefaults(): void
    {
        $assistant = new AIPortfolioAssistant();

        $this->assertInstanceOf(AIPortfolioAssistant::class, $assistant);
    }

    public function testGetConfig(): void
    {
        $assistant = new AIPortfolioAssistant([
            'claude' => ['api_key' => 'my-key'],
        ]);

        $config = $assistant->getConfig();

        $this->assertInstanceOf(Configuration::class, $config);
        $this->assertEquals('my-key', $config->get('claude.api_key'));
    }

    public function testGetLLMManager(): void
    {
        $assistant = new AIPortfolioAssistant();

        $manager = $assistant->getLLMManager();

        $this->assertInstanceOf(LLMManager::class, $manager);
    }

    public function testGetToolsManager(): void
    {
        $assistant = new AIPortfolioAssistant();

        $manager = $assistant->getToolsManager();

        $this->assertInstanceOf(ToolsManager::class, $manager);
    }

    public function testRegisterFunction(): void
    {
        $assistant = new AIPortfolioAssistant();

        $result = $assistant->registerFunction(
            'custom_func',
            fn($params, $ctx) => ['result' => 'ok'],
            ['description' => 'Custom function']
        );

        $this->assertSame($assistant, $result); // Fluent interface
        $this->assertTrue($assistant->getToolsManager()->hasFunction('custom_func'));
    }

    public function testRegisterFunctions(): void
    {
        $assistant = new AIPortfolioAssistant();

        $assistant->registerFunctions([
            'func1' => [
                'handler' => fn() => [],
                'schema' => ['description' => 'Func 1'],
            ],
            'func2' => [
                'handler' => fn() => [],
                'schema' => ['description' => 'Func 2'],
            ],
        ]);

        $tools = $assistant->getToolsManager();
        $this->assertTrue($tools->hasFunction('func1'));
        $this->assertTrue($tools->hasFunction('func2'));
    }

    public function testCreateConversation(): void
    {
        $assistant = new AIPortfolioAssistant();

        $conversation = $assistant->createConversation('user-123', ['topic' => 'test']);

        $this->assertInstanceOf(Conversation::class, $conversation);
        $this->assertEquals('user-123', $conversation->getUserId());
        $this->assertEquals(['topic' => 'test'], $conversation->getMetadata());
    }

    public function testSetModel(): void
    {
        $assistant = new AIPortfolioAssistant([
            'claude' => ['api_key' => 'test-key'],
        ]);

        $result = $assistant->setModel('claude-3-opus-20240229');

        $this->assertSame($assistant, $result); // Fluent interface
    }

    public function testGetAvailableProviders(): void
    {
        $assistant = new AIPortfolioAssistant([
            'claude' => ['api_key' => 'test-key'],
        ]);

        $providers = $assistant->getAvailableProviders();

        $this->assertIsArray($providers);
        $this->assertContains('claude', $providers);
    }

    public function testGetProviderInfo(): void
    {
        $assistant = new AIPortfolioAssistant([
            'claude' => ['api_key' => 'test-key'],
        ]);

        $info = $assistant->getProviderInfo('claude');

        $this->assertIsArray($info);
        $this->assertEquals('claude', $info['name']);
        $this->assertTrue($info['available']);
    }

    public function testSearchFunctionsAreRegisteredByDefault(): void
    {
        $assistant = new AIPortfolioAssistant([
            'claude' => ['api_key' => 'test-key'],
            'search' => [
                'serpapi' => ['api_key' => 'serp-key'],
            ],
        ]);

        $tools = $assistant->getToolsManager();

        // Search functions should be registered without database
        $this->assertTrue($tools->hasFunction('serpapi_search'));
        $this->assertTrue($tools->hasFunction('brave_search'));
    }

    public function testDebugModeFromConfig(): void
    {
        $assistant = new AIPortfolioAssistant([
            'debug' => true,
        ]);

        $this->assertTrue($assistant->getConfig()->isDebugEnabled());
    }
}
