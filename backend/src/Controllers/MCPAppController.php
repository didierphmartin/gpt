<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;

/**
 * MCP App Controller
 *
 * Fetches MCP app HTML via the resources/read protocol and serves it directly.
 */
class MCPAppController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Get MCP app resource (returns HTML directly, not JSON)
     *
     * This method is special - it outputs HTML directly and should be called
     * from a route handler that doesn't JSON-encode the response.
     */
    public function getResource(array $request): array
    {
        $serverUrl = $request['query']['server'] ?? '';
        $resourceUri = $request['query']['resource'] ?? '';
        $west = $request['query']['west'] ?? '';
        $south = $request['query']['south'] ?? '';
        $east = $request['query']['east'] ?? '';
        $north = $request['query']['north'] ?? '';
        $label = $request['query']['label'] ?? '';
        $viewUUID = $request['query']['viewUUID'] ?? '';

        if (!$serverUrl) {
            return [
                'error' => 'Missing server parameter',
                'status_code' => 400,
                'content_type' => 'text/plain'
            ];
        }

        if (!$resourceUri) {
            return [
                'error' => 'Missing resource parameter',
                'status_code' => 400,
                'content_type' => 'text/plain'
            ];
        }

        // Normalize URL: servers ending in .php are already the endpoint
        // (e.g. XAMPP-style mcp-server.php). Only append /mcp otherwise.
        $mcpUrl = rtrim($serverUrl, '/');
        if (!str_ends_with($mcpUrl, '/mcp') && !str_ends_with($mcpUrl, '.php')) {
            $mcpUrl .= '/mcp';
        }

        // Initialize MCP session
        $initRequest = [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'initialize',
            'params' => [
                'protocolVersion' => '2024-11-05',
                'clientInfo' => [
                    'name' => 'GPT-Chatbot-MCP-App-Proxy',
                    'version' => '1.0.0'
                ],
                'capabilities' => new \stdClass()
            ]
        ];

        $initResponse = $this->sendMCPRequest($mcpUrl, $initRequest);
        if (!$initResponse || isset($initResponse['error'])) {
            return [
                'error' => 'Failed to initialize MCP session',
                'status_code' => 502,
                'content_type' => 'text/plain'
            ];
        }

        // Send initialized notification
        $this->sendMCPRequest($mcpUrl, [
            'jsonrpc' => '2.0',
            'method' => 'notifications/initialized',
            'params' => new \stdClass()
        ], false);

        // Fetch the UI resource
        $resourceRequest = [
            'jsonrpc' => '2.0',
            'id' => 2,
            'method' => 'resources/read',
            'params' => [
                'uri' => $resourceUri
            ]
        ];

        $resourceResponse = $this->sendMCPRequest($mcpUrl, $resourceRequest);

        if (!$resourceResponse || isset($resourceResponse['error'])) {
            return [
                'error' => 'Failed to fetch MCP resource: ' . ($resourceResponse['error']['message'] ?? 'Unknown error'),
                'status_code' => 502,
                'content_type' => 'text/plain'
            ];
        }

        // Extract HTML content
        $htmlContent = $resourceResponse['result']['contents'][0]['text'] ?? null;

        if (!$htmlContent) {
            return [
                'error' => 'No HTML content in MCP resource',
                'status_code' => 502,
                'content_type' => 'text/plain'
            ];
        }

        // Inject initialization script with the tool arguments
        $initData = json_encode([
            'west' => $west !== '' ? (float)$west : null,
            'south' => $south !== '' ? (float)$south : null,
            'east' => $east !== '' ? (float)$east : null,
            'north' => $north !== '' ? (float)$north : null,
            'label' => $label,
            'viewUUID' => $viewUUID,
            'serverUrl' => $serverUrl
        ]);

        $initScript = <<<SCRIPT
<script>
    // MCP App initialization data from parent
    window.MCP_INIT_DATA = {$initData};

    // Override the MCP server URL to point to the actual server
    window.MCP_SERVER_URL = '{$serverUrl}';

    // Dispatch init event when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));
        });
    } else {
        window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));
    }
</script>
SCRIPT;

        // Inject before </head> or at the start
        if (strpos($htmlContent, '</head>') !== false) {
            $htmlContent = str_replace('</head>', $initScript . '</head>', $htmlContent);
        } else {
            $htmlContent = $initScript . $htmlContent;
        }

        return [
            'html' => $htmlContent,
            'status_code' => 200,
            'content_type' => 'text/html; charset=utf-8'
        ];
    }

    /**
     * Send request to MCP server
     */
    private function sendMCPRequest(string $url, array $request, bool $expectResponse = true): ?array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($request),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json, text/event-stream, */*'
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode >= 400 || !$response) {
            return null;
        }

        if (!$expectResponse) {
            return ['success' => true];
        }

        // Try JSON first
        $decoded = json_decode($response, true);
        if ($decoded !== null) {
            return $decoded;
        }

        // Try SSE format
        $lines = explode("\n", $response);
        foreach ($lines as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'data:')) {
                $data = trim(substr($line, 5));
                if (!empty($data)) {
                    $parsed = json_decode($data, true);
                    if ($parsed !== null) {
                        return $parsed;
                    }
                }
            }
        }

        return null;
    }
}
