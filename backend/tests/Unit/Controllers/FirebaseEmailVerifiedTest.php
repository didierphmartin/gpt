<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AuthController;

/** Firebase sign-in reaches an existing account by email only when Firebase verified that email. */
class FirebaseEmailVerifiedTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->sqliteCreateFunction('NOW', fn () => date('Y-m-d H:i:s'), 0);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,
            first_name TEXT, last_name TEXT, role TEXT, plan TEXT DEFAULT 'free', provider TEXT, kind TEXT NOT NULL DEFAULT 'person',
            email_verified INTEGER DEFAULT 0, firebase_uid TEXT, phone TEXT, ledger_user_id TEXT, last_login TEXT,
            app_key_hash TEXT, app_key_prefix TEXT, app_key_created_at TEXT, created_at TEXT, updated_at TEXT)");
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO users (id, email, role, plan, firebase_uid) VALUES
            (1, 'boss@x.test', 'admin', 'premium', NULL), (2, 'own@x.test', 'user', 'free', 'uid-own')");
    }

    private function signIn(array $claims): array
    {
        $c = new class ($this->db, ['auth' => ['jwt_secret' => 'test-secret-0123456789-0123456789']]) extends AuthController {
            public array $claims = [];
            protected function verifyFirebaseIdToken(string $idToken): ?array
            {
                return $this->claims ?: null;
            }
        };
        $c->claims = $claims;
        return $c->firebaseAuth(['body' => ['idToken' => 'x', 'provider' => 'password']]);
    }

    public function test_unverified_email_does_not_reach_an_existing_account(): void
    {
        foreach ([[], ['email_verified' => false]] as $extra) {
            $r = $this->signIn(['sub' => 'uid-attacker', 'email' => 'boss@x.test'] + $extra);
            $this->assertSame('EMAIL_NOT_VERIFIED', $r['code']);
            $this->assertArrayNotHasKey('data', $r);
        }
        $this->assertNull($this->db->query('SELECT firebase_uid FROM users WHERE id = 1')->fetchColumn());
    }

    public function test_verified_email_links_and_signs_in(): void
    {
        $r = $this->signIn(['sub' => 'uid-boss', 'email' => 'boss@x.test', 'email_verified' => true]);
        $this->assertSame(200, $r['status_code']);
        $this->assertSame('uid-boss', $this->db->query('SELECT firebase_uid FROM users WHERE id = 1')->fetchColumn());
    }

    public function test_the_imported_firebase_user_of_the_row_signs_in_unverified(): void
    {
        $r = $this->signIn(['sub' => 'local-1', 'email' => 'boss@x.test']);
        $this->assertSame(200, $r['status_code']);
    }

    public function test_the_accounts_own_firebase_user_signs_in_unverified(): void
    {
        $r = $this->signIn(['sub' => 'uid-own', 'email' => 'own@x.test']);
        $this->assertSame(200, $r['status_code']);
    }
}
