<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * Root Controller
 *
 * Handles root endpoint and health checks.
 */
class RootController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Root endpoint / Health check
     */
    public function index(array $request): array
    {
        return [
            'success' => true,
            'message' => 'GPT Chat Backend API',
            'version' => '2.0.0',
            'architecture' => 'MVC with FastRoute',
            'endpoints' => [
                'auth' => '/api/v1/auth/*',
                'chat' => '/api/v1/chat',
                'contexts' => '/api/v1/contexts',
                'providers' => '/api/v1/providers',
                'settings' => '/api/v1/settings/*',
                'usage' => '/api/v1/usage/*',
                'prompts' => '/api/v1/prompts',
                'admin' => '/api/v1/admin/*',
                'mcp' => '/api/v1/mcp/*',
                'hume' => '/api/v1/hume/*',
                'evi' => '/api/v1/evi/*',
                'drive' => '/api/v1/drive/*'
            ],
            'status_code' => 200
        ];
    }
}
