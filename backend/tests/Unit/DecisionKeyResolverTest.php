<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
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
}
