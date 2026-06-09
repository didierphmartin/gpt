<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use PDO;

/**
 * Agent MCP Controller
 *
 * Handles MCP (Model Context Protocol) JSON-RPC requests for agent management.
 * Compatible with AI clients like Claude Desktop, Cursor, VS Code, etc.
 *
 * Endpoint: POST /api/v1/mcp/agents
 *
 * Supported Methods:
 * - initialize: Handshake and capabilities
 * - agents/list: List agents
 * - agents/get: Get agent by ID
 * - agents/create: Create agent
 * - agents/update: Update agent
 * - agents/delete: Delete agent
 * - agents/run: Execute agent
 * - tools/list: List available tools
 *
 * @see docs/agentDesign.md
 */
class AgentMCPController
{
    private PDO $db;
    private array $config;
    private AgentRepository $repository;
    private AgentRunner $runner;

    private const PROTOCOL_VERSION = '2024-11-05';
    private const SERVER_NAME = 'AgentTeam';
    private const SERVER_VERSION = '1.0.0';

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;

        // Create repository
        $this->repository = new AgentRepository($db);

        // Create AIPortfolioAssistant to get LLMManager and ToolsManager.
        // DB-overlay first so providers from system_llm_settings register
        // (post-cutover the file no longer carries provider blocks).
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
     * Handle MCP JSON-RPC request
     *
     * POST /api/v1/mcp/agents
     */
    public function handle(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        $body = $request['body'] ?? [];

        // Validate JSON-RPC structure
        if (!isset($body['jsonrpc']) || $body['jsonrpc'] !== '2.0') {
            return $this->jsonRpcError(null, -32600, 'Invalid Request: missing jsonrpc 2.0');
        }

        $method = $body['method'] ?? '';
        $params = $body['params'] ?? [];
        $id = $body['id'] ?? null;

        // Route to appropriate handler
        try {
            $result = match ($method) {
                'initialize' => $this->initialize($params),
                'agents/list' => $this->listAgents($userId, $params),
                'agents/get' => $this->getAgent($userId, $params),
                'agents/create' => $this->createAgent($userId, $params),
                'agents/update' => $this->updateAgent($userId, $params),
                'agents/delete' => $this->deleteAgent($userId, $params),
                'agents/run' => $this->runAgent($userId, $params),
                'tools/list' => $this->listTools($userId),
                'tools/call' => $this->callTool($userId, $params),
                'ping' => ['pong' => true],
                default => throw new \InvalidArgumentException("Method not found: {$method}"),
            };

            return $this->jsonRpcSuccess($id, $result);

        } catch (\InvalidArgumentException $e) {
            return $this->jsonRpcError($id, -32601, $e->getMessage());
        } catch (\Exception $e) {
            return $this->jsonRpcError($id, -32603, $e->getMessage());
        }
    }

    /**
     * Initialize - MCP handshake
     */
    private function initialize(array $params): array
    {
        return [
            'protocolVersion' => self::PROTOCOL_VERSION,
            'capabilities' => [
                'tools' => [
                    'listChanged' => true,
                ],
                'resources' => [
                    'subscribe' => true,
                    'listChanged' => true,
                ],
                'prompts' => [
                    'listChanged' => true,
                ],
            ],
            'serverInfo' => [
                'name' => self::SERVER_NAME,
                'version' => self::SERVER_VERSION,
            ],
        ];
    }

    /**
     * List agents accessible to user
     */
    private function listAgents(int $userId, array $params): array
    {
        $filters = [
            'agent_type' => $params['type'] ?? null,
            'provider' => $params['provider'] ?? null,
            'limit' => $params['limit'] ?? 100,
        ];

        $filters = array_filter($filters, fn($v) => $v !== null);

        $agents = $this->repository->findAccessibleByUser($userId, $filters);

        return [
            'agents' => array_map(fn($a) => [
                'id' => $a->getId(),
                'name' => $a->getName(),
                'description' => $a->getDescription(),
                'type' => $a->getAgentType(),
                'provider' => $a->getProvider(),
                'model' => $a->getModel(),
                'visibility' => $a->getVisibility(),
                'tools' => $a->getTools(),
            ], $agents),
            'count' => count($agents),
        ];
    }

