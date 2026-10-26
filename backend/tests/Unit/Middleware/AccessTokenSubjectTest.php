<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Middleware;

use Firebase\JWT\JWT;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Middleware\AuthMiddleware;

/** Only a gpt access token is a session: not the login service's tokens (same secret), not a refresh token. */
class AccessTokenSubjectTest extends TestCase
{
    private const SECRET = 'test-secret-0123456789-0123456789';

    private function token(array $claims): string
    {
        return JWT::encode($claims + ['iat' => time(), 'exp' => time() + 60, 'sub' => 7], self::SECRET, 'HS256');
    }

    public function testGptAccessTokenIsAccepted(): void
    {
        $this->assertSame(7, AuthMiddleware::accessTokenSubject($this->token(['iss' => 'gpt-chat', 'type' => 'access']), self::SECRET));
    }

    public function testLoginServiceTokenIsRefused(): void
    {
        $this->assertNull(AuthMiddleware::accessTokenSubject($this->token(['iss' => 'login-service', 'type' => 'access']), self::SECRET));
    }

    public function testRefreshTokenIsRefused(): void
    {
        $this->assertNull(AuthMiddleware::accessTokenSubject($this->token(['iss' => 'gpt-chat', 'type' => 'refresh']), self::SECRET));
    }

    public function testTokenWithoutClaimsIsRefused(): void
    {
        $this->assertNull(AuthMiddleware::accessTokenSubject($this->token([]), self::SECRET));
    }
}
