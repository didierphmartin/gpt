<?php

declare(strict_types=1);

/**
 * AI Service Backend Entry Point
 *
 * Routes all API requests using FastRoute and middleware pipeline.
 * MVC Architecture with centralized CORS and authentication.
 */

// Error reporting
error_reporting(E_ALL);
ini_set('display_errors', 0);

// Load autoloader
require_once __DIR__ . '/vendor/autoload.php';

// Load configuration
$config = require __DIR__ . '/config/ai_config.php';

// Load routes
require_once __DIR__ . '/src/routes.php';

use Quantis\AIPortfolioAssistant\Middleware\MiddlewareProcessor;
use FastRoute\Dispatcher;

// Build request from PHP globals
$request = MiddlewareProcessor::buildRequest();

// Initialize middleware processor
$middlewareProcessor = new MiddlewareProcessor($config);

// Process request through middleware pipeline
$middlewareResult = $middlewareProcessor->process($request);

// Check if middleware handled the request (e.g., OPTIONS preflight)
if ($middlewareResult['handled']) {
    $response = $middlewareResult['response'];
    MiddlewareProcessor::sendResponse($response);
    exit;
}

// Get processed request with user_id
$request = $middlewareResult['request'];

// Database connection
$pdo = null;
try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false
    ]);
} catch (PDOException $e) {
    error_log("[Backend] Database connection failed: " . $e->getMessage());
    header('Content-Type: application/json');
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Database connection failed'
    ]);
    exit;
}

// Create route dispatcher
$dispatcher = createRouteDispatcher();

// Dispatch route
$routeInfo = $dispatcher->dispatch($request['method'], $request['uri']);

switch ($routeInfo[0]) {
    case Dispatcher::NOT_FOUND:
        header('Content-Type: application/json');
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'error' => 'Endpoint not found',
            'uri' => $request['uri']
        ]);
        break;

    case Dispatcher::METHOD_NOT_ALLOWED:
        $allowedMethods = $routeInfo[1];
        header('Content-Type: application/json');
        http_response_code(405);
        echo json_encode([
            'success' => false,
            'error' => 'Method not allowed',
            'allowed_methods' => $allowedMethods
        ]);
        break;

    case Dispatcher::FOUND:
        $handler = $routeInfo[1];
        $routeParams = $routeInfo[2];

        // Extract controller and method
        [$controllerName, $methodName] = $handler;

        // Build full controller class name
        $controllerClass = getControllerClass($controllerName);

        // Check if controller exists
        if (!class_exists($controllerClass)) {
            header('Content-Type: application/json');
            http_response_code(500);
            echo json_encode([
                'success' => false,
                'error' => "Controller not found: {$controllerName}"
            ]);
            break;
        }

        try {
            // Instantiate controller
            $controller = new $controllerClass($pdo, $config);

            // Check if method exists
            if (!method_exists($controller, $methodName)) {
                header('Content-Type: application/json');
                http_response_code(500);
                echo json_encode([
                    'success' => false,
                    'error' => "Method not found: {$methodName}"
                ]);
                break;
            }

            // Call controller method with request and route params
            if (!empty($routeParams)) {
                // Methods with route parameters (e.g., /contexts/{id})
                // Cast numeric parameters to int
                $params = array_map(function($v) {
                    return is_numeric($v) ? (int)$v : $v;
                }, array_values($routeParams));

                // Also add route params to request['params'] for controllers that expect it there
                $request['params'] = $routeParams;

                $result = $controller->$methodName($request, ...$params);
            } else {
                $result = $controller->$methodName($request);
            }

            // Handle response
            $statusCode = $result['status_code'] ?? 200;

            // Check for special streaming response marker
            if (isset($result['streaming_handled']) && $result['streaming_handled'] === true) {
                // Streaming was handled directly by the controller, nothing to do
                break;
            }

            // Check for HTML content type (MCP App)
            if (isset($result['content_type']) && strpos($result['content_type'], 'text/html') !== false) {
                http_response_code($statusCode);
                header('Content-Type: ' . $result['content_type']);
                header('Cache-Control: no-cache');
                if (isset($result['html'])) {
                    echo $result['html'];
                } elseif (isset($result['error'])) {
                    echo $result['error'];
                }
                break;
            }

            // Check for plain text error
            if (isset($result['content_type']) && $result['content_type'] === 'text/plain') {
                http_response_code($statusCode);
                header('Content-Type: text/plain');
                echo $result['error'] ?? 'Unknown error';
                break;
            }

            // Raw body download (e.g. generated file) with custom headers
            if (isset($result['raw_body'])) {
                http_response_code($statusCode);
                foreach (($result['headers'] ?? []) as $name => $value) {
                    header($name . ': ' . $value);
                }
                echo $result['raw_body'];
                break;
            }

            // Standard JSON response
            http_response_code($statusCode);
            header('Content-Type: application/json');

            // Remove internal fields before sending response
            unset($result['status_code']);
            unset($result['content_type']);

            echo json_encode($result);

        } catch (Throwable $e) {
            error_log("[Backend] Controller error: " . $e->getMessage() . "\n" . $e->getTraceAsString());
            header('Content-Type: application/json');
            http_response_code(500);
            echo json_encode([
                'success' => false,
                'error' => $e->getMessage()
            ]);
        }
        break;
}
