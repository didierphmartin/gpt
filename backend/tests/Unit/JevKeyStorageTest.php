<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PDO;
use PDOStatement;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AdminController;
use Quantis\AIPortfolioAssistant\Controllers\ProviderController;
use Quantis\AIPortfolioAssistant\Controllers\SettingsController;
use Quantis\AIPortfolioAssistant\Controllers\SystemSettingsController;
use Quantis\AIPortfolioAssistant\Services\ApiKeyCrypto;
use Quantis\AIPortfolioAssistant\Services\JevKeyResolver;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use Quantis\AIPortfolioAssistant\Services\ProviderKinds;

/**
 * The Jev key is stored where LLM keys are stored -- a global row in
 * system_llm_settings (api_format 'router') and a per-user row in
 * user_api_keys -- WITHOUT Jev ever becoming a chat provider.
 *
 * Jev answers closed questions only; it cannot generate text. Every chat path
 * that treats a system_llm_settings row as "a provider that can answer a
 * prompt" (provider list, automatic fallback, provider registration) must
 * therefore skip the router row, while the key paths (user Settings, admin
 * per-user keys) must accept it.
 */
final class JevKeyStorageTest extends TestCase
{
    private const SECRET = 'test-jwt-secret';

    private MysqlishSqlitePdo $db;

    protected function setUp(): void
    {
        $this->db = new MysqlishSqlitePdo();
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)');
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (1, 'admin@test', 'admin'), (2, 'user@test', 'user')");
        $this->db->exec('CREATE TABLE system_llm_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_key TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            api_key TEXT,
            model TEXT NOT NULL,
            base_url TEXT,
            max_tokens INTEGER DEFAULT 4096,
            temperature REAL DEFAULT 0.7,
            price_input_per_1m REAL,
            price_output_per_1m REAL,
            chat_endpoint TEXT,
            streaming INTEGER DEFAULT 1,
            supports_tools INTEGER DEFAULT 1,
            supported_models TEXT,
            api_format TEXT DEFAULT \'openai\',
            system_prompt TEXT,
            enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )');
        $this->db->exec('CREATE TABLE user_api_keys (
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            api_key TEXT NOT NULL,
            model TEXT, base_url TEXT, max_tokens INTEGER, temperature REAL,
            chat_endpoint TEXT, streaming INTEGER, supports_tools INTEGER,
            system_prompt TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT, updated_at TEXT,
            PRIMARY KEY (user_id, provider)
        )');
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $this->db->exec('CREATE TABLE user_model_selections (
            user_id INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT,
            PRIMARY KEY (user_id, provider)
        )');

        $this->db->exec("INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url, api_format, sort_order)
            VALUES ('claude', 'Claude', 'sk-claude', 'claude-sonnet-4-5', 'https://api.anthropic.com', 'anthropic', 0),
                   ('kimi', 'Kimi', 'sk-kimi', 'moonshot-v1-auto', 'https://api.moonshot.ai', 'openai', 5)");
    }

    private function config(): array
    {
        return ['auth' => ['jwt_secret' => self::SECRET]];
    }

