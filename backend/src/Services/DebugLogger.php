<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel;

/**
 * Debug logger for AI Portfolio Assistant
 */
class DebugLogger implements LoggerInterface
{
    private bool $enabled;
    private ?string $logFile;
    private bool $includeTimestamp;

    public function __construct(bool $enabled = false, ?string $logFile = null, bool $includeTimestamp = true)
    {
        $this->enabled = $enabled;
        $this->logFile = $logFile;
        $this->includeTimestamp = $includeTimestamp;
    }

    public function emergency(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::EMERGENCY, $message, $context);
    }

    public function alert(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::ALERT, $message, $context);
    }

    public function critical(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::CRITICAL, $message, $context);
    }

    public function error(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::ERROR, $message, $context);
    }

    public function warning(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::WARNING, $message, $context);
    }

    public function notice(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::NOTICE, $message, $context);
    }

    public function info(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::INFO, $message, $context);
    }

    public function debug(\Stringable|string $message, array $context = []): void
    {
        $this->log(LogLevel::DEBUG, $message, $context);
    }

    public function log($level, \Stringable|string $message, array $context = []): void
    {
        if (!$this->enabled) {
            return;
        }

        $formattedMessage = $this->formatMessage($level, (string) $message, $context);

        if ($this->logFile) {
            file_put_contents($this->logFile, $formattedMessage . PHP_EOL, FILE_APPEND);
        } else {
            error_log($formattedMessage);
        }
    }

    /**
     * Log an API request
     */
    public function logApiRequest(string $provider, string $endpoint, array $payload): void
    {
        $this->debug("API Request to {$provider}", [
            'endpoint' => $endpoint,
            'payload_size' => strlen(json_encode($payload)),
        ]);
    }

    /**
     * Log an API response
     */
    public function logApiResponse(string $provider, int $statusCode, int $responseTimeMs): void
    {
        $level = $statusCode >= 400 ? LogLevel::ERROR : LogLevel::DEBUG;
        $this->log($level, "API Response from {$provider}", [
            'status_code' => $statusCode,
            'response_time_ms' => $responseTimeMs,
        ]);
    }

    /**
     * Log a function call
     */
    public function logFunctionCall(string $functionName, array $parameters, int $executionTimeMs, bool $success): void
    {
        $level = $success ? LogLevel::DEBUG : LogLevel::WARNING;
        $this->log($level, "Function call: {$functionName}", [
            'parameters' => $parameters,
            'execution_time_ms' => $executionTimeMs,
            'success' => $success,
        ]);
    }

    /**
     * Format a log message
     */
    private function formatMessage(string $level, string $message, array $context): string
    {
        $parts = [];

        if ($this->includeTimestamp) {
            $parts[] = '[' . date('Y-m-d H:i:s') . ']';
        }

        $parts[] = '[' . strtoupper($level) . ']';
        $parts[] = '[AIPortfolioAssistant]';
        $parts[] = $message;

        if (!empty($context)) {
            $parts[] = json_encode($context, JSON_UNESCAPED_SLASHES);
        }

        return implode(' ', $parts);
    }

    /**
     * Enable or disable logging
     */
    public function setEnabled(bool $enabled): self
    {
        $this->enabled = $enabled;
        return $this;
    }

    /**
     * Set the log file path
     */
    public function setLogFile(?string $path): self
    {
        $this->logFile = $path;
        return $this;
    }
}
