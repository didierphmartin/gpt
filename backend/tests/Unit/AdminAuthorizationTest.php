<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AdminController;
use Quantis\AIPortfolioAssistant\Controllers\VideoEditorController;
use PDO;

/**
 * Every /api/v1/admin/* endpoint must refuse a caller who is not an admin.
 *
 * The JWT carries only `sub` — no role — so `AuthMiddleware` establishes WHO
 * the caller is and nothing more. Authorization is therefore entirely the
 * controller's job, and for a long time AdminController did not do it: any
 * authenticated user could list every account, read another user's provider
 * keys, or POST /admin/users with {"role":"admin"} and hand themselves the
 * admin role. No forgery was involved — signature checking, algorithm pinning
 * and expiry all work correctly; the token was simply never asked what it was
 * allowed to do.
 *
 * These tests use an in-memory SQLite database with just the `users` columns
 * the guard reads. They assert the REFUSAL, which returns before any
 * MySQL-specific query runs, so they stay honest without a real database.
 */
class AdminAuthorizationTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec(
            'CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT,
                password TEXT,
                first_name TEXT,
                last_name TEXT,
                role TEXT,
                plan TEXT,
                provider TEXT,
                app_key_prefix TEXT,
                app_key_created_at TEXT,
                created_at TEXT,
                updated_at TEXT
            )'
        );
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (1, 'admin@test', 'admin')");
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (2, 'plain@test', 'user')");
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (3, 'guest@test', 'guest')");
    }

    private function admin(): AdminController
    {
        return new AdminController($this->db, []);
    }

    /** Endpoints that must refuse a non-admin, as method => request body. */
    public static function adminEndpoints(): array
    {
        return [
            'listUsers'             => ['listUsers', []],
            'getUsageStats'         => ['getUsageStats', []],
            'getUsageByUser'        => ['getUsageByUser', []],
            'getUsageTransactions'  => ['getUsageTransactions', []],
            'getToolStats'          => ['getToolStats', []],
            'listMCPServers'        => ['listMCPServers', []],
            'getCosts'              => ['getCosts', []],
            'getExchangeRates'      => ['getExchangeRates', []],
            'createUser'            => ['createUser', ['email' => 'x@y.z', 'password' => 'pw', 'role' => 'admin']],
            'updateUser'            => ['updateUser', ['user_id' => 1, 'role' => 'admin']],
            'saveApiKeys'           => ['saveApiKeys', ['user_id' => 1, 'keys' => []]],
            'saveProvider'          => ['saveProvider', ['provider_key' => 'claude']],
            'createMCPServer'       => ['createMCPServer', ['name' => 'x', 'url' => 'http://x']],
        ];
    }

    /**
     * @dataProvider adminEndpoints
     */
    public function testPlainUserIsRefused(string $method, array $body): void
    {
        $result = $this->admin()->$method(['user_id' => 2, 'body' => $body, 'query' => []]);

        $this->assertSame(
            403,
            $result['status_code'] ?? null,
            "AdminController::{$method}() let a role='user' caller through"
        );
        $this->assertFalse($result['success'] ?? true);
    }

    /**
     * @dataProvider adminEndpoints
     */
    public function testUnauthenticatedCallerIsRefused(string $method, array $body): void
    {
        $result = $this->admin()->$method(['user_id' => null, 'body' => $body, 'query' => []]);

        $this->assertSame(
            401,
            $result['status_code'] ?? null,
            "AdminController::{$method}() accepted a request with no user_id"
        );
    }

    /**
     * The escalation that made this concrete: a plain user creating an admin.
     * Asserted separately from the data provider because the consequence — not
     * the status code — is the point.
     */
    public function testPlainUserCannotCreateAnAdminAccount(): void
    {
        $before = (int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn();

        $this->admin()->createUser([
            'user_id' => 2,
            'body' => ['email' => 'escalated@test', 'password' => 'pw', 'role' => 'admin'],
            'query' => [],
        ]);

        $this->assertSame(
            $before,
            (int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn(),
            'a non-admin created a user row'
        );
        $this->assertSame(
            0,
            (int) $this->db->query("SELECT COUNT(*) FROM users WHERE email = 'escalated@test'")->fetchColumn(),
            'a non-admin granted themselves the admin role'
        );
    }

    /** A role that is neither admin nor user must not slip through either. */
    public function testGuestIsRefused(): void
    {
        $result = $this->admin()->listUsers(['user_id' => 3, 'body' => [], 'query' => []]);
        $this->assertSame(403, $result['status_code'] ?? null);
    }

    /** A token whose subject no longer exists must be refused, not trusted. */
    public function testDeletedUserIsRefused(): void
    {
        $result = $this->admin()->listUsers(['user_id' => 999, 'body' => [], 'query' => []]);
        $this->assertSame(
            403,
            $result['status_code'] ?? null,
            'a JWT for a deleted user was accepted'
        );
    }

    /** An admin must NOT be refused — the guard has to let the right people in. */
    public function testAdminIsNotRefused(): void
    {
        $result = $this->admin()->listUsers(['user_id' => 1, 'body' => [], 'query' => []]);
        $this->assertNotSame(403, $result['status_code'] ?? null, 'the guard locked out a real admin');
        $this->assertNotSame(401, $result['status_code'] ?? null);
    }

    /** The same gap existed on five video-editor admin routes. */
    public function testVideoEditorAdminRoutesRefusePlainUser(): void
    {
        $c = new VideoEditorController($this->db, []);
        foreach (['getUsageStats', 'getUsageSummary', 'getUsageByUser', 'getPrices'] as $method) {
            $result = $c->$method(['user_id' => 2, 'body' => [], 'query' => []]);
            $this->assertSame(
                403,
                $result['status_code'] ?? null,
                "VideoEditorController::{$method}() let a role='user' caller through"
            );
        }
    }
}
