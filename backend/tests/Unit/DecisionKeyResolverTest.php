<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\JevRouter;
use Quantis\AIPortfolioAssistant\Services\ApiKeyCrypto;
use Quantis\AIPortfolioAssistant\Services\DecisionKeyResolver;
use Quantis\AIPortfolioAssistant\Services\DecisionProviders;

require_once __DIR__ . '/JevKeyStorageTest.php';

/**
 * Decision providers are router rows (api_format 'router') naming a
 * registered protocol. Several rows may share a protocol (jev, jev-eu).
 */
final class DecisionKeyResolverTest extends TestCase
{
    private const SECRET = 'decision-test-secret';

    private MysqlishSqlitePdo $db;

    protected function setUp(): void
    {
        $this->db = new MysqlishSqlitePdo();
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)');
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (2, 'u@test', 'user')");
        $this->db->exec('CREATE TABLE system_llm_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, provider_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
            api_key TEXT, model TEXT NOT NULL, base_url TEXT, chat_endpoint TEXT, api_format TEXT DEFAULT \'openai\',
            protocol TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
            price_input_per_1m REAL, price_output_per_1m REAL, streaming INTEGER, supports_tools INTEGER,
            max_tokens INTEGER, temperature REAL, supported_models TEXT, system_prompt TEXT, created_at TEXT, updated_at TEXT)');
        $this->db->exec('CREATE TABLE user_api_keys (
            user_id INTEGER NOT NULL, provider TEXT NOT NULL, api_key TEXT NOT NULL, base_url TEXT,
            enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, provider))');
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, api_format, sort_order)
            VALUES ('claude', 'Claude', 'sk-c', 'claude-x', 'anthropic', 0)");
    }

    private function row(string $key, string $apiKey = '', ?string $protocol = 'typesafe', int $sort = 100,
                         int $enabled = 1, ?string $url = null, string $label = ''): void
    {
        $this->db->prepare("INSERT INTO system_llm_settings
            (provider_key, display_name, api_key, model, base_url, api_format, protocol, enabled, sort_order)
            VALUES (?, ?, ?, 'jev-latest', ?, 'router', ?, ?, ?)")
            ->execute([$key, $label !== '' ? $label : ucfirst($key), $apiKey, $url, $protocol, $enabled, $sort]);
    }

    private function allow(array $entries): void
    {
        $this->db->prepare('INSERT INTO packages (role, capabilities) VALUES (?, ?)')
            ->execute(['user', json_encode(['providers' => $entries])]);
    }

    public function testRowsAreRouterRowsInAdminOrder(): void
    {
        $this->row('jev', sort: 100);
        $this->row('acme', sort: 50);
        $this->row('off', enabled: 0, sort: 10);
        $this->assertSame(['acme', 'jev'], array_column(DecisionProviders::rows($this->db), 'provider_key'));
        $this->assertSame(['off', 'acme', 'jev'], DecisionProviders::keys($this->db));
    }

    public function testRowFindsAnEnabledRowOnly(): void
    {
        $this->row('jev');
        $this->row('off', enabled: 0);
        $this->assertSame('jev', DecisionProviders::row($this->db, 'jev')['provider_key']);
        $this->assertNull(DecisionProviders::row($this->db, 'off'));
        $this->assertNull(DecisionProviders::row($this->db, 'claude'), 'a chat row is never a decision provider');
    }

    public function testEnvStemSanitises(): void
    {
        $this->assertSame('JEV', DecisionProviders::envStem('jev'));
        $this->assertSame('JEV_EU', DecisionProviders::envStem('jev-eu'));
        $this->assertSame('ACME_V2', DecisionProviders::envStem('acme.v2'));
    }

    public function testAnInstallWithoutTheTableReadsNoRows(): void
    {
        $this->db->exec('DROP TABLE system_llm_settings');
        $this->assertSame([], DecisionProviders::rows($this->db));
    }

    private function config(): array
    {
        return ['auth' => ['jwt_secret' => self::SECRET]];
    }

    private function userKey(string $provider, string $key, ?string $url = null): void
    {
        $this->db->prepare('INSERT INTO user_api_keys (user_id, provider, api_key, base_url) VALUES (2, ?, ?, ?)')
            ->execute([$provider, ApiKeyCrypto::encrypt($key, self::SECRET), $url]);
    }

    public function testEachProviderResolvesItsOwnKey(): void
    {
        $this->row('jev', 'jev-global');
        $this->row('acme', 'acme-global');
        $this->allow(['jev' => ['enabled' => true], 'acme' => ['enabled' => true]]);
        $this->assertSame('jev-global', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'jev')['key']);
        $this->assertSame('acme-global', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme')['key']);
    }

    public function testPrecedenceIsUserThenPackageThenGlobal(): void
    {
        $this->row('acme', 'acme-global');
        $this->allow(['acme' => ['enabled' => true, 'default_api_key' => 'acme-package']]);
        $this->assertSame(['acme-package', 'package'],
            array_values(array_intersect_key(DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme'), ['key' => 1, 'source' => 1])));
        $this->userKey('acme', 'acme-mine');
        $r = DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme');
        $this->assertSame('acme-mine', $r['key']);
        $this->assertSame('user', $r['source']);
    }

    public function testTheUrlIsThePairedOne(): void
    {
        $this->row('acme', 'acme-global', url: 'https://gw.corp/acme');
        $this->allow(['acme' => ['enabled' => true]]);
        $this->assertSame('https://gw.corp/acme', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme')['url']);

        // The user's URL goes with the user's own key only.
        $this->userKey('acme', 'acme-mine', 'https://mine.example/acme');
        $this->assertSame('https://mine.example/acme', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme')['url']);
        $this->db->exec("UPDATE user_api_keys SET api_key = '' WHERE provider = 'acme'");
        $this->assertSame('https://gw.corp/acme', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme')['url']);
    }

    public function testNoRowUrlIsTheProtocolDefault(): void
    {
        $this->row('jev', 'k');
        $this->allow(['jev' => ['enabled' => true]]);
        $this->assertSame(JevRouter::URL, DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'jev')['url']);
    }

    public function testARowWithoutProtocolIsUnknown(): void
    {
        $this->row('jev', 'k', protocol: null);
        $this->allow(['jev' => ['enabled' => true]]);
        $r = DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'jev');
        $this->assertSame('unknown', $r['source']);
        $this->assertSame('', $r['key']);
        $this->assertSame("'jev' is not an available decision provider", DecisionKeyResolver::unavailableReason($r, 'jev'));
    }

    public function testADeletedOrDisabledProviderIsUnknown(): void
    {
        $this->row('off', 'k', enabled: 0);
        $this->allow(['off' => ['enabled' => true]]);
        $this->assertSame('unknown', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'off')['source']);
        $this->assertSame('unknown', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'gone')['source']);
    }

    public function testThePlanDecidesPerProvider(): void
    {
        $this->row('jev', 'k1');
        $this->row('acme', 'k2', label: 'Acme Router');
        $this->allow(['jev' => ['enabled' => true]]);   // acme missing from the allowlist
        $r = DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme');
        $this->assertSame('not_allowed', $r['source']);
        $this->assertSame('Acme Router is not enabled for your plan', DecisionKeyResolver::unavailableReason($r, 'acme'));
        $this->assertSame('jev', DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'jev')['row']['provider_key']);
    }

    public function testNoKeyAnywhereIsNone(): void
    {
        $this->row('acme', '', label: 'Acme');
        $this->allow(['acme' => ['enabled' => true]]);
        $r = DecisionKeyResolver::resolve($this->db, $this->config(), 2, 'acme');
        $this->assertSame('none', $r['source']);
        $this->assertSame('no Acme key', DecisionKeyResolver::unavailableReason($r, 'acme'));
    }

    public function testTheDefaultIsTheFirstAllowedRowInAdminOrder(): void
    {
        $this->row('jev', 'k', sort: 100);
        $this->row('acme', 'k', sort: 50);
        $this->row('broken', 'k', protocol: null, sort: 10);
        $this->allow(['jev' => ['enabled' => true], 'broken' => ['enabled' => true]]);
        $this->assertSame('jev', DecisionKeyResolver::defaultProvider($this->db, 2), 'acme not in plan, broken has no protocol');
    }

    public function testNoAllowedRowMeansNoDefault(): void
    {
        $this->row('jev', 'k');
        $this->allow(['claude' => ['enabled' => true]]);
        $this->assertNull(DecisionKeyResolver::defaultProvider($this->db, 2));
    }

    public function testAPackageWithoutAnAllowlistAllowsEveryProvider(): void
    {
        $this->row('acme', 'k');
        $this->db->prepare('INSERT INTO packages (role, capabilities) VALUES (?, ?)')->execute(['user', json_encode([])]);
        $this->assertTrue(DecisionKeyResolver::allowed($this->db, 2, 'acme'));
    }
}
