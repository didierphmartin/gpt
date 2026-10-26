<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\VoiceController;
use Quantis\AIPortfolioAssistant\Services\ApiKeyCrypto;

/** The Gemini voice key is found like every other key and never reaches the browser. */
class GeminiVoiceTokenTest extends TestCase
{
    private const SECRET = 'test-secret-0123456789-0123456789';

    private PDO $db;
    private array $sent = [];

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)");
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->db->exec('CREATE TABLE user_api_keys (id INTEGER PRIMARY KEY, user_id INTEGER, provider TEXT, api_key TEXT, base_url TEXT, enabled INTEGER DEFAULT 1)');
        $this->db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, api_key TEXT, enabled INTEGER)');
        $this->db->exec("INSERT INTO users VALUES (1, 'u@x.test', 'user'), (2, 'n@x.test', 'nogemini')");
        $this->package('user', ['gemini' => ['enabled' => true]]);
        $this->package('nogemini', ['claude' => ['enabled' => true]]);
    }

    private function package(string $role, array $providers): void
    {
        $this->db->prepare('INSERT OR REPLACE INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)')
            ->execute([$role, $role, json_encode(['providers' => $providers])]);
    }

    private function voice(array $responses = [], string $envKey = ''): VoiceController
    {
        $stack = HandlerStack::create(new MockHandler($responses));
        $stack->push(Middleware::history($this->sent));
        $config = ['auth' => ['jwt_secret' => self::SECRET], 'gemini_voice' => ['api_key' => $envKey]];
        return new class ($this->db, $config, new Client(['handler' => $stack, 'http_errors' => false])) extends VoiceController {
            public function __construct(PDO $db, array $config, private Client $client)
            {
                parent::__construct($db, $config);
            }
            protected function getHttpClient(): Client
            {
                return $this->client;
            }
        };
    }

    private function token(): Response
    {
        return new Response(200, [], json_encode(['name' => 'auth_tokens/abc']));
    }

    public function test_config_says_whether_a_key_exists_and_never_gives_it(): void
    {
        $r = $this->voice([], 'env-key')->getConfig(['user_id' => 1, 'query' => ['provider' => 'gemini']]);
        $this->assertTrue($r['config']['available']);
        $this->assertStringNotContainsString('env-key', json_encode($r));
        $this->assertArrayNotHasKey('api_key', $r['config']);

        $this->assertFalse($this->voice()->getConfig(['user_id' => 1, 'query' => ['provider' => 'gemini']])['config']['available']);
        $this->assertFalse($this->voice([], 'env-key')->getConfig(['query' => ['provider' => 'gemini']])['config']['available']);
    }

    public function test_package_without_gemini_has_no_voice_key(): void
    {
        $this->assertFalse($this->voice([], 'env-key')->getConfig(['user_id' => 2, 'query' => ['provider' => 'gemini']])['config']['available']);
        $r = $this->voice([], 'env-key')->getEphemeralToken(['user_id' => 2, 'body' => ['provider' => 'gemini']]);
        $this->assertSame('NO_GEMINI_KEY', $r['code']);
        $this->assertSame([], $this->sent);
    }

    public function test_token_is_minted_with_the_users_own_key_in_a_header(): void
    {
        $this->db->exec("INSERT INTO system_llm_settings VALUES ('gemini', 'admin-key', 1)");
        $this->db->prepare("INSERT INTO user_api_keys (user_id, provider, api_key) VALUES (1, 'gemini', ?)")
            ->execute([ApiKeyCrypto::encrypt('own-key', self::SECRET)]);

        $r = $this->voice([$this->token()], 'env-key')->getEphemeralToken(['user_id' => 1, 'body' => ['provider' => 'gemini']]);

        $this->assertTrue($r['success']);
        $this->assertSame('auth_tokens/abc', $r['client_secret']);
        $req = $this->sent[0]['request'];
        $this->assertSame('own-key', $req->getHeaderLine('x-goog-api-key'));
        $this->assertStringNotContainsString('key', (string) $req->getUri()->getQuery());
        $this->assertSame(1, json_decode((string) $req->getBody(), true)['uses']);
    }

    public function test_admin_key_then_server_key(): void
    {
        $this->db->exec("INSERT INTO system_llm_settings VALUES ('gemini', 'admin-key', 1)");
        $this->voice([$this->token()], 'env-key')->getEphemeralToken(['user_id' => 1, 'body' => ['provider' => 'gemini']]);
        $this->assertSame('admin-key', $this->sent[0]['request']->getHeaderLine('x-goog-api-key'));

        $this->db->exec('DELETE FROM system_llm_settings');
        $this->voice([$this->token()], 'env-key')->getEphemeralToken(['user_id' => 1, 'body' => ['provider' => 'gemini']]);
        $this->assertSame('env-key', $this->sent[1]['request']->getHeaderLine('x-goog-api-key'));
    }

    public function test_signed_out_gets_no_token(): void
    {
        $r = $this->voice([], 'env-key')->getEphemeralToken(['body' => ['provider' => 'gemini']]);
        $this->assertSame(401, $r['status_code']);
        $this->assertSame([], $this->sent);
    }

    public function test_google_refusal_never_echoes_the_key(): void
    {
        $r = $this->voice([new Response(400, [], json_encode(['error' => ['message' => 'API key not valid']]))], 'env-key')
            ->getEphemeralToken(['user_id' => 1, 'body' => ['provider' => 'gemini']]);
        $this->assertFalse($r['success']);
        $this->assertSame(400, $r['status_code']);
        $this->assertStringNotContainsString('env-key', json_encode($r));
    }
}
