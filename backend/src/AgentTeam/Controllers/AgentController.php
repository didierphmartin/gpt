<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\StreamContext;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use PDO;

/**
 * Agent Controller
 *
 * REST API controller for agent CRUD and execution.
 *
 * Endpoints:
 * - GET    /api/v1/agents           - List agents
 * - POST   /api/v1/agents           - Create agent
 * - GET    /api/v1/agents/{id}      - Get agent
 * - PUT    /api/v1/agents/{id}      - Update agent
 * - DELETE /api/v1/agents/{id}      - Delete agent
 * - POST   /api/v1/agents/{id}/run  - Run agent
 * - POST   /api/v1/agents/{id}/chat - Run agent (streaming)
 * - GET    /api/v1/agents/tools     - List available tools
 *
 * @see docs/agentDesign.md
 */
class AgentController
{
    private PDO $db;
    private array $config;
    private AgentRepository $repository;
    private AgentRunner $runner;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;

        // Create repository
        $this->repository = new AgentRepository($db);

        // Create AIPortfolioAssistant to get LLMManager and ToolsManager.
        // DB-overlay first so the assistant registers all providers from
        // system_llm_settings (the file no longer carries provider blocks).
        $config = LLMProviderResolver::applyDbSettings($db, $config);
        $this->config = $config;
        $assistant = new AIPortfolioAssistant($config);
        $assistant->setDatabase($db);

        // Create MCPToolsLoader
        $mcpToolsLoader = new MCPToolsLoader($db);

