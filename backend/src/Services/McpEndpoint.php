<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Where an MCP client POSTs JSON-RPC for a registered server URL.
 *
 * One rule for every client (proxy, tools loader, app proxy): the registered
 * URL is tried as given first; only if that fails (HTTP error, no reply, or a
 * reply that is not JSON-RPC) is "/mcp" tried, inserted into the path before
 * any query string. Not every server lives at ".../mcp" — e.g. a PHP endpoint
 * addressed by query (http://localhost/servicenow/?profile=mock&toolset=jobs).
 */
final class McpEndpoint
{
    /**
     * The URLs to try, in order.
     *  - 'sse' transport: a trailing "/sse" path is the event stream; its
     *    JSON-RPC endpoint is the sibling "/mcp" (MCPeek's SSEMCPClient), the
     *    only candidate.
     *  - a path already ending in "/mcp" or ".php" is the endpoint: no fallback.
     *  - the as-given URL is used byte-for-byte (never trim its trailing slash:
     *    Apache 301-redirects a directory URL requested without it).
     *
     * @return list<string>
     */
    public static function candidates(string $serverUrl, string $transport = 'http'): array
    {
        [$path, $rest] = self::splitPath($serverUrl);
        $trimmed = rtrim($path, '/');

        if ($transport === 'sse' && str_ends_with($trimmed, '/sse')) {
            return [substr($trimmed, 0, -4) . '/mcp' . $rest];
        }
        if (str_ends_with($trimmed, '/mcp') || str_ends_with($trimmed, '.php')) {
            return [$serverUrl];
        }
        return [$serverUrl, $trimmed . '/mcp' . $rest];
    }

    /**
     * True for a decoded JSON-RPC reply (a result or an error). "jsonrpc" is
     * not required: lenient servers omit it and have always been accepted.
     */
    public static function isJsonRpcReply(?array $decoded): bool
    {
        return $decoded !== null
            && (array_key_exists('result', $decoded) || array_key_exists('error', $decoded));
    }

    /** Split "scheme://host/path?query#frag" into [scheme://host/path, ?query#frag]. */
    private static function splitPath(string $url): array
    {
        $cut = strcspn($url, '?#');
        return [substr($url, 0, $cut), substr($url, $cut)];
    }
}
