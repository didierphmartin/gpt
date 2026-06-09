# External Services Integration Guide

This document explains how external services (PubMed, Battery News, Metals News, etc.) are integrated into the GPT backend to provide specialized tools for the LLM.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Integration Components](#integration-components)
3. [PubMed Service](#pubmed-service)
4. [Battery News Service](#battery-news-service)
5. [Metals News Service](#metals-news-service)
6. [Adding New Services](#adding-new-services)
7. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

External services follow a three-layer architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                         GPT Frontend                            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GPT Backend                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ AIPortfolio     │  │ ToolsManager    │  │ LLMManager      │  │
│  │ Assistant       │──│ (registry)      │──│ (Claude/OpenAI) │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                    │                                │
│           ▼                    ▼                                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Functions Classes                        ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ ││
│  │  │ PubMed       │ │ BatteryNews  │ │ CryptoNews/Financial │ ││
│  │  │ Functions    │ │ Functions    │ │ Functions            │ ││
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                                │
                    HTTP Requests to External Services
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│ PubMed        │      │ Battery News  │      │ Other         │
│ Service       │      │ Service       │      │ Services      │
│ /pubmed/public│      │ /batteries/   │      │               │
└───────────────┘      │ public        │      └───────────────┘
                       └───────────────┘
```

### Data Flow

1. **User Request** → User asks a question (e.g., "What's the latest battery news?")
2. **LLM Analysis** → Claude/OpenAI analyzes the request and available tools
3. **Tool Selection** → LLM decides to call `battery_news_get_all` tool
4. **Function Execution** → `BatteryNewsFunctions::getAllBatteryNews()` is called
5. **HTTP Request** → Function makes HTTP request to external service
6. **Response Processing** → Results formatted and returned to LLM
7. **Final Response** → LLM generates human-readable response for user

---

## Integration Components

### 1. Configuration (`config/ai_config.php`)

Each external service needs a configuration entry with at minimum a `service_url`:

```php
// PubMed Service Configuration
'pubmed' => [
    'service_url' => 'http://localhost/pubmed/public',
],

// Battery News Service Configuration
'battery_news' => [
    'service_url' => 'http://localhost/batteries/public',
],
```

### 2. Functions Class (`src/Functions/`)

Each service needs a Functions class that defines:
- **Tool schemas** (descriptions and parameters for the LLM)
- **Handlers** (methods that call the external service)

Location: `backend/src/Functions/{ServiceName}Functions.php`

### 3. Registration (`src/AIPortfolioAssistant.php`)

Functions must be registered in the `registerSearchFunctions()` method:

```php
// Import at top of file
use Quantis\AIPortfolioAssistant\Functions\{ServiceName}Functions;

// Register in registerSearchFunctions()
$serviceFunctions = new {ServiceName}Functions($this->config);
$this->toolsManager->registerFunctions($serviceFunctions->getAllFunctions());
```

### 4. External Service

The external service must expose REST endpoints:
- `GET /tools` - Returns tool definitions
- `POST /tools/execute` - Executes a tool call

---

## PubMed Service

### Overview

PubMed is a biomedical literature database. The integration allows the LLM to search medical research articles.

### Configuration

```php
// config/ai_config.php
'pubmed' => [
    'service_url' => 'http://localhost/pubmed/public',
],
```

### Available Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `pubmed_search` | Search PubMed for articles | `query` (required), `max_results`, `include_abstracts` |
| `pubmed_build_query` | Build structured search query | `mesh_terms`, `title_terms`, `author`, `date_start`, `date_end`, `combine_with` |
| `pubmed_mesh_suggestions` | Get MeSH term suggestions | `topic` (required) |

### Files

| File | Purpose |
|------|---------|
| `backend/src/Functions/PubMedFunctions.php` | Tool definitions and handlers |
| `backend/config/ai_config.php` | Service URL configuration |
| `/pubmed/public/index.php` | External service entry point |
| `/pubmed/src/FunctionToolInterface.php` | Service-side tool definitions |

### Service Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tools` | GET | List available tools |
| `/tools/execute` | POST | Execute a tool |
| `/search` | POST | Direct search endpoint |
| `/mesh/suggestions` | GET | Get MeSH suggestions |
| `/query/build` | POST | Build structured query |
| `/health` | GET | Health check |

### Example Usage

User prompt: *"Find recent research on diabetes treatment"*

LLM tool call:
```json
{
  "name": "pubmed_search",
  "input": {
    "query": "diabetes treatment",
    "max_results": 10,
    "include_abstracts": true
  }
}
```

Handler execution:
```php
// PubMedFunctions::searchPubMed()
$response = $this->httpClient->post("{$this->pubmedServiceUrl}/search", [
    'json' => [
        'query' => $query,
        'max_results' => $maxResults,
        'include_abstracts' => $includeAbstracts,
    ],
]);
```

---

## Battery News Service

### Overview

Battery News aggregates news from multiple RSS feeds covering battery technology, electric vehicles, and energy storage.

### Configuration

```php
// config/ai_config.php
'battery_news' => [
    'service_url' => 'http://localhost/batteries/public',
],
```

### Available Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `battery_news_get_all` | Get latest battery/EV news | `limit` (optional, default: 20, max: 200) |
| `battery_news_search` | Search news by keyword | `keyword` (required), `limit` (optional) |

### Files

| File | Purpose |
|------|---------|
| `backend/src/Functions/BatteryNewsFunctions.php` | Tool definitions and handlers |
| `backend/config/ai_config.php` | Service URL configuration |
| `/batteries/public/index.php` | External service entry point |
| `/batteries/src/FunctionToolsHandler.php` | Service-side tool definitions |
| `/batteries/config.php` | RSS feeds configuration |

### Service Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tools` | GET | List available tools |
| `/tools/execute` | POST | Execute a tool |
| `/mcp` | POST | MCP protocol endpoint |
| `/feeds` | GET | List configured RSS feeds |
| `/cache/clear` | GET | Clear RSS cache |
| `/health` | GET | Health check |

### RSS Feed Sources

| Source | Category | URL |
|--------|----------|-----|
| InsideEVs | ev_battery | `https://insideevs.com/rss/articles/all` |
| Electrek | ev_tech | `https://electrek.co/feed/` |
| CleanTechnica | cleantech | `https://cleantechnica.com/feed/` |
| BatteriesNews | battery_industry | `https://batteriesnews.com/feed/` |
| ScienceDaily | research | `https://www.sciencedaily.com/rss/matter_energy/batteries.xml` |

### Example Usage

User prompt: *"What's the latest news about solid-state batteries?"*

LLM tool call:
```json
{
  "name": "battery_news_search",
  "input": {
    "keyword": "solid-state",
    "limit": 10
  }
}
```

Handler execution:
```php
// BatteryNewsFunctions::searchBatteryNews()
$response = $this->httpClient->post("{$this->batteryNewsServiceUrl}/tools/execute", [
    'json' => [
        'tool_name' => 'search_battery_news',
        'arguments' => [
            'keyword' => $keyword,
            'limit' => $limit,
        ],
    ],
]);
```

---

## Metals News Service

### Overview

Metals News aggregates news from multiple RSS feeds covering precious metals (gold, silver, platinum, palladium) and base metals (copper, aluminum, zinc).

### Configuration

```php
// config/ai_config.php
'metals_news' => [
    'service_url' => 'http://localhost/metals/public',
],
```

### Available Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `metals_news_get_all` | Get latest metals news | `limit` (optional, default: 20, max: 200) |
| `metals_news_search` | Search news by keyword | `keyword` (required), `limit` (optional) |

### Files

| File | Purpose |
|------|---------|
| `backend/src/Functions/MetalsNewsFunctions.php` | Tool definitions and handlers |
| `backend/config/ai_config.php` | Service URL configuration |
| `/metals/public/index.php` | External service entry point |
| `/metals/src/FunctionToolsHandler.php` | Service-side tool definitions |
| `/metals/config.php` | RSS feeds configuration |

### Service Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tools` | GET | List available tools |
| `/tools/execute` | POST | Execute a tool |
| `/mcp` | POST | MCP protocol endpoint |
| `/feeds` | GET | List configured feeds |
| `/cache/clear` | GET | Clear RSS cache |
| `/health` | GET | Health check |

### RSS Feed Categories

| Category | Description |
|----------|-------------|
| precious_metals | Gold, Silver, Platinum, Palladium news |
| base_metals | Copper, Aluminum, Zinc, Nickel news |
| mining | Mining industry news and analysis |
| commodities | General commodities market news |

### Example Usage

User prompt: *"What's the latest news about gold prices?"*

LLM tool call:
```json
{
  "name": "metals_news_search",
  "input": {
    "keyword": "gold prices",
    "limit": 10
  }
}
```

Handler execution:
```php
// MetalsNewsFunctions::searchMetalsNews()
$response = $this->httpClient->post("{$this->metalsNewsServiceUrl}/tools/execute", [
    'json' => [
        'tool_name' => 'search_metals_news',
        'arguments' => [
            'keyword' => $keyword,
            'limit' => $limit,
        ],
    ],
]);
```

---

## Adding New Services

Follow these steps to integrate a new external service:

### Step 1: Create the External Service

Create a new service with the standard endpoint structure:

```
/new-service/
├── public/
│   ├── index.php          # REST API entry point
│   └── .htaccess          # URL rewriting
├── src/
│   └── ...                # Service logic
└── config.php             # Service configuration
```

Required endpoints:
- `GET /tools` - Return tool definitions in OpenAI format
- `POST /tools/execute` - Execute tool calls

### Step 2: Add Configuration

Add service URL to `backend/config/ai_config.php`:

```php
'new_service' => [
    'service_url' => 'http://localhost/new-service/public',
],
```

### Step 3: Create Functions Class

Create `backend/src/Functions/NewServiceFunctions.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Functions;

use GuzzleHttp\Client;
use Quantis\AIPortfolioAssistant\Config\Configuration;

class NewServiceFunctions
{
    private Configuration $config;
    private Client $httpClient;
    private string $serviceUrl;

    public function __construct(Configuration $config)
    {
        $this->config = $config;
        $this->httpClient = new Client(['timeout' => 30]);
        $this->serviceUrl = $config->get('new_service.service_url', 'http://localhost/new-service/public');
    }

    public function getAllFunctions(): array
    {
        return [
            'new_service_action' => [
                'handler' => [$this, 'performAction'],
                'schema' => [
                    'description' => 'Description of what this tool does for the LLM',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'param1' => [
                                'type' => 'string',
                                'description' => 'Description of param1',
                            ],
                        ],
                        'required' => ['param1'],
                    ],
                ],
            ],
        ];
    }

    public function performAction(array $params, mixed $userId): array
    {
        try {
            $response = $this->httpClient->post("{$this->serviceUrl}/tools/execute", [
                'json' => [
                    'tool_name' => 'service_tool_name',
                    'arguments' => $params,
                ],
            ]);

            $data = json_decode($response->getBody()->getContents(), true);

            if (!($data['success'] ?? false)) {
                return ['error' => $data['error'] ?? 'Action failed'];
            }

            return [
                'success' => true,
                'data' => $data,
            ];
        } catch (\Exception $e) {
            return ['error' => 'Service error: ' . $e->getMessage()];
        }
    }
}
```

### Step 4: Register Functions

Edit `backend/src/AIPortfolioAssistant.php`:

```php
// Add import at top
use Quantis\AIPortfolioAssistant\Functions\NewServiceFunctions;

// Add in registerSearchFunctions() method
$newServiceFunctions = new NewServiceFunctions($this->config);
$this->toolsManager->registerFunctions($newServiceFunctions->getAllFunctions());
```

### Step 5: Test Integration

1. Verify service is accessible: `curl http://localhost/new-service/public/health`
2. Check tools are listed: `curl http://localhost/new-service/public/tools`
3. Test tool execution:
   ```bash
   curl -X POST http://localhost/new-service/public/tools/execute \
     -H "Content-Type: application/json" \
     -d '{"tool_name":"tool_name","arguments":{"param":"value"}}'
   ```
4. Test via GPT frontend with relevant prompts

---

## Troubleshooting

### Tools Not Appearing

1. **Check registration**: Verify Functions class is imported and registered in `AIPortfolioAssistant.php`
2. **Check syntax**: Run `php -l` on all modified PHP files
3. **Check service URL**: Ensure `service_url` in config is correct
4. **Check service health**: `curl {service_url}/health`

### Tool Calls Failing

1. **Check HTTP connectivity**: Can backend reach the service?
2. **Check request format**: Does `tools/execute` expect `tool_name` or `function`?
3. **Check response format**: Is response JSON with `success` field?
4. **Check logs**: Look for errors in PHP error logs

### Service Not Responding

1. **Check Apache**: Is the service's virtual host/directory configured?
2. **Check .htaccess**: Is URL rewriting working?
3. **Check PHP errors**: `tail -f /path/to/php_error.log`

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| 404 on /tools | Missing .htaccess | Add URL rewriting rules |
| "Unknown function" | Not registered | Add to `registerSearchFunctions()` |
| Connection refused | Wrong service URL | Check `ai_config.php` |
| Timeout errors | Slow service | Increase Guzzle timeout |
| Empty results | Cache stale | Clear service cache |

---

## Quick Reference

### File Locations

| Component | Location |
|-----------|----------|
| Backend config | `backend/config/ai_config.php` |
| Functions classes | `backend/src/Functions/` |
| Registration | `backend/src/AIPortfolioAssistant.php` |
| PubMed service | `/pubmed/public/` |
| Battery service | `/batteries/public/` |
| Metals service | `/metals/public/` |

### Required Endpoints (External Service)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/tools` | GET | Return tool definitions |
| `/tools/execute` | POST | Execute tool calls |
| `/health` | GET | Health check (optional) |

### Tool Definition Format

```php
'tool_name' => [
    'handler' => [$this, 'methodName'],
    'schema' => [
        'description' => 'What the tool does (shown to LLM)',
        'input_schema' => [
            'type' => 'object',
            'properties' => [
                'param' => [
                    'type' => 'string|integer|boolean|array',
                    'description' => 'What this parameter does',
                ],
            ],
            'required' => ['param'],
        ],
    ],
],
```
