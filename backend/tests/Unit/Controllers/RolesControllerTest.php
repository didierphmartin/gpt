<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\RolesController;

class RolesControllerTest extends TestCase
{
    private PDO $db;
    private RolesController $c;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT, updated_by INTEGER)');
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, role TEXT, kind TEXT DEFAULT 'person')");
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (1, 'admin@x.test', 'admin'), (2, 'u@x.test', 'user')");
        $this->db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', NULL, 1, '{\"providers\":{},\"sidebar\":{}}'), ('admin', NULL, 1, '{}')");
        $this->c = new RolesController($this->db, []);
    }

    private function req(int $uid, array $body = [], ?string $role = null): array
    {
        return ['user_id' => $uid, 'body' => $body, 'params' => $role === null ? [] : ['role' => $role]];
    }

    public function testNonAdminIsRefusedEverywhere(): void
    {
        foreach ([
            fn() => $this->c->index($this->req(2)),
            fn() => $this->c->create($this->req(2, ['role' => 'x', 'name' => 'X'])),
            fn() => $this->c->rename($this->req(2, ['name' => 'X'], 'user')),
            fn() => $this->c->destroy($this->req(2, [], 'user')),
        ] as $call) {
            $out = $call();
            $this->assertFalse($out['success']);
            $this->assertSame(403, $out['status_code']);
        }
    }

    public function testAdminFlowWithDigitsAndDashes(): void
    {
        $out = $this->c->create($this->req(1, ['role' => 'it-ops-2', 'name' => 'IT Ops', 'copy_from' => 'user']));
        $this->assertTrue($out['success']);
        $this->assertSame('it-ops-2', $out['data']['role']);

        $keys = array_column($this->c->index($this->req(1))['data'], 'role');
        $this->assertContains('it-ops-2', $keys);

        $out = $this->c->rename($this->req(1, ['name' => 'Ops Two'], 'it-ops-2'));
        $this->assertSame('Ops Two', $out['data']['name']);

        $out = $this->c->create($this->req(1, ['role' => '2024', 'name' => 'Numeric']));
        $this->assertTrue($out['success']);
        $this->assertTrue($this->c->destroy($this->req(1, [], '2024'))['success']);

        $out = $this->c->destroy($this->req(1, [], 'it-ops-2'));
        $this->assertTrue($out['success']);
    }

    public function testErrorsCarryKindAndStatus(): void
    {
        $out = $this->c->create($this->req(1, ['role' => 'Bad Key', 'name' => 'x']));
        $this->assertSame([false, 'invalid_key', 422], [$out['success'], $out['kind'], $out['status_code']]);
        $out = $this->c->destroy($this->req(1, [], 'user'));
        $this->assertSame(409, $out['status_code']);
    }
}
