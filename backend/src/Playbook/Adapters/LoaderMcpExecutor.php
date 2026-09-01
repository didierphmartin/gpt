<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook\Adapters;

use Quantis\AIPortfolioAssistant\Playbook\McpExecutorInterface;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * Adapts MCPToolsLoader (DB-backed MCP tool cache + JSON-RPC proxy) to the
 * playbook interpreter's McpExecutorInterface.
 *
 * The loader keys its tools by `mcp_<tool_name>` and stores per-tool the
 * server it came from (`server_name`). This adapter re-keys that map as
 * "<server_slug>.<tool_name>" (e.g. "okta.search_users") so playbooks can
 * address tools the same way regardless of which MCP server hosts them.
 *
 * The caller is responsible for having already called
 * `$loader->loadToolsForUser(...)` before constructing this adapter.
 */
final class LoaderMcpExecutor implements McpExecutorInterface
{
    public function __construct(private readonly MCPToolsLoader $loader)
    {
    }

    public function call(string $server, string $tool, array $args): array
    {
        $entry = $this->findEntry($server, $tool);
        if ($entry === null) {
            return ['ok' => false, 'error' => "MCP tool '{$server}.{$tool}' not found"];
        }

        $result = $this->loader->executeTool('mcp_' . $entry['original_name'], $args);

        if (isset($result['error']) && $result['error'] === true) {
            return ['ok' => false, 'error' => $result['message'] ?? 'MCP tool execution failed'];
        }

        return ['ok' => true, 'result' => $result];
    }

    public function availableTools(): array
    {
        $tools = [];
        foreach ($this->loader->getTools() as $entry) {
            $key = $this->slug($entry['server_name']) . '.' . $entry['original_name'];
            $tools[$key] = [
                'description' => $entry['description'] ?? '',
                'input_schema' => $this->decodeSchema($entry['input_schema_json'] ?? null),
            ];
        }
        return $tools;
    }

    /**
     * Find the loader's tool entry matching "<slug(server_name)>.<original_name>".
     */
    private function findEntry(string $server, string $tool): ?array
    {
        foreach ($this->loader->getTools() as $entry) {
            if ($this->slug($entry['server_name']) === $server && $entry['original_name'] === $tool) {
                return $entry;
            }
        }
        return null;
    }

    private function slug(string $serverName): string
    {
        return strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $serverName));
    }

    private function decodeSchema(?string $json): array
    {
        if ($json === null || $json === '') {
            return ['type' => 'object', 'properties' => []];
        }
        $decoded = json_decode($json, true);
        return is_array($decoded) ? $decoded : ['type' => 'object', 'properties' => []];
    }
}
