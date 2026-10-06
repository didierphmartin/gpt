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
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, kind TEXT DEFAULT "person")');
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT)');
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
        $out = (new PackageController($this->db, []))->adminGet(['user_id' => 1, 'params' => ['role' => 'user']], 'user');
        $this->assertStringContainsString('jev-pkg-key', json_encode($out));
    }

    public function testACustomRolesUserGetsThatRowsCapabilities(): void
    {
        $this->db->exec("INSERT INTO users (id, role) VALUES (8, 'it-ops-2')");
        $this->db->prepare('INSERT INTO packages (role, name, capabilities) VALUES (?, ?, ?)')
            ->execute(['it-ops-2', 'IT Ops', json_encode(['providers' => [], 'sidebar' => [], 'quota_tokens' => 42])]);
        $out = (new PackageController($this->db, []))->me(['user_id' => 8]);
        $this->assertSame('it-ops-2', $out['role']);
        $this->assertSame(42, $out['capabilities']['quota_tokens']);
    }

    public function testARoleWithoutARowResolvesToGuest(): void
    {
        $this->db->exec("INSERT INTO users (id, role) VALUES (9, 'affiliate')");
        $this->db->prepare('INSERT INTO packages (role, capabilities) VALUES (?, ?)')
            ->execute(['guest', json_encode(['providers' => [], 'sidebar' => [], 'quota_tokens' => 7])]);
        $out = (new PackageController($this->db, []))->me(['user_id' => 9]);
        $this->assertSame('guest', $out['role']);
        $this->assertSame(7, $out['capabilities']['quota_tokens']);
    }

    public function testAdminListAndGetCarryNameAndBuiltin(): void
    {
        $this->db->exec("INSERT INTO users (id, role) VALUES (1, 'admin')");
        $this->db->prepare('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)')
            ->execute(['it-ops-2', 'IT Ops', '{}']);
        $c = new PackageController($this->db, []);
        $list = $c->adminList(['user_id' => 1])['packages'];
        $byRole = array_column($list, null, 'role');
        $this->assertSame('IT Ops', $byRole['it-ops-2']['name']);
        $this->assertFalse($byRole['it-ops-2']['builtin']);
        $this->assertSame('User', $byRole['user']['name']);
        $got = $c->adminGet(['user_id' => 1, 'params' => ['role' => 'it-ops-2']]);
        $this->assertSame('IT Ops', $got['package']['name']);
        $this->assertSame(400, $c->adminGet(['user_id' => 1, 'params' => ['role' => 'nope']])['status_code']);
    }
}
