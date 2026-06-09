<?php

/**
 * AI Portfolio Assistant - Basic Usage Example
 *
 * This example demonstrates how to use the package with the pre-configured API keys.
 */

require_once __DIR__ . '/../vendor/autoload.php';

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

// =============================================================================
// Method 1: Load from config file (recommended)
// =============================================================================

echo "=== AI Portfolio Assistant Example ===\n\n";

try {
    // Load configuration from file
    $assistant = AIPortfolioAssistant::fromConfigFile(__DIR__ . '/../config/ai_config.php');

    echo "Configuration loaded successfully!\n";
    echo "Available providers: " . implode(', ', $assistant->getAvailableProviders()) . "\n\n";

    // Get provider info
    $claudeInfo = $assistant->getProviderInfo('claude');
    echo "Claude Provider:\n";
    echo "  - Model: {$claudeInfo['model']}\n";
    echo "  - Available: " . ($claudeInfo['available'] ? 'Yes' : 'No') . "\n\n";

    // =============================================================================
    // Method 2: With Database Connection (for portfolio functions)
    // =============================================================================

    $config = require __DIR__ . '/../config/ai_config.php';

    if (!empty($config['database']['host'])) {
        try {
            $dsn = sprintf(
                'mysql:host=%s;dbname=%s;charset=%s',
                $config['database']['host'],
                $config['database']['database'],
                $config['database']['charset'] ?? 'utf8mb4'
            );

            $pdo = new PDO(
                $dsn,
                $config['database']['username'],
                $config['database']['password'],
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            );

            // Enable portfolio functions
            $assistant->setDatabase($pdo);
            echo "Database connected! Portfolio functions enabled.\n\n";

            // List available functions
            $functions = $assistant->getToolsManager()->getRegisteredFunctions();
            echo "Registered functions (" . count($functions) . "):\n";
            foreach ($functions as $func) {
                echo "  - {$func}\n";
            }
            echo "\n";
        } catch (PDOException $e) {
            echo "Database connection failed: " . $e->getMessage() . "\n";
            echo "Portfolio functions disabled. Search functions still available.\n\n";
        }
    }

    // =============================================================================
    // Example Chat (uncomment to test with real API call)
    // =============================================================================

    // Uncomment below to make a real API call:
    /*
    echo "Sending test message to Claude...\n";
    $response = $assistant->chat(
        "What is the current price of Bitcoin?",
        null, // userId
        [],   // conversationHistory
        ['system_prompt' => 'You are a helpful financial assistant.']
    );

    echo "\nResponse:\n";
    echo $response['text'] . "\n\n";
    echo "Usage:\n";
    echo "  - Input tokens: " . ($response['usage']['input_tokens'] ?? 'N/A') . "\n";
    echo "  - Output tokens: " . ($response['usage']['output_tokens'] ?? 'N/A') . "\n";
    echo "  - Provider: " . ($response['provider_used'] ?? 'N/A') . "\n";
    */

    echo "=== Example Complete ===\n";

} catch (Exception $e) {
    echo "Error: " . $e->getMessage() . "\n";
    echo "Stack trace:\n" . $e->getTraceAsString() . "\n";
}
