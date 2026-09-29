<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AdminController;
use Quantis\AIPortfolioAssistant\Services\LoginAccounts;

class AdminCorporateAccountsTest extends TestCase
{
    private PDO $gpt;
    private PDO $login;

    protected function setUp(): void
    {
        $now = fn () => date('Y-m-d H:i:s');
        $this->gpt = new PDO('sqlite::memory:');
        $this->gpt->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->gpt->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->gpt->sqliteCreateFunction('NOW', $now, 0);
        $this->gpt->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE,
            password TEXT, first_name TEXT, last_name TEXT, role TEXT, plan TEXT, provider TEXT,
            email_verified INTEGER DEFAULT 0, app_key_prefix TEXT, app_key_created_at TEXT,
            created_at TEXT, updated_at TEXT)');
        $this->gpt->exec("INSERT INTO users (id, email, role) VALUES (1, 'boss@corp.test', 'admin')");

        $this->login = new PDO('sqlite::memory:');
        $this->login->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->login->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->login->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE,
            password TEXT, first_name TEXT, last_name TEXT, provider TEXT,
            email_verified INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)');
    }

    private function admin(string $edition = 'corporate'): AdminController
    {
        return new AdminController($this->gpt, ['edition' => $edition], new LoginAccounts($this->login));
    }

    private function asAdmin(array $body): array
    {
        return ['user_id' => 1, 'body' => $body];
    }

    private function loginRow(string $email): array|false
    {
        $s = $this->login->prepare('SELECT * FROM users WHERE email = ?');
        $s->execute([$email]);
        return $s->fetch();
    }

    public function test_create_user_creates_verified_login_account(): void
    {
        $r = $this->admin()->createUser($this->asAdmin(['email' => 'Ann@Corp.test', 'password' => 'ann-password-1', 'role' => 'user']));
        $this->assertTrue($r['success']);
        $row = $this->loginRow('ann@corp.test');
        $this->assertNotFalse($row);
        $this->assertTrue(password_verify('ann-password-1', $row['password']));
        $this->assertSame(1, (int) $row['email_verified']);
        $g = $this->gpt->query("SELECT * FROM users WHERE email = 'ann@corp.test'")->fetch();
        $this->assertNull($g['password']);
    }

    public function test_update_password_changes_login_password(): void
    {
        $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1']));
        $id = (int) $this->gpt->query("SELECT id FROM users WHERE email = 'ann@corp.test'")->fetchColumn();
        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => $id, 'email' => 'ann@corp.test', 'password' => 'new-password-2']));
        $this->assertTrue($r['success']);
        $row = $this->loginRow('ann@corp.test');
        $this->assertTrue(password_verify('new-password-2', $row['password']));
        $this->assertFalse(password_verify('ann-password-1', $row['password']));
    }

    public function test_email_change_is_refused_on_corporate(): void
    {
        $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1']));
        $id = (int) $this->gpt->query("SELECT id FROM users WHERE email = 'ann@corp.test'")->fetchColumn();
        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => $id, 'email' => 'other@corp.test']));
        $this->assertSame(400, $r['status_code']);
    }

    public function test_delete_user_deletes_login_account(): void
    {
        $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1']));
        $id = (int) $this->gpt->query("SELECT id FROM users WHERE email = 'ann@corp.test'")->fetchColumn();
        $this->admin()->deleteUser($this->asAdmin([]), $id);
        $this->assertFalse($this->loginRow('ann@corp.test'));
    }

    public function test_individual_edition_does_not_touch_login_database(): void
    {
        $this->admin('individual')->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1']));
        $this->assertFalse($this->loginRow('ann@corp.test'));
        $g = $this->gpt->query("SELECT * FROM users WHERE email = 'ann@corp.test'")->fetch();
        $this->assertNotNull($g['password']);
    }

    public function test_duplicate_email_create_returns_409_and_preserves_existing_login_password(): void
    {
        $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1']));

        $r = $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'different-password-2']));

        $this->assertFalse($r['success']);
        $this->assertSame(409, $r['status_code']);
        $row = $this->loginRow('ann@corp.test');
        $this->assertTrue(password_verify('ann-password-1', $row['password']));
        $this->assertFalse(password_verify('different-password-2', $row['password']));
    }

    public function test_gpt_insert_failure_rolls_back_newly_created_login_row(): void
    {
        $now = fn () => date('Y-m-d H:i:s');
        $broken = new PDO('sqlite::memory:');
        $broken->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $broken->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $broken->sqliteCreateFunction('NOW', $now, 0);
        // Full schema (requireAdmin's `role` lookup and the createUser() column
        // list both need it), plus a trigger that aborts every INSERT so the
        // gpt write fails at execute() time, after the login row already exists.
        $broken->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE,
            password TEXT, first_name TEXT, last_name TEXT, role TEXT, plan TEXT, provider TEXT,
            email_verified INTEGER DEFAULT 0, app_key_prefix TEXT, app_key_created_at TEXT,
            created_at TEXT, updated_at TEXT)');
        $broken->exec("INSERT INTO users (id, email, role) VALUES (1, 'boss@corp.test', 'admin')");
        $broken->exec("CREATE TRIGGER forced_insert_failure BEFORE INSERT ON users
            WHEN NEW.id IS NOT 1
            BEGIN SELECT RAISE(ABORT, 'forced failure for rollback test'); END");

        $admin = new AdminController($broken, ['edition' => 'corporate'], new LoginAccounts($this->login));

        $threw = false;
        try {
            $admin->createUser($this->asAdmin(['email' => 'rollback@corp.test', 'password' => 'rollback-password-1']));
        } catch (\Throwable $e) {
            $threw = true;
        }

        $this->assertTrue($threw, 'expected the broken gpt INSERT to raise');
        $this->assertFalse($this->loginRow('rollback@corp.test'));
    }

    public function test_explicit_null_accounts_on_corporate_returns_503(): void
    {
        $admin = new AdminController($this->gpt, ['edition' => 'corporate'], null);

        $r = $admin->createUser($this->asAdmin(['email' => 'noaccounts@corp.test', 'password' => 'no-accounts-pw-1']));

        $this->assertFalse($r['success']);
        $this->assertSame(503, $r['status_code']);
        $this->assertSame('The login service is not configured', $r['error']);
    }

    public function test_deleting_the_last_admin_is_refused(): void
    {
        $r = $this->admin()->deleteUser($this->asAdmin([]), 1);

        $this->assertSame(409, $r['status_code']);
        $this->assertSame('The last administrator cannot be removed or demoted', $r['error']);
        $this->assertSame('admin', $this->gpt->query('SELECT role FROM users WHERE id = 1')->fetchColumn());
    }

    public function test_deleting_the_last_admin_keeps_its_login_account(): void
    {
        $this->login->exec("INSERT INTO users (email, password, email_verified) VALUES ('boss@corp.test', 'x', 1)");

        $this->admin()->deleteUser($this->asAdmin([]), 1);

        $this->assertNotFalse($this->loginRow('boss@corp.test'));
    }

    public function test_demoting_the_last_admin_is_refused(): void
    {
        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => 1, 'email' => 'boss@corp.test', 'role' => 'user']));

        $this->assertSame(409, $r['status_code']);
        $this->assertSame('The last administrator cannot be removed or demoted', $r['error']);
        $this->assertSame('admin', $this->gpt->query('SELECT role FROM users WHERE id = 1')->fetchColumn());
    }

    public function test_updating_the_last_admin_without_changing_role_still_works(): void
    {
        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => 1, 'email' => 'boss@corp.test',
            'first_name' => 'Big', 'role' => 'admin']));
        $this->assertTrue($r['success']);
        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => 1, 'email' => 'boss@corp.test', 'first_name' => 'Bigger']));
        $this->assertTrue($r['success']);
    }

    public function test_a_non_last_admin_can_be_demoted_and_deleted(): void
    {
        $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1', 'role' => 'admin']));
        $this->admin()->createUser($this->asAdmin(['email' => 'bob@corp.test', 'password' => 'bob-password-1', 'role' => 'admin']));
        $ann = (int) $this->gpt->query("SELECT id FROM users WHERE email = 'ann@corp.test'")->fetchColumn();
        $bob = (int) $this->gpt->query("SELECT id FROM users WHERE email = 'bob@corp.test'")->fetchColumn();

        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => $ann, 'email' => 'ann@corp.test', 'role' => 'user']));
        $this->assertTrue($r['success']);
        $this->assertSame('user', $this->gpt->query("SELECT role FROM users WHERE id = $ann")->fetchColumn());

        $r = $this->admin()->deleteUser($this->asAdmin([]), $bob);
        $this->assertTrue($r['success']);
        $this->assertFalse($this->loginRow('bob@corp.test'));
    }

    public function test_update_user_lowercases_email(): void
    {
        $this->admin()->createUser($this->asAdmin(['email' => 'ann@corp.test', 'password' => 'ann-password-1']));
        $id = (int) $this->gpt->query("SELECT id FROM users WHERE email = 'ann@corp.test'")->fetchColumn();

        $r = $this->admin()->updateUser($this->asAdmin(['user_id' => $id, 'email' => 'Ann@Corp.test']));

        $this->assertTrue($r['success']);
        $g = $this->gpt->query("SELECT email FROM users WHERE id = $id")->fetch();
        $this->assertSame('ann@corp.test', $g['email']);
    }
}
