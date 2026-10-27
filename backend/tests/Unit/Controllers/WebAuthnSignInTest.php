<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\WebAuthnController;

/** Passkey sign-in issues a token only for a verified assertion: real keys, real signatures. */
class WebAuthnSignInTest extends TestCase
{
    private const SECRET = 'test-secret-0123456789-0123456789';

    private PDO $db;
    /** @var array<string, \OpenSSLAsymmetricKey> credential id => private key */
    private array $keys = [];

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->sqliteCreateFunction('NOW', fn () => date('Y-m-d H:i:s'), 0);
        $this->db->sqliteCreateFunction('UNIX_TIMESTAMP', fn ($t) => strtotime((string) $t), 1);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
            kind TEXT NOT NULL DEFAULT 'person', role TEXT, plan TEXT, ledger_user_id TEXT, provider TEXT, last_login TEXT, created_at TEXT)");
        $this->db->exec('CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY, user_id INTEGER, credential_id TEXT, public_key TEXT, created_at TEXT)');
        $this->db->exec('CREATE TABLE webauthn_challenges (challenge TEXT PRIMARY KEY, user_id INTEGER NOT NULL, action TEXT, created_at TEXT)');
        $this->db->exec("INSERT INTO users (id, email, first_name, role, plan) VALUES (1, 'ada@x.test', 'Ada', 'user', 'premium')");
        $this->db->exec("INSERT INTO users (id, email, kind, role) VALUES (2, 'robot@x.test', 'service', 'robot')");
        $this->addCredential(1, 'cred-ec', ['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $this->addCredential(1, 'cred-rsa', ['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048]);
        $this->addCredential(2, 'cred-robot', ['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    }

    protected function tearDown(): void
    {
        unset($_SERVER['HTTP_HOST']);
    }

    private static function b64u(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    /** Store the DER SubjectPublicKeyInfo as base64url, as the frontend's getPublicKey() does. */
    private function addCredential(int $userId, string $credId, array $opts): void
    {
        $key = openssl_pkey_new($opts);
        $pem = openssl_pkey_get_details($key)['key'];
        $der = base64_decode(preg_replace('/-----[^-]+-----|\s/', '', $pem));
        $this->db->prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES (?, ?, ?)')
            ->execute([$userId, $credId, self::b64u($der)]);
        $this->keys[$credId] = $key;
    }

    private function controller(array $webauthn = ['rp_id' => 'localhost']): WebAuthnController
    {
        return new WebAuthnController($this->db, ['auth' => ['jwt_secret' => self::SECRET], 'webauthn' => $webauthn]);
    }

    private function challengeFor(string $credId, ?WebAuthnController $w = null): string
    {
        $r = ($w ?? $this->controller())->challenge(['body' => ['action' => 'authenticate', 'credential_id' => $credId]]);
        $this->assertTrue($r['success']);
        return $r['challenge'];
    }

    /** Build and sign an assertion; $o overrides any part. */
    private function assertion(string $credId, string $challenge, array $o = []): array
    {
        $clientData = json_encode([
            'type' => $o['type'] ?? 'webauthn.get',
            'challenge' => $challenge,
            'origin' => $o['origin'] ?? 'http://localhost',
            'crossOrigin' => false,
        ], JSON_UNESCAPED_SLASHES);
        $authData = hash('sha256', $o['rp_id'] ?? 'localhost', true) . chr($o['flags'] ?? 0x05) . pack('N', 1);
        openssl_sign($authData . hash('sha256', $clientData, true), $sig, $o['key'] ?? $this->keys[$credId], OPENSSL_ALGO_SHA256);
        return [
            'credential_id' => $credId,
            'client_data_json' => self::b64u($clientData),
            'authenticator_data' => self::b64u($authData),
            'signature' => self::b64u($o['signature'] ?? $sig),
        ];
    }

    private function signIn(string $credId, array $o = [], ?WebAuthnController $w = null): array
    {
        $w ??= $this->controller();
        return $w->authenticate(['body' => $this->assertion($credId, $this->challengeFor($credId, $w), $o)]);
    }

    private function assertRefused(array $r): void
    {
        $this->assertSame(401, $r['status_code']);
        $this->assertFalse($r['success']);
        $this->assertSame('Passkey sign-in failed', $r['message']);
        $this->assertArrayNotHasKey('token', $r);
    }

    private function challengeCount(): int
    {
        return (int) $this->db->query('SELECT COUNT(*) FROM webauthn_challenges')->fetchColumn();
    }

    public function test_es256_assertion_signs_in(): void
    {
        $r = $this->signIn('cred-ec');
        $this->assertTrue($r['success']);
        $this->assertSame(200, $r['status_code']);
        $this->assertSame(1, JWT::decode($r['token'], new Key(self::SECRET, 'HS256'))->sub);
        $this->assertSame('1', $r['user']['id']);
        $this->assertSame('ada@x.test', $r['user']['email']);
        $this->assertSame('premium', $r['user']['plan']);
        $this->assertNotNull($this->db->query('SELECT last_login FROM users WHERE id = 1')->fetchColumn());
        $this->assertSame(0, $this->challengeCount());
    }

    public function test_rs256_assertion_signs_in(): void
    {
        $r = $this->signIn('cred-rsa');
        $this->assertTrue($r['success']);
        $this->assertSame('1', $r['user']['id']);
    }

    public function test_signature_from_another_key_is_refused(): void
    {
        $this->assertRefused($this->signIn('cred-ec', ['key' => $this->keys['cred-rsa']]));
    }

    public function test_tampered_signature_is_refused(): void
    {
        $this->assertRefused($this->signIn('cred-ec', ['signature' => random_bytes(70)]));
    }

    public function test_challenge_never_issued_is_refused(): void
    {
        $w = $this->controller();
        $this->challengeFor('cred-ec', $w);
        $this->assertRefused($w->authenticate(['body' => $this->assertion('cred-ec', self::b64u(random_bytes(32)))]));
    }

    public function test_challenge_of_another_user_is_refused(): void
    {
        $this->db->exec("INSERT INTO users (id, email) VALUES (3, 'eve@x.test')");
        $this->db->exec("INSERT INTO webauthn_challenges VALUES ('eve-challenge', 3, 'authenticate', '" . date('Y-m-d H:i:s') . "')");
        $this->assertRefused($this->controller()->authenticate(['body' => $this->assertion('cred-ec', 'eve-challenge')]));
        $this->assertSame(0, $this->challengeCount());
    }

    public function test_register_challenge_is_not_a_sign_in_challenge(): void
    {
        $this->db->exec("INSERT INTO webauthn_challenges VALUES ('reg-challenge', 1, 'register', '" . date('Y-m-d H:i:s') . "')");
        $this->assertRefused($this->controller()->authenticate(['body' => $this->assertion('cred-ec', 'reg-challenge')]));
    }

    public function test_challenge_is_single_use(): void
    {
        $w = $this->controller();
        $body = $this->assertion('cred-ec', $this->challengeFor('cred-ec', $w));
        $this->assertTrue($w->authenticate(['body' => $body])['success']);
        $this->assertRefused($w->authenticate(['body' => $body]));
    }

    public function test_failed_attempt_still_consumes_the_challenge(): void
    {
        $w = $this->controller();
        $challenge = $this->challengeFor('cred-ec', $w);
        $this->assertRefused($w->authenticate(['body' => $this->assertion('cred-ec', $challenge, ['origin' => 'https://evil.test'])]));
        $this->assertRefused($w->authenticate(['body' => $this->assertion('cred-ec', $challenge)]));
    }

    public function test_expired_challenge_is_refused(): void
    {
        $this->db->exec("INSERT INTO webauthn_challenges VALUES ('old-challenge', 1, 'authenticate', '" . date('Y-m-d H:i:s', time() - 121) . "')");
        $this->assertRefused($this->controller()->authenticate(['body' => $this->assertion('cred-ec', 'old-challenge')]));
        $this->assertSame(0, $this->challengeCount());
    }

    public function test_wrong_origin_is_refused(): void
    {
        foreach (['https://evil.test', 'http://localhost.evil.test', 'http://localhost/path', 'https://user@localhost'] as $origin) {
            $this->assertRefused($this->signIn('cred-ec', ['origin' => $origin]), $origin);
        }
    }

    public function test_localhost_origin_on_any_port_is_allowed(): void
    {
        $this->assertTrue($this->signIn('cred-ec', ['origin' => 'http://localhost:8080'])['success']);
    }

    public function test_origin_must_be_https_off_localhost(): void
    {
        $_SERVER['HTTP_HOST'] = 'synergyaichat.com:443';
        $w = $this->controller([]);
        $o = ['rp_id' => 'synergyaichat.com'];
        $this->assertTrue($this->signIn('cred-ec', $o + ['origin' => 'https://synergyaichat.com'], $w)['success']);
        $this->assertRefused($this->signIn('cred-ec', $o + ['origin' => 'http://synergyaichat.com'], $w));
    }

    public function test_configured_origins_are_the_only_ones_allowed(): void
    {
        $w = $this->controller(['rp_id' => 'localhost', 'origins' => ['chrome-extension://abc']]);
        $this->assertTrue($this->signIn('cred-ec', ['origin' => 'chrome-extension://abc'], $w)['success']);
        $this->assertRefused($this->signIn('cred-ec', ['origin' => 'http://localhost'], $w));
    }

    public function test_wrong_rp_id_hash_is_refused(): void
    {
        $this->assertRefused($this->signIn('cred-ec', ['rp_id' => 'evil.test']));
    }

    public function test_missing_user_verification_is_refused(): void
    {
        $this->assertRefused($this->signIn('cred-ec', ['flags' => 0x01]));
        $this->assertRefused($this->signIn('cred-ec', ['flags' => 0x04]));
    }

    public function test_registration_type_is_refused(): void
    {
        $this->assertRefused($this->signIn('cred-ec', ['type' => 'webauthn.create']));
    }

    public function test_unknown_credential_is_not_found(): void
    {
        $r = $this->controller()->authenticate(['body' => ['credential_id' => 'nope'] + $this->assertion('cred-ec', 'x')]);
        $this->assertSame(404, $r['status_code']);
        $this->assertSame('CREDENTIAL_NOT_FOUND', $r['code']);
        $this->assertArrayNotHasKey('token', $r);
    }

    public function test_service_user_is_not_found_even_with_a_valid_assertion(): void
    {
        $this->db->exec("INSERT INTO webauthn_challenges VALUES ('robot-challenge', 2, 'authenticate', '" . date('Y-m-d H:i:s') . "')");
        $r = $this->controller()->authenticate(['body' => $this->assertion('cred-robot', 'robot-challenge')]);
        $this->assertSame(404, $r['status_code']);
        $this->assertSame('CREDENTIAL_NOT_FOUND', $r['code']);
        $this->assertArrayNotHasKey('token', $r);
    }

    public function test_missing_fields_are_a_bad_request(): void
    {
        $full = $this->assertion('cred-ec', 'x');
        foreach (array_keys($full) as $field) {
            $body = $full;
            unset($body[$field]);
            $r = $this->controller()->authenticate(['body' => $body]);
            $this->assertSame(400, $r['status_code'], $field);
            $this->assertArrayNotHasKey('token', $r);
        }
    }

    public function test_email_challenge_lists_that_users_credentials(): void
    {
        $r = $this->controller()->challenge(['body' => ['action' => 'authenticate', 'email' => 'ada@x.test']]);
        $this->assertTrue($r['success']);
        $this->assertEqualsCanonicalizing(['cred-ec', 'cred-rsa'], array_column($r['allow_credentials'], 'id'));
        $this->assertSame('1', (string) $this->db->query('SELECT user_id FROM webauthn_challenges')->fetchColumn());
        // ... and the email-bound challenge signs in.
        $r2 = $this->controller()->authenticate(['body' => $this->assertion('cred-rsa', $r['challenge'])]);
        $this->assertTrue($r2['success']);
    }

    public function test_discoverable_challenge_is_refused(): void
    {
        $r = $this->controller()->challenge(['body' => ['action' => 'authenticate']]);
        $this->assertSame(400, $r['status_code']);
        $this->assertSame('EMAIL_REQUIRED', $r['code']);
        $this->assertArrayNotHasKey('challenge', $r);
        $this->assertSame(0, $this->challengeCount());
    }

    public function test_challenge_for_unknown_credential_is_not_found(): void
    {
        $r = $this->controller()->challenge(['body' => ['action' => 'authenticate', 'credential_id' => 'nope']]);
        $this->assertSame(404, $r['status_code']);
        $this->assertSame(0, $this->challengeCount());
    }

    public function test_register_challenge_still_requires_a_signed_in_user(): void
    {
        $r = $this->controller()->challenge(['body' => ['action' => 'register']]);
        $this->assertSame(401, $r['status_code']);
        $r = $this->controller()->challenge(['user_id' => 1, 'body' => ['action' => 'register']]);
        $this->assertTrue($r['success']);
        $this->assertSame('localhost', $r['rp_id']);
    }
}
