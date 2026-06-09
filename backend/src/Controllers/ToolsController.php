<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\PackageResolver;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use PDO;
use Exception;

/**
 * Tools Controller
 *
 * Provides API endpoints for listing and managing available tools/functions
 * that can be passed to LLM providers.
 *
 * Endpoints:
 * - GET  /api/v1/tools                  - List all available tools (builtin + MCP)
 * - POST /api/v1/tools/execute          - Execute a single tool by name
 * - POST /api/v1/tools/classify-intent  - Ask a cheap LLM whether a given
 *                                         transcript implied a tool call
 *                                         (used by the realtime runner as a
 *                                         language-agnostic safety net when
 *                                         the speaking LLM forgot to emit
 *                                         the function call itself).
 */
class ToolsController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * GET /api/v1/tools
     *
     * List all available tools that can be used in chat requests.
     * Returns both built-in tools and MCP server tools.
     *
     * Query parameters:
     * - type: Filter by tool type ('builtin', 'mcp', or 'all')
     * - search: Search tools by name or description
     *
     * Response:
     * {
     *   "success": true,
     *   "tools": [
     *     {
     *       "name": "tool_name",
     *       "description": "Tool description",
     *       "type": "builtin|mcp",
     *       "server": "server_name" (for MCP tools only),
     *       "input_schema": {...}
     *     }
     *   ],
     *   "counts": {
     *     "builtin": 15,
     *     "mcp": 23,
     *     "total": 38
     *   }
     * }
     */
    public function list(array $request): array
    {
        $query = $request['query'] ?? [];
        $typeFilter = $query['type'] ?? 'all';
        $searchTerm = $query['search'] ?? null;

        // Validate type filter
        if (!in_array($typeFilter, ['all', 'builtin', 'mcp'])) {
            return [
                'success' => false,
                'error' => 'Invalid type filter. Must be: all, builtin, or mcp',
                'status_code' => 400
            ];
        }

        // Initialize tools arrays
        $builtinTools = [];
        $mcpTools = [];

        // Get built-in tools
        if ($typeFilter === 'all' || $typeFilter === 'builtin') {
            $assistant = new AIPortfolioAssistant(LLMProviderResolver::applyDbSettings($this->db, $this->config));
            $toolsManager = $assistant->getToolsManager();
            $builtinDefinitions = $toolsManager->getToolDefinitions();

            foreach ($builtinDefinitions as $tool) {
                $builtinTools[] = [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'type' => 'builtin',
                    'input_schema' => $tool['input_schema'] ?? new \stdClass()
                ];
            }
        }

        // Get MCP tools (filtered by the caller's role-based package allowlist
        // so the workflow editor's agent-form tool picker only shows servers
        // the caller is permitted to use).
        if ($typeFilter === 'all' || $typeFilter === 'mcp') {
            try {
                $mcpLoader = new MCPToolsLoader($this->db);
                $allowlist = $this->resolvePackageMcpAllowlist($request);
                $mcpLoader->loadToolsForUser(null, $allowlist);

                if ($mcpLoader->hasTools()) {
                    $mcpDefinitions = $mcpLoader->getToolDefinitions();

                    foreach ($mcpDefinitions as $tool) {
                        // Extract server name from description if present
                        $description = $tool['description'] ?? '';
                        $serverName = null;
                        if (preg_match('/^\[MCP:([^\]]+)\]/', $description, $matches)) {
                            $serverName = $matches[1];
                            $description = trim(preg_replace('/^\[MCP:[^\]]+\]\s*/', '', $description));
                        }

                        $mcpTools[] = [
                            'name' => $tool['name'],
                            'description' => $description,
                            'type' => 'mcp',
                            'server' => $serverName,
                            'input_schema' => $tool['input_schema'] ?? new \stdClass()
                        ];
                    }
                }
            } catch (\Exception $e) {
                error_log("[ToolsController] Failed to load MCP tools: " . $e->getMessage());
            }
        }

        // Combine tools
        $allTools = array_merge($builtinTools, $mcpTools);

        // Apply search filter if provided
        if ($searchTerm !== null && $searchTerm !== '') {
            $searchLower = strtolower($searchTerm);
            $allTools = array_filter($allTools, function ($tool) use ($searchLower) {
                $nameMatch = stripos($tool['name'], $searchLower) !== false;
                $descMatch = stripos($tool['description'] ?? '', $searchLower) !== false;
                return $nameMatch || $descMatch;
            });
            $allTools = array_values($allTools);
        }

        return [
            'success' => true,
            'tools' => $allTools,
            'counts' => [
                'builtin' => count($builtinTools),
                'mcp' => count($mcpTools),
                'total' => count($allTools)
            ]
        ];
    }

    /**
     * POST /api/v1/tools/execute
     *
     * Execute a single tool by name. Used by the realtime audio workflow
     * runner on the frontend — when a voice agent calls a user-selected
     * function, the runner POSTs here, gets the result, and feeds it back
     * to the LLM via the realtime WebSocket.
     *
     * Body: { "tool_name": "search_web", "parameters": { ... } }
     * Returns: { "success": bool, "result": <json>, "error"?: string }
     */
    public function execute(array $request): array
    {
        $body = $request['body'] ?? [];
        $userId = $request['user_id'] ?? 'demo-user';

        $toolName = $body['tool_name'] ?? $body['name'] ?? null;
        $parameters = $body['parameters'] ?? $body['args'] ?? [];
        if (!is_array($parameters)) $parameters = [];

        if (!$toolName) {
            return [
                'success' => false,
                'error' => 'Missing tool_name',
                'status_code' => 400
            ];
        }

        // Try built-in tools first.
        $assistant = new AIPortfolioAssistant(LLMProviderResolver::applyDbSettings($this->db, $this->config));
        $toolsManager = $assistant->getToolsManager();
        if ($toolsManager->hasFunction($toolName)) {
            try {
                $result = $toolsManager->execute($toolName, $parameters, $userId);
                return ['success' => true, 'result' => $result, 'status_code' => 200];
            } catch (\Throwable $e) {
                error_log("[ToolsController] Built-in tool $toolName failed: " . $e->getMessage());
                return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
            }
        }

        // Fall back to MCP tools (restricted by the caller's package allowlist
        // so you can't execute a tool whose server the role isn't permitted to see).
        try {
            $mcpLoader = new MCPToolsLoader($this->db);
            $mcpLoader->loadToolsForUser(null, $this->resolvePackageMcpAllowlist($request));
            if ($mcpLoader->isMCPTool($toolName)) {
                $result = $mcpLoader->executeTool($toolName, $parameters);
                return ['success' => true, 'result' => $result, 'status_code' => 200];
            }
        } catch (\Throwable $e) {
            error_log("[ToolsController] MCP tool $toolName failed: " . $e->getMessage());
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }

        return [
            'success' => false,
            'error' => "Unknown tool: $toolName",
            'status_code' => 404
        ];
    }

    /**
     * POST /api/v1/tools/classify-intent
     *
     * Given what an audio agent just said and the list of tools it had
     * available, ask a cheap LLM whether the agent intended to call one of
     * those tools. Used by the Gemini adapter as a multilingual safety net
     * when Gemini narrates a transfer but forgets to emit the function call.
     *
     * Body:
     *   {
     *     "transcript": "je vais vous transférer au service de facturation",
     *     "tools": [
     *       { "name": "handoff_to",
     *         "description": "...",
     *         "parameters": { "properties": { "target": { "enum": ["billing"] } } } },
     *       { "name": "end_session", ... },
     *       { "name": "done", ... }
     *     ]
     *   }
     * Returns:
     *   { "success": true, "tool": "handoff_to", "args": { "target": "billing" } }
     * or
     *   { "success": true, "tool": null }
     */
    public function classifyIntent(array $request): array
    {
        $body = $request['body'] ?? [];
        $transcript = trim((string) ($body['transcript'] ?? ''));
        $tools = $body['tools'] ?? [];
        $userId = $request['user_id'] ?? 'demo-user';

        if ($transcript === '' || !is_array($tools) || count($tools) === 0) {
            return ['success' => true, 'tool' => null, 'status_code' => 200];
        }

        // Build a compact description of each tool the agent had available.
        $toolLines = [];
        foreach ($tools as $t) {
            $name = $t['name'] ?? '?';
            $desc = $t['description'] ?? '';
            $enum = $t['parameters']['properties']['target']['enum'] ?? null;
            $line = "- $name: $desc";
            if (is_array($enum) && count($enum) > 0) {
                $line .= " (valid target values: " . implode(', ', $enum) . ")";
            }
            $toolLines[] = $line;
        }

        $systemPrompt =
            "You are a function-call classifier for a voice assistant.\n" .
            "An AI agent just said something to a caller but did NOT emit a function call. " .
            "Decide whether the agent's utterance implies it intended to call one of the tools below, " .
            "and if so, pick exactly one tool and fill in its arguments. " .
            "Respond with JSON ONLY, no other text, using this schema:\n" .
            "  { \"tool\": \"<tool name or null>\", \"args\": {<arguments>} }\n" .
            "Rules:\n" .
            "- If the utterance is normal conversation (answering a question, greeting, etc.) " .
            "and does NOT imply a tool call, respond with {\"tool\": null, \"args\": {}}.\n" .
            "- If the utterance announces a transfer / end-of-call / completion, pick the matching tool.\n" .
            "- For handoff_to, pick the target whose description best matches where the agent is sending the caller. " .
            "The utterance may be in any language (English, French, Spanish, etc.) — reason about the meaning.\n\n" .
            "Tools available to the agent:\n" . implode("\n", $toolLines);

        $userMessage =
            "Agent's utterance:\n\"\"\"\n" . $transcript . "\n\"\"\"\n\n" .
            "Respond with JSON only.";

        try {
            $assistant = new AIPortfolioAssistant(LLMProviderResolver::applyDbSettings($this->db, $this->config));
            // Use a cheap/fast provider when configured; fall back to default.
            // Tools=[] keeps the classifier from calling anything itself.
            $response = $assistant->getLLMManager()->chat(
                $userMessage,
                [],
                [
                    'user_id' => $userId,
                    'system_prompt' => $systemPrompt,
                    'tools' => [],
                    'temperature' => 0,
                    'max_tokens' => 120,
                ]
            );
            $text = $response['text'] ?? $response['content'] ?? '';
            // Extract the first {...} block — LLM sometimes wraps in ```json.
            if (preg_match('/\{.*\}/s', $text, $m)) {
                $parsed = json_decode($m[0], true);
                if (is_array($parsed)) {
                    $tool = $parsed['tool'] ?? null;
                    $args = $parsed['args'] ?? new \stdClass();
                    // Validate tool exists in the provided list.
                    $valid = false;
                    foreach ($tools as $t) {
                        if (($t['name'] ?? null) === $tool) { $valid = true; break; }
                    }
                    if ($tool && $valid) {
                        return [
                            'success' => true,
                            'tool' => $tool,
                            'args' => $args,
                            'status_code' => 200
                        ];
                    }
                    return ['success' => true, 'tool' => null, 'status_code' => 200];
                }
            }
            return ['success' => true, 'tool' => null, 'status_code' => 200];
        } catch (\Throwable $e) {
            error_log("[ToolsController] classifyIntent failed: " . $e->getMessage());
            return [
                'success' => false,
                'tool' => null,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Resolve the MCP server allowlist for the caller's role-based package.
     * Returns null (no restriction), an array of allowed server names, or
     * an empty array (allow nothing). Suitable to pass straight to
     * MCPToolsLoader::loadToolsForUser().
     */
    private function resolvePackageMcpAllowlist(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;
        try {
            $resolver = new PackageResolver($this->db);
            return $resolver->allowedMcpServers(is_numeric($userId) ? (int)$userId : null);
        } catch (Exception $e) {
            error_log("[ToolsController] Package allowlist failed: " . $e->getMessage());
            return null;
        }
    }
}
