<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\SetupController;
use Quantis\AIPortfolioAssistant\Services\LoginAccounts;

class SetupControllerTest extends TestCase
{
    private PDO $gpt;
    private PDO $login;

    protected function setUp(): void
    {
        $this->gpt = new PDO('sqlite::memory:');
        $this->gpt->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->gpt->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->gpt->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE,
            password TEXT, first_name TEXT, last_name TEXT, role TEXT, plan TEXT, provider TEXT,
            email_verified INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)');

        $this->login = new PDO('sqlite::memory:');
        $this->login->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->login->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->login->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE,
            password TEXT, first_name TEXT, last_name TEXT, provider TEXT,
            email_verified INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)');
    }

    private function controller(string $edition = 'corporate'): SetupController
    {
        return new SetupController($this->gpt, ['edition' => $edition], new LoginAccounts($this->login));
    }

    private function create(array $body, string $edition = 'corporate'): array
    {
        return $this->controller($edition)->createAdmin(['body' => $body]);
    }

    public function test_status_needs_setup_only_on_corporate_without_admin(): void
    {
        $this->assertTrue($this->controller()->status([])['needs_setup']);
        $this->assertFalse($this->controller('individual')->status([])['needs_setup']);
        $this->assertFalse($this->controller('')->status([])['needs_setup']);
        $this->assertSame('corporate', $this->controller()->status([])['edition']);
    }

    public function test_create_admin_writes_both_databases(): void
    {
        $r = $this->create(['email' => 'boss@corp.test', 'password' => 'correct-horse-1']);
        $this->assertTrue($r['success']);
        $this->assertSame(201, $r['status_code']);

        $g = $this->gpt->query("SELECT * FROM users WHERE email = 'boss@corp.test'")->fetch();
        $this->assertSame('admin', $g['role']);
        $this->assertNull($g['password'], 'gpt must not hold a password: the login service is the only credential store');
        $this->assertSame(1, (int) $g['email_verified']);

        $l = $this->login->query("SELECT * FROM users WHERE email = 'boss@corp.test'")->fetch();
        $this->assertTrue(password_verify('correct-horse-1', $l['password']));
        $this->assertSame(1, (int) $l['email_verified']);

        $this->assertFalse($this->controller()->status([])['needs_setup']);
    }

    public function test_second_setup_is_refused(): void
    {
        $this->create(['email' => 'boss@corp.test', 'password' => 'correct-horse-1']);
        $r = $this->create(['email' => 'intruder@corp.test', 'password' => 'another-pass-2']);
        $this->assertSame(409, $r['status_code']);
        $this->assertSame(0, (int) $this->login->query("SELECT COUNT(*) FROM users WHERE email = 'intruder@corp.test'")->fetchColumn());
    }

    public function test_setup_rejects_bad_input(): void
    {
        $this->assertSame(400, $this->create(['email' => 'not-an-email', 'password' => 'correct-horse-1'])['status_code']);
        $this->assertSame(400, $this->create(['email' => 'boss@corp.test', 'password' => 'short'])['status_code']);
        $this->assertTrue($this->controller()->status([])['needs_setup']);
    }

    public function test_setup_is_not_available_outside_corporate(): void
    {
        $this->assertSame(404, $this->create(['email' => 'boss@corp.test', 'password' => 'correct-horse-1'], 'individual')['status_code']);
    }

    public function test_setup_normalises_email_in_both_databases(): void
    {
        $this->create(['email' => '  Boss@Corp.TEST ', 'password' => 'correct-horse-1']);
        $this->assertSame(1, (int) $this->gpt->query("SELECT COUNT(*) FROM users WHERE email = 'boss@corp.test'")->fetchColumn());
        $this->assertSame(1, (int) $this->login->query("SELECT COUNT(*) FROM users WHERE email = 'boss@corp.test'")->fetchColumn());
    }

    public function test_setup_retry_after_partial_failure_uses_new_password(): void
    {
        // A previous attempt wrote the login row, then failed before the gpt row.
        $this->login->exec("INSERT INTO users (email, password, email_verified) VALUES ('boss@corp.test', '"
            . password_hash('first-attempt-1', PASSWORD_BCRYPT) . "', 0)");

        $r = $this->create(['email' => 'boss@corp.test', 'password' => 'second-attempt-2']);
        $this->assertTrue($r['success']);
        $l = $this->login->query("SELECT * FROM users WHERE email = 'boss@corp.test'")->fetch();
        $this->assertTrue(password_verify('second-attempt-2', $l['password']));
        $this->assertSame(1, (int) $l['email_verified']);
    }

    public function test_setup_is_refused_once_any_gpt_user_exists_even_without_an_admin(): void
    {
        // The only admin demoted themselves: a regular account remains. Setup must
        // not reopen, or anyone could overwrite that account's login password.
        $this->gpt->exec("INSERT INTO users (email, role) VALUES ('ann@corp.test', 'user')");
        $this->login->exec("INSERT INTO users (email, password, email_verified) VALUES ('ann@corp.test', '"
            . password_hash('ann-password-1', PASSWORD_BCRYPT) . "', 1)");

        $this->assertFalse($this->controller()->status([])['needs_setup']);
        $r = $this->create(['email' => 'ann@corp.test', 'password' => 'takeover-pass-2']);
        $this->assertSame(409, $r['status_code']);

        $l = $this->login->query("SELECT * FROM users WHERE email = 'ann@corp.test'")->fetch();
        $this->assertTrue(password_verify('ann-password-1', $l['password']));
        $g = $this->gpt->query("SELECT role FROM users WHERE email = 'ann@corp.test'")->fetchColumn();
        $this->assertSame('user', $g);
    }

    public function test_busy_lock_is_503_without_writing_or_releasing(): void
    {
        $c = new class ($this->gpt, ['edition' => 'corporate'], new LoginAccounts($this->login)) extends SetupController {
            public int $unlocks = 0;
            protected function lock(): bool
            {
                return false;
            }
            protected function unlock(): void
            {
                $this->unlocks++;
            }
        };

        $r = $c->createAdmin(['body' => ['email' => 'boss@corp.test', 'password' => 'correct-horse-1']]);

        $this->assertSame(503, $r['status_code']);
        $this->assertSame('Setup is busy, please try again', $r['message']);
        $this->assertSame(0, $c->unlocks, 'a lock that was not acquired must not be released');
        $this->assertSame(0, (int) $this->gpt->query('SELECT COUNT(*) FROM users')->fetchColumn());
        $this->assertSame(0, (int) $this->login->query('SELECT COUNT(*) FROM users')->fetchColumn());
    }

    public function test_missing_login_database_is_503(): void
    {
        $r = (new SetupController($this->gpt, ['edition' => 'corporate'], null))
            ->createAdmin(['body' => ['email' => 'boss@corp.test', 'password' => 'correct-horse-1']]);
        $this->assertSame(503, $r['status_code']);
        $this->assertTrue($this->controller()->status([])['needs_setup']);
    }
}
