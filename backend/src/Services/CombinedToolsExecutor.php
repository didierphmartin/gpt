<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Contracts\FunctionExecutorInterface;

/**
 * Combines regular tools with MCP tools for unified execution
 */
class CombinedToolsExecutor implements FunctionExecutorInterface
{
    private FunctionExecutorInterface $baseExecutor;
    private ?MCPToolsLoader $mcpLoader;

    public function __construct(FunctionExecutorInterface $baseExecutor, ?MCPToolsLoader $mcpLoader = null)
    {
        $this->baseExecutor = $baseExecutor;
        $this->mcpLoader = $mcpLoader;
    }

    /**
     * Execute a function - routes to MCP or base executor
     */
    public function execute(string $functionName, array $parameters, mixed $context = null): array
    {
        // Check if this is an MCP tool
        if ($this->mcpLoader && $this->mcpLoader->isMCPTool($functionName)) {
            error_log("🔌 [MCP] Executing MCP tool: {$functionName}");
            $result = $this->mcpLoader->executeTool($functionName, $parameters);

            // Log MCP tool result
            if (isset($result['error']) && $result['error']) {
                error_log("❌ [MCP] Tool error: " . ($result['message'] ?? 'Unknown error'));
            } else {
                error_log("✅ [MCP] Tool result: " . substr(json_encode($result), 0, 200));
            }

            return $result;
        }

        // Fall back to base executor for regular tools
        return $this->baseExecutor->execute($functionName, $parameters, $context);
    }

    /**
     * Check if a function is registered (in either executor)
     */
    public function hasFunction(string $functionName): bool
    {
        // Check MCP tools first
        if ($this->mcpLoader && $this->mcpLoader->isMCPTool($functionName)) {
            return true;
        }

        // Check base executor
        return $this->baseExecutor->hasFunction($functionName);
    }

    /**
     * Get all registered function names (combined from base + MCP)
     */
    public function getRegisteredFunctions(): array
    {
        $functions = $this->baseExecutor->getRegisteredFunctions();

        // Add MCP tool names
        if ($this->mcpLoader) {
            $mcpTools = $this->mcpLoader->getTools();
            $functions = array_merge($functions, array_keys($mcpTools));
        }

        return $functions;
    }

    /**
     * Get combined tool definitions (implements FunctionExecutorInterface)
     */
    public function getToolDefinitions(): array
    {
        // Get base tool definitions
        $tools = $this->baseExecutor->getToolDefinitions();

        // Add MCP tool definitions
        if ($this->mcpLoader) {
            $mcpTools = $this->mcpLoader->getToolDefinitions();
            $tools = array_merge($tools, $mcpTools);
        }

        return $tools;
    }

    /**
     * Register a new function (delegates to base executor)
     */
    public function registerFunction(string $name, callable $handler, array $schema): self
    {
        $this->baseExecutor->registerFunction($name, $handler, $schema);
        return $this;
    }

    /**
     * Get combined tool definitions (alias for getToolDefinitions)
     * @deprecated Use getToolDefinitions() instead
     */
    public function getCombinedToolDefinitions(): array
    {
        return $this->getToolDefinitions();
    }

    /**
     * Get base executor
     */
    public function getBaseExecutor(): FunctionExecutorInterface
    {
        return $this->baseExecutor;
    }

    /**
     * Get MCP loader
     */
    public function getMCPLoader(): ?MCPToolsLoader
    {
        return $this->mcpLoader;
    }

    /**
     * Check if a function is an MCP tool
     */
    public function isMCPTool(string $functionName): bool
    {
        if ($this->mcpLoader && $this->mcpLoader->isMCPTool($functionName)) {
            return true;
        }
        return false;
    }
}
