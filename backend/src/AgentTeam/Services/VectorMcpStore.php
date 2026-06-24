<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/**
 * Read/write chunks to a registered vector-store MCP server (the LangChain
 * `mcp_qrant` server) through its provider-agnostic `store` / `find` tools. The
 * actual MCP call is injected (a callable) so this is unit-testable and so the
 * dispatch mechanism stays the single source of truth for how tools are invoked.
 *
 * The injected dispatch returns the MCP `result` object — the mcp_qrant envelope
 * `{content:[{type:text,text:"<json>"}]}`. Tool-level errors ride INSIDE that
 * payload as `{error:true,code?,message}` (not as JSON-RPC isError), so we decode
 * content[0].text and check `error` ourselves.
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
     * Store all chunks for one file in a SINGLE `store` call. Blank chunks are
     * skipped; every stored chunk carries the same per-file metadata (provenance).
     * The server self-embeds for providers with embeds_internally (Qdrant); for
     * others the chosen `embedding` id is passed through and the MCP embeds.
     *
     * @param int                 $serverId  vector-store MCP server id (from store: "mcp:<id>")
     * @param array<int,string>   $chunks    text chunks
     * @param array<string,mixed> $cfg       {provider, connection, collection, embedding?, metadata?}
     * @return array{stored:int,errors:int,collection:?string}
     */
    public function store(int $serverId, array $chunks, array $cfg): array
    {
        $collection = $cfg['collection'] ?? null;
        $metadata = is_array($cfg['metadata'] ?? null) ? $cfg['metadata'] : [];

        $items = [];
        foreach ($chunks as $chunk) {
            $text = (string) $chunk;
            if (trim($text) === '') {
                continue;
            }
            $items[] = ['text' => $text, 'metadata' => $metadata];
        }
        if ($items === []) {
            return ['stored' => 0, 'errors' => 0, 'collection' => $collection];
        }

        $args = [
            'provider'   => (string) ($cfg['provider'] ?? ''),
            'connection' => (array) ($cfg['connection'] ?? []),
            'collection' => (string) ($collection ?? ''),
            'items'      => $items,
        ];
        $embedding = $cfg['embedding'] ?? null;
        if ($embedding !== null && $embedding !== '') {
            $args['embedding'] = (string) $embedding;
        }

        $payload = $this->decode(($this->dispatch)($serverId, 'store', $args));
        if (!empty($payload['error'])) {
            throw new \RuntimeException((string) ($payload['message'] ?? 'store failed'));
        }
        // A valid store result MUST carry `stored`. Anything else (empty body,
        // a redirect/HTML page, a non-MCP response) is a transport/endpoint
        // failure — surface it loudly instead of silently reporting 0 stored.
        if (!array_key_exists('stored', $payload)) {
            throw new \RuntimeException(
                'store: the vector MCP returned no {stored} field — likely a transport/endpoint problem '
                . '(e.g. a redirect from a trailing-slash URL, a wrong endpoint, or a non-MCP response).'
            );
        }
        return [
            'stored'     => (int) ($payload['stored'] ?? 0),
            'errors'     => (int) ($payload['errors'] ?? 0),
            'collection' => $collection,
        ];
    }

    /**
     * Semantic search via `find`. Maps the payload's results to a normalized
     * shape; tolerates a missing/non-numeric score.
     *
     * @param array<string,mixed> $cfg  {provider, connection, collection, embedding?, limit?}
     * @return array{results:list<array{text:string,metadata:array,score:?float}>}
     */
    public function find(int $serverId, string $query, array $cfg): array
    {
        $args = [
            'provider'   => (string) ($cfg['provider'] ?? ''),
            'connection' => (array) ($cfg['connection'] ?? []),
            'collection' => (string) ($cfg['collection'] ?? ''),
            'query'      => $query,
            'limit'      => (int) ($cfg['limit'] ?? 5),
        ];
        $embedding = $cfg['embedding'] ?? null;
        if ($embedding !== null && $embedding !== '') {
            $args['embedding'] = (string) $embedding;
        }

        $payload = $this->decode(($this->dispatch)($serverId, 'find', $args));
        if (!empty($payload['error'])) {
            throw new \RuntimeException((string) ($payload['message'] ?? 'find failed'));
        }
        // A valid find result MUST carry `results`. Anything else is a
        // transport/endpoint failure — surface it, don't return "0 matches".
        if (!array_key_exists('results', $payload)) {
            throw new \RuntimeException(
                'find: the vector MCP returned no {results} field — likely a transport/endpoint problem '
                . '(e.g. a redirect from a trailing-slash URL, a wrong endpoint, or a non-MCP response).'
            );
        }
        $results = [];
        foreach ((array) ($payload['results'] ?? []) as $r) {
            if (!is_array($r)) {
                continue;
            }
            $results[] = [
                'text'     => (string) ($r['text'] ?? ''),
                'metadata' => is_array($r['metadata'] ?? null) ? $r['metadata'] : [],
                'score'    => isset($r['score']) && is_numeric($r['score']) ? (float) $r['score'] : null,
            ];
        }
        return ['results' => $results];
    }

    /**
     * Decode the mcp_qrant envelope: pull content[0].text and json-decode it to
     * the payload. A transport/tool error already normalized to {error:true,...}
     * passes through unchanged (callers check `error`). If there's no envelope,
     * the input is returned as-is.
     *
     * @param array<string,mixed> $res
     * @return array<string,mixed>
     */
    private function decode(array $res): array
    {
        if (!empty($res['error'])) {
            return $res;
        }
        $text = $res['content'][0]['text'] ?? null;
        if (is_string($text)) {
            $decoded = json_decode($text, true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }
        return $res;
    }
}
