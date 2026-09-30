<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\PackageController;

/**
 * GET /api/v1/me/package goes to the browser: it says which providers are on
 * and their default model, never a package default key (the admin endpoints
 * keep the keys for gpt_admin).
 */
final class PackageControllerMeTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)');
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO users (id, role) VALUES (7, 'user')");
        $caps = [
            'providers' => [
                'claude' => ['enabled' => true, 'default_model' => 'claude-sonnet-4-5', 'default_api_key' => 'sk-claude-pkg'],
                'jev' => ['enabled' => true, 'default_model' => null, 'default_api_key' => 'jev-pkg-key'],
                'kimi' => ['enabled' => false, 'default_model' => 'kimi-k2', 'default_api_key' => null],
            ],
            'quota_tokens' => 1000,
        ];
        $this->db->prepare('INSERT INTO packages (role, capabilities) VALUES (?, ?)')
            ->execute(['user', json_encode($caps)]);
    }

    public function testMeNeverReturnsAPackageDefaultKey(): void
    {
        $out = (new PackageController($this->db, []))->me(['user_id' => 7]);

        $this->assertTrue($out['success']);
        $this->assertStringNotContainsString('default_api_key', json_encode($out));
        $this->assertStringNotContainsString('jev-pkg-key', json_encode($out));
        $this->assertStringNotContainsString('sk-claude-pkg', json_encode($out));

        $providers = $out['capabilities']['providers'];
        $this->assertSame(['enabled' => true, 'default_model' => 'claude-sonnet-4-5'], $providers['claude']);
        $this->assertSame(['enabled' => true, 'default_model' => null], $providers['jev']);
        $this->assertSame(['enabled' => false, 'default_model' => 'kimi-k2'], $providers['kimi']);
        $this->assertSame(1000, $out['capabilities']['quota_tokens']);
    }

    public function testAdminGetStillReturnsTheKeys(): void
    {
        $this->db->exec("INSERT INTO users (id, role) VALUES (1, 'admin')");
        $out = (new PackageController($this->db, []))->adminGet(['user_id' => 1], 'user');
        $this->assertStringContainsString('jev-pkg-key', json_encode($out));
    }
}