    private function seedGlobalJev(string $key = 'global-jev-key', int $enabled = 1): void
    {
        $stmt = $this->db->prepare("INSERT INTO system_llm_settings
            (provider_key, display_name, api_key, model, base_url, streaming, supports_tools, api_format, enabled, sort_order)
            VALUES ('jev', 'Jev (dispatcher routing)', :k, 'jev-latest', NULL, 0, 0, 'router', :e, 100)");
        $stmt->execute([':k' => $key, ':e' => $enabled]);
    }

    private function seedUserJev(int $userId, string $stored, int $enabled = 1): void
    {
        $stmt = $this->db->prepare("INSERT INTO user_api_keys (user_id, provider, api_key, enabled) VALUES (:u, 'jev', :k, :e)");
        $stmt->execute([':u' => $userId, ':k' => $stored, ':e' => $enabled]);
    }

    private function package(string $role, ?array $jev, bool $providersIsArray = true): void
    {
        $caps = $providersIsArray ? ['providers' => $jev === null ? [] : ['jev' => $jev]] : ['providers' => null];
        $this->db->prepare('INSERT INTO packages (role, capabilities) VALUES (?, ?)')
            ->execute([$role, json_encode($caps)]);
    }

    private function userWithRole(int $id, string $role): void
    {
        $this->db->prepare('INSERT INTO users (id, role) VALUES (?, ?)')->execute([$id, $role]);
    }

    /** Every role's package switches Jev on, so the key-precedence tests see keys. */
    private function allowJev(): void
    {
        foreach (['guest', 'prospect', 'user', 'admin'] as $role) {
            $this->package($role, ['enabled' => true]);
        }
    }

    // ---------------------------------------------------------------- kinds

    public function testRouterRowIsRecognisedByApiFormat(): void
    {
        $this->assertSame('router', ProviderKinds::ROUTER_FORMAT);
        $this->assertTrue(ProviderKinds::isRouterRow(['provider_key' => 'jev', 'api_format' => 'router']));
        $this->assertFalse(ProviderKinds::isRouterRow(['provider_key' => 'kimi', 'api_format' => 'openai']));
        $this->assertFalse(ProviderKinds::isRouterRow(['provider_key' => 'x']));
    }

    // ------------------------------------------------------- chat paths skip it

    public function testApplyDbSettingsKeepsTheRouterRowOutOfProviders(): void
    {
        $this->seedGlobalJev();
        $config = LLMProviderResolver::applyDbSettings($this->db, $this->config());

        $this->assertArrayHasKey('kimi', $config['providers'], 'chat providers still load');
        $this->assertArrayHasKey('claude', $config, 'root providers still load');
        $this->assertArrayNotHasKey('jev', $config['providers']);
        $this->assertArrayNotHasKey('jev', $config);
        $this->assertSame('global-jev-key', $config['routers']['jev']['api_key'] ?? null);
        $this->assertSame('jev-latest', $config['routers']['jev']['model'] ?? null);
    }

    public function testProviderListExcludesRouterRows(): void
    {
        $this->seedGlobalJev();
        $ctrl = new ProviderController($this->db, $this->config());
        $m = new \ReflectionMethod($ctrl, 'getProvidersFromDatabase');
        $names = array_column($m->invoke($ctrl), 'name');

        $this->assertContains('kimi', $names);
        $this->assertContains('claude', $names);
        $this->assertNotContains('jev', $names);
    }

    // ------------------------------------------------- user Settings accepts it

    public function testSettingsSaveKeysStoresTheJevKeyEncrypted(): void
    {
        $ctrl = new SettingsController($this->db, $this->config());
        $out = $ctrl->saveKeys(['user_id' => 2, 'body' => [
            'keys' => ['jev' => 'user-jev-key'],
            'models' => ['jev' => 'jev-latest'],
            'system_prompts' => ['jev' => 'be a chat model'],
        ]]);
        $this->assertTrue($out['success']);
        $this->assertSame(1, $out['saved_count']);
        $this->assertSame(0, $out['model_count'], 'Jev has no model choice');
        $this->assertSame(0, $out['prompt_count'], 'Jev has no system prompt');

        $row = $this->db->query("SELECT api_key, system_prompt FROM user_api_keys WHERE user_id = 2 AND provider = 'jev'")
            ->fetch(PDO::FETCH_ASSOC);
        $this->assertNotSame('user-jev-key', $row['api_key'], 'stored encrypted, never plaintext');
        $this->assertSame('user-jev-key', ApiKeyCrypto::decrypt($row['api_key'], self::SECRET));
        $this->assertNull($row['system_prompt']);
        $this->assertSame(0, (int) $this->db->query("SELECT COUNT(*) FROM user_model_selections WHERE provider = 'jev'")->fetchColumn());
    }

    /** The shared helper must be the exact algorithm the controllers already used. */
    public function testApiKeyCryptoRoundTripsAndRejectsForeignBlobs(): void
    {
        $blob = ApiKeyCrypto::encrypt('abc123', self::SECRET);
        $this->assertSame('abc123', ApiKeyCrypto::decrypt($blob, self::SECRET));
        $this->assertNull(ApiKeyCrypto::decrypt($blob, 'another-secret'));
        $this->assertNull(ApiKeyCrypto::decrypt('short', self::SECRET));

        // Byte-for-byte the pre-existing format: base64(iv16 . AES-256-CBC(sha256(secret))).
        $raw = base64_decode($blob);
        $plain = openssl_decrypt(substr($raw, 16), 'AES-256-CBC', hash('sha256', self::SECRET, true), OPENSSL_RAW_DATA, substr($raw, 0, 16));
        $this->assertSame('abc123', $plain);
    }

    // ---------------------------------------------- admin per-user keys accept it

    public function testAdminSaveAndGetApiKeysAcceptJev(): void
    {
        $this->allowJev();
        $admin = new AdminController($this->db, $this->config());

        $before = $admin->getApiKeys(['user_id' => 1], 2);
        $this->assertArrayHasKey('jev', $before['keys'], 'the empty Jev slot is listed');
        $this->assertNull($before['keys']['jev']['masked_key']);

        $saved = $admin->saveApiKeys(['user_id' => 1, 'body' => ['user_id' => 2, 'keys' => ['jev' => 'admin-set-jev-key-9876']]]);
        $this->assertTrue($saved['success']);

        $after = $admin->getApiKeys(['user_id' => 1], 2);
        $this->assertSame('****9876', $after['keys']['jev']['masked_key']);

        // Existing storage behaviour kept (plaintext, like every other provider
        // on this path); the resolver still reads it.
        $this->assertSame(
            ['key' => 'admin-set-jev-key-9876', 'source' => 'user'],
            JevKeyResolver::resolve($this->db, $this->config(), 2)
        );
    }

    // ------------------------------------------------------------ precedence

    public function testUserKeyWinsOverGlobal(): void
    {
        $this->allowJev();
        $this->seedGlobalJev();
        $this->seedUserJev(2, ApiKeyCrypto::encrypt('user-jev-key', self::SECRET));
        $this->assertSame(['key' => 'user-jev-key', 'source' => 'user'], JevKeyResolver::resolve($this->db, $this->config(), 2));
    }

    public function testGlobalKeyWhenTheUserHasNone(): void
    {
        $this->allowJev();
        $this->seedGlobalJev();
        $this->assertSame(['key' => 'global-jev-key', 'source' => 'global'], JevKeyResolver::resolve($this->db, $this->config(), 2));
        $this->assertSame(['key' => 'global-jev-key', 'source' => 'global'], JevKeyResolver::resolve($this->db, $this->config(), null));
    }

    public function testNoneWhenNothingIsSet(): void
    {
        $this->allowJev();
        $this->assertSame(['key' => '', 'source' => 'none'], JevKeyResolver::resolve($this->db, $this->config(), 2));
        $this->seedGlobalJev('');
        $this->assertSame(['key' => '', 'source' => 'none'], JevKeyResolver::resolve($this->db, $this->config(), 2));
    }

    public function testDisabledRowsAreIgnored(): void
    {
        $this->allowJev();
        $this->seedGlobalJev('global-jev-key', 0);
        $this->seedUserJev(2, ApiKeyCrypto::encrypt('user-jev-key', self::SECRET), 0);
        $this->assertSame(['key' => '', 'source' => 'none'], JevKeyResolver::resolve($this->db, $this->config(), 2));
    }

    public function testAnotherUsersKeyIsNotUsed(): void
    {
        $this->allowJev();
        $this->seedUserJev(1, ApiKeyCrypto::encrypt('admin-own-key', self::SECRET));
        $this->assertSame(['key' => '', 'source' => 'none'], JevKeyResolver::resolve($this->db, $this->config(), 2));
    }

    /** Encrypted under an old jwt_secret: unusable, so the global key must take over. */
    public function testUndecryptableUserKeyFallsBackToGlobal(): void
    {
        $this->allowJev();
        $this->seedGlobalJev();
        $this->seedUserJev(2, ApiKeyCrypto::encrypt('user-jev-key', 'rotated-away-secret'));
        $this->assertSame(['key' => 'global-jev-key', 'source' => 'global'], JevKeyResolver::resolve($this->db, $this->config(), 2));
    }

    public function testJevOffInThePackageIsNotAllowedEvenWithTheUsersOwnKey(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', ['enabled' => false, 'default_api_key' => 'pkg-key']);
        $this->seedUserJev(7, ApiKeyCrypto::encrypt('own-key', self::SECRET));
        $this->seedGlobalJev('global-key');
        $this->assertSame(['key' => '', 'source' => 'not_allowed'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testAPackageWithoutAJevEntryIsNotAllowed(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', null);
        $this->seedGlobalJev('global-key');
        $this->assertSame('not_allowed', JevKeyResolver::resolve($this->db, $this->config(), 7)['source']);
    }

    public function testAMissingPackageRowIsNotAllowed(): void
    {
        $this->userWithRole(7, 'user');
        $this->seedGlobalJev('global-key');
        $this->assertSame('not_allowed', JevKeyResolver::resolve($this->db, $this->config(), 7)['source']);
    }

    public function testProvidersNotAnArrayMeansNoAllowlist(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', null, false);
        $this->seedGlobalJev('global-key');
        $this->assertSame(['key' => 'global-key', 'source' => 'global'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testUserKeyWinsOverPackageAndGlobal(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', ['enabled' => true, 'default_api_key' => 'pkg-key']);
        $this->seedUserJev(7, ApiKeyCrypto::encrypt('own-key', self::SECRET));
        $this->seedGlobalJev('global-key');
        $this->assertSame(['key' => 'own-key', 'source' => 'user'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testPackageKeyWinsOverGlobal(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', ['enabled' => true, 'default_api_key' => '  pkg-key  ']);
        $this->seedGlobalJev('global-key');
        $this->assertSame(['key' => 'pkg-key', 'source' => 'package'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testEnabledPackageWithoutKeyFallsBackToGlobal(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', ['enabled' => true]);
        $this->seedGlobalJev('global-key');
        $this->assertSame(['key' => 'global-key', 'source' => 'global'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testTruthyEnabledCountsAsOnLikeTheLlmProviders(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', ['enabled' => 1, 'default_api_key' => 'pkg-key']);
        $this->assertSame(['key' => 'pkg-key', 'source' => 'package'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testEnabledPackageAndNoKeyAnywhereIsNone(): void
    {
        $this->userWithRole(7, 'user');
        $this->package('user', ['enabled' => true]);
        $this->assertSame(['key' => '', 'source' => 'none'], JevKeyResolver::resolve($this->db, $this->config(), 7));
    }

    public function testUnavailableReasons(): void
    {
        $this->assertSame('Jev is not enabled for your plan', JevKeyResolver::unavailableReason('not_allowed'));
        $this->assertSame('no Jev key', JevKeyResolver::unavailableReason('none'));
    }

    // ------------------------------------------------ admin router-row save

    public function testSystemSettingsAcceptsTheJevRouterRow(): void
    {
        $ctrl = new SystemSettingsController($this->db, $this->config());
        $out = $ctrl->saveLLMProvider(['user_id' => 1, 'body' => [
            'provider_key' => 'jev', 'display_name' => 'Jev (dispatcher routing)',
            'model' => 'jev-latest', 'api_format' => 'router', 'api_key' => 'global-jev-key',
            'base_url' => 'https://should-not-be-kept', 'streaming' => 1, 'supports_tools' => 1,
        ]]);
        $this->assertTrue($out['success'], $out['error'] ?? '');

        $row = $this->db->query("SELECT * FROM system_llm_settings WHERE provider_key = 'jev'")->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('router', $row['api_format']);
        $this->assertNull($row['base_url'], 'a router row has no chat endpoint');
        $this->assertSame(0, (int) $row['streaming']);
        $this->assertSame(0, (int) $row['supports_tools']);
    }

    public function testRouterFormatIsOnlyForTheJevRow(): void
    {
        $ctrl = new SystemSettingsController($this->db, $this->config());
        $asRouter = $ctrl->saveLLMProvider(['user_id' => 1, 'body' => [
            'provider_key' => 'kimi', 'model' => 'moonshot-v1-auto', 'api_format' => 'router',
        ]]);
        $this->assertSame(400, $asRouter['status_code']);

        $jevAsChat = $ctrl->saveLLMProvider(['user_id' => 1, 'body' => [
            'provider_key' => 'jev', 'model' => 'jev-latest', 'api_format' => 'openai',
        ]]);
        $this->assertSame(400, $jevAsChat['status_code']);
    }
}

/**
 * SQLite that tolerates the few MySQL-isms the controllers under test use:
 * NOW(), ON DUPLICATE KEY UPDATE ... VALUES(col), and the runtime
 * CREATE TABLE/ALTER TABLE "ensure" statements (the tables are pre-created by
 * the test). Everything else runs as real SQL, so the assertions read real rows.
 */
final class MysqlishSqlitePdo extends PDO
{
    public function __construct()
    {
        parent::__construct('sqlite::memory:');
        $this->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->sqliteCreateFunction('NOW', fn () => date('Y-m-d H:i:s'), 0);
    }

    public function exec(string $statement): int|false
    {
        if (preg_match('/^\s*(CREATE TABLE IF NOT EXISTS|ALTER TABLE)\s+`/i', $statement)) {
            return 0;
        }
        return parent::exec($statement);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $pos = stripos($query, 'ON DUPLICATE KEY UPDATE');
        if ($pos !== false) {
            $tail = substr($query, $pos + strlen('ON DUPLICATE KEY UPDATE'));
            $tail = preg_replace('/VALUES\((\w+)\)/i', 'excluded.$1', $tail);
            $query = substr($query, 0, $pos) . 'ON CONFLICT(user_id, provider) DO UPDATE SET' . $tail;
        }
        return parent::prepare($query, $options);
    }
}
