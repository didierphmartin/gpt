<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;

/**
 * Tests the mock Okta MCP server's request handler directly (no HTTP round trip).
 *
 * The server lives OUTSIDE this repo at /Applications/XAMPP/xamppfiles/htdocs/mockokta/
 * (served by XAMPP at http://localhost/mockokta/). It exposes a pure function
 * `mockokta_handle(array $rpc, string $logDir): array` that this test requires
 * directly and exercises without going over HTTP.
 */
class MockOktaHandlerTest extends TestCase
{
    private string $logDir;

    public static function setUpBeforeClass(): void
    {
        $path = realpath(__DIR__ . '/../../../../../mockokta/index.php');
        if ($path === false) {
            self::fail(
                'mockokta/index.php not found at expected location outside the repo '
                . '(/Applications/XAMPP/xamppfiles/htdocs/mockokta/index.php). '
                . 'This test requires the mock Okta MCP server to exist there.'
            );
        }
        require_once $path;
    }

    protected function setUp(): void
    {
        $this->logDir = sys_get_temp_dir() . '/mockokta_test_' . uniqid();
    }

    protected function tearDown(): void
    {
        $calls = $this->logDir . '/calls.jsonl';
        if (is_file($calls)) {
            unlink($calls);
        }
        if (is_dir($this->logDir)) {
            @rmdir($this->logDir);
        }
    }

    private function rpc(string $method, array $params = [], $id = 1): array
    {
        return [
            'jsonrpc' => '2.0',
            'id' => $id,
            'method' => $method,
            'params' => $params,
        ];
    }

    private function call(string $tool, array $arguments = []): array
    {
        return mockokta_handle($this->rpc('tools/call', [
            'name' => $tool,
            'arguments' => $arguments,
        ]), $this->logDir);
    }

    private function contentText(array $response): string
    {
        $this->assertArrayHasKey('result', $response);
        $this->assertArrayHasKey('content', $response['result']);
        $this->assertIsArray($response['result']['content']);
        $this->assertNotEmpty($response['result']['content']);
        $first = $response['result']['content'][0];
        $this->assertSame('text', $first['type']);
        $this->assertIsString($first['text']);
        return $first['text'];
    }

    public function testToolsListReturnsSevenTools(): void
    {
        $response = mockokta_handle($this->rpc('tools/list'), $this->logDir);

        $this->assertArrayHasKey('result', $response);
        $this->assertArrayHasKey('tools', $response['result']);
        $tools = $response['result']['tools'];
        $this->assertCount(12, $tools);

        $names = array_map(fn($t) => $t['name'], $tools);
        $this->assertContains('search_users', $names);
        $this->assertContains('search_system_log', $names);
        $this->assertContains('list_user_factors', $names);
        $this->assertContains('verify_security_answers', $names);
        $this->assertContains('reset_password', $names);
        $this->assertContains('reset_factor', $names);
        $this->assertContains('unlock_user', $names);

        // Hidden test-hook tools must NOT appear in tools/list
        $this->assertNotContains('_reset_call_log', $names);
        $this->assertNotContains('_get_call_log', $names);

        foreach ($tools as $tool) {
            $this->assertArrayHasKey('name', $tool);
            $this->assertArrayHasKey('description', $tool);
            $this->assertArrayHasKey('inputSchema', $tool);
            $this->assertSame('object', $tool['inputSchema']['type']);
        }
    }

    public function testSearchUsersLowFixture(): void
    {
        $response = $this->call('search_users', ['email' => 'low@test']);
        $text = $this->contentText($response);
        $this->assertStringContainsString('u-low', $text);
    }

    public function testSearchUsersUnknownEmailReturnsEmptyNotError(): void
    {
        $response = $this->call('search_users', ['email' => 'nobody@test']);
        $this->assertArrayNotHasKey('error', $response);
        $text = $this->contentText($response);
        $decoded = json_decode($text, true);
        $this->assertIsArray($decoded);
        $this->assertArrayHasKey('users', $decoded);
        $this->assertCount(0, $decoded['users']);
    }

    public function testSearchSystemLogHighFixtureHasFourResetEvents(): void
    {
        $response = $this->call('search_system_log', ['email' => 'high@test']);
        $text = $this->contentText($response);
        $decoded = json_decode($text, true);
        $this->assertIsArray($decoded);
        $this->assertArrayHasKey('events', $decoded);
        $resetEvents = array_filter(
            $decoded['events'],
            fn($e) => $e['event'] === 'user.account.reset_password'
        );
        $this->assertCount(4, $resetEvents);
    }

    public function testResetPasswordTwiceLogsTwoCallEntries(): void
    {
        $this->call('reset_password', ['user_id' => 'u-low', 'send_email' => true]);
        $this->call('reset_password', ['user_id' => 'u-low', 'send_email' => false]);

        $logResponse = mockokta_handle($this->rpc('tools/call', [
            'name' => '_get_call_log',
            'arguments' => [],
        ]), $this->logDir);
        $text = $this->contentText($logResponse);
        $entries = json_decode($text, true);
        $this->assertIsArray($entries);
        $this->assertCount(2, $entries);
        foreach ($entries as $entry) {
            $this->assertSame('reset_password', $entry['tool']);
            $this->assertArrayHasKey('args', $entry);
            $this->assertArrayHasKey('ts', $entry);
        }
    }

    public function testResetCallLogEmptiesIt(): void
    {
        $this->call('reset_password', ['user_id' => 'u-low', 'send_email' => true]);

        mockokta_handle($this->rpc('tools/call', [
            'name' => '_reset_call_log',
            'arguments' => [],
        ]), $this->logDir);

        $logResponse = mockokta_handle($this->rpc('tools/call', [
            'name' => '_get_call_log',
            'arguments' => [],
        ]), $this->logDir);
        $text = $this->contentText($logResponse);
        $entries = json_decode($text, true);
        $this->assertIsArray($entries);
        $this->assertCount(0, $entries);
    }

    public function testVerifySecurityAnswersCorrect(): void
    {
        $response = $this->call('verify_security_answers', [
            'user_id' => 'u-low',
            'answers' => ['fluffy', 'paris'],
        ]);
        $text = $this->contentText($response);
        $decoded = json_decode($text, true);
        $this->assertTrue($decoded['verified']);
    }

    public function testVerifySecurityAnswersIncorrect(): void
    {
        $response = $this->call('verify_security_answers', [
            'user_id' => 'u-low',
            'answers' => ['wrong', 'answers'],
        ]);
        $text = $this->contentText($response);
        $decoded = json_decode($text, true);
        $this->assertFalse($decoded['verified']);
    }

    public function testListUserFactorsLowFixture(): void
    {
        $response = $this->call('list_user_factors', ['user_id' => 'u-low']);
        $text = $this->contentText($response);
        $decoded = json_decode($text, true);
        $this->assertIsArray($decoded['factors']);
        $this->assertCount(1, $decoded['factors']);
        $this->assertSame('f1', $decoded['factors'][0]['id']);
        $this->assertSame('sms', $decoded['factors'][0]['type']);
    }

    public function testInitializeMethod(): void
    {
        $response = mockokta_handle($this->rpc('initialize'), $this->logDir);
        $this->assertArrayHasKey('result', $response);
        $this->assertSame('2.0', $response['jsonrpc']);
        $this->assertSame(1, $response['id']);
    }
}
