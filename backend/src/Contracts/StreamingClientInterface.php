<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Contracts;

/**
 * Interface for SSE streaming clients
 */
interface StreamingClientInterface
{
    /**
     * Send a progress message to the client
     */
    public function sendProgress(string $message): void;

    /**
     * Send a response (JSON data) to the client
     */
    public function sendResponse(array $data): void;

    /**
     * Send an error to the client
     */
    public function sendError(string $message, int $code = 500): void;

    /**
     * Send a chunk of streaming text
     */
    public function sendChunk(string $text): void;

    /**
     * Signal that streaming is complete
     */
    public function complete(): void;

    /**
     * Send a custom event with arbitrary data
     */
    public function sendCustomEvent(string $eventName, array $data): void;

    /**
     * Get the session ID
     */
    public function getSessionId(): string;

    /**
     * Check if the client is connected
     */
    public function isConnected(): bool;
}
