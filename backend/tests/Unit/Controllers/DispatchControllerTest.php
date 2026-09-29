<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\DispatchController;
use Quantis\AIPortfolioAssistant\Services\ApiKeyCrypto;

/**
 * The browser run path never sees the Jev key: it asks these endpoints to route
 * (POST) and to say whether a key exists (GET status). Jev's HTTP API is mocked.
 */
final class DispatchControllerTest extends TestCase
{
    private const SECRET = 'test-jwt-secret';
    private const TARGETS = [
        ['id' => 1, 'name' => 'Billing', 'description' => 'Invoices.'],
        ['id' => 2, 'name' => 'Sales', 'description' => 'Plans.'],
    ];

    private PDO $db;
    private MockHandler $mock;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)');
        $this->db->exec("INSERT INTO users (id, role) VALUES (7, 'user'), (8, 'user')");
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO packages (role, capabilities) VALUES ('user', '{\"providers\":{\"jev\":{\"enabled\":true}}}')");
        $this->db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, api_key TEXT, enabled INTEGER DEFAULT 1)');
        $this->db->exec('CREATE TABLE user_api_keys (user_id INTEGER, provider TEXT, api_key TEXT, enabled INTEGER DEFAULT 1)');
    }

    private function controller(array $queue = []): DispatchController
    {
        $this->mock = new MockHandler($queue);
        $http = new Client(['handler' => HandlerStack::create($this->mock)]);
        return new DispatchController($this->db, ['auth' => ['jwt_secret' => self::SECRET]], $http);
    }

    private function globalKey(string $key = 'g-key'): void
    {
        $this->db->prepare("INSERT INTO system_llm_settings (provider_key, api_key) VALUES ('jev', ?)")->execute([$key]);
    }

    private function userKey(int $uid, string $key = 'u-key'): void
    {
        $this->db->prepare("INSERT INTO user_api_keys (user_id, provider, api_key) VALUES (?, 'jev', ?)")
            ->execute([$uid, ApiKeyCrypto::encrypt($key, self::SECRET)]);
    }

    private static function answer(string $choice, float $confidence): Response
    {
        return new Response(200, [], json_encode(['answers' => ['route' => [
            'choice' => $choice, 'confidence' => $confidence, 'probabilities' => [$choice => $confidence],
        ]], 'usage' => ['input_tokens' => 1]]));
    }

    private function post(DispatchController $c, array $body, int $uid = 7): array
    {
        return $c->route(['user_id' => $uid, 'body' => $body]);
    }

    private function body(array $extra = []): array
    {
        return $extra + ['request' => 'I was charged twice', 'targets' => self::TARGETS, 'question' => 'Which team?'];
    }

    public function testStatusPerSource(): void
    {
        $c = $this->controller();
        $this->assertSame(['success' => true, 'available' => false, 'source' => 'none', 'status_code' => 200], $c->jevStatus(['user_id' => 7]));

        $this->globalKey();
        $this->assertSame('global', $c->jevStatus(['user_id' => 7])['source']);

        $this->userKey(7);
        $s = $c->jevStatus(['user_id' => 7]);
        $this->assertSame('user', $s['source']);
        $this->assertTrue($s['available']);
        $this->assertArrayNotHasKey('key', $s);
        $this->assertStringNotContainsString('u-key', json_encode($s));
        $this->assertSame('global', $c->jevStatus(['user_id' => 8])['source'], 'another user falls back to global');
    }

    public function testRouted(): void
    {
        $this->globalKey();
        $out = $this->post($this->controller([self::answer('Billing', 0.95)]), $this->body());
        $this->assertTrue($out['success']);
        $this->assertSame('routed', $out['outcome']);
        $this->assertSame(['id' => 1, 'name' => 'Billing'], $out['target']);
        $this->assertSame(0.95, $out['confidence']);
        $this->assertArrayNotHasKey('probabilities', $out);
        $this->assertArrayNotHasKey('usage', $out);
        $this->assertSame(200, $out['status_code']);
    }

    public function testUnclear(): void
    {
        $this->globalKey();
        $out = $this->post($this->controller([self::answer('unclear', 1.0)]), $this->body());
        $this->assertSame('unclear', $out['outcome']);
        $this->assertNull($out['target']);
    }

    public function testCustomFloorAndClamp(): void
    {
        $this->globalKey();
        $out = $this->post($this->controller([self::answer('Billing', 0.7)]), $this->body(['min_confidence' => 0.8]));
        $this->assertSame('low_confidence', $out['outcome']);

        $out = $this->post($this->controller([self::answer('Billing', 0.7)]), $this->body(['min_confidence' => 5]));
        $this->assertSame('low_confidence', $out['outcome'], 'clamped to 1.0');

        $out = $this->post($this->controller([self::answer('Billing', 0.7)]), $this->body(['min_confidence' => -3]));
        $this->assertSame('routed', $out['outcome'], 'clamped to 0.0');

        $out = $this->post($this->controller([self::answer('Billing', 0.7)]), $this->body());
        $this->assertSame('routed', $out['outcome'], 'default floor 0.6');
    }

    public function testNoKeyIsUnavailableWithoutHttp(): void
    {
        $c = $this->controller([self::answer('Billing', 0.99)]);
        $out = $this->post($c, $this->body());
        $this->assertTrue($out['success']);
        $this->assertSame('unavailable', $out['outcome']);
        $this->assertNull($out['target']);
        $this->assertCount(1, $this->mock, 'no HTTP call was made');
    }

    public function testUserKeyIsUsed(): void
    {
        $this->userKey(7);
        $out = $this->post($this->controller([self::answer('Sales', 0.9)]), $this->body());
        $this->assertSame('routed', $out['outcome']);
        $this->assertSame(2, $out['target']['id']);
    }

    /** @dataProvider invalidBodies */
    public function testInvalidBodyIs400(array $body): void
    {
        $this->globalKey();
        $out = $this->post($this->controller(), $body);
        $this->assertFalse($out['success']);
        $this->assertSame(400, $out['status_code']);
        $this->assertArrayHasKey('message', $out);
    }

    public static function invalidBodies(): array
    {
        $ok = ['request' => 'x', 'targets' => self::TARGETS, 'question' => 'q'];
        return [
            'missing request' => [array_diff_key($ok, ['request' => 1])],
            'empty request' => [['request' => ''] + $ok],
            'targets not array' => [['targets' => 'Billing'] + $ok],
            'question not string' => [['question' => 5] + $ok],
            'min_confidence not numeric' => [['min_confidence' => 'high'] + $ok],
        ];
    }
}
