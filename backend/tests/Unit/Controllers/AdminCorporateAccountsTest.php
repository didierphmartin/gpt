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
}
