<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;

/**
 * MCP Proxy Controller
 *
 * Forwards JSON-RPC 2.0 requests from the frontend to configured MCP servers.
 * This proxy avoids CORS issues and keeps MCP server URLs secure.
 */
class MCPProxyController
{
    private PDO $db;
    private array $config;
    private ?string $lastError = null;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->ensureTablesExist();
    }

    /**
     * Forward JSON-RPC request to MCP server
     */
    public function forward(array $request): array
    {
        $input = $request['body'];

        $action = $input['action'] ?? null;
        // server_id arrives as a string when round-tripped through JSON
        // (PDO::lastInsertId returns string); normalize to ?int for the strict
        // signatures on proxyRequest() and discoverTools().
        $rawServerId = $input['server_id'] ?? null;
        $serverId = ($rawServerId === null || $rawServerId === '') ? null : (int) $rawServerId;
        $serverUrl = $input['server_url'] ?? null;
        $userId = (string) ($input['user_id'] ?? $request['user_id'] ?? 'demo-user');

        switch ($action) {
            case 'proxy':
                return $this->proxyRequest($serverUrl, $serverId, $input['jsonrpc'] ?? null, $userId);

            case 'test_connection':
                return $this->testConnection($serverUrl);

            case 'discover_tools':
                if (!is_string($serverUrl) || $serverUrl === '') {
                    return [
                        'success' => false,
                        'error' => ['code' => -32602, 'message' => 'Server URL required'],
                        'status_code' => 400
                    ];
                }
                return $this->discoverTools($serverUrl, $serverId, $userId);

            default:
                return [
                    'success' => false,
                    'error' => ['code' => -32600, 'message' => 'Unknown action: ' . $action],
                    'status_code' => 400
                ];
        }
    }

    /**
     * Proxy a JSON-RPC request to an MCP server
     */
    private function proxyRequest(?string $serverUrl, ?int $serverId, ?array $jsonrpc, string $userId): array
    {
        // Get server URL from ID if not provided directly
        if (!$serverUrl && $serverId) {
            $serverUrl = $this->getServerUrl($serverId, $userId);
        }

        // Look up custom headers by server id (global or caller's user scope)
        $extraHeaders = $serverId ? $this->getServerHeaders($serverId, $userId) : [];

        if (!$serverUrl) {
            return [
                'success' => false,
                'error' => ['code' => -32602, 'message' => 'Server URL required'],
                'status_code' => 400
            ];
        }

        if (!$jsonrpc) {
            return [
                'success' => false,
                'error' => ['code' => -32602, 'message' => 'JSON-RPC request required'],
                'status_code' => 400
            ];
        }

        // Ensure proper JSON-RPC structure
        if (!isset($jsonrpc['jsonrpc'])) {
            $jsonrpc['jsonrpc'] = '2.0';
        }
        if (!isset($jsonrpc['id'])) {
            $jsonrpc['id'] = time();
        }

        // Ensure params.arguments is an object, not an array (for tools/call)
        $method = $jsonrpc['method'] ?? '';
        if ($method === 'tools/call' && isset($jsonrpc['params'])) {
            if (!isset($jsonrpc['params']['arguments']) ||
                (is_array($jsonrpc['params']['arguments']) && empty($jsonrpc['params']['arguments']))) {
                $jsonrpc['params']['arguments'] = new \stdClass();
            }
        }

        // For resources/read and tools/call requests, initialize the MCP session first
        if (str_starts_with($method, 'resources/') || str_starts_with($method, 'tools/')) {
            $initRequest = [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'initialize',
                'params' => [
                    'protocolVersion' => '2024-11-05',
                    'clientInfo' => [
                        'name' => 'GPT-Chatbot-MCP-Client',
                        'version' => '1.0.0'
                    ],
                    'capabilities' => new \stdClass()
                ]
            ];

            $initResponse = $this->sendToMCPServer($serverUrl, $initRequest, true, $extraHeaders);
            if ($initResponse === null || isset($initResponse['error'])) {
                return [
                    'success' => false,
                    'error' => ['code' => -32603, 'message' => 'Failed to initialize MCP session'],
                    'status_code' => 500
                ];
            }

            // Send initialized notification
            $this->sendToMCPServer($serverUrl, [
                'jsonrpc' => '2.0',
                'method' => 'notifications/initialized',
                'params' => new \stdClass()
            ], false, $extraHeaders);
        }

        // Forward request to MCP server
        $response = $this->sendToMCPServer($serverUrl, $jsonrpc, true, $extraHeaders);

        if ($response === null) {
            return [
                'success' => false,
                'error' => ['code' => -32603, 'message' => 'Failed to connect to MCP server'],
                'status_code' => 500
            ];
        }

        return [
            'success' => true,
            'response' => $response,
            'status_code' => 200
        ];
    }

    /**
     * Test connection to an MCP server
     */
    private function testConnection(?string $serverUrl): array
    {
        if (!$serverUrl) {
            return [
                'success' => false,
                'error' => ['code' => -32602, 'message' => 'Server URL required'],
                'status_code' => 400
            ];
        }

        // Send initialize request
        $initRequest = [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'initialize',
            'params' => [
                'protocolVersion' => '2024-11-05',
                'clientInfo' => [
                    'name' => 'GPT-Chatbot-MCP-Client',
                    'version' => '1.0.0'
                ],
                'capabilities' => new \stdClass()
            ]
        ];

        $response = $this->sendToMCPServer($serverUrl, $initRequest);

        if ($response === null) {
            $trimmed = rtrim($serverUrl, '/');
            $urlTried = (str_ends_with($trimmed, '/mcp') || str_ends_with($trimmed, '.php'))
                ? $trimmed
                : $trimmed . '/mcp';
            return [
                'success' => false,
                'error' => $this->lastError ?? 'Failed to connect to MCP server',
                'url_tried' => $urlTried,
                'status_code' => 500
            ];
        }

        if (isset($response['error'])) {
            return [
                'success' => false,
                'error' => $response['error']['message'] ?? 'Unknown error',
                'details' => $response['error'],
                'status_code' => 500
            ];
        }

        return [
            'success' => true,
            'serverInfo' => $response['result']['serverInfo'] ?? null,
            'capabilities' => $response['result']['capabilities'] ?? null,
            'status_code' => 200
        ];
    }

    /**
     * Discover tools from an MCP server
     */
    private function discoverTools(string $serverUrl, ?int $serverId, string $userId): array
    {
        $extraHeaders = $serverId ? $this->getServerHeaders($serverId, $userId) : [];
        if (!$serverUrl) {
            return [
                'success' => false,
                'error' => ['code' => -32602, 'message' => 'Server URL required'],
                'status_code' => 400
            ];
        }

        // First initialize
        $initRequest = [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'initialize',
            'params' => [
                'protocolVersion' => '2024-11-05',
                'clientInfo' => [
                    'name' => 'GPT-Chatbot-MCP-Client',
                    'version' => '1.0.0'
                ],
                'capabilities' => new \stdClass()
            ]
        ];

        $initResponse = $this->sendToMCPServer($serverUrl, $initRequest, true, $extraHeaders);

        if ($initResponse === null) {
            return [
                'success' => false,
                'error' => ['code' => -32603, 'message' => $this->lastError ?? 'Failed to initialize MCP server'],
                'status_code' => 500
            ];
        }

        if (isset($initResponse['error'])) {
            return [
                'success' => false,
                'error' => ['code' => -32603, 'message' => $initResponse['error']['message'] ?? 'MCP server returned error'],
                'status_code' => 500
            ];
        }

        // Send initialized notification
        $this->sendToMCPServer($serverUrl, [
            'jsonrpc' => '2.0',
            'method' => 'notifications/initialized',
            'params' => new \stdClass()
        ], false, $extraHeaders);

        // List tools
        $toolsRequest = [
            'jsonrpc' => '2.0',
            'id' => 2,
            'method' => 'tools/list',
            'params' => new \stdClass()
        ];

        $toolsResponse = $this->sendToMCPServer($serverUrl, $toolsRequest, true, $extraHeaders);

        if ($toolsResponse === null || isset($toolsResponse['error'])) {
            return [
                'success' => false,
                'error' => ['code' => -32603, 'message' => 'Failed to list tools from MCP server'],
                'status_code' => 500
            ];
        }

        $tools = $toolsResponse['result']['tools'] ?? [];

        // Cache tools in database if we have a server ID
        if ($serverId) {
            $this->cacheTools($serverId, $tools);
        }

        return [
            'success' => true,
            'serverInfo' => $initResponse['result']['serverInfo'] ?? null,
            'tools' => $tools,
            'status_code' => 200
        ];
    }

    /**
     * Send request to MCP server
     */
    private function sendToMCPServer(string $serverUrl, array $request, bool $expectResponse = true, array $extraHeaders = []): ?array
    {
        $this->lastError = null;

        // Normalize URL: some MCP servers are exposed as XAMPP-style
        // .php scripts (e.g. mcp-server.php) that ARE the endpoint already.
        // Only append /mcp when the URL doesn't already end in /mcp or .php.
        $mcpUrl = rtrim($serverUrl, '/');
        if (!str_ends_with($mcpUrl, '/mcp') && !str_ends_with($mcpUrl, '.php')) {
            $mcpUrl .= '/mcp';
        }

        $baseHeaders = [
            'Content-Type: application/json',
            'Accept: application/json, text/event-stream, */*'
        ];
        $headers = array_merge($baseHeaders, $extraHeaders);

        $ch = curl_init($mcpUrl);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($request),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        $errno = curl_errno($ch);
        curl_close($ch);

        if ($error) {
            $this->lastError = "Connection failed: $error (code: $errno)";
            return null;
        }

        if ($httpCode === 0) {
            $this->lastError = "Could not connect to server at $mcpUrl";
            return null;
        }

        if ($httpCode >= 400) {
            $errorDetails = '';
            $parsed = json_decode($response, true);
            if ($parsed && isset($parsed['error']['message'])) {
                $errorDetails = ': ' . $parsed['error']['message'];
            }
            $this->lastError = "Server returned HTTP $httpCode$errorDetails";
            return null;
        }

        if (!$expectResponse) {
            return ['success' => true];
        }

        // Try to parse as plain JSON
        $decoded = json_decode($response, true);
        if ($decoded !== null) {
            return $decoded;
        }

        // Try to parse as SSE format
        $decoded = $this->parseSSEResponse($response);
        if ($decoded !== null) {
            return $decoded;
        }

        $this->lastError = "Server returned invalid response format";
        return null;
    }

    /**
     * Parse Server-Sent Events (SSE) response format
     */
    private function parseSSEResponse(string $response): ?array
    {
        $lines = explode("\n", $response);
        $jsonData = null;

        foreach ($lines as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'data:')) {
                $data = trim(substr($line, 5));
                if (!empty($data)) {
                    $parsed = json_decode($data, true);
                    if ($parsed !== null) {
                        $jsonData = $parsed;
                    }
                }
            }
        }

        return $jsonData;
    }

    /**
     * Get server URL from database
     */
    private function getServerUrl(int $serverId, string $userId): ?string
    {
        $stmt = $this->db->prepare("
            SELECT url FROM mcp_servers
            WHERE id = ? AND user_id = ? AND enabled = 1
        ");
        $stmt->execute([$serverId, $userId]);
        $row = $stmt->fetch();

        return $row['url'] ?? null;
    }

    /**
     * Get custom headers for an MCP server (global or caller-scoped),
     * returned as "Name: value" strings for CURLOPT_HTTPHEADER.
     */
    private function getServerHeaders(int $serverId, string $userId): array
    {
        try {
            $stmt = $this->db->prepare("
                SELECT headers FROM mcp_servers
                WHERE id = ? AND (user_id IS NULL OR user_id = ?)
                LIMIT 1
            ");
            $stmt->execute([$serverId, $userId]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            if (!$row || empty($row['headers'])) return [];
            $decoded = json_decode($row['headers'], true);
            if (!is_array($decoded)) return [];
            $out = [];
            foreach ($decoded as $name => $value) {
                if (!is_string($name) || $name === '') continue;
                if (!is_scalar($value)) continue;
                $name = preg_replace('/[\r\n:]/', '', $name);
                $value = preg_replace('/[\r\n]/', '', (string)$value);
                $out[] = $name . ': ' . $value;
            }
            return $out;
        } catch (\Exception $e) {
            error_log('[MCPProxy] getServerHeaders failed: ' . $e->getMessage());
            return [];
        }
    }

    /**
     * Cache discovered tools in database
     */
    private function cacheTools(int $serverId, array $tools): void
    {
        // Clear existing tools for this server
        $stmt = $this->db->prepare("DELETE FROM mcp_server_tools WHERE server_id = ?");
        $stmt->execute([$serverId]);

        // Insert new tools
        $stmt = $this->db->prepare("
            INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)
            VALUES (?, ?, ?, ?, ?, ?)
        ");

        foreach ($tools as $tool) {
            $hasUi = isset($tool['_meta']['ui']['resourceUri']);
            $uiResourceUri = $tool['_meta']['ui']['resourceUri'] ?? null;

            // Sanitize input schema
            $inputSchema = $this->sanitizeSchema($tool['inputSchema'] ?? ['type' => 'object', 'properties' => new \stdClass()]);

            $stmt->execute([
                $serverId,
                $tool['name'],
                $tool['description'] ?? '',
                json_encode($inputSchema),
                $hasUi ? 1 : 0,
                $uiResourceUri
            ]);
        }
    }

    /**
     * Sanitize tool input schema
     */
    private function sanitizeSchema(mixed $schema): mixed
    {
        if (is_object($schema)) {
            $schema = (array)$schema;
        }

        if (is_array($schema) && empty($schema)) {
            return new \stdClass();
        }

        if (is_array($schema)) {
            unset($schema['$schema']);
            unset($schema['default']);
            unset($schema['$id']);
            unset($schema['definitions']);
            unset($schema['$defs']);

            foreach ($schema as $key => $value) {
                if (is_array($value) || is_object($value)) {
                    $schema[$key] = $this->sanitizeSchema($value);
                }
            }
        }

        return $schema;
    }

    /**
     * Ensure required tables exist
     */
    private function ensureTablesExist(): void
    {
        $this->db->exec("
            CREATE TABLE IF NOT EXISTS mcp_servers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NULL,
                name VARCHAR(255) NOT NULL,
                url VARCHAR(500) NOT NULL,
                description TEXT,
                headers JSON NULL,
                enabled TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_scope_name (user_id, name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");

        $this->db->exec("
            CREATE TABLE IF NOT EXISTS mcp_server_tools (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                tool_name VARCHAR(255) NOT NULL,
                tool_description TEXT,
                input_schema JSON,
                has_ui TINYINT(1) DEFAULT 0,
                ui_resource_uri VARCHAR(500),
                cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
                UNIQUE KEY unique_server_tool (server_id, tool_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
    }
}
