<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Middleware;

/**
 * Middleware Processor
 *
 * Orchestrates the middleware pipeline for handling requests.
 * Processes CORS, authentication, and other middleware in order.
 */
class MiddlewareProcessor
{
    private CorsMiddleware $corsMiddleware;
    private AuthMiddleware $authMiddleware;
    private array $config;

    /**
     * Public routes that don't require authentication
     */
    private const PUBLIC_ROUTES = [
        // Authentication routes (must be public)
        ['pattern' => '/api/v1/auth', 'methods' => ['POST']], // Legacy action-based auth
        ['pattern' => '/api/v1/auth/login', 'methods' => ['POST']],
        ['pattern' => '/api/v1/auth/register', 'methods' => ['POST']],
        ['pattern' => '/api/v1/auth/firebase', 'methods' => ['POST']],
        ['pattern' => '/api/v1/auth/verify', 'methods' => ['POST']],
        ['pattern' => '/api/v1/auth/logout', 'methods' => ['POST']],
        // EVI webhook (external callback)
        ['pattern' => '/api/v1/evi/webhook', 'methods' => ['POST']],
        // MCP App (serves HTML in iframe, cannot send auth headers)
        ['pattern' => '/api/v1/mcp/app', 'methods' => ['GET']],
        ['pattern' => '/api/mcp-app.php', 'methods' => ['GET']], // Legacy path
        // Scheduler (uses its own token validation for cron access)
        ['pattern' => '/api/v1/scheduler/run', 'methods' => ['POST']],
        // WebAuthn biometric authentication (challenge + authenticate are needed for login)
        ['pattern' => '/api/v1/webauthn/challenge', 'methods' => ['POST']],
        ['pattern' => '/api/v1/webauthn/authenticate', 'methods' => ['POST']],
        // Model catalog (referenced by both gpt and gpt_admin before login flows complete)
        ['pattern' => '/api/v1/models/catalog', 'methods' => ['GET']],
        // Health check
        ['pattern' => '/', 'methods' => ['GET']],
    ];

    public function __construct(array $config)
    {
        $this->config = $config;

        // Initialize CORS middleware
        $this->corsMiddleware = new CorsMiddleware($config['cors'] ?? []);

        // Initialize Auth middleware with public routes. The full config
        // is passed so the middleware can lazily open a DB connection for
        // app-key (Authorization: AppKey …) validation.
        $jwtSecret = $config['auth']['jwt_secret'] ?? '';
        $this->authMiddleware = new AuthMiddleware($jwtSecret, self::PUBLIC_ROUTES, $config);
    }

    /**
     * Process request through middleware pipeline
     *
     * @param array $request Request data
     * @return array Processed request or error response
     */
    public function process(array $request): array
    {
        // 1. Process CORS
        $corsResult = $this->corsMiddleware->handle($request);
        if ($corsResult !== null) {
            // This is an OPTIONS preflight response
            return [
                'handled' => true,
                'response' => $corsResult
            ];
        }

        // 2. Process Authentication
        $authResult = $this->authMiddleware->handle($request);
        if (isset($authResult['error']) && $authResult['error'] === true) {
            return [
                'handled' => true,
                'response' => $authResult
            ];
        }

        // Return the processed request with user_id injected
        return [
            'handled' => false,
            'request' => $authResult
        ];
    }

    /**
     * Build request array from PHP globals
     */
    public static function buildRequest(): array
    {
        $method = $_SERVER['REQUEST_METHOD'];
        $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

        // Remove base path to get relative URI
        $basePath = '/gpt/backend';
        if (str_starts_with($uri, $basePath)) {
            $uri = substr($uri, strlen($basePath));
        }

        // Ensure URI starts with /
        if (empty($uri) || $uri[0] !== '/') {
            $uri = '/' . $uri;
        }

        // Get headers
        $headers = self::getAllHeaders();

        // Get query parameters
        $query = $_GET;

        // Get request body
        $rawBody = file_get_contents('php://input');
        $body = json_decode($rawBody, true) ?? [];

        return [
            'method' => $method,
            'uri' => $uri,
            'headers' => $headers,
            'query' => $query,
            'body' => $body,
            'raw_body' => $rawBody,
        ];
    }

    /**
     * Get all headers (with polyfill)
     */
    private static function getAllHeaders(): array
    {
        if (function_exists('getallheaders')) {
            $headers = getallheaders();
            return is_array($headers) ? $headers : [];
        }

        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (substr($name, 0, 5) === 'HTTP_') {
                $headerName = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))));
                $headers[$headerName] = $value;
            }
        }
        return $headers;
    }

    /**
     * Send JSON response
     */
    public static function sendResponse(array $response): void
    {
        $statusCode = $response['status_code'] ?? 200;
        $body = $response['body'] ?? [];
        $headers = $response['headers'] ?? [];

        http_response_code($statusCode);

        foreach ($headers as $name => $value) {
            header("{$name}: {$value}");
        }

        if (!empty($body)) {
            header('Content-Type: application/json');
            echo json_encode($body);
        }
    }

    /**
     * Get CORS middleware (for setting headers before streaming)
     */
    public function getCorsMiddleware(): CorsMiddleware
    {
        return $this->corsMiddleware;
    }
}
