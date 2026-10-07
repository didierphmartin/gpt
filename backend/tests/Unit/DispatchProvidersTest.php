<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\DispatchController;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;

require_once __DIR__ . '/JevKeyStorageTest.php';

/** The browser asks the server to route with a named decision provider; keys never leave it. */
final class DispatchProvidersTest extends TestCase
{
    private MysqlishSqlitePdo $db;
    private array $history = [];

    protected function setUp(): void
    {
        $this->db = new MysqlishSqlitePdo();
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)');
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (2, 'u@test', 'user')");
        $this->db->exec('CREATE TABLE system_llm_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_key TEXT UNIQUE,
            display_name TEXT, api_key TEXT, model TEXT, base_url TEXT, api_format TEXT, protocol TEXT,
            enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, price_input_per_1m REAL, price_output_per_1m REAL)');
        $this->db->exec('CREATE TABLE user_api_keys (user_id INTEGER, provider TEXT, api_key TEXT, base_url TEXT,
            enabled INTEGER DEFAULT 1, PRIMARY KEY (user_id, provider))');
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url, api_format, protocol, sort_order) VALUES
            ('jev', 'Jev', 'jev-global', 'jev-latest', NULL, 'router', 'typesafe', 100),
            ('acme', 'Acme', 'acme-global', 'acme-1', 'https://gw.corp/acme', 'router', 'typesafe', 50),
            ('broken', 'Broken', 'k', 'm', NULL, 'router', NULL, 60),
            ('claude', 'Claude', 'sk', 'c', 'https://api.anthropic.com', 'anthropic', NULL, 0)");
        $this->db->prepare('INSERT INTO packages (role, capabilities) VALUES (?, ?)')->execute(['user', json_encode(['providers' => [
            'jev' => ['enabled' => true], 'acme' => ['enabled' => true], 'broken' => ['enabled' => true],
        ]])]);
    }

    private function controller(array $answers = []): DispatchController
    {
        $stack = HandlerStack::create(new MockHandler($answers));
        $stack->push(Middleware::history($this->history));
        $usage = $this->createMock(UsageLogger::class);
        return new DispatchController($this->db, ['auth' => ['jwt_secret' => 's']], new Client(['handler' => $stack]), $usage);
    }

    private static function answer(string $choice): Response
    {
        return new Response(200, [], json_encode(['answers' => ['route' => ['choice' => $choice, 'confidence' => 0.99]],
            'usage' => ['input_tokens' => 3, 'output_tokens' => 1]]));
    }

    private const TARGETS = [['id' => 2, 'name' => 'Billing'], ['id' => 3, 'name' => 'Sales']];

    public function testProvidersListsEveryRowWithItsStatus(): void
    {
        $out = $this->controller()->providers(['user_id' => 2]);
        $this->assertSame(['acme', 'broken', 'jev'], array_column($out['providers'], 'key'));
        $this->assertSame('acme', $out['default']);
        $acme = $out['providers'][0];
        $this->assertTrue($acme['routable']);
        $this->assertTrue($acme['supported'], 'PHP routes with decision models');
        $this->assertSame('ACME_API_KEY', $acme['key_env']);
        $this->assertSame('ACME_BASE_URL', $acme['url_env']);
        $this->assertSame(['key' => 'TYPESAFE_API_KEY', 'url' => 'TYPESAFE_BASE_URL'], $acme['legacy_env']);
        $this->assertArrayNotHasKey('api_key', $acme, 'never the key');
    }

    public function testProvidersListMarksARowWithoutProtocolUnroutable(): void
    {
        $broken = $this->controller()->providers(['user_id' => 2])['providers'][1];
        $this->assertFalse($broken['routable']);
        $this->assertSame("'broken' is not an available decision provider", $broken['reason']);
        $this->assertNull($broken['legacy_env']);
    }

    public function testRouteUsesTheNamedProvidersKeyAndUrl(): void
    {
        $out = $this->controller([self::answer('Sales')])->route(['user_id' => 2, 'body' => [
            'provider' => 'acme', 'request' => 'buy', 'targets' => self::TARGETS, 'question' => 'q',
        ]]);
        $this->assertSame('routed', $out['outcome']);
        $this->assertSame('acme', $out['provider']);
        $req = $this->history[0]['request'];
        $this->assertSame('https://gw.corp/acme', (string) $req->getUri());
        $this->assertSame('Bearer acme-global', $req->getHeaderLine('Authorization'));
        $this->assertSame('acme-1', json_decode((string) $req->getBody(), true)['model']);
    }

    public function testRouteWithAnUnknownProviderCallsNothing(): void
    {
        $out = $this->controller()->route(['user_id' => 2, 'body' => [
            'provider' => 'gone', 'request' => 'x', 'targets' => self::TARGETS, 'question' => 'q',
        ]]);
        $this->assertSame('unavailable', $out['outcome']);
        $this->assertSame("'gone' is not an available decision provider", $out['reason']);
        $this->assertSame([], $this->history);
    }

    public function testRouteNeedsAProvider(): void
    {
        $out = $this->controller()->route(['user_id' => 2, 'body' => ['request' => 'x', 'targets' => self::TARGETS, 'question' => 'q']]);
        $this->assertSame(400, $out['status_code']);
    }

    public function testTheJevAliasesStillWork(): void
    {
        $st = $this->controller()->jevStatus(['user_id' => 2]);
        $this->assertTrue($st['available']);
        $out = $this->controller([self::answer('Billing')])->jevRoute(['user_id' => 2, 'body' => [
            'request' => 'x', 'targets' => self::TARGETS, 'question' => 'q',
        ]]);
        $this->assertSame('jev', $out['provider']);
        $this->assertSame('routed', $out['outcome']);
    }

    public function testStatusIsPerProvider(): void
    {
        $st = $this->controller()->status(['user_id' => 2, 'params' => ['key' => 'acme']]);
        $this->assertSame(['acme', true, true, 'global'], [$st['provider'], $st['allowed'], $st['available'], $st['source']]);
    }
}
