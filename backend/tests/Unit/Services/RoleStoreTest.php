<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\RoleStore;
use Quantis\AIPortfolioAssistant\Services\RoleStoreError;

class RoleStoreTest extends TestCase
{
    private PDO $db;
    private RoleStore $store;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT, updated_by INTEGER)');
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, role TEXT, kind TEXT DEFAULT 'person')");
        foreach (['guest', 'prospect', 'user', 'admin'] as $r) {
            $caps = json_encode(['providers' => [], 'sidebar' => [], 'quota_tokens' => $r === 'user' ? 500 : null]);
            $this->db->prepare('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 1, ?)')
                ->execute([$r, null, $caps]);
        }
        $this->store = new RoleStore($this->db);
    }

    private function refusal(callable $fn): RoleStoreError
    {
        try {
            $fn();
        } catch (RoleStoreError $e) {
            return $e;
        }
        $this->fail('expected a RoleStoreError');
    }

    public function testCreateCopiesAnotherRolesCapabilities(): void
    {
        $row = $this->store->create('it-ops-2', 'IT Ops', 'user');
        $this->assertSame('it-ops-2', $row['role']);
        $this->assertSame('IT Ops', $row['name']);
        $this->assertFalse($row['builtin']);
        $this->assertSame($this->store->get('user')['capabilities'], $row['capabilities']);
        $this->assertTrue($this->store->exists('it-ops-2'));
    }

    public function testInvalidKeyIs422(): void
    {
        $e = $this->refusal(fn() => $this->store->create('IT Ops', 'IT Ops', null));
        $this->assertSame(['invalid_key', 422], [$e->kind, $e->status]);
        $e = $this->refusal(fn() => $this->store->create(str_repeat('a', 65), 'x', null));
        $this->assertSame('invalid_key', $e->kind);
    }

    public function testDuplicateIs409(): void
    {
        $e = $this->refusal(fn() => $this->store->create('user', 'Again', null));
        $this->assertSame(['exists', 409], [$e->kind, $e->status]);
    }

    public function testRename(): void
    {
        $this->store->create('ops', 'Ops', null);
        $this->assertSame('Operators', $this->store->rename('ops', 'Operators')['name']);
        $e = $this->refusal(fn() => $this->store->rename('nope', 'X'));
        $this->assertSame(['not_found', 404], [$e->kind, $e->status]);
    }

    public function testBuiltInCannotBeDeleted(): void
    {
        $e = $this->refusal(fn() => $this->store->delete('user'));
        $this->assertSame(['builtin', 409], [$e->kind, $e->status]);
        $this->assertSame("Built-in roles can't be deleted", $e->getMessage());
    }

    public function testDeleteRefusedWhilePersonHoldsIt(): void
    {
        $this->store->create('ops', 'Ops', null);
        $this->db->exec("INSERT INTO users (email, role) VALUES ('ann@x.test', 'ops')");
        $e = $this->refusal(fn() => $this->store->delete('ops'));
        $this->assertSame(['in_use', 409], [$e->kind, $e->status]);
        $this->assertStringContainsString('ann@x.test', $e->getMessage());
    }

    public function testRobotHoldingARoleDoesNotCount(): void
    {
        $this->store->create('ops', 'Ops', null);
        $this->db->exec("INSERT INTO users (email, role, kind) VALUES ('robot@synergyai.invalid', 'ops', 'service')");
        $this->assertSame([], $this->store->usersWith('ops'));
        $this->store->delete('ops');
        $this->assertFalse($this->store->exists('ops'));
    }

    public function testListPutsBuiltInsFirstWithNamesAndUsage(): void
    {
        $this->store->create('ops', 'Ops', null);
        $this->db->exec("INSERT INTO users (email, role) VALUES ('a@x.test', 'user')");
        $rows = $this->store->list();
        $this->assertSame(['guest', 'prospect', 'user', 'admin', 'robot', 'ops'], array_column($rows, 'role'));
        $this->assertSame('User', $rows[2]['name']);
        $this->assertTrue($rows[2]['builtin']);
        $this->assertSame(1, $rows[2]['used_by']);
        $this->assertSame(0, $rows[5]['used_by']);
    }
}