        // Create AgentRunner with all dependencies
        $this->runner = new AgentRunner(
            $assistant->getLLMManager(),
            $assistant->getToolsManager(),
            $mcpToolsLoader,
            $db,
            $config
        );
    }

    /**
     * GET /api/v1/agents
     * List agents accessible to the current user
     */
    public function index(array $request): array
    {
        $userId = $this->getUserId($request);
        $query = $request['query'] ?? [];

        $filters = [
            'agent_type' => $query['type'] ?? null,
            'provider' => $query['provider'] ?? null,
            'visibility' => $query['visibility'] ?? null,
            'search' => $query['search'] ?? null,
            'category' => $query['category'] ?? null,
            'limit' => isset($query['limit']) ? (int) $query['limit'] : 100,
            'offset' => isset($query['offset']) ? (int) $query['offset'] : 0,
        ];

        // Remove null filters
        $filters = array_filter($filters, fn($v) => $v !== null);

        $agents = $this->repository->findAccessibleByUser($userId, $filters);
        $total = $this->repository->countAccessible($userId);

        return [
            'success' => true,
            'data' => array_map(fn($a) => $a->toApiArray(), $agents),
            'meta' => [
                'total' => $total,
                'count' => count($agents),
                'limit' => $filters['limit'] ?? 100,
                'offset' => $filters['offset'] ?? 0,
            ],
        ];
    }

    /**
     * POST /api/v1/agents
     * Create a new agent
     */
    public function create(array $request): array
    {
        $userId = $this->getUserId($request);
        $data = $request['body'] ?? [];

        // Validate required fields
        if (empty($data['name'])) {
            return $this->error('Name is required', 400);
        }

        // Validate agent type
        $agentType = $data['agent_type'] ?? 'standard';
        if (!in_array($agentType, ['standard', 'manager', 'worker'])) {
            return $this->error('Invalid agent_type. Must be: standard, manager, or worker', 400);
        }

        // Validate visibility
        $visibility = $data['visibility'] ?? 'personal';
        if (!in_array($visibility, ['personal', 'workspace', 'public'])) {
            return $this->error('Invalid visibility. Must be: personal, workspace, or public', 400);
        }

        // Create agent model
        $agent = new Agent([
            'user_id' => $userId,
            'team_id' => $data['team_id'] ?? null,
            'category' => $data['category'] ?? null,
            'name' => $data['name'],
            'description' => $data['description'] ?? '',
            'agent_type' => $agentType,
            'parent_agent_id' => $data['parent_agent_id'] ?? null,
            'can_delegate_to' => $data['can_delegate_to'] ?? [],
            'display_order' => $data['display_order'] ?? 0,
            'provider' => $data['provider'] ?? 'claude',
            'model' => $data['model'] ?? null,
            'instructions' => $data['instructions'] ?? '',
            'tools' => $data['tools'] ?? [],
            'visibility' => $visibility,
            'settings' => $data['settings'] ?? [],
        ]);

        try {
            $created = $this->repository->create($agent);

            return [
                'success' => true,
                'data' => $created->toArray(),
                'message' => "Agent '{$created->getName()}' created successfully",
            ];
        } catch (\Exception $e) {
            return $this->error('Failed to create agent: ' . $e->getMessage(), 500);
        }
    }

    /**
     * GET /api/v1/agents/{id}
     * Get a specific agent
     */
    public function show(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);

        if (!$this->repository->canUserAccess($userId, $agentId)) {
            return $this->error('Agent not found', 404);
        }

        $agent = $this->repository->findById($agentId);

        // Include stats if requested
        $includeStats = ($request['query']['include_stats'] ?? false) === 'true';
        $data = $agent->toArray();

        if ($includeStats) {
            $data['stats'] = $this->repository->getAgentStats($agentId);
        }

        return [
            'success' => true,
            'data' => $data,
        ];
    }

    /**
     * PUT /api/v1/agents/{id}
     * Update an agent
     */
    public function update(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);
        $data = $request['body'] ?? [];

        // Check ownership (only owner can update)
        if (!$this->repository->isOwner($userId, $agentId)) {
            return $this->error('Agent not found or access denied', 404);
        }

        $agent = $this->repository->findById($agentId);

        // Update fields
        if (isset($data['name'])) {
            $agent->setName($data['name']);
        }
        if (isset($data['description'])) {
            $agent->setDescription($data['description']);
        }
        if (array_key_exists('team_id', $data)) {
            $agent->setTeamId($data['team_id']);
        }
        if (array_key_exists('category', $data)) {
            $agent->setCategory($data['category']);
        }
        if (isset($data['agent_type'])) {
            $agent->setAgentType($data['agent_type']);
        }
        if (isset($data['parent_agent_id'])) {
            $agent->setParentAgentId($data['parent_agent_id']);
        }
        if (isset($data['can_delegate_to'])) {
            $agent->setCanDelegateTo($data['can_delegate_to']);
        }
        if (isset($data['provider'])) {
            $agent->setProvider($data['provider']);
        }
        if (isset($data['model'])) {
            $agent->setModel($data['model']);
        }
        if (isset($data['instructions'])) {
            $agent->setInstructions($data['instructions']);
        }
        if (isset($data['tools'])) {
            $agent->setTools($data['tools']);
        }
        if (isset($data['display_order'])) {
            $agent->setDisplayOrder((int) $data['display_order']);
        }
        if (isset($data['visibility'])) {
            $agent->setVisibility($data['visibility']);
        }
        if (isset($data['enabled'])) {
            $agent->setEnabled((bool) $data['enabled']);
        }
        if (isset($data['settings'])) {
            $agent->setSettings($data['settings']);
        }

        try {
            $updated = $this->repository->update($agent);

            return [
                'success' => true,
                'data' => $updated->toArray(),
                'message' => "Agent '{$updated->getName()}' updated successfully",
            ];
        } catch (\Exception $e) {
            return $this->error('Failed to update agent: ' . $e->getMessage(), 500);
        }
    }

    /**
     * DELETE /api/v1/agents/{id}
     * Delete an agent
     */
    public function destroy(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);

        // Check ownership
        if (!$this->repository->isOwner($userId, $agentId)) {
            return $this->error('Agent not found or access denied', 404);
        }

        $agent = $this->repository->findById($agentId);
        $agentName = $agent->getName();

        try {
            $this->repository->delete($agentId);

            return [
                'success' => true,
                'message' => "Agent '{$agentName}' deleted successfully",
            ];
        } catch (\Exception $e) {
            return $this->error('Failed to delete agent: ' . $e->getMessage(), 500);
        }
    }

    /**
     * GET /api/v1/agents/categories
     * List the user's distinct container/category names.
     */
    public function listCategories(array $request): array
    {
        $userId = $this->getUserId($request);
        $categories = $this->repository->findDistinctCategories($userId);
        return [
            'success' => true,
            'data' => $categories,
            'meta' => ['count' => count($categories)],
        ];
    }

    /**
     * PUT /api/v1/agents/categories/rename
     * Body: { old_name: string, new_name: string }
     * Rename a container across all of the user's agents.
     */
    public function renameCategory(array $request): array
    {
        $userId = $this->getUserId($request);
        $data = $request['body'] ?? [];
        $old = trim((string) ($data['old_name'] ?? ''));
        $new = trim((string) ($data['new_name'] ?? ''));
        if ($old === '' || $new === '') {
            return $this->error('old_name and new_name are required', 400);
        }
        if ($old === $new) {
            return ['success' => true, 'data' => ['affected' => 0]];
        }
        $affected = $this->repository->renameCategory($userId, $old, $new);
        return [
            'success' => true,
            'data' => ['affected' => $affected, 'old_name' => $old, 'new_name' => $new],
        ];
    }

    /**
     * DELETE /api/v1/agents/categories
     * Body or query: { name: string }
     * Clears the named container — agents fall back to Uncategorized (NULL).
     */
    public function deleteCategory(array $request): array
    {
        $userId = $this->getUserId($request);
        $body = $request['body'] ?? [];
        $query = $request['query'] ?? [];
        $name = trim((string) ($body['name'] ?? $query['name'] ?? ''));
        if ($name === '') {
            return $this->error('name is required', 400);
        }
        $affected = $this->repository->clearCategory($userId, $name);
        return [
            'success' => true,
            'data' => ['affected' => $affected, 'name' => $name],
        ];
    }

    /**
     * POST /api/v1/agents/{id}/run
     * Execute an agent (non-streaming)
     */
    public function run(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);
        $data = $request['body'] ?? [];

        // App-key auth is scope-gated. A JWT-authed user reaches the
        // ownership check below unrestricted; an app key must explicitly
        // carry `agents:run` or `agents:run:<id>` in its scopes.
        // ($userId is already the app key's bound user — set by the
        // middleware — so the canUserAccess() ownership check still holds.)
        if (($request['auth_type'] ?? null) === 'app_key') {
            $scopes = $request['app_key_scopes'] ?? [];
            $scopeAllowed = in_array('agents:run', $scopes, true)
                || in_array("agents:run:{$agentId}", $scopes, true);
            if (!$scopeAllowed) {
                return $this->error('App key not authorized for this agent (missing scope agents:run)', 403);
            }
        }

        // Check access
        if (!$this->repository->canUserAccess($userId, $agentId)) {
            return $this->error('Agent not found', 404);
        }

        $agent = $this->repository->findById($agentId);

        // Check if agent is enabled
        if (!$agent->isEnabled()) {
            return $this->error('Agent is disabled', 400);
        }

        // Get input
        $input = $data['input'] ?? $data['message'] ?? '';
        if (empty(trim($input))) {
            return $this->error('Input message is required', 400);
        }

        // Get conversation history
        $conversationHistory = $data['conversation_history'] ?? [];

        // Get optional tools filter
        $toolsFilter = $data['tools'] ?? null;
        if ($toolsFilter !== null && !is_array($toolsFilter)) {
            return $this->error('tools must be an array of tool names', 400);
        }

        // Execute agent with optional tools filter
        $response = $this->runner->run(
            $agent,
            $input,
            $conversationHistory,
            $userId,
            ['tools_filter' => $toolsFilter]
        );

        return $response;
    }

    /**
     * POST /api/v1/agents/{id}/chat
     * Execute an agent with streaming (SSE)
     */
    public function chat(array $request): void
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);
        $data = $request['body'] ?? [];

        // Check access
        if (!$this->repository->canUserAccess($userId, $agentId)) {
            $this->sendJsonResponse(['success' => false, 'error' => 'Agent not found'], 404);
            return;
        }

        $agent = $this->repository->findById($agentId);

        // Check if enabled
        if (!$agent->isEnabled()) {
            $this->sendJsonResponse(['success' => false, 'error' => 'Agent is disabled'], 400);
            return;
        }

        // Get input
        $input = $data['input'] ?? $data['message'] ?? '';
        if (empty(trim($input))) {
            $this->sendJsonResponse(['success' => false, 'error' => 'Input message is required'], 400);
            return;
        }

        // Set SSE headers
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');

        // Disable output buffering
        if (ob_get_level()) {
            ob_end_clean();
        }

        // Get conversation history
        $conversationHistory = $data['conversation_history'] ?? [];

        // Get optional tools filter
        $toolsFilter = $data['tools'] ?? null;
        if ($toolsFilter !== null && !is_array($toolsFilter)) {
            $this->sendJsonResponse(['success' => false, 'error' => 'tools must be an array of tool names'], 400);
            return;
        }

        // Create SSE callback for streaming events
        $sseCallback = function ($event) {
            echo "data: " . json_encode($event) . "\n\n";
            if (ob_get_level()) {
                ob_flush();
            }
            flush();
        };

        // Create stream context for agent activity events
        $streamContext = new StreamContext($sseCallback, $userId);
        $this->runner->setStreamContext($streamContext);

        // Execute with streaming (pass tools filter via context)
        $this->runner->streamRun(
            $agent,
            $input,
            $conversationHistory,
            $userId,
            $sseCallback,
            ['tools_filter' => $toolsFilter]
        );

        echo "data: [DONE]\n\n";
        flush();
    }

    /**
     * GET /api/v1/agents/tools
     * List all available tools that can be assigned to agents
     */
    public function listTools(array $request): array
    {
        $toolsManager = $this->runner->getToolsManager();
        $mcpLoader = $this->runner->getMCPToolsLoader();

        $builtinTools = [];
        foreach ($toolsManager->getToolDefinitions() as $tool) {
            $builtinTools[] = [
                'name' => $tool['name'],
                'description' => $tool['description'] ?? '',
                'type' => 'builtin',
            ];
        }

        $mcpTools = [];
        if ($mcpLoader) {
            foreach ($mcpLoader->getToolDefinitions() as $tool) {
                $mcpTools[] = [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'type' => 'mcp',
                    'server' => $tool['server_name'] ?? null,
                ];
            }
        }

        // Add delegation tools
        $delegationTools = [
            [
                'name' => 'delegate_to_agent',
                'description' => 'Delegate a task to a specialized sub-agent',
                'type' => 'delegation',
            ],
            [
                'name' => 'list_available_agents',
                'description' => 'List agents that can be delegated to',
                'type' => 'delegation',
            ],
            [
                'name' => 'run_agents_parallel',
                'description' => 'Run multiple agents in parallel',
                'type' => 'delegation',
            ],
        ];

        return [
            'success' => true,
            'tools' => [
                'builtin' => $builtinTools,
                'mcp' => $mcpTools,
                'delegation' => $delegationTools,
            ],
            'counts' => [
                'builtin' => count($builtinTools),
                'mcp' => count($mcpTools),
                'delegation' => count($delegationTools),
                'total' => count($builtinTools) + count($mcpTools) + count($delegationTools),
            ],
        ];
    }

    /**
     * GET /api/v1/agents/{id}/executions
     * Get execution history for an agent
     */
    public function executions(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);
        $query = $request['query'] ?? [];

        // Check access
        if (!$this->repository->canUserAccess($userId, $agentId)) {
            return $this->error('Agent not found', 404);
        }

        $limit = isset($query['limit']) ? (int) $query['limit'] : 50;
        $offset = isset($query['offset']) ? (int) $query['offset'] : 0;

        $executions = $this->runner->getExecutionHistory($agentId, $limit, $offset);

        return [
            'success' => true,
            'data' => $executions,
            'meta' => [
                'count' => count($executions),
                'limit' => $limit,
                'offset' => $offset,
            ],
        ];
    }

    /**
     * POST /api/v1/agents/{id}/duplicate
     * Duplicate an agent
     */
    public function duplicate(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);
        $data = $request['body'] ?? [];

        // Check access
        if (!$this->repository->canUserAccess($userId, $agentId)) {
            return $this->error('Agent not found', 404);
        }

        $newName = $data['name'] ?? null;

        try {
            $duplicated = $this->repository->duplicate($agentId, $userId, $newName);

            if (!$duplicated) {
                return $this->error('Failed to duplicate agent', 500);
            }

            return [
                'success' => true,
                'data' => $duplicated->toArray(),
                'message' => "Agent duplicated successfully",
            ];
        } catch (\Exception $e) {
            return $this->error('Failed to duplicate agent: ' . $e->getMessage(), 500);
        }
    }

    /**
     * POST /api/v1/agents/{id}/move-up
     * Move an agent up in display order within its team
     */
    public function moveUp(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);

        // Check ownership
        if (!$this->repository->isOwner($userId, $agentId)) {
            return $this->error('Agent not found or access denied', 404);
        }

        try {
            $success = $this->repository->moveAgentUp($agentId);

            if (!$success) {
                return $this->error('Cannot move agent up (already at top or not in a team)', 400);
            }

            $agent = $this->repository->findById($agentId);
            $teamAgents = $this->repository->findByTeamId($agent->getTeamId());

            return [
                'success' => true,
                'message' => 'Agent moved up successfully',
                'agents' => array_map(fn($a) => $a->toApiArray(), $teamAgents),
            ];
        } catch (\Exception $e) {
            return $this->error('Failed to move agent: ' . $e->getMessage(), 500);
        }
    }

    /**
     * POST /api/v1/agents/{id}/move-down
     * Move an agent down in display order within its team
     */
    public function moveDown(array $request): array
    {
        $userId = $this->getUserId($request);
        $agentId = $this->getAgentId($request);

        // Check ownership
        if (!$this->repository->isOwner($userId, $agentId)) {
            return $this->error('Agent not found or access denied', 404);
        }

        try {
            $success = $this->repository->moveAgentDown($agentId);

            if (!$success) {
                return $this->error('Cannot move agent down (already at bottom or not in a team)', 400);
            }

            $agent = $this->repository->findById($agentId);
            $teamAgents = $this->repository->findByTeamId($agent->getTeamId());

            return [
                'success' => true,
                'message' => 'Agent moved down successfully',
                'agents' => array_map(fn($a) => $a->toApiArray(), $teamAgents),
            ];
        } catch (\Exception $e) {
            return $this->error('Failed to move agent: ' . $e->getMessage(), 500);
        }
    }

    /**
     * POST /api/v1/agents/reorder
     * Reorder agents within a team
     * Body: { team_id: int, agent_ids: int[] }
     *
     * NOTE: Manager agents are always enforced at position 0 (top of stack).
     * If the submitted order places a manager elsewhere, the order will be
     * adjusted and a message will be returned.
     */
    public function reorder(array $request): array
    {
        $userId = $this->getUserId($request);
        $data = $request['body'] ?? [];

        if (empty($data['team_id'])) {
            return $this->error('team_id is required', 400);
        }

        if (empty($data['agent_ids']) || !is_array($data['agent_ids'])) {
            return $this->error('agent_ids array is required', 400);
        }

        $teamId = (int) $data['team_id'];
        $agentIds = array_map('intval', $data['agent_ids']);

        // Verify user owns all agents in the list
        foreach ($agentIds as $agentId) {
            if (!$this->repository->isOwner($userId, $agentId)) {
                return $this->error('Access denied for agent ID: ' . $agentId, 403);
            }
        }

        try {
            $result = $this->repository->updateAgentOrder($agentIds, $teamId);

            if (!$result['success']) {
                return $this->error($result['error'] ?? 'Failed to reorder agents', 500);
            }

            // Get agents with pipeline info
            $teamAgentsWithInfo = $this->repository->findByTeamIdWithPipelineInfo($teamId);

            // Format response
            $agents = array_map(function ($item) {
                $agentData = $item['agent']->toApiArray();
                $agentData['pipeline_position'] = $item['pipeline_position'];
                $agentData['pipeline_label'] = $item['pipeline_label'];
                $agentData['can_reorder'] = $item['can_reorder'];
                return $agentData;
            }, $teamAgentsWithInfo);

            $response = [
                'success' => true,
                'message' => 'Agents reordered successfully',
                'agents' => $agents,
            ];

            // Notify if order was adjusted (manager moved back to top)
            if ($result['reordered'] ?? false) {
                $response['notice'] = $result['message'];
                $response['enforced'] = true;
            }

            return $response;
        } catch (\Exception $e) {
            return $this->error('Failed to reorder agents: ' . $e->getMessage(), 500);
        }
    }

    // ========================================
    // Helper Methods
    // ========================================

    private function getUserId(array $request): int
    {
        return (int) ($request['user_id'] ?? 0);
    }

    private function getAgentId(array $request): int
    {
        return (int) ($request['params']['id'] ?? 0);
    }

    private function error(string $message, int $status = 400): array
    {
        return [
            'success' => false,
            'error' => $message,
            'status' => $status,
            // index.php sends the HTTP status from `status_code`, not
            // `status` — without this every AgentController error went out
            // as HTTP 200 with the real code buried in the body. Additive:
            // `status` is kept for any existing readers.
            'status_code' => $status,
        ];
    }

    private function sendJsonResponse(array $data, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode($data);
    }
}
