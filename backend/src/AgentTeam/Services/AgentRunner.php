<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Agent;
use AgentTeam\Functions\AgentDelegationFunctions;
use AgentTeam\Services\AgentToolsExecutor;
use AgentTeam\Services\SessionSearchService;
use Quantis\AIPortfolioAssistant\Services\LLMManager;
use Quantis\AIPortfolioAssistant\Services\ToolsManager;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\CombinedToolsExecutor;
use Quantis\AIPortfolioAssistant\Services\FilteredToolsExecutor;
use PDO;

/**
 * Agent Runner
 *
 * Executes agents with their configured tools and settings.
 * Integrates with existing LLMManager and ToolsManager.
 *
 * @see docs/agentDesign.md
 */
class AgentRunner
{
    private LLMManager $llmManager;
    private ToolsManager $toolsManager;
    private ?MCPToolsLoader $mcpToolsLoader;
    private PDO $db;
    private array $config;

    /**
     * Delegation functions for manager agents
     */
    private ?AgentDelegationFunctions $delegationFunctions = null;

    /**
     * Tracks whether session_search has been registered on the shared
     * ToolsManager for the current request. Idempotent.
     */
    private bool $sessionSearchRegistered = false;

    /**
     * Context passed to tools during execution (for delegation)
     */
    private array $executionContext = [];

    /**
     * Stream context for real-time agent activity events
     */
    private ?StreamContext $streamContext = null;