    /**
     * Get agent by ID
     */
    private function getAgent(int $userId, array $params): array
    {
        $agentId = $params['id'] ?? $params['agent_id'] ?? null;

        if (!$agentId) {
            throw new \InvalidArgumentException('agent_id is required');
        }

        if (!$this->repository->canUserAccess($userId, (int) $agentId)) {
            throw new \InvalidArgumentException('Agent not found');
        }

        $agent = $this->repository->findById((int) $agentId);

        return [
            'agent' => $agent->toArray(),
        ];
    }

    /**
     * Create a new agent
     */
    private function createAgent(int $userId, array $params): array
    {
        if (empty($params['name'])) {
            throw new \InvalidArgumentException('name is required');
        }

        $agent = new Agent([
            'user_id' => $userId,
            'name' => $params['name'],
            'description' => $params['description'] ?? '',
            'agent_type' => $params['agent_type'] ?? 'standard',
            'provider' => $params['provider'] ?? 'claude',
            'model' => $params['model'] ?? null,
            'instructions' => $params['instructions'] ?? '',
            'tools' => $params['tools'] ?? [],
            'can_delegate_to' => $params['can_delegate_to'] ?? [],
            'visibility' => $params['visibility'] ?? 'personal',
            'settings' => $params['settings'] ?? [],
        ]);

        $created = $this->repository->create($agent);

        return [
            'agent' => $created->toArray(),
            'message' => 'Agent created successfully',
        ];
    }

    /**
     * Update an existing agent
     */
    private function updateAgent(int $userId, array $params): array
    {
        $agentId = $params['id'] ?? $params['agent_id'] ?? null;

        if (!$agentId) {
            throw new \InvalidArgumentException('agent_id is required');
        }

        if (!$this->repository->isOwner($userId, (int) $agentId)) {
            throw new \InvalidArgumentException('Agent not found or access denied');
        }

        $agent = $this->repository->findById((int) $agentId);

        // Update fields
        if (isset($params['name'])) {
            $agent->setName($params['name']);
        }
        if (isset($params['description'])) {
            $agent->setDescription($params['description']);
        }
        if (isset($params['agent_type'])) {
            $agent->setAgentType($params['agent_type']);
        }
        if (isset($params['provider'])) {
            $agent->setProvider($params['provider']);
        }
        if (isset($params['model'])) {
            $agent->setModel($params['model']);
        }
        if (isset($params['instructions'])) {
            $agent->setInstructions($params['instructions']);
        }
        if (isset($params['tools'])) {
            $agent->setTools($params['tools']);
        }
        if (isset($params['can_delegate_to'])) {
            $agent->setCanDelegateTo($params['can_delegate_to']);
        }
        if (isset($params['visibility'])) {
            $agent->setVisibility($params['visibility']);
        }
        if (isset($params['enabled'])) {
            $agent->setEnabled((bool) $params['enabled']);
        }
        if (isset($params['settings'])) {
            $agent->setSettings($params['settings']);
        }

        $updated = $this->repository->update($agent);

        return [
            'agent' => $updated->toArray(),
            'message' => 'Agent updated successfully',
        ];
    }

    /**
     * Delete an agent
     */
    private function deleteAgent(int $userId, array $params): array
    {
        $agentId = $params['id'] ?? $params['agent_id'] ?? null;

        if (!$agentId) {
            throw new \InvalidArgumentException('agent_id is required');
        }

        if (!$this->repository->isOwner($userId, (int) $agentId)) {
            throw new \InvalidArgumentException('Agent not found or access denied');
        }

        $this->repository->delete((int) $agentId);

        return [
            'deleted' => true,
            'message' => 'Agent deleted successfully',
        ];
    }

