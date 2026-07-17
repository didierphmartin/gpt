<?php

require_once __DIR__ . '/load_env.php';

/**
 * AI Portfolio Assistant Configuration
 *
 * Pre-configured with API keys from Quantis backend.
 * Supports multiple AI providers with easy switching.
 */

return [
    // LLM provider blocks (claude, openai, kimi, grok, gemini, deepseek)
    // are now loaded from the system_llm_settings DB table at runtime.
    // See ChatController::applyDatabaseProviderSettings.

    // How long the workflow engine waits for a browser-side (Pyodide) skill
    // to return through the SkillToolBridge. The old defaults (60s sequential
    // / 120s parallel) killed network-heavy skills on slow target sites —
    // a GEO audit run died 60s after its report was already written.
    'parallel_skill_timeout_ms' => 300000,

    // Search APIs
    'search' => [
        'serpapi' => [
            'api_key' => $_ENV['SERPAPI_KEY'] ?? '',
            'base_url' => 'https://serpapi.com/search',
            'engine' => 'google',
            'max_results' => 20,
        ],
        'scrapingdog' => [
            'api_key' => $_ENV['SCRAPINGDOG_KEY'] ?? '',
            'base_url' => 'https://api.scrapingdog.com/google',
        ],
        'brave' => [
            'api_key' => $_ENV['BRAVE_KEY'] ?? '',
            'base_url' => 'https://api.search.brave.com/res/v1',
            'max_results' => 20,
        ],
    ],

    // PubMed, Battery News, Crypto News, and Financial News configs removed:
    // these services are now provided by external MCP servers (/pubmed, /battery,
    // /cryptos, /finance in xampp/htdocs).

    // Metals News Service Configuration
    'metals_news' => [
        'service_url' => 'http://localhost/metals/public',
    ],


    // Financial Data APIs
    'financial' => [
        'fmp' => [
            'api_key' => $_ENV['FMP_KEY'] ?? '',
            'base_url' => 'https://financialmodelingprep.com/api/v3',
        ],
    ],

    // SSE Streaming Configuration
    'sse' => [
        'enabled' => true,
        'hub_url' => null,
    ],

    // Usage Tracking
    'tracking' => [
        'enabled' => true,
        'track_costs' => true,
    ],

    // Debug Mode
    'debug' => false,

    // Default Provider
    'default_provider' => 'kimi',

    // Max recursion depth for tool calls
    'max_recursion_depth' => 10,

    // Database Configuration (for portfolio functions)
    'database' => [
        'host' => $_ENV['DB_HOST'] ?? '',
        'database' => $_ENV['DB_NAME'] ?? '',
        'username' => $_ENV['DB_USER'] ?? '',
        'password' => $_ENV['DB_PASS'] ?? '',
        'charset' => 'utf8mb4',
    ],

    // Contexts Database Configuration (for conversation history)
    'contexts_database' => [
        'host' => $_ENV['CTX_DB_HOST'] ?? '',
        'database' => $_ENV['CTX_DB_NAME'] ?? '',
        'username' => $_ENV['CTX_DB_USER'] ?? '',
        'password' => $_ENV['CTX_DB_PASS'] ?? '',
        'charset' => 'utf8mb4',
    ],

    // Authentication Configuration
    'auth' => [
        'jwt_secret' => $_ENV['JWT_SECRET'] ?? '',
        'jwt_expiry' => 28800,     // 8 hours
        'refresh_expiry' => 604800, // 7 days
        // HMAC pepper for app_keys.key_hash. A DB leak alone cannot forge
        // keys without this server-side secret. Rotating it invalidates
        // every existing app key.
        'app_key_secret' => $_ENV['APP_KEY_SECRET'] ?? '',
    ],

    // Hume EVI Configuration
    'hume_evi' => [
        'api_key' => $_ENV['HUME_API_KEY'] ?? '', // Add your Hume API key here (get from https://platform.hume.ai/)
        'base_url' => 'https://api.hume.ai/v0/evi',
        'config_id' => '0d9df320-ec1d-4e08-8c2e-300e4e8de3b1', // Your EVI configuration ID (optional, for auto-linking tools)
        'auto_sync_on_changes' => false, // Auto-sync tools when backend functions change
        'cleanup_orphaned_tools' => false, // Auto-delete tools from Hume that don't exist in backend
    ],

    // Grok Voice (xAI Realtime API) Configuration
    // Used for secure ephemeral token generation - keeps API key server-side
    // Available voices: Eve (energetic), Ara (warm), Rex (confident), Sal (balanced), Leo (authoritative)
    'grok_voice' => [
        'api_key' => $_ENV['GROK_VOICE_API_KEY'] ?? '',
        'base_url' => 'https://api.x.ai',
        'realtime_endpoint' => '/v1/realtime',
        'client_secrets_endpoint' => '/v1/realtime/client_secrets',
        'default_voice' => 'Eve',
        'token_expiry_minutes' => 5, // Ephemeral tokens expire quickly for security
    ],

    // Gemini Voice (Google Live API) Configuration
    'gemini_voice' => [
        'api_key' => $_ENV['GEMINI_VOICE_API_KEY'] ?? '',
        'model' => 'gemini-2.5-flash-native-audio-preview-12-2025',
        'default_voice' => 'Zephyr',
    ],

    // Scheduler Configuration (for cron-based workflow execution)
    'scheduler' => [
        'token' => $_ENV['SCHEDULER_TOKEN'] ?? '', // Secret token for HTTP-based scheduler invocation
        'max_concurrent' => 5, // Maximum concurrent workflow executions
        'timeout_minutes' => 30, // Maximum execution time per workflow
    ],

    // Storage Configuration (for file attachments, workflow outputs, etc.)
    // User settings in database override these defaults
    'storage' => [
        'default_provider' => 's3', // Options: 'local', 's3', 'gdrive', 'onedrive'
        // UniversalFS handles the actual provider credentials
        // Credentials are stored in universalFS database per user
    ],

];
