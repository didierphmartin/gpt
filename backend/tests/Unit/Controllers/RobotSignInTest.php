<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use Firebase\JWT\JWT;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AdminController;
use Quantis\AIPortfolioAssistant\Controllers\AuthController;
use Quantis\AIPortfolioAssistant\Controllers\WebAuthnController;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;

/** The robot (users.kind = 'service') is never a person: no token, no app key, not editable. */
class RobotSignInTest extends TestCase
{
    private const SECRET = 'test-secret-0123456789-0123456789';
    private const LOGIN_SECRET = 'login-secret-0123456789-0123456789';

    private PDO $db;
    private int $robotId;

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
        $this->db->exec('CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, credential_id TEXT)');
        $this->db->exec("INSERT INTO users (id, email, role, plan) VALUES (1, 'boss@x.test', 'admin', 'premium')");
        $this->robotId = RobotAccount::ensure($this->db);
    }

    private function auth(array $extra = []): AuthController
    {
        $config = ['auth' => ['jwt_secret' => self::SECRET, 'login_jwt_secret' => self::LOGIN_SECRET],
            'login_db' => []] + $extra;
        return new class ($this->db, $config) extends AuthController {
            public array $claims = [];
            protected function verifyFirebaseIdToken(string $idToken): ?array
            {
                return $this->claims ?: null;
            }
            protected function loginDbConnection(array $ld): PDO
            {
                $p = new PDO('sqlite::memory:');
                $p->exec('CREATE TABLE users (id INTEGER, email TEXT, email_verified INTEGER)');
                $p->exec("INSERT INTO users VALUES (1, 'robot@synergyai.invalid', 1)");
                return $p;
            }
        };
    }

    private function rowCount(): int
    {
        return (int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn();
    }

    public function test_password_login_as_robot_is_the_unknown_account_answer(): void
    {
        $r = $this->auth()->login(['body' => ['email' => RobotAccount::EMAIL, 'password' => 'anything']]);
        $this->assertSame(401, $r['status_code']);
        $this->assertSame('Invalid email or password', $r['message']);
        $this->assertArrayNotHasKey('data', $r);
    }

    public function test_sso_exchange_for_robot_answers_like_no_account(): void
    {
        $tok = JWT::encode(['iss' => 'login-service', 'type' => 'access', 'sub' => 1, 'iat' => time(), 'exp' => time() + 60], self::LOGIN_SECRET, 'HS256');
        $r = $this->auth()->ssoExchange(['body' => ['login_token' => $tok]]);
        $this->assertSame(403, $r['status_code']);
        $this->assertStringStartsWith('No account for robot@synergyai.invalid', $r['message']);
        $this->assertArrayNotHasKey('data', $r);
    }

    public function test_firebase_for_robot_is_refused_and_touches_nothing(): void
    {
        $c = $this->auth();
        $c->claims = ['sub' => 'uid-1', 'email' => RobotAccount::EMAIL];
        $r = $c->firebaseAuth(['body' => ['idToken' => 'x', 'provider' => 'google', 'plan' => 'premium']]);
        $this->assertSame(401, $r['status_code']);
        $this->assertArrayNotHasKey('data', $r);
        $row = $this->db->query("SELECT * FROM users WHERE kind = 'service'")->fetch();
        $this->assertNull($row['firebase_uid']);
        $this->assertNull($row['last_login']);
        $this->assertSame('robot', $row['role']);
        $this->assertSame(2, $this->rowCount());
    }

    public function test_webauthn_for_robot_gives_no_token(): void
    {
        $this->db->exec("INSERT INTO webauthn_credentials (user_id, credential_id) VALUES ({$this->robotId}, 'cred-r')");
        $w = new WebAuthnController($this->db, ['auth' => ['jwt_secret' => self::SECRET]]);
        $r = $w->authenticate(['body' => ['credential_id' => 'cred-r', 'signature' => 's', 'authenticator_data' => 'a', 'client_data_json' => 'c']]);
        $this->assertSame('PASSKEY_SIGNIN_OFF', $r['code']);
        $this->assertArrayNotHasKey('token', $r);
    }

    public function test_paid_plan_resign_in_keeps_custom_and_user_roles_but_promotes_prospect(): void
    {
        $this->db->exec("INSERT INTO users (email, role, plan) VALUES
            ('ops@x.test', 'it-ops-2', 'free'), ('u@x.test', 'user', 'free'), ('p@x.test', 'prospect', 'free'), ('g@x.test', 'guest', 'free')");
        $expect = ['ops@x.test' => 'it-ops-2', 'u@x.test' => 'user', 'p@x.test' => 'user', 'g@x.test' => 'user'];
        foreach ($expect as $email => $role) {
            $c = $this->auth();
            $c->claims = ['sub' => 'uid-' . $email, 'email' => $email, 'email_verified' => true];
            $r = $c->firebaseAuth(['body' => ['idToken' => 'x', 'provider' => 'google', 'plan' => 'premium']]);
            $this->assertTrue($r['success'], $email);
            $got = $this->db->query("SELECT role, plan FROM users WHERE email = '$email'")->fetch();
            $this->assertSame($role, $got['role'], $email);
            $this->assertSame('premium', $got['plan'], $email);
        }
    }

    public function test_upgrade_plan_promotes_only_guest_and_prospect(): void
    {
        $this->db->exec("INSERT INTO users (email, role, plan) VALUES
            ('ops@x.test', 'it-ops-2', 'free'), ('u@x.test', 'user', 'free'), ('p@x.test', 'prospect', 'free'),
            ('g@x.test', 'guest', 'free'), ('a@x.test', 'admin', 'free'), ('af@x.test', 'affiliate', 'free')");
        $expect = ['ops@x.test' => 'it-ops-2', 'u@x.test' => 'user', 'p@x.test' => 'user', 'g@x.test' => 'user',
            'a@x.test' => 'admin', 'af@x.test' => 'affiliate'];
        foreach ($expect as $email => $role) {
            $id = (int) $this->db->query("SELECT id FROM users WHERE email = '$email'")->fetchColumn();
            $r = $this->auth()->upgradePlan(['user_id' => $id, 'body' => ['plan' => 'standard']]);
            $this->assertTrue($r['success'], $email);
            $this->assertSame($role, $r['role'], $email);
            $got = $this->db->query("SELECT role, plan FROM users WHERE id = $id")->fetch();
            $this->assertSame($role, $got['role'], $email);
            $this->assertSame('standard', $got['plan'], $email);
        }
    }

    public function test_admin_users_api_refuses_the_robot_role_for_a_person(): void
    {
        $this->db->exec("INSERT INTO users (id, email, role, plan) VALUES (5, 'ada@x.test', 'user', 'free')");
        $a = new AdminController($this->db, []);
        foreach ([
            $a->createUser(['user_id' => 1, 'body' => ['email' => 'new@x.test', 'password' => 'pw', 'role' => 'robot']]),
            $a->updateUser(['user_id' => 1, 'body' => ['user_id' => 5, 'email' => 'ada@x.test', 'role' => 'robot']]),
        ] as $r) {
            $this->assertSame(400, $r['status_code']);
            $this->assertSame("The robot role can't be given to a person", $r['error']);
        }
        $this->assertSame('user', $this->db->query('SELECT role FROM users WHERE id = 5')->fetchColumn());
        $this->assertFalse($this->db->query("SELECT id FROM users WHERE email = 'new@x.test'")->fetchColumn());
    }

    public function test_no_personal_app_key_for_the_robot(): void
    {
        $r = $this->auth()->generateAppKey(['user_id' => $this->robotId, 'auth_type' => 'jwt']);
        $this->assertFalse($r['success']);
        $r = $this->auth()->adminGenerateAppKeyForUser(['user_id' => 1, 'auth_type' => 'jwt', 'body' => ['user_id' => $this->robotId]]);
        $this->assertSame(404, $r['status_code']);
        $this->assertSame('User not found', $r['message']);
        $this->assertNull($this->db->query("SELECT app_key_hash FROM users WHERE id = {$this->robotId}")->fetchColumn());
        // A person still gets one.
        $this->assertTrue($this->auth()->adminGenerateAppKeyForUser(['user_id' => 1, 'auth_type' => 'jwt', 'body' => ['user_id' => 1]])['success']);
    }

    public function test_admin_never_sees_or_edits_the_robot(): void
    {
        $a = new AdminController($this->db, []);
        $req = ['user_id' => 1];
        $ids = array_column($a->listUsers($req)['users'], 'id');
        $this->assertSame([1], array_map('intval', $ids));
        foreach ([
            $a->getUser($req, $this->robotId),
            $a->getUserAccount($req, $this->robotId),
            $a->updateUser($req + ['body' => ['user_id' => $this->robotId, 'email' => 'x@x.test', 'role' => 'user']]),
            $a->deleteUser($req, $this->robotId),
        ] as $r) {
            $this->assertSame(404, $r['status_code']);
            $this->assertSame('User not found', $r['error']);
        }
        $this->assertSame(2, $this->rowCount());
        $this->assertSame(RobotAccount::EMAIL, $this->db->query("SELECT email FROM users WHERE id = {$this->robotId}")->fetchColumn());
    }
}
