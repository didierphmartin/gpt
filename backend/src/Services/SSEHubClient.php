<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Contracts\StreamingClientInterface;
use Quantis\AIPortfolioAssistant\Exceptions\StreamingException;

/**
 * Server-Sent Events (SSE) client for streaming responses
 */
class SSEHubClient implements StreamingClientInterface
{
    private string $sessionId;
    private ?string $hubUrl;
    private bool $debug;
    private bool $connected = false;
    private bool $headersSet = false;

    public function __construct(string $sessionId, ?string $hubUrl = null, bool $debug = false)
    {
        $this->sessionId = $sessionId;
        $this->hubUrl = $hubUrl;
        $this->debug = $debug;
    }

    /**
     * Static factory method
     */
    public static function create(string $sessionId, ?string $hubUrl = null, bool $debug = false): self
    {
        return new self($sessionId, $hubUrl, $debug);
    }

    /**
     * Initialize SSE headers for direct streaming
     */
    public function initializeHeaders(): void
    {
        if ($this->headersSet) {
            return;
        }

        if (headers_sent()) {
            $this->log("Headers already sent, marking as initialized");
            $this->headersSet = true;
            $this->connected = true;
            return;
        }

        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');

        // Disable output buffering
        while (ob_get_level()) {
            ob_end_flush();
        }

        $this->headersSet = true;
        $this->connected = true;
        $this->log("SSE headers initialized for session: {$this->sessionId}");
    }

    /**
     * Mark headers as already initialized (when headers are set externally)
     */
    public function markHeadersInitialized(): void
    {
        $this->headersSet = true;
        $this->connected = true;
        $this->log("Headers marked as initialized for session: {$this->sessionId}");
    }

    /**
     * Send a progress message to the client
     */
    public function sendProgress(string $message): void
    {
        $this->sendEvent('progress', $message);
    }

    /**
     * Send a response (JSON data) to the client
     */
    public function sendResponse(array $data): void
    {
        $this->sendEvent('response', json_encode($data));
    }

    /**
     * Send an error to the client
     */
    public function sendError(string $message, int $code = 500): void
    {
        $this->sendEvent('error', json_encode([
            'error' => true,
            'message' => $message,
            'code' => $code
        ]));
    }

    /**
     * Send a chunk of streaming text
     */
    public function sendChunk(string $text): void
    {
        // DEBUG: Log EXACT data being sent to frontend (json_encode shows \n as \\n)
        error_log("📤 SENDING TO FRONTEND (len=" . strlen($text) . "): " . json_encode($text));
        $this->sendEvent('chunk', $text);
    }

    /**
     * Signal that streaming is complete
     */
    public function complete(): void
    {
        $this->sendEvent('complete', json_encode(['status' => 'done']));
        $this->connected = false;
    }

    /**
     * Send a custom event with arbitrary data
     */
    public function sendCustomEvent(string $eventName, array $data): void
    {
        $this->sendEvent($eventName, json_encode($data));
    }

    /**
     * Get the session ID
     */
    public function getSessionId(): string
    {
        return $this->sessionId;
    }

    /**
     * Check if the client is connected
     */
    public function isConnected(): bool
    {
        return $this->connected && connection_status() === CONNECTION_NORMAL;
    }

    /**
     * Send an SSE event
     */
    private function sendEvent(string $event, string $data): void
    {
        if ($this->hubUrl) {
            $this->sendToHub($event, $data);
        } else {
            $this->sendDirect($event, $data);
        }
    }

    /**
     * Send event directly via echo (for direct streaming)
     */
    private function sendDirect(string $event, string $data): void
    {
        if (!$this->headersSet) {
            $this->initializeHeaders();
        }

        echo "event: {$event}\n";

        // SSE spec: if data contains newlines, send each line as separate "data:" line
        $lines = explode("\n", $data);
        foreach ($lines as $line) {
            echo "data: {$line}\n";
        }
        echo "\n";  // End of event

        if (ob_get_level()) {
            ob_flush();
        }
        flush();

        $this->log("Direct SSE sent - event: {$event}");
    }

    /**
     * Send event to an SSE hub server
     */
    private function sendToHub(string $event, string $data): void
    {
        try {
            $payload = json_encode([
                'session_id' => $this->sessionId,
                'event' => $event,
                'data' => $data
            ]);

            $ch = curl_init($this->hubUrl);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'Content-Length: ' . strlen($payload)
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 5
            ]);

            $result = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) {
                $this->log("Hub send failed with HTTP {$httpCode}");
            }
        } catch (\Throwable $e) {
            $this->log("Hub send error: " . $e->getMessage());
        }
    }

    /**
     * Log a debug message
     */
    private function log(string $message): void
    {
        if ($this->debug) {
            error_log("[SSEHubClient] {$message}");
        }
    }
}
