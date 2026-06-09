# AI Portfolio Assistant

A reusable PHP Composer package for AI-powered portfolio analysis with Claude integration, streaming SSE support, and extensible function calling.

## Features

- **Claude AI Integration** - Native support for Claude API with function calling
- **Streaming Responses** - Real-time SSE streaming for responsive chat
- **Extensible Functions** - Register custom functions for Claude to call
- **Portfolio Analysis** - Built-in functions for portfolio management
- **Web Search** - Integrated search via SerpAPI, Brave Search
- **Financial Data** - Analyst ratings, price targets, financial ratios
- **Multi-Provider** - Fallback support for multiple LLM providers
- **Usage Tracking** - Track API usage and costs

## Installation

### Via Composer (from GitHub)

Add the repository to your project's `composer.json`:

```json
{
    "repositories": [
        {
            "type": "vcs",
            "url": "https://github.com/your-username/ai-portfolio-assistant"
        }
    ],
    "require": {
        "quantis/ai-portfolio-assistant": "^1.0"
    }
}
```

Then run:

```bash
composer install
```

### Local Development

For local development, use path repository:

```json
{
    "repositories": [
        {
            "type": "path",
            "url": "/path/to/ai-portfolio-assistant"
        }
    ],
    "require": {
        "quantis/ai-portfolio-assistant": "*"
    }
}
```

## Quick Start

### Basic Usage

```php
<?php

require 'vendor/autoload.php';

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

// Create instance with configuration
$assistant = new AIPortfolioAssistant([
    'claude' => [
        'api_key' => 'your-claude-api-key',
        'model' => 'claude-sonnet-4-5-20250929',
    ],
]);

// Send a chat message
$response = $assistant->chat("What are the top performing tech stocks today?");

echo $response['text'];
```

### With Database (Full Portfolio Features)

```php
<?php

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

$pdo = new PDO('mysql:host=localhost;dbname=your_db', 'user', 'password');

$assistant = new AIPortfolioAssistant([
    'claude' => ['api_key' => 'your-api-key'],
    'search' => [
        'serpapi' => ['api_key' => 'your-serpapi-key'],
    ],
    'financial' => [
        'fmp' => ['api_key' => 'your-fmp-key'],
    ],
]);

// Enable portfolio functions
$assistant->setDatabase($pdo);

// Chat with user context
$userId = 123;
$response = $assistant->chat(
    "What's in my portfolio and how is it performing?",
    $userId
);
```

### Using Environment Variables

```php
<?php

// Set environment variables:
// CLAUDE_API_KEY=your-key
// SERPAPI_API_KEY=your-key
// FMP_API_KEY=your-key

$assistant = AIPortfolioAssistant::fromEnvironment();
```

### Using Config File

```php
<?php

$assistant = AIPortfolioAssistant::fromConfigFile('/path/to/config.php');
```

## Configuration

### Full Configuration Options

```php
$config = [
    // Claude AI
    'claude' => [
        'api_key' => '',
        'model' => 'claude-sonnet-4-5-20250929',
        'max_tokens' => 4000,
        'temperature' => 0.7,
        'base_url' => 'https://api.anthropic.com',
        'api_version' => '2023-06-01',
    ],

    // Search APIs
    'search' => [
        'serpapi' => ['api_key' => ''],
        'brave' => ['api_key' => ''],
    ],

    // Financial Data
    'financial' => [
        'fmp' => ['api_key' => ''], // Financial Modeling Prep
    ],

    // SSE Streaming
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
    'default_provider' => 'claude',

    // Max recursion for tool calls
    'max_recursion_depth' => 10,
];
```

## Conversation Management

### Using Conversation Objects

```php
<?php

// Create a new conversation
$conversation = $assistant->createConversation($userId);

// Chat with conversation history
$response = $assistant->chatWithConversation(
    "Show my portfolio",
    $conversation
);

// Continue the conversation
$response = $assistant->chatWithConversation(
    "What's my best performing asset?",
    $conversation
);

// Access conversation history
$messages = $conversation->getMessages();
$history = $conversation->getHistory(); // Array format for API
```

### Manual History Management

```php
<?php

$conversationHistory = [
    ['role' => 'user', 'content' => 'Show my portfolio'],
    ['role' => 'assistant', 'content' => 'Your portfolio contains...'],
];

$response = $assistant->chat(
    "What's the total value?",
    $userId,
    $conversationHistory
);
```

## Streaming Responses

### SSE Streaming

```php
<?php

// Generate session ID
$sessionId = 'chat_' . time() . '_' . uniqid();

// Stream response
$response = $assistant->streamChat(
    "Analyze my portfolio",
    $sessionId,
    $userId
);
```

### Frontend JavaScript

