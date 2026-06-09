<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * Loads MCP tools from database and provides execution via MCP proxy
 */
class MCPToolsLoader
{
    private PDO $pdo;
    private array $tools = [];
    private array $serverUrls = [];

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    /**
     * Load enabled MCP tools: all global servers plus the caller's user-scoped servers.
     *
     * When $allowedServerNames is a non-null array, the result is further
     * restricted to servers whose `name` column is in that list — this is how
     * role-based package allowlists gate MCP access at the chat runtime.
     * Pass null for no allowlist restriction (backward-compatible default).
     */
    public function loadToolsForUser(?string $userId = null, ?array $allowedServerNames = null): array
    {
        $this->tools = [];
        $this->serverUrls = [];

        try {
            // Fetch all enabled tools visible to this caller WITHOUT applying the
            // package allowlist in SQL. We resolve the effective per-server
            // enable in PHP below so the per-user override layer can ADD a
            // server back that the package allowlist would otherwise hide.
            if ($userId !== null && $userId !== '') {
                $sql = "SELECT t.*, s.id as server_id_col, s.url as server_url, s.name as server_name,
                               s.user_id as server_user_id, s.headers as server_headers
                        FROM mcp_server_tools t
                        JOIN mcp_servers s ON t.server_id = s.id
                        WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = ?)
                        ORDER BY s.name, t.tool_name";
                $stmt = $this->pdo->prepare($sql);
                $stmt->execute([(string)$userId]);
            } else {
                $sql = "SELECT t.*, s.id as server_id_col, s.url as server_url, s.name as server_name,
                               s.user_id as server_user_id, s.headers as server_headers
                        FROM mcp_server_tools t
                        JOIN mcp_servers s ON t.server_id = s.id
                        WHERE s.user_id IS NULL AND s.enabled = 1
                        ORDER BY s.name, t.tool_name";
                $stmt = $this->pdo->query($sql);
            }
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Per-user overrides cascade on top of the package allowlist.
            // override.allowed = true  → include the server even if the package
            //                            allowlist excludes it
            // override.allowed = false → exclude the server even if the package
            //                            allowlist would grant it
            // no override              → defer to the package allowlist
            // User-private servers (s.user_id = $userId) always pass when no
            // override exists for them — owners self-manage those.
            $overridesByServerId = [];
            $userIdInt = ($userId !== null && $userId !== '' && is_numeric($userId)) ? (int)$userId : null;
            if ($userIdInt !== null) {
                $stmt = $this->pdo->prepare("SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?");
                $stmt->execute([$userIdInt]);
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $overridesByServerId[(int)$row['server_id']] = (bool)$row['allowed'];
                }
            }

            $rows = array_values(array_filter($rows, function (array $r) use ($allowedServerNames, $overridesByServerId) {
                $serverId   = (int)$r['server_id_col'];
                $isPrivate  = $r['server_user_id'] !== null;

                if (array_key_exists($serverId, $overridesByServerId)) {
                    return $overridesByServerId[$serverId];
                }
                // No override → user-private servers always pass; globals are
                // gated by the package allowlist (null = unrestricted).
                if ($isPrivate) {
                    return true;
                }
                if ($allowedServerNames === null) {
                    return true;
                }
                return in_array($r['server_name'], $allowedServerNames, true);
            }));

            foreach ($rows as $row) {
                $toolName = 'mcp_' . $row['tool_name'];
                $this->tools[$toolName] = [
                    'original_name' => $row['tool_name'],
                    'server_id' => $row['server_id'],
                    'server_url' => $row['server_url'],
                    'server_name' => $row['server_name'],
                    'server_headers' => $this->parseServerHeaders($row['server_headers'] ?? null),
                    'description' => $row['tool_description'],
                    'input_schema_json' => $row['input_schema'],  // Keep raw JSON to avoid {} -> [] corruption
                    'has_ui' => (bool) $row['has_ui'],
                    'ui_resource_uri' => $row['ui_resource_uri']
                ];
                $this->serverUrls[$row['server_id']] = $row['server_url'];
            }