    /**
     * Run an agent
     */
    private function runAgent(int $userId, array $params): array
    {
        $agentId = $params['agent_id'] ?? $params['id'] ?? null;
        $input = $params['input'] ?? $params['message'] ?? '';

        if (!$agentId) {
            throw new \InvalidArgumentException('agent_id is required');
        }

        if (empty(trim($input))) {
            throw new \InvalidArgumentException('input is required');
        }

        if (!$this->repository->canUserAccess($userId, (int) $agentId)) {
            throw new \InvalidArgumentException('Agent not found');
        }

        $agent = $this->repository->findById((int) $agentId);

        if (!$agent->isEnabled()) {
            throw new \InvalidArgumentException('Agent is disabled');
        }

        $conversationHistory = $params['conversation_history'] ?? [];

        $result = $this->runner->run(
            $agent,
            $input,
            $conversationHistory,
            $userId
        );

        return [
            'response' => [
                'text' => $result['text'] ?? '',
                'success' => $result['success'] ?? false,
                'error' => $result['error'] ?? null,
                'usage' => $result['usage'] ?? [],
                'tools_used' => $result['tools_used'] ?? [],
                'execution_id' => $result['execution_id'] ?? null,
            ],
            'agent' => [
                'id' => $agent->getId(),
                'name' => $agent->getName(),
            ],
        ];
    }

    /**
     * List available tools
     */
    private function listTools(int $userId): array
    {
        $toolsManager = $this->runner->getToolsManager();
        $mcpLoader = $this->runner->getMCPToolsLoader();

        $tools = [];

        // Built-in tools
        foreach ($toolsManager->getToolDefinitions() as $tool) {
            $tools[] = [
                'name' => $tool['name'],
                'description' => $tool['description'] ?? '',
                'inputSchema' => $tool['input_schema'] ?? [],
                'type' => 'builtin',
            ];
        }

        // MCP tools
        if ($mcpLoader) {
            foreach ($mcpLoader->getToolDefinitions() as $tool) {
                $tools[] = [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'inputSchema' => $tool['input_schema'] ?? [],
                    'type' => 'mcp',
                ];
            }
        }

        // Delegation tools
        $delegationTools = [
            [
                'name' => 'delegate_to_agent',
                'description' => 'Delegate a task to a specialized sub-agent',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'agent_name' => ['type' => 'string'],
                        'task' => ['type' => 'string'],
                        'context' => ['type' => 'string'],
                    ],
                    'required' => ['task'],
                ],
                'type' => 'delegation',
            ],
            [
                'name' => 'list_available_agents',
                'description' => 'List agents available for delegation',
                'inputSchema' => ['type' => 'object', 'properties' => []],
                'type' => 'delegation',
            ],
            [
                'name' => 'run_agents_parallel',
                'description' => 'Run multiple agents in parallel',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'delegations' => ['type' => 'array'],
                    ],
                    'required' => ['delegations'],
                ],
                'type' => 'delegation',
            ],
        ];

        $tools = array_merge($tools, $delegationTools);

        return [
            'tools' => $tools,
            'count' => count($tools),
        ];
    }

    /**
     * Call a tool directly
     */
    private function callTool(int $userId, array $params): array
    {
        $toolName = $params['name'] ?? '';
        $arguments = $params['arguments'] ?? [];

        if (empty($toolName)) {
            throw new \InvalidArgumentException('Tool name is required');
        }

        $toolsManager = $this->runner->getToolsManager();

        if (!$toolsManager->hasFunction($toolName)) {
            throw new \InvalidArgumentException("Tool not found: {$toolName}");
        }

        $result = $toolsManager->execute($toolName, $arguments, $userId);

        return [
            'content' => [
                [
                    'type' => 'text',
                    'text' => is_array($result) ? json_encode($result, JSON_PRETTY_PRINT) : (string) $result,
                ],
            ],
            'isError' => isset($result['error']),
        ];
    }

    /**
     * Create JSON-RPC success response
     */
    private function jsonRpcSuccess($id, array $result): array
    {
        return [
            'jsonrpc' => '2.0',
            'id' => $id,
            'result' => $result,
        ];
    }

    /**
     * Create JSON-RPC error response
     */
    private function jsonRpcError($id, int $code, string $message, $data = null): array
    {
        $error = [
            'code' => $code,
            'message' => $message,
        ];

        if ($data !== null) {
            $error['data'] = $data;
        }

        return [
            'jsonrpc' => '2.0',
            'id' => $id,
            'error' => $error,
        ];
    }
}
