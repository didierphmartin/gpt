<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AuthController;

/**
 * On a corporate install the login service is the only credential store:
 * gpt's own password, registration and Firebase paths must hand out nothing.
 */
class CorporateSignInTest extends TestCase
{
    private function controller(string $edition): AuthController
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, password TEXT, role TEXT)');
        $db->exec("INSERT INTO users (email, password, role) VALUES ('a@corp.test', '"
            . password_hash('right-password', PASSWORD_BCRYPT) . "', 'admin')");
        return new AuthController($db, [
            'edition' => $edition,
            'auth' => ['jwt_secret' => 'test-secret-0123456789-0123456789'],
        ]);
    }

    public function test_corporate_refuses_password_login(): void
    {
        $r = $this->controller('corporate')->login(['body' => ['email' => 'a@corp.test', 'password' => 'right-password']]);
        $this->assertSame(403, $r['status_code']);
        $this->assertArrayNotHasKey('data', $r);
    }

    public function test_corporate_refuses_register_and_firebase(): void
    {
        $c = $this->controller('corporate');
        $this->assertSame(403, $c->register(['body' => ['email' => 'n@corp.test', 'password' => 'x']])['status_code']);
        $this->assertSame(403, $c->firebaseAuth(['body' => ['idToken' => 'x']])['status_code']);
    }
}
