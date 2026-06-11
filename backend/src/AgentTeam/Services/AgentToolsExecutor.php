<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Functions\AgentDelegationFunctions;
use Quantis\AIPortfolioAssistant\Contracts\FunctionExecutorInterface;

/**
 * Agent Tools Executor
 *
 * Combines built-in tools, MCP tools, and delegation tools into a single executor.
 * Used when running agents to provide unified tool execution.
 */
class AgentToolsExecutor implements FunctionExecutorInterface
{
    private FunctionExecutorInterface $baseExecutor;
    private ?AgentDelegationFunctions $delegationFunctions;

    /**
     * Execution context for delegation tools
     * Contains: current_agent_id, execution_id, user_id, parent_execution_id
     */
    private array $executionContext = [];

    /**
     * Delegation tool names
     */
    private const DELEGATION_TOOLS = [
        'delegate_to_agent',
        'list_available_agents',
        'run_agents_parallel',
    ];

    public function __construct(
        FunctionExecutorInterface $baseExecutor,
        ?AgentDelegationFunctions $delegationFunctions = null
    ) {
        $this->baseExecutor = $baseExecutor;
        $this->delegationFunctions = $delegationFunctions;
    }

    /**
     * Set execution context for delegation tools
     */
    public function setExecutionContext(array $context): self
    {
        $this->executionContext = $context;
        return $this;
    }

    /**
     * Get execution context
     */
    public function getExecutionContext(): array
    {
        return $this->executionContext;
    }

    /**
     * Execute a function by name
     */
    public function execute(string $functionName, array $parameters, mixed $context = null): array
    {
        // Check if it's a delegation tool
        if ($this->isDelegationTool($functionName)) {
            if (!$this->delegationFunctions) {
                return ['error' => 'Delegation functions not configured'];
            }

            // Use stored execution context for delegation tools
            return $this->executeDelegationTool($functionName, $parameters);
        }

        // Fall back to base executor (built-in + MCP tools)
        return $this->baseExecutor->execute($functionName, $parameters, $context);
    }

    /**
     * Execute a delegation tool
     * Uses stored executionContext instead of passed context
     */
    private function executeDelegationTool(string $toolName, array $parameters): array
    {
        $functions = $this->delegationFunctions->getAllFunctions();

        if (!isset($functions[$toolName])) {
            return ['error' => "Unknown delegation tool: {$toolName}"];
        }

        $handler = $functions[$toolName]['handler'];

        try {
            // Pass stored execution context (has agent_id, user_id, etc.)
            return \call_user_func($handler, $parameters, $this->executionContext);
        } catch (\Throwable $e) {
            return ['error' => "Delegation tool error: " . $e->getMessage()];
        }
    }

    /**
     * Check if a function name is a delegation tool
     */
    public function isDelegationTool(string $functionName): bool
    {
        return \in_array($functionName, self::DELEGATION_TOOLS, true);
    }

    /**
     * Check if a function is registered
     */
    public function hasFunction(string $functionName): bool
    {
        if ($this->isDelegationTool($functionName) && $this->delegationFunctions) {
            return true;
        }

        return $this->baseExecutor->hasFunction($functionName);
    }

    /**
     * Get all registered function names
     */
    public function getRegisteredFunctions(): array
    {
        $functions = $this->baseExecutor->getRegisteredFunctions();

        if ($this->delegationFunctions) {
            $functions = array_merge($functions, self::DELEGATION_TOOLS);
        }

        return $functions;
    }

    /**
     * Get tool definitions (for LLM)
     */
    public function getToolDefinitions(): array
    {
        $tools = $this->baseExecutor->getToolDefinitions();

        // Add delegation tool definitions if available
        if ($this->delegationFunctions) {
            foreach ($this->delegationFunctions->getAllFunctions() as $name => $func) {
                $tools[] = [
                    'name' => $name,
                    'description' => $func['schema']['description'],
                    'input_schema' => $func['schema']['input_schema'],
                ];
            }
        }

        return $tools;
    }

    /**
     * Get delegation tool definitions only
     */
    public function getDelegationToolDefinitions(): array
    {
        if (!$this->delegationFunctions) {
            return [];
        }

        $tools = [];
        foreach ($this->delegationFunctions->getAllFunctions() as $name => $func) {
            $tools[] = [
                'name' => $name,
                'description' => $func['schema']['description'],
                'input_schema' => $func['schema']['input_schema'],
            ];
        }

        return $tools;
    }

    /**
     * Register a function (delegates to base executor)
     */
    public function registerFunction(string $name, callable $handler, array $schema): self
    {
        $this->baseExecutor->registerFunction($name, $handler, $schema);
        return $this;
    }

    /**
     * Check if a function is an MCP tool
     */
    public function isMCPTool(string $functionName): bool
    {
        if (method_exists($this->baseExecutor, 'isMCPTool')) {
            return $this->baseExecutor->isMCPTool($functionName);
        }
        return false;
    }

    /**
     * Get the base executor
     */
    public function getBaseExecutor(): FunctionExecutorInterface
    {
        return $this->baseExecutor;
    }
}