            // Debug: Log loaded tools
            error_log("[MCP] Loaded " . count($this->tools) . " MCP tools: " . implode(', ', array_keys($this->tools)));
        } catch (\PDOException $e) {
            error_log("MCPToolsLoader: Failed to load tools: " . $e->getMessage());
        }

        return $this->tools;
    }

    /**
     * Get tool definitions in Claude/OpenAI format
     */
    public function getToolDefinitions(): array
    {
        $definitions = [];

        foreach ($this->tools as $toolName => $tool) {
            // Decode JSON without 'true' flag to preserve {} as stdClass (not [])
            // This avoids the {} -> [] corruption that breaks Claude API
            $schema = json_decode($tool['input_schema_json'] ?? '{"type":"object","properties":{}}');

            $definitions[] = [
                'name' => $toolName,
                'description' => "[MCP:{$tool['server_name']}] " . ($tool['description'] ?: $tool['original_name']),
                'input_schema' => $schema
            ];
        }

        return $definitions;
    }

    /**
     * Check if a tool is an MCP tool
     */
    public function isMCPTool(string $toolName): bool
    {
        return isset($this->tools[$toolName]) || isset($this->tools['mcp_' . $toolName]);
    }

    /**
     * Execute an MCP tool by calling the MCP server
     */
    public function executeTool(string $toolName, array $arguments): array
    {
        // Handle both prefixed and non-prefixed names
        $prefixedName = str_starts_with($toolName, 'mcp_') ? $toolName : 'mcp_' . $toolName;

        if (!isset($this->tools[$prefixedName])) {
            return [
                'error' => true,
                'message' => "MCP tool '{$toolName}' not found"
            ];
        }

        $tool = $this->tools[$prefixedName];
        $serverUrl = $tool['server_url'];
        $originalName = $tool['original_name'];

        // Call the MCP server (returns both formatted and raw result)
        $callResult = $this->callMCPServer($serverUrl, $originalName, $arguments, $tool['server_headers'] ?? []);
        $result = $callResult['formatted'];
        $rawResult = $callResult['raw'];

        error_log("🔧 [MCP] Tool execution for: {$originalName}");
        error_log("🔧 [MCP] Tool has_ui flag: " . ($tool['has_ui'] ? 'true' : 'false'));
        error_log("🔧 [MCP] Formatted result: " . json_encode($result));

        // Check for UI info in the result (viewUUID indicates tool has dynamic UI)
        $hasViewUUID = isset($result['_meta']['viewUUID']);

        // If tool has UI (either static or dynamic via viewUUID), include UI info
        // ALWAYS include UI info for tools with has_ui=true, even on errors
        if ($tool['has_ui'] || $hasViewUUID) {
            $result['_mcp_ui'] = [
                'has_ui' => true,
                'tool_name' => $originalName,
                'server_url' => $serverUrl,
                'server_name' => $tool['server_name'],
                'resource_uri' => $tool['ui_resource_uri'] ?? null,
                'view_uuid' => $result['_meta']['viewUUID'] ?? null,
                'arguments' => $arguments,  // Pass arguments so UI can use them
                'tool_result' => $rawResult,  // Pass raw result for ui/notifications/tool-result
                'has_error' => isset($result['error']) && $result['error'] === true
            ];

            error_log("🖼️ [MCP] Tool has UI: {$originalName}, viewUUID: " . ($result['_meta']['viewUUID'] ?? 'none'));
            error_log("🖼️ [MCP] Arguments passed: " . json_encode($arguments));
            error_log("🖼️ [MCP] Tool result (raw): " . substr(json_encode($rawResult), 0, 500));
        } else {
            error_log("⚠️ [MCP] Tool {$originalName} does NOT have UI flag set");
        }

        return $result;
    }

    /**
     * Call an MCP server to execute a tool
     */
    private function callMCPServer(string $serverUrl, string $toolName, array $arguments, array $extraHeaders = []): array
    {
        // Use URL as provided - don't force any suffix
        $mcpUrl = rtrim($serverUrl, '/');

        // Ensure empty arguments is an object {} not array []
        // MCP servers expect "arguments" to be a record/object
        $args = empty($arguments) ? new \stdClass() : $arguments;

        // Build JSON-RPC request
        $request = [
            'jsonrpc' => '2.0',
            'id' => time(),
            'method' => 'tools/call',
            'params' => [
                'name' => $toolName,
                'arguments' => $args
            ]
        ];

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
            CURLOPT_TIMEOUT => 180,  // Increased for larger operations
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($error) {
            return [
                'formatted' => [
                    'error' => true,
                    'message' => "MCP connection failed: $error"
                ],
                'raw' => null
            ];
        }

        if ($httpCode >= 400) {
            return [
                'formatted' => [
                    'error' => true,
                    'message' => "MCP server returned HTTP $httpCode"
                ],
                'raw' => null
            ];
        }

        // Parse response (may be JSON or SSE)
        $parsed = $this->parseResponse($response);

        if ($parsed === null) {
            return [
                'formatted' => [
                    'error' => true,
                    'message' => "Failed to parse MCP response"
                ],
                'raw' => null
            ];
        }

        // Check for JSON-RPC error
        if (isset($parsed['error'])) {
            return [
                'formatted' => [
                    'error' => true,
                    'message' => $parsed['error']['message'] ?? 'MCP tool execution failed'
                ],
                'raw' => null
            ];
        }

        // Extract result
        $result = $parsed['result'] ?? $parsed;

        // Return both formatted (for AI) and raw (for UI) results
        return [
            'formatted' => $this->formatToolResult($result),
            'raw' => $result  // Original MCP result with content/structuredContent
        ];
    }

    /**
     * Parse response (JSON or SSE format)
     */
    private function parseResponse(string $response): ?array
    {
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

    /**
     * Format MCP tool result for AI consumption
     */
    private function formatToolResult(array $result): array
    {
        // MCP tools return content array with type/text items
        if (isset($result['content']) && is_array($result['content'])) {
            $textParts = [];
            foreach ($result['content'] as $item) {
                if (isset($item['type']) && $item['type'] === 'text' && isset($item['text'])) {
                    $textParts[] = $item['text'];
                } elseif (isset($item['text'])) {
                    $textParts[] = $item['text'];
                }
            }

            if (!empty($textParts)) {
                return [
                    'result' => implode("\n", $textParts),
                    '_meta' => $result['_meta'] ?? null
                ];
            }
        }

        // Return as-is if already formatted
        if (isset($result['result'])) {
            return $result;
        }

        // Wrap raw result
        return ['result' => json_encode($result)];
    }

    /**
     * Get loaded tools
     */
    public function getTools(): array
    {
        return $this->tools;
    }

    /**
     * Check if any MCP tools are loaded
     */
    public function hasTools(): bool
    {
        return !empty($this->tools);
    }

    /**
     * Parse stored JSON headers into CURLOPT_HTTPHEADER strings.
     */
    private function parseServerHeaders(?string $json): array
    {
        if ($json === null || $json === '') return [];
        $decoded = json_decode($json, true);
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
    }
}
