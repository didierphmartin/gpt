<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Contracts\FunctionExecutorInterface;
use Quantis\AIPortfolioAssistant\Exceptions\FunctionExecutionException;

/**
 * Manages and executes LLM tool functions
 */
class ToolsManager implements FunctionExecutorInterface
{
    /**
     * @var array<string, callable> Registered function handlers
     */
    private array $functions = [];

    /**
     * @var array<string, array> Tool schemas for LLM
     */
    private array $schemas = [];

    /**
     * @var ?string Path to claude_tools.json
     */
    private ?string $toolsJsonPath = null;

    /**
     * @var array Cached tool definitions
     */
    private array $cachedToolDefinitions = [];

    public function __construct(?string $toolsJsonPath = null)
    {
        if ($toolsJsonPath) {
            $this->toolsJsonPath = $toolsJsonPath;
            $this->loadToolsFromJson();
        }
    }

    /**
     * Register a new function
     */
    public function registerFunction(string $name, callable $handler, array $schema): self
    {
        $this->functions[$name] = $handler;
        $this->schemas[$name] = $schema;
        $this->cachedToolDefinitions = []; // Clear cache

        return $this;
    }

    /**
     * Register multiple functions at once
     */
    public function registerFunctions(array $functions): self
    {
        foreach ($functions as $name => $config) {
            $this->registerFunction(
                $name,
                $config['handler'],
                $config['schema']
            );
        }

        return $this;
    }

    /**
     * Execute a function by name
     */
    public function execute(string $functionName, array $parameters, mixed $context = null): array
    {
        if (!$this->hasFunction($functionName)) {
            throw FunctionExecutionException::notFound($functionName);
        }

        try {
            $handler = $this->functions[$functionName];
            $result = $handler($parameters, $context);

            if (!is_array($result)) {
                $result = ['result' => $result];
            }

            return $result;
        } catch (\Throwable $e) {
            throw FunctionExecutionException::executionFailed($functionName, $e->getMessage());
        }
    }

    /**
     * Check if a function is registered
     */
    public function hasFunction(string $functionName): bool
    {
        return isset($this->functions[$functionName]);
    }

    /**
     * Get all registered function names
     */
    public function getRegisteredFunctions(): array
    {
        return array_keys($this->functions);
    }

    /**
     * Get tool definitions for Claude API
     */
    public function getToolDefinitions(): array
    {
        if (!empty($this->cachedToolDefinitions)) {
            return $this->cachedToolDefinitions;
        }

        $definitions = [];

        foreach ($this->schemas as $name => $schema) {
            $definitions[] = [
                'name' => $name,
                'description' => $schema['description'] ?? "Execute {$name}",
                'input_schema' => $schema['input_schema'] ?? [
                    'type' => 'object',
                    'properties' => new \stdClass(),
                    'required' => [],
                ],
            ];
        }

        $this->cachedToolDefinitions = $definitions;
        return $definitions;
    }

    /**
     * Load tool definitions from JSON file
     */
    private function loadToolsFromJson(): void
    {
        if (!$this->toolsJsonPath || !file_exists($this->toolsJsonPath)) {
            return;
        }

        $content = file_get_contents($this->toolsJsonPath);
        $tools = json_decode($content, true);

        if (!is_array($tools)) {
            return;
        }

        foreach ($tools as $tool) {
            $name = $tool['name'] ?? null;
            if (!$name) {
                continue;
            }

            $this->schemas[$name] = [
                'description' => $tool['description'] ?? '',
                'input_schema' => $tool['input_schema'] ?? [
                    'type' => 'object',
                    'properties' => new \stdClass(),
                    'required' => [],
                ],
            ];
        }
    }

    /**
     * Set tool definitions from JSON path
     */
    public function loadFromJson(string $path): self
    {
        $this->toolsJsonPath = $path;
        $this->loadToolsFromJson();
        $this->cachedToolDefinitions = [];

        return $this;
    }

    /**
     * Get schema for a specific function
     */
    public function getSchema(string $functionName): ?array
    {
        return $this->schemas[$functionName] ?? null;
    }

    /**
     * Remove a function
     */
    public function removeFunction(string $functionName): self
    {
        unset($this->functions[$functionName]);
        unset($this->schemas[$functionName]);
        $this->cachedToolDefinitions = [];

        return $this;
    }

    /**
     * Clear all registered functions
     */
    public function clear(): self
    {
        $this->functions = [];
        $this->schemas = [];
        $this->cachedToolDefinitions = [];

        return $this;
    }

    /**
     * Check if a function is an MCP tool
     * ToolsManager only handles regular tools, so always returns false
     */
    public function isMCPTool(string $functionName): bool
    {
        return false;
    }
}
