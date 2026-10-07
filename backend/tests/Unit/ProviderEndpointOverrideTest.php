<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Controllers\SettingsController;
use Quantis\AIPortfolioAssistant\Providers\ClaudeProvider;
use Quantis\AIPortfolioAssistant\Providers\DeepSeekProvider;
use Quantis\AIPortfolioAssistant\Providers\GrokProvider;
use Quantis\AIPortfolioAssistant\Providers\KimiProvider;
use Quantis\AIPortfolioAssistant\Providers\OpenAIProvider;
use Quantis\AIPortfolioAssistant\Services\ApiKeyCrypto;

/**
 * Several providers can sit behind one entry point (a gateway). Every
 * provider therefore honours the base_url it is configured with -- vendor
 * link by default -- and a per-user key row is read the same way whether
 * Settings stored it encrypted or gpt_admin stored it in the clear.
 */
final class ProviderEndpointOverrideTest extends TestCase
{
    private const SECRET = 'test-secret';

    public function testRevealOpensAnEncryptedKey(): void
    {
        $blob = ApiKeyCrypto::encrypt('sk-user-1234', self::SECRET);
        $this->assertSame('sk-user-1234', ApiKeyCrypto::reveal($blob, self::SECRET));
    }

    public function testRevealReturnsAClearKeyAsIs(): void
    {
        $this->assertSame('sk-ant-clear-key', ApiKeyCrypto::reveal(' sk-ant-clear-key ', self::SECRET));
    }

    public function testRevealDropsABlobItCannotOpen(): void
    {
        $blob = ApiKeyCrypto::encrypt('sk-user-1234', 'another-secret');
        $this->assertSame('', ApiKeyCrypto::reveal($blob, self::SECRET));
    }

    public function testRevealOfNothingIsNothing(): void
    {
        $this->assertSame('', ApiKeyCrypto::reveal('', self::SECRET));
    }

    public function testABadEndpointSavesNothing(): void
    {
        $db = $this->createMock(PDO::class);
        $db->expects($this->never())->method('prepare');
        $db->expects($this->never())->method('exec');

        $result = (new SettingsController($db, ['auth' => ['jwt_secret' => self::SECRET]]))->saveKeys([
            'user_id' => 7,
            'body' => [
                'keys' => ['claude' => 'sk-would-be-saved'],
                'endpoints' => ['claude' => 'https://gw.example', 'kimi' => 'gw.example/kimi'],
            ],
        ]);

        $this->assertFalse($result['success']);
        $this->assertSame(400, $result['status_code']);
        $this->assertStringContainsString('kimi', $result['error']);
    }

    /** @return array<string, array{class-string, string, string, string}> */
    public static function providers(): array
    {
        return [
            'kimi'     => [KimiProvider::class, 'providers', 'kimi', 'https://api.moonshot.ai'],
            'grok'     => [GrokProvider::class, 'providers', 'grok', 'https://api.x.ai'],
            'deepseek' => [DeepSeekProvider::class, 'providers', 'deepseek', 'https://api.deepseek.com'],
            'claude'   => [ClaudeProvider::class, '', 'claude', 'https://api.anthropic.com'],
            'openai'   => [OpenAIProvider::class, '', 'openai', 'https://api.openai.com'],
        ];
    }

    /** @dataProvider providers */
    public function testVendorLinkByDefault(string $class, string $nest, string $key, string $vendor): void
    {
        $this->assertSame($vendor, $this->baseUrlOf($class, $nest, $key, ['api_key' => 'k', 'base_url' => '']));
    }

    /** @dataProvider providers */
    public function testConfiguredEntryPointReplacesTheVendorLink(string $class, string $nest, string $key): void
    {
        $gateway = 'https://gateway.corp.example/llm/' . $key . '/';
        $this->assertSame(
            'https://gateway.corp.example/llm/' . $key,
            $this->baseUrlOf($class, $nest, $key, ['api_key' => 'k', 'base_url' => $gateway])
        );
    }

    public function testAGatewayPathInChatEndpointReachesClaude(): void
    {
        // gpt_admin's API URL field stores origin + path split.
        $provider = new ClaudeProvider(new Configuration(['claude' => [
            'api_key' => 'k', 'base_url' => 'https://gw.corp.example', 'chat_endpoint' => '/llm/anthropic/v1/messages',
        ]]));
        $prop = new \ReflectionProperty(ClaudeProvider::class, 'chatEndpoint');
        $prop->setAccessible(true);
        $this->assertSame('/llm/anthropic/v1/messages', $prop->getValue($provider));
    }

    private function baseUrlOf(string $class, string $nest, string $key, array $cfg): string
    {
        $config = $nest === '' ? [$key => $cfg] : [$nest => [$key => $cfg]];
        $provider = new $class(new Configuration($config));
        $prop = new \ReflectionProperty($class, 'baseUrl');
        $prop->setAccessible(true);
        return $prop->getValue($provider);
    }
}
