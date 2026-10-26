<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\WebAuthnController;

/** Passkey sign-in is off until assertions are verified: no token, and no credential ids handed out by email. */
class WebAuthnSignInOffTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
        $this->db->exec("CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY, user_id INTEGER, credential_id TEXT, public_key TEXT)");
        $this->db->exec("INSERT INTO users (id, email) VALUES (1, 'admin@x.test')");
        $this->db->exec("INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES (1, 'cred-1', 'pk')");
    }

    public function test_authenticate_never_issues_a_token(): void
    {
        $r = (new WebAuthnController($this->db, []))->authenticate(['body' => [
            'credential_id' => 'cred-1', 'signature' => 'x', 'authenticator_data' => 'x', 'client_data_json' => 'x',
        ]]);
        $this->assertSame('PASSKEY_SIGNIN_OFF', $r['code']);
        $this->assertFalse($r['success']);
        $this->assertArrayNotHasKey('token', $r);
    }

    public function test_sign_in_challenge_hands_out_no_credential_ids(): void
    {
        $w = new WebAuthnController($this->db, []);
        foreach ([['email' => 'admin@x.test'], ['credential_id' => 'cred-1'], []] as $who) {
            $r = $w->challenge(['body' => ['action' => 'authenticate'] + $who]);
            $this->assertSame('PASSKEY_SIGNIN_OFF', $r['code']);
            $this->assertArrayNotHasKey('allow_credentials', $r);
            $this->assertArrayNotHasKey('challenge', $r);
        }
    }

    public function test_register_challenge_still_requires_a_signed_in_user(): void
    {
        $r = (new WebAuthnController($this->db, []))->challenge(['body' => ['action' => 'register']]);
        $this->assertSame(401, $r['status_code']);
    }
}
