<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Exceptions;

/**
 * Exception for AI provider errors (API failures, rate limits, etc.)
 */
class ProviderException extends AIAssistantException
{
    private ?string $provider = null;
    private ?int $httpStatusCode = null;

    public function setProvider(string $provider): self
    {
        $this->provider = $provider;
        return $this;
    }

    public function getProvider(): ?string
    {
        return $this->provider;
    }

    public function setHttpStatusCode(int $code): self
    {
        $this->httpStatusCode = $code;
        return $this;
    }

    public function getHttpStatusCode(): ?int
    {
        return $this->httpStatusCode;
    }

    /**
     * Create exception for rate limit errors
     */
    public static function rateLimited(string $provider, int $retryAfter = 0): self
    {
        $exception = new self(
            "Rate limited by {$provider}. " . ($retryAfter > 0 ? "Retry after {$retryAfter} seconds." : ""),
            429
        );
        $exception->setProvider($provider);
        $exception->setHttpStatusCode(429);
        return $exception;
    }

    /**
     * Create exception for authentication errors
     */
    public static function authenticationFailed(string $provider): self
    {
        $exception = new self("Authentication failed for {$provider}. Please check your API key.", 401);
        $exception->setProvider($provider);
        $exception->setHttpStatusCode(401);
        return $exception;
    }

    /**
     * Create exception for API errors
     */
    public static function apiError(string $provider, string $message, int $statusCode = 500): self
    {
        $exception = new self("{$provider} API error: {$message}", $statusCode);
        $exception->setProvider($provider);
        $exception->setHttpStatusCode($statusCode);
        return $exception;
    }
}
