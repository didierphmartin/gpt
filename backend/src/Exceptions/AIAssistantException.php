<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Exceptions;

use Exception;

/**
 * Base exception for AI Portfolio Assistant
 */
class AIAssistantException extends Exception
{
    protected array $context = [];

    public function __construct(string $message = "", int $code = 0, ?\Throwable $previous = null, array $context = [])
    {
        parent::__construct($message, $code, $previous);
        $this->context = $context;
    }

    /**
     * Get additional context for the exception
     */
    public function getContext(): array
    {
        return $this->context;
    }

    /**
     * Create exception with context
     */
    public static function withContext(string $message, array $context = [], int $code = 0): static
    {
        return new static($message, $code, null, $context);
    }
}
