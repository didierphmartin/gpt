<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/**
 * Embed + store chunks into a registered vector-DB MCP server. The actual MCP
 * call is injected (a callable) so this is unit-testable and so the dispatch
 * mechanism (MCPToolsLoader / the existing tool runner) stays the single source
 * of truth for how tools are invoked.
 */
final class VectorMcpStore
{
    /** @var callable(int,string,array):array */
    private $dispatch;

    /** @param callable(int $serverId, string $tool, array $args):array $dispatch */
    public function __construct(callable $dispatch)
    {
        $this->dispatch = $dispatch;
    }

    /**
     * @param int                  $serverId  vector-DB MCP server id (from store: "mcp:<id>")
     * @param array<int,string>    $chunks    text chunks
     * @param array<string,mixed>  $cfg       {embeddings, collection}
     * @return array{stored:int,collection:?string}
     */
    public function store(int $serverId, array $chunks, array $cfg): array
    {
        if ($chunks === []) {
            return ['stored' => 0, 'collection' => $cfg['collection'] ?? null];
        }
        $args = [
            'chunks'     => array_values($chunks),
            'embeddings' => (string) ($cfg['embeddings'] ?? 'openai:text-embedding-3-small'),
            'collection' => $cfg['collection'] ?? null,
        ];
        // Tool name convention for vector-store MCP servers; documented in spec.
        $result = ($this->dispatch)($serverId, 'store_documents', $args);
        return [
            'stored'     => (int) ($result['stored'] ?? count($chunks)),
            'collection' => $result['collection'] ?? $args['collection'],
        ];
    }
}
