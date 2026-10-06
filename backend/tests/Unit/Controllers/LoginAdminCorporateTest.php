<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\LoginAdminController;

/**
 * On a corporate install AdminController is the only writer of the login
 * database (it keeps the gpt and login rows in step). The Login card's write
 * routes must refuse there, before touching any database.
 */
class LoginAdminCorporateTest extends TestCase
{
    private const REFUSAL = 'Manage accounts from the Users screen on this installation';

    /** No tables at all: any query would throw, so a refusal proves no DB access. */
    private function bareDb(): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        return $db;
    }

    private function adminDb(): PDO
    {
        $db = $this->bareDb();
        $db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)');
        $db->exec("INSERT INTO users (id, email, role) VALUES (1, 'boss@corp.test', 'admin')");
        return $db;
    }

    public static function writeRoutes(): array
    {
        return [
            'createUser' => ['createUser', ['email' => 'ann@corp.test']],
            'updateUser' => ['updateUser', ['id' => 2, 'first_name' => 'Ann']],
            'deleteUser' => ['deleteUser', ['id' => 2]],
            'setAppUserRole' => ['setAppUserRole', ['app' => 'gpt', 'user_id' => 2, 'role' => 'user']],
            'addAppMember' => ['addAppMember', ['app' => 'gpt', 'email' => 'ann@corp.test', 'role' => 'user']],
        ];
    }

    /** @dataProvider writeRoutes */
    public function test_write_routes_are_refused_on_corporate_before_any_db_access(string $method, array $body): void
    {
        $c = new LoginAdminController($this->bareDb(), ['edition' => 'corporate']);

        $r = $c->$method(['user_id' => 1, 'body' => $body]);

        $this->assertFalse($r['success']);
        $this->assertSame(403, $r['status_code']);
        $this->assertSame(self::REFUSAL, $r['error']);
    }

    /** @dataProvider writeRoutes */
    public function test_write_routes_are_not_refused_outside_corporate(string $method, array $body): void
    {
        foreach (['individual', ''] as $edition) {
            $c = new LoginAdminController($this->adminDb(), ['edition' => $edition]);

            $r = $c->$method(['user_id' => 1, 'body' => $body]);

            // No login_database configured: the call gets past the edition gate
            // and the admin check, and stops at the login connection.
            $this->assertNotSame(self::REFUSAL, $r['error'] ?? null);
            $this->assertSame('Login DB not reachable', $r['message'] ?? null);
        }
    }

    public function test_reads_stay_allowed_on_corporate(): void
    {
        $c = new LoginAdminController($this->adminDb(), ['edition' => 'corporate']);

        $r = $c->getUsers(['user_id' => 1, 'query' => []]);

        $this->assertNotSame(403, $r['status_code'] ?? null);
        $this->assertFalse($r['available']);
    }
}
