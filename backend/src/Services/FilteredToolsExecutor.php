<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Contracts\FunctionExecutorInterface;

/**
 * Filters tool definitions to only include allowed tools
 *
 * Wraps another FunctionExecutorInterface and filters getToolDefinitions()
 * to only return tools that are in the allowed list.
 *
 * Usage:
 *   $filtered = new FilteredToolsExecutor($baseExecutor);
 *   $filtered->setAllowedTools(['tool_a', 'mcp_tool_b']);
 *   $provider->setFunctionExecutor($filtered);
 */
class FilteredToolsExecutor implements FunctionExecutorInterface
{
    private FunctionExecutorInterface $baseExecutor;

    /**
     * List of allowed tool names. If null, all tools are allowed.
     * @var array<string>|null
     */
    private ?array $allowedTools = null;

    public function __construct(FunctionExecutorInterface $baseExecutor)
    {
        $this->baseExecutor = $baseExecutor;
    }

    /**
     * Set the list of allowed tool names
     *
     * @param array<string>|null $tools List of tool names to allow, or null to allow all
     */
    public function setAllowedTools(?array $tools): self
    {
        $this->allowedTools = $tools;
        return $this;
    }

    /**
     * Get the list of allowed tools
     *
     * @return array<string>|null
     */
    public function getAllowedTools(): ?array
    {
        return $this->allowedTools;
    }

    /**
     * Check if filtering is active
     */
    public function isFiltering(): bool
    {
        return $this->allowedTools !== null && !empty($this->allowedTools);
    }

    /**
     * Execute a function by name with given parameters
     *
     * Execution is NOT filtered - all registered tools can be executed.
     * Only tool definitions returned to LLM are filtered.
     */
    public function execute(string $functionName, array $parameters, mixed $context = null): array
    {
        return $this->baseExecutor->execute($functionName, $parameters, $context);
    }

    /**
     * Check if a function is registered
     */
    public function hasFunction(string $functionName): bool
    {
        return $this->baseExecutor->hasFunction($functionName);
    }

    /**
     * Get all registered function names (unfiltered)
     */
    public function getRegisteredFunctions(): array
    {
        return $this->baseExecutor->getRegisteredFunctions();
    }

    /**
     * Get filtered tool definitions for LLM API
     *
     * If allowedTools is set, only returns tools whose names are in the list.
     * If allowedTools is null or empty, returns all tools.
     */
    public function getToolDefinitions(): array
    {
        $allTools = $this->baseExecutor->getToolDefinitions();

        // If no filter is set, return all tools
        if ($this->allowedTools === null || empty($this->allowedTools)) {
            return $allTools;
        }

        // Filter tools to only include those in the allowed list
        $filtered = array_filter($allTools, function ($tool) {
            $name = $tool['name'] ?? '';
            return in_array($name, $this->allowedTools, true);
        });

        // Log filtering info
        $originalCount = count($allTools);
        $filteredCount = count($filtered);
        if ($filteredCount < $originalCount) {
            error_log("[FilteredToolsExecutor] Filtered tools: {$filteredCount}/{$originalCount} allowed");
        }

        return array_values($filtered);
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
     * Check if a function is an MCP tool
     */
    public function isMCPTool(string $functionName): bool
    {
        return $this->baseExecutor->isMCPTool($functionName);
    }

    /**
     * Get the base executor
     */
    public function getBaseExecutor(): FunctionExecutorInterface
    {
        return $this->baseExecutor;
    }
}