    public function __construct(
        LLMManager $llmManager,
        ToolsManager $toolsManager,
        ?MCPToolsLoader $mcpToolsLoader,
        PDO $db,
        array $config = []
    ) {
        $this->llmManager = $llmManager;
        $this->toolsManager = $toolsManager;
        $this->mcpToolsLoader = $mcpToolsLoader;
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Run an agent with the given input (non-streaming)
     *
     * Uses the provider's built-in tool loop for unified execution.
     * Delegation tools are auto-added for manager agents.
     */
    public function run(
        Agent $agent,
        string $input,
        array $conversationHistory = [],
        int $userId = 0,
        array $context = []
    ): array {
        error_log("[AgentRunner::run] Starting agent: {$agent->getName()} (id={$agent->getId()})");

        // Create execution record
        $executionId = $this->createExecution($agent, $userId, $input, $context);
        error_log("[AgentRunner::run] Execution record created: id={$executionId}");

        // Set execution context for delegation tools
        $this->executionContext = [
            'current_agent_id' => $agent->getId(),
            'execution_id' => $executionId,
            'user_id' => $userId,
            'parent_execution_id' => $context['parent_execution_id'] ?? null,
            'stream_context' => $this->streamContext,
        ];

        // Emit agent_start event
        if ($this->streamContext) {
            $this->streamContext->emitAgentStart(
                $agent->getId(),
                $agent->getName(),
                $agent->getAgentType(),
                $context['parent_agent_id'] ?? null,
                $executionId
            );
        }

        try {
            // Get the LLM provider
            $provider = $this->llmManager->getProvider($agent->getProvider());

            if (!$provider) {
                throw new \RuntimeException("Provider '{$agent->getProvider()}' not found");
            }

            // Set model if specified
            if ($agent->getModel()) {
                $provider->setModel($agent->getModel());
            }

            // Set up unified function executor with delegation tools for managers
            $this->setupFunctionExecutor($provider, $agent);

            // Build options from agent settings
            $options = $this->buildOptions($agent);
            $options['user_id'] = $userId;

            // Extract tools filter from context
            $toolsFilter = $context['tools_filter'] ?? null;

            // Build tool definitions (auto-includes delegation for managers)
            $tools = $this->buildToolsForAgent($agent, $toolsFilter);

            // Per-call extras from the caller (e.g. workflow runner
            // injecting `run_skill_script` when the node is bound to a
            // folder-backed skill with executable scripts). These are
            // appended to the agent's normal tool set so they're only
            // visible for this single call — the underlying agent
            // template is unchanged.
            if (!empty($context['extra_tools']) && is_array($context['extra_tools'])) {
                foreach ($context['extra_tools'] as $extra) {
                    if (is_array($extra)) $tools[] = $extra;
                }
            }

            if (!empty($tools)) {
                $options['tools'] = $tools;
                // Force tool usage for manager agents - they MUST delegate
                if ($agent->getAgentType() === 'manager') {
                    $options['tool_choice'] = 'required';
                }
            }

            // Per-call tool_choice override from the caller. Workflow
            // runner uses this to force run_skill_script on the first
            // turn for bound-skill agents — without forcing, the LLM
            // sometimes produces prose instead of calling the script.
            // Caller-supplied value wins over the manager default above.
            if (isset($context['tool_choice'])) {
                $options['tool_choice'] = $context['tool_choice'];
            }

            // skill_metadata mirrors what ChatController passes when
            // run_skill_script is in play, so the providers' B3 short-
            // circuit (emitClientToolCallEvent) recognises this as a
            // browser-bound tool. Workflow runner sets it from the
            // bound folder-backed skill before calling AgentRunner.
            if (!empty($context['skill_metadata']) && is_array($context['skill_metadata'])) {
                $options['skill_metadata'] = $context['skill_metadata'];
            }

            // Pass output_schema through for constrained decoding (structured outputs).
            // Resolved upstream by GraphWorkflowRunner from node config.
            if (!empty($context['output_schema']) && is_array($context['output_schema'])) {
                $options['output_schema'] = $context['output_schema'];
            }

            // Build system prompt - workflow logic is defined in manager's instructions
            $systemPrompt = $agent->buildSystemPrompt();

            // Build messages with system prompt
            $messages = $this->buildMessages(
                $systemPrompt,
                $conversationHistory,
                $input
            );

            // Execute chat - provider handles tool loop internally
            $startTime = microtime(true);
            $response = $provider->chat($input, $messages, $options);
            $responseTime = (microtime(true) - $startTime) * 1000;

            // Extract response data
            $text = $response['text'] ?? '';
            $usage = $response['usage'] ?? [];
            $functionsCalled = $response['functions_called'] ?? [];

            // Complete execution record
            $this->completeExecution($executionId, [
                'text' => $text,
                'usage' => $usage,
                'tool_calls' => $functionsCalled,
            ], $responseTime);

            // Emit agent_complete event
            if ($this->streamContext) {
                $this->streamContext->emitAgentComplete(
                    $agent->getId(),
                    $agent->getName(),
                    $agent->getAgentType(),
                    true,
                    null,
                    $executionId
                );
            }

            $result = [
                'success' => true,
                'text' => $text,
                'usage' => $usage,
                'tools_used' => $functionsCalled,
                'execution_id' => $executionId,
                'agent' => [
                    'id' => $agent->getId(),
                    'name' => $agent->getName(),
                    'type' => $agent->getAgentType(),
                ],
                'provider' => $agent->getProvider(),
                'model' => $agent->getModel() ?? $provider->getModel(),
                'response_time_ms' => round($responseTime),
            ];

            // B3 short-circuit: provider bailed out because the LLM
            // emitted a client-side tool (run_skill_script). Surface
            // the marker so the workflow runner can take the
            // round-trip to the browser and resume.
            if (!empty($response['pending_client_tool_call'])) {
                $result['pending_client_tool_call'] = true;
                $result['pending_tool_calls'] = $response['pending_tool_calls'] ?? [];
                $result['pending_assistant_text'] = $text;
            }

            return $result;

        } catch (\Exception $e) {
            $this->failExecution($executionId, $e->getMessage());

            // Emit agent_complete event with error
            if ($this->streamContext) {
                $this->streamContext->emitAgentComplete(
                    $agent->getId(),
                    $agent->getName(),
                    $agent->getAgentType(),
                    false,
                    $e->getMessage(),
                    $executionId
                );
            }

            return [
                'success' => false,
                'error' => $e->getMessage(),
                'execution_id' => $executionId,
                'agent' => [
                    'id' => $agent->getId(),
                    'name' => $agent->getName(),
                ],
            ];
        }
    }

    /**
     * Set up function executor on the provider
     *
     * For manager agents, includes delegation tools.
     * For all agents, combines built-in + MCP tools.
     */
    private function setupFunctionExecutor($provider, Agent $agent): void
    {
        if (!method_exists($provider, 'setFunctionExecutor')) {
            return;
        }

        // Register session_search on the shared ToolsManager once per
        // request (idempotent). user_id comes from the per-run
        // executionContext set earlier in run()/streamRun().
        $this->ensureSessionSearchRegistered();

        // Create base executor (built-in + MCP)
        $baseExecutor = new CombinedToolsExecutor($this->toolsManager, $this->mcpToolsLoader);

        // For managers, wrap with AgentToolsExecutor to include delegation
        if ($agent->getAgentType() === 'manager') {
            $executor = new AgentToolsExecutor($baseExecutor, $this->getDelegationFunctions());
            $executor->setExecutionContext($this->executionContext);
            $provider->setFunctionExecutor($executor);
        } else {
            // Workers use base executor (no delegation tools)
            $provider->setFunctionExecutor($baseExecutor);
        }
    }

    /**
     * Register session_search on the shared ToolsManager bound to the
     * current executionContext's user_id. Idempotent — runs once per
     * AgentRunner instance (which lives for one HTTP request).
     */
    private function ensureSessionSearchRegistered(): void
    {
        if ($this->sessionSearchRegistered) {
            return;
        }
        $userId = (int) ($this->executionContext['user_id'] ?? 0);
        if ($userId <= 0) {
            return;
        }
        $this->sessionSearchRegistered = SessionSearchService::registerAsTool(
            $this->toolsManager,
            $userId,
            $this->config
        );
    }

    /**
     * Run an agent with streaming response (SSE)
     *
     * @param Agent $agent The agent to run
     * @param string $input User input message
     * @param array $conversationHistory Previous conversation messages
     * @param int $userId User ID
     * @param callable|null $onChunk Callback for streaming chunks
     * @param array $context Additional context (e.g., tools_filter)
     */
    public function streamRun(
        Agent $agent,
        string $input,
        array $conversationHistory = [],
        int $userId = 0,
        ?callable $onChunk = null,
        array $context = []
    ): array {
        // Create execution record
        $executionId = $this->createExecution($agent, $userId, $input, []);

        // Create or update stream context with the callback
        if ($onChunk && !$this->streamContext) {
            $this->streamContext = new StreamContext($onChunk, $userId);
        } elseif ($onChunk && $this->streamContext) {
            $this->streamContext->setEventCallback($onChunk);
        }

        // Set root execution ID if this is the first agent
        if ($this->streamContext && !$this->streamContext->getRootExecutionId()) {
            $this->streamContext->setRootExecutionId($executionId);
        }

        // Set execution context
        $this->executionContext = [
            'current_agent_id' => $agent->getId(),
            'execution_id' => $executionId,
            'user_id' => $userId,
            'stream_context' => $this->streamContext,
        ];

        // Debug: Log stream context status
        error_log("[AgentRunner::streamRun] Agent: {$agent->getName()}, StreamContext set: " . ($this->streamContext ? 'YES' : 'NO'));

        // Emit agent_start event
        if ($this->streamContext) {
            $this->streamContext->emitAgentStart(
                $agent->getId(),
                $agent->getName(),
                $agent->getAgentType(),
                null,
                $executionId
            );
        }

        try {
            // Get provider
            $provider = $this->llmManager->getProvider($agent->getProvider());

            if (!$provider) {
                throw new \RuntimeException("Provider '{$agent->getProvider()}' not found");
            }

            // Set model
            if ($agent->getModel()) {
                $provider->setModel($agent->getModel());
            }

            // Set up function executor (required for tool calls including delegation)
            $this->setupFunctionExecutor($provider, $agent);

            // Build options
            $options = $this->buildOptions($agent);
            $options['user_id'] = $userId;

            // Extract tools filter from context
            $toolsFilter = $context['tools_filter'] ?? null;

            // Build tools with optional filter
            $tools = $this->buildToolsForAgent($agent, $toolsFilter);
            if (!empty($tools)) {
                $options['tools'] = $tools;
                // Force tool usage for manager agents - they MUST delegate
                if ($agent->getAgentType() === 'manager') {
                    $options['tool_choice'] = 'required';
                }
            }

            // Build system prompt - workflow logic is defined in manager's instructions
            $systemPrompt = $agent->buildSystemPrompt();

            // Build messages
            $messages = $this->buildMessages($systemPrompt, $conversationHistory, $input);

            // Create streaming callback
            $fullText = '';
            $streamCallback = function ($chunk) use ($onChunk, $agent, &$fullText) {
                $text = is_array($chunk) ? ($chunk['text'] ?? '') : $chunk;
                $fullText .= $text;

                if ($onChunk) {
                    $onChunk([
                        'type' => 'chunk',
                        'text' => $text,
                        'agent_id' => $agent->getId(),
                        'agent_name' => $agent->getName(),
                    ]);
                }
            };

            // Execute streaming chat
            $startTime = microtime(true);
            $response = $provider->streamChat($input, $streamCallback, $messages, $options);
            $responseTime = (microtime(true) - $startTime) * 1000;

            // Complete execution
            $this->completeExecution($executionId, [
                'text' => $fullText,
                'usage' => $response['usage'] ?? [],
                'tool_calls' => $response['tool_calls'] ?? [],
            ], $responseTime);

            // Emit agent_complete event
            if ($this->streamContext) {
                $this->streamContext->emitAgentComplete(
                    $agent->getId(),
                    $agent->getName(),
                    $agent->getAgentType(),
                    true,
                    null,
                    $executionId
                );
            }

            return [
                'success' => true,
                'text' => $fullText,
                'usage' => $response['usage'] ?? [],
                'execution_id' => $executionId,
            ];

        } catch (\Exception $e) {
            $this->failExecution($executionId, $e->getMessage());

            // Emit agent_complete event with error
            if ($this->streamContext) {
                $this->streamContext->emitAgentComplete(
                    $agent->getId(),
                    $agent->getName(),
                    $agent->getAgentType(),
                    false,
                    $e->getMessage(),
                    $executionId
                );
            }

            // Send error through stream if callback exists
            if ($onChunk) {
                $onChunk([
                    'type' => 'error',
                    'error' => $e->getMessage(),
                    'agent_id' => $agent->getId(),
                ]);
            }

            return [
                'success' => false,
                'error' => $e->getMessage(),
                'execution_id' => $executionId,
            ];
        }
    }

    /**
     * Get delegation functions with fresh DB connection
     * Always creates fresh repository to ensure current DB connection is used
     * (connection may have been refreshed after going stale)
     */
    private function getDelegationFunctions(): AgentDelegationFunctions
    {
        // Always ensure connection is valid and create fresh repository
        $this->ensureDbConnection();
        $repository = new AgentRepository($this->db);
        $this->delegationFunctions = new AgentDelegationFunctions($repository, $this);
        return $this->delegationFunctions;
    }

    /**
     * Build tool definitions for an agent
     *
     * Tool access by agent type:
     * - Manager: ONLY delegation tools (forces delegation to workers)
     * - Worker/Standard: Built-in tools + configured MCP tools
     *
     * @param Agent $agent The agent to build tools for
     * @param array|null $toolsFilter Optional list of tool names to filter (null = all tools)
     */
    private function buildToolsForAgent(Agent $agent, ?array $toolsFilter = null): array
    {
        $tools = [];

        // Manager agents get delegation tools: delegate_to_agent, list_available_agents, complete_task
        if ($agent->getAgentType() === 'manager') {
            $delegationFuncs = $this->getDelegationFunctions()->getAllFunctions();

            // Give managers list_available_agents to discover their workers
            if (isset($delegationFuncs['list_available_agents'])) {
                $func = $delegationFuncs['list_available_agents'];
                $tools['list_available_agents'] = [
                    'name' => 'list_available_agents',
                    'description' => $func['schema']['description'],
                    'input_schema' => $func['schema']['input_schema'],
                ];
            }

            // Give managers delegate_to_agent for delegating to workers
            if (isset($delegationFuncs['delegate_to_agent'])) {
                $func = $delegationFuncs['delegate_to_agent'];
                $tools['delegate_to_agent'] = [
                    'name' => 'delegate_to_agent',
                    'description' => $func['schema']['description'],
                    'input_schema' => $func['schema']['input_schema'],
                ];
            }

            // Give managers complete_task to signal workflow completion
            if (isset($delegationFuncs['complete_task'])) {
                $func = $delegationFuncs['complete_task'];
                $tools['complete_task'] = [
                    'name' => 'complete_task',
                    'description' => $func['schema']['description'],
                    'input_schema' => $func['schema']['input_schema'],
                ];
            }

            // Managers don't get built-in or MCP tools - they must delegate
            return array_values($tools);
        }

        // Workers and standard agents get built-in tools
        $builtinTools = $this->toolsManager->getToolDefinitions();
        foreach ($builtinTools as $tool) {
            $tools[$tool['name']] = $tool;
        }

        // Add ALL MCP tools - same as conversation does
        // This ensures agents have the same capabilities as regular chat
        if ($this->mcpToolsLoader) {
            $mcpTools = $this->mcpToolsLoader->getToolDefinitions();
            foreach ($mcpTools as $tool) {
                $tools[$tool['name']] = $tool;
            }
        }

        $allTools = array_values($tools);

        // Apply tools filter if specified
        if ($toolsFilter !== null && !empty($toolsFilter)) {
            $filteredTools = array_filter($allTools, function ($tool) use ($toolsFilter) {
                return in_array($tool['name'], $toolsFilter, true);
            });
            error_log("[AgentRunner] Tool filter applied: " . count($filteredTools) . "/" . count($allTools) . " tools");
            return array_values($filteredTools);
        }

        return $allTools;
    }

    /**
     * Build options array from agent settings
     */
    private function buildOptions(Agent $agent): array
    {
        $settings = $agent->getSettings();
        $options = [];

        // Temperature
        if (isset($settings['temperature'])) {
            $options['temperature'] = (float) $settings['temperature'];
        }

        // Max tokens
        if (isset($settings['max_tokens'])) {
            $options['max_tokens'] = (int) $settings['max_tokens'];
        }

        // System prompt is passed to provider via system_prompt key
        $options['system_prompt'] = $agent->buildSystemPrompt();

        return $options;
    }

    /**
     * Build messages array for LLM
     */
    private function buildMessages(string $systemPrompt, array $conversationHistory, string $input): array
    {
        $messages = [];

        // Add conversation history
        foreach ($conversationHistory as $msg) {
            if (is_array($msg) && isset($msg['role']) && isset($msg['content'])) {
                $messages[] = $msg;
            }
        }

        return $messages;
    }

    /**
     * Create execution record in database
     */
    private function createExecution(Agent $agent, int $userId, string $input, array $context): int
    {
        // Skip execution record for inline agents (no database ID)
        if ($agent->getId() === null) {
            error_log("[AgentRunner] Skipping execution record for inline agent: {$agent->getName()}");
            return 0;
        }

        try {
            $this->ensureDbConnection();
            $stmt = $this->db->prepare(
                "INSERT INTO agent_executions
                 (agent_id, user_id, parent_execution_id, input, status, metadata)
                 VALUES (?, ?, ?, ?, 'running', ?)"
            );

            $stmt->execute([
                $agent->getId(),
                $userId,
                $context['parent_execution_id'] ?? null,
                $input,
                json_encode([
                    'provider' => $agent->getProvider(),
                    'model' => $agent->getModel(),
                    'agent_type' => $agent->getAgentType(),
                ]),
            ]);

            return (int) $this->db->lastInsertId();
        } catch (\PDOException $e) {
            // Log error but don't fail the execution
            error_log("[AgentRunner] Failed to create execution record: " . $e->getMessage());
            return 0;
        }
    }

    /**
     * Mark execution as completed
     */
    private function completeExecution(int $executionId, array $response, float $responseTime): void
    {
        if ($executionId === 0) {
            return;
        }

        try {
            $this->ensureDbConnection();
            $usage = $response['usage'] ?? [];
            $promptTokens = $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0;
            $completionTokens = $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0;

            $stmt = $this->db->prepare(
                "UPDATE agent_executions SET
                 status = 'completed',
                 output = ?,
                 prompt_tokens = ?,
                 completion_tokens = ?,
                 tokens_used = ?,
                 response_time_ms = ?,
                 tools_called = ?,
                 completed_at = NOW()
                 WHERE id = ?"
            );

            $stmt->execute([
                $response['text'] ?? '',
                $promptTokens,
                $completionTokens,
                $promptTokens + $completionTokens,
                (int) $responseTime,
                json_encode(array_map(
                    fn($t) => is_array($t) ? ($t['name'] ?? 'unknown') : $t,
                    $response['tool_calls'] ?? []
                )),
                $executionId,
            ]);
        } catch (\PDOException $e) {
            error_log("[AgentRunner] Failed to complete execution record: " . $e->getMessage());
        }
    }

    /**
     * Mark execution as failed
     */
    private function failExecution(int $executionId, string $error): void
    {
        // Always log the error for debugging
        error_log("[AgentRunner] Agent execution failed: " . $error);

        if ($executionId === 0) {
            return;
        }

        try {
            $this->ensureDbConnection();
            $stmt = $this->db->prepare(
                "UPDATE agent_executions SET
                 status = 'failed',
                 error_message = ?,
                 completed_at = NOW()
                 WHERE id = ?"
            );

            $stmt->execute([$error, $executionId]);
        } catch (\PDOException $e) {
            error_log("[AgentRunner] Failed to mark execution as failed: " . $e->getMessage());
        }
    }

    /**
     * Get a fresh AgentRepository with valid DB connection
     * Used by delegation functions to ensure connection is alive
     */
    public function getFreshRepository(): AgentRepository
    {
        $this->ensureDbConnection();
        return new AgentRepository($this->db);
    }

    /**
     * Ensure database connection is alive, reconnect if needed
     */
    private function ensureDbConnection(): void
    {
        try {
            $this->db->query('SELECT 1');
        } catch (\PDOException $e) {
            // Connection lost, try to reconnect
            error_log("[AgentRunner] DB connection lost, reconnecting...");
            $dbConfig = $this->config['contexts_database'] ?? $this->config['database'] ?? [];
            if (!empty($dbConfig)) {
                $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset=" . ($dbConfig['charset'] ?? 'utf8mb4');
                $this->db = new \PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
                    \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                    \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
                ]);
                error_log("[AgentRunner] DB reconnected successfully");
            }
        }
    }

    /**
     * Get available worker agents for a manager (for workflow decisions)
     */
    public function getAvailableWorkers(int $managerId): array
    {
        $this->ensureDbConnection();
        $repository = new AgentRepository($this->db);
        $workers = $repository->findWorkerAgents($managerId);

        return array_map(function($agent) {
            return [
                'id' => $agent->getId(),
                'name' => $agent->getName(),
                'description' => $agent->getDescription(),
                'agent_type' => $agent->getAgentType(),
            ];
        }, $workers);
    }

    /**
     * Get execution context (for delegation functions)
     */
    public function getExecutionContext(): array
    {
        return $this->executionContext;
    }

    /**
     * Set execution context
     */
    public function setExecutionContext(array $context): self
    {
        $this->executionContext = $context;
        return $this;
    }

    /**
     * Get stream context
     */
    public function getStreamContext(): ?StreamContext
    {
        return $this->streamContext;
    }

    /**
     * Set stream context for real-time activity events
     */
    public function setStreamContext(?StreamContext $context): self
    {
        $this->streamContext = $context;
        return $this;
    }

    /**
     * Get execution history for an agent
     */
    public function getExecutionHistory(int $agentId, int $limit = 50, int $offset = 0): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agent_executions
             WHERE agent_id = ?
             ORDER BY started_at DESC
             LIMIT ? OFFSET ?"
        );
        $stmt->execute([$agentId, $limit, $offset]);

        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Get a specific execution by ID
     */
    public function getExecution(int $executionId): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM agent_executions WHERE id = ?");
        $stmt->execute([$executionId]);
        $result = $stmt->fetch(PDO::FETCH_ASSOC);

        return $result ?: null;
    }

    /**
     * Get child executions (delegations) for a parent execution
     */
    public function getChildExecutions(int $parentExecutionId): array
    {
        $stmt = $this->db->prepare(
            "SELECT e.*, a.name as agent_name
             FROM agent_executions e
             JOIN agents a ON e.agent_id = a.id
             WHERE e.parent_execution_id = ?
             ORDER BY e.started_at ASC"
        );
        $stmt->execute([$parentExecutionId]);

        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Get LLM Manager (for access to providers)
     */
    public function getLLMManager(): LLMManager
    {
        return $this->llmManager;
    }

    /**
     * Get Tools Manager
     */
    public function getToolsManager(): ToolsManager
    {
        return $this->toolsManager;
    }

    /**
     * Get MCP Tools Loader
     */
    public function getMCPToolsLoader(): ?MCPToolsLoader
    {
        return $this->mcpToolsLoader;
    }
}