```javascript
const sessionId = 'chat_' + Date.now() + '_' + Math.random().toString(36);

const eventSource = new EventSource(`/api/sse?session=${sessionId}`);

eventSource.addEventListener('progress', (e) => {
    console.log('Progress:', e.data);
});

eventSource.addEventListener('response', (e) => {
    const response = JSON.parse(e.data);
    console.log('Response:', response.text);
});

eventSource.addEventListener('complete', () => {
    eventSource.close();
});
```

## Custom Functions

### Registering Custom Functions

```php
<?php

$assistant->registerFunction(
    'get_stock_price',
    function (array $params, mixed $userId) {
        $symbol = $params['symbol'];
        // Your implementation
        return ['price' => 150.25, 'symbol' => $symbol];
    },
    [
        'description' => 'Get current stock price',
        'input_schema' => [
            'type' => 'object',
            'properties' => [
                'symbol' => [
                    'type' => 'string',
                    'description' => 'Stock symbol',
                ],
            ],
            'required' => ['symbol'],
        ],
    ]
);
```

### Loading Tools from JSON

```php
<?php

$assistant->loadToolsFromJson('/path/to/custom_tools.json');
```

## Built-in Functions

### Portfolio Functions
- `get_portfolios` - List all user portfolios
- `get_portfolio_assets_with_discovery` - Get portfolio holdings with values
- `get_portfolio_diversification` - Diversification analysis
- `get_all_transactions` - Transaction history

### Watchlist Functions
- `get_user_watchlist` - Get tracked assets
- `get_watchlist_with_market_data` - Watchlist with prices
- `add_to_watchlist` - Add asset to watchlist
- `remove_from_watchlist` - Remove from watchlist

### Analysis Functions
- `get_analyst_ratings` - Analyst recommendations
- `get_financial_ratios` - P/E, ROE, etc.
- `get_price_targets` - Price target consensus
- `get_company_profile` - Company information
- `get_crypto_news` - Cryptocurrency news

### Search Functions
- `serpapi_search` - Google search via SerpAPI
- `brave_search` - Brave Search API
- `search_assets` - Search for assets

## Database Schema

For full portfolio functionality, create these tables:

```sql
-- Portfolios
CREATE TABLE portfolios (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    currency VARCHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Assets
CREATE TABLE assets (
    id INT PRIMARY KEY AUTO_INCREMENT,
    symbol VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type ENUM('stock', 'crypto', 'etf', 'bond', 'commodity'),
    exchange VARCHAR(50),
    currency VARCHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Portfolio Assets
CREATE TABLE portfolio_assets (
    id INT PRIMARY KEY AUTO_INCREMENT,
    portfolio_id INT NOT NULL,
    asset_id INT NOT NULL,
    quantity DECIMAL(20,8) NOT NULL,
    average_cost DECIMAL(20,8),
    total_cost DECIMAL(20,2),
    current_value DECIMAL(20,2),
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id),
    FOREIGN KEY (asset_id) REFERENCES assets(id)
);

-- Watchlist
CREATE TABLE watchlist (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    asset_id INT NOT NULL,
    alert_price_above DECIMAL(20,8),
    alert_price_below DECIMAL(20,8),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id)
);

-- LLM Usage Tracking
CREATE TABLE llm_requests (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    provider VARCHAR(50),
    model VARCHAR(100),
    request_type VARCHAR(50),
    input_tokens INT,
    output_tokens INT,
    total_tokens INT,
    estimated_cost DECIMAL(10,6),
    response_time_ms INT,
    function_calls_count INT,
    status VARCHAR(20),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## API Reference

### AIPortfolioAssistant

| Method | Description |
|--------|-------------|
| `chat($message, $userId, $history, $options)` | Send chat message |
| `streamChat($message, $sessionId, $userId, $history, $options)` | Stream response |
| `chatWithConversation($message, $conversation, $options)` | Chat with conversation object |
| `registerFunction($name, $handler, $schema)` | Register custom function |
| `setDatabase($pdo)` | Enable portfolio functions |
| `setModel($model)` | Change Claude model |
| `getAvailableProviders()` | List available providers |
| `createConversation($userId)` | Create new conversation |

### Response Format

```php
[
    'text' => 'Response text from Claude',
    'usage' => [
        'input_tokens' => 150,
        'output_tokens' => 500,
        'total_tokens' => 650,
        'function_calls' => 2,
    ],
    'model' => 'claude-sonnet-4-5-20250929',
    'provider' => 'claude',
    'provider_used' => 'claude',
    'fallback_used' => false,
]
```

## Error Handling

```php
<?php

use Quantis\AIPortfolioAssistant\Exceptions\ProviderException;
use Quantis\AIPortfolioAssistant\Exceptions\ConfigurationException;

try {
    $response = $assistant->chat("Hello");
} catch (ProviderException $e) {
    if ($e->getHttpStatusCode() === 429) {
        // Rate limited
    } elseif ($e->getHttpStatusCode() === 401) {
        // Invalid API key
    }
} catch (ConfigurationException $e) {
    // Configuration error
}
```

## License

MIT License

## Support

For issues and feature requests, please open an issue on GitHub.
