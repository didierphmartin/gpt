<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Exceptions;

/**
 * Exception for SSE streaming errors
 */
class StreamingException extends AIAssistantException
{
    /**
     * Create exception for connection failure
     */
    public static function connectionFailed(string $reason): self
    {
        return new self("SSE connection failed: {$reason}", 503);
    }

    /**
     * Create exception for write failure
     */
    public static function writeFailed(string $reason): self
    {
        return new self("Failed to write to SSE stream: {$reason}", 500);
    }
}
