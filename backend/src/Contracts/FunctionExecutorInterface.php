<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Contracts;

/**
 * Interface for executing LLM function calls
 */
interface FunctionExecutorInterface
{
    /**
     * Execute a function by name with given parameters
     *
     * @param string $functionName Name of the function to execute
     * @param array $parameters Function parameters
     * @param mixed $context Additional context (e.g., user ID, JWT token)
     * @return array Function result
     */
    public function execute(string $functionName, array $parameters, mixed $context = null): array;

    /**
     * Check if a function is registered
     */
    public function hasFunction(string $functionName): bool;

    /**
     * Get all registered function names
     */
    public function getRegisteredFunctions(): array;

    /**
     * Get the tool definition for Claude API
     */
    public function getToolDefinitions(): array;

    /**
     * Register a new function
     *
     * @param string $name Function name
     * @param callable $handler Function handler
     * @param array $schema Tool schema for the LLM
     */
    public function registerFunction(string $name, callable $handler, array $schema): self;

    /**
     * Check if a function is an MCP tool
     *
     * @param string $functionName Function name to check
     * @return bool True if this is an MCP tool, false for regular tools
     */
    public function isMCPTool(string $functionName): bool;
}
