<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\Services\ToolsManager;
use Quantis\AIPortfolioAssistant\Services\HumeToolSyncService;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Functions\WatchlistFunctions;
use Quantis\AIPortfolioAssistant\Functions\PortfolioFunctions;
use Quantis\AIPortfolioAssistant\Functions\SearchFunctions;
use Quantis\AIPortfolioAssistant\Functions\AnalysisFunctions;
use PDO;
use Exception;

/**
 * Hume Tool Controller
 *
 * Handles Hume EVI tool operations:
 * - Execute tool functions
 * - List available tools
 * - Sync tools to Hume API
 * - Get sync status
 * - Test Hume connection
 * - Get Hume config
 */
class HumeToolController
{
    private PDO $db;
    private array $config;
    private ToolsManager $toolsManager;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->toolsManager = $this->initializeToolsManager();
    }

    /**
     * Execute a tool function
     */
    public function execute(array $request): array
    {
        $input = $request['body'];

        $toolCallId = $input['toolCallId'] ?? null;
        $toolName = $input['toolName'] ?? null;
        $parameters = $input['parameters'] ?? [];

        if (!$toolCallId || !$toolName) {
            return [
                'success' => false,
                'error' => 'Missing toolCallId or toolName',
                'status_code' => 400
            ];
        }

        // Get user ID from session or input
        $userId = $input['userId'] ?? $request['user_id'] ?? 'demo-user';

        // Check if function exists
        if (!$this->toolsManager->hasFunction($toolName)) {
            return [
                'success' => false,
                'error' => "Function not found: {$toolName}",
                'toolCallId' => $toolCallId,
                'availableFunctions' => $this->toolsManager->getRegisteredFunctions(),
                'status_code' => 404
            ];
        }

        // Execute the tool
        $result = $this->toolsManager->execute($toolName, $parameters, $userId);

        // Format response for Hume EVI (content must be a string)
        $content = json_encode($result, JSON_PRETTY_PRINT);

        return [
            'success' => true,
            'toolCallId' => $toolCallId,
            'toolName' => $toolName,
            'content' => $content,
            'result' => $result,
            'status_code' => 200
        ];
    }

    /**
     * List available tools in Hume format
     */
    public function list(array $request): array
    {
        // Get Claude-format definitions
        $claudeDefinitions = $this->toolsManager->getToolDefinitions();

        // Convert to Hume EVI format
        $humeTools = [];
        foreach ($claudeDefinitions as $tool) {
            $humeTools[] = [
                'name' => $tool['name'],
                'description' => $tool['description'],
                'parameters' => $tool['input_schema']
            ];
        }

        return [
            'success' => true,
            'tools' => $humeTools,
            'count' => count($humeTools),
            'note' => 'Copy these tool definitions to your Hume EVI configuration',
            'status_code' => 200
        ];
    }

    /**
     * Sync tools to Hume API
     */
    public function sync(array $request): array
    {
        try {
            $syncService = new HumeToolSyncService($this->config, $this->db);
            $results = $syncService->syncAllTools($this->toolsManager);

            return [
                'success' => true,
                'message' => 'Tools synchronized successfully',
                'stats' => [
                    'total_local' => $results['total_local'],
                    'total_hume' => $results['total_hume'],
                    'created' => count($results['created']),
                    'updated' => count($results['updated']),
                    'unchanged' => count($results['unchanged']),
                    'errors' => count($results['errors'])
                ],
                'details' => $results,
                'timestamp' => date('Y-m-d H:i:s'),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get sync status
     */
    public function getStatus(array $request): array
    {
        try {
            $syncService = new HumeToolSyncService($this->config, $this->db);
            $status = $syncService->getSyncStatus($this->toolsManager);

            return [
                'success' => true,
                'status' => $status,
                'needs_action' => !empty($status['missing_in_hume']) || !empty($status['missing_in_local']),
                'timestamp' => date('Y-m-d H:i:s'),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Test Hume API connection
     */
    public function testConnection(array $request): array
    {
        try {
            $syncService = new HumeToolSyncService($this->config, $this->db);
            $result = $syncService->testConnection();

            return array_merge($result, ['status_code' => $result['success'] ? 200 : 500]);
        } catch (Exception $e) {
            return [
                'success' => false,
                'message' => 'Connection failed: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get current Hume EVI configuration
     */
    public function getConfig(array $request): array
    {
        try {
            $configId = $this->config['hume_evi']['config_id'] ?? '';

            if (empty($configId)) {
                return [
                    'success' => false,
                    'error' => 'No config_id set in ai_config.php',
                    'status_code' => 400
                ];
            }

            $apiKey = $this->config['hume_evi']['api_key'] ?? '';
            $baseUrl = $this->config['hume_evi']['base_url'] ?? 'https://api.hume.ai/v0/evi';

            $httpClient = new \GuzzleHttp\Client(['timeout' => 30]);

            $response = $httpClient->get("{$baseUrl}/configs/{$configId}", [
                'headers' => [
                    'X-Hume-Api-Key' => $apiKey,
                ]
            ]);

            $configData = json_decode($response->getBody()->getContents(), true);

            return [
                'success' => true,
                'config' => $configData,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Initialize and register all functions
     */
    private function initializeToolsManager(): ToolsManager
    {
        $toolsManager = new ToolsManager();

        // Create Configuration object from array
        $config = new Configuration($this->config);

        // Register functions that need PDO
        try {
            $watchlistFunctions = new WatchlistFunctions($this->db);
            $toolsManager->registerFunctions($watchlistFunctions->getAllFunctions());

            $portfolioFunctions = new PortfolioFunctions($this->db);
            $toolsManager->registerFunctions($portfolioFunctions->getAllFunctions());
        } catch (Exception $e) {
            error_log("[HumeToolController] Failed to register DB functions: " . $e->getMessage());
        }

        // Register functions that need configuration
        $searchFunctions = new SearchFunctions($config);
        $toolsManager->registerFunctions($searchFunctions->getAllFunctions());

        $analysisFunctions = new AnalysisFunctions($config);
        $toolsManager->registerFunctions($analysisFunctions->getAllFunctions());

        // Financial News, Crypto News, PubMed, and Battery News functions disabled - using external MCP servers instead
        // (battery_news_get_all, battery_news_search)

        return $toolsManager;
    }
}
