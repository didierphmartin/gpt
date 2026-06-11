<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Middleware;

/**
 * CORS Middleware
 *
 * Handles Cross-Origin Resource Sharing headers for API requests.
 * Centralizes CORS configuration that was previously duplicated across API endpoints.
 */
class CorsMiddleware
{
    private array $allowedOrigins;
    private array $allowedMethods;
    private array $allowedHeaders;

    public function __construct(array $config = [])
    {
        $this->allowedOrigins = $config['allowed_origins'] ?? ['*'];
        $this->allowedMethods = $config['allowed_methods'] ?? ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
        $this->allowedHeaders = $config['allowed_headers'] ?? ['Content-Type', 'Authorization'];
    }

    /**
     * Process CORS headers for the request
     *
     * @param array $request The request data
     * @return array|null Returns null to continue, or response array for OPTIONS preflight
     */
    public function handle(array $request): ?array
    {
        $this->setHeaders();

        // Handle OPTIONS preflight request
        if ($request['method'] === 'OPTIONS') {
            return [
                'status_code' => 204,
                'headers' => [],
                'body' => ''
            ];
        }

        return null;
    }

    /**
     * Set CORS headers on the response
     */
    public function setHeaders(): void
    {
        $origin = $this->getAllowedOriginHeader();
        header("Access-Control-Allow-Origin: {$origin}");
        header('Access-Control-Allow-Methods: ' . implode(', ', $this->allowedMethods));
        header('Access-Control-Allow-Headers: ' . implode(', ', $this->allowedHeaders));
    }

    /**
     * Get the appropriate Access-Control-Allow-Origin header value
     */
    private function getAllowedOriginHeader(): string
    {
        if (in_array('*', $this->allowedOrigins)) {
            return '*';
        }

        $requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (in_array($requestOrigin, $this->allowedOrigins)) {
            return $requestOrigin;
        }

        // Return first allowed origin as fallback
        return $this->allowedOrigins[0] ?? '*';
    }
}
