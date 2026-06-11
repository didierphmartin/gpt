<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use PDO;
use Exception;

/**
 * EVI Webhook Controller
 *
 * Receives tool call requests from Hume EVI and executes registered functions.
 */
class EVIWebhookController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Handle incoming webhook from Hume EVI
     */
    public function handleWebhook(array $request): array
    {
        $payload = $request['body'];

        // Validate webhook payload
        if (!$payload || !isset($payload['tool_name'])) {
            return [
                'success' => false,
                'error' => 'Invalid webhook payload: missing tool_name',
                'status_code' => 400
            ];
        }

        $toolName = $payload['tool_name'];
        $parameters = $payload['parameters'] ?? [];

        try {
            $config = LLMProviderResolver::applyDbSettings($this->db, $this->config);
            $assistant = new AIPortfolioAssistant($config);
            $toolsManager = $assistant->getToolsManager();

            // Check if tool exists
            $availableTools = $toolsManager->getAvailableTools();
            if (!in_array($toolName, $availableTools)) {
                return [
                    'success' => false,
                    'error' => "Tool not found: {$toolName}",
                    'status_code' => 404
                ];
            }

            // Execute the tool
            $result = $toolsManager->executeTool($toolName, $parameters);

            return [
                'success' => true,
                'result' => $result,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            error_log("[EVIWebhookController] Error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }
}
