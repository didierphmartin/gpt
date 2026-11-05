<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\McpEndpoint;
use Quantis\AIPortfolioAssistant\Services\McpTestRelay;

/**
 * MCP Test tab: relays one JSON-RPC message to a server and returns the raw
 * outcome. Access rules live here (the relay does none): stored headers are
 * only ever sent to the stored server's URL (or its /mcp sibling) and are
 * never returned.
 */
final class McpTestController
{
    use RequiresAdmin;

    private PDO $db;
    private array $config;
    private McpTestRelay $relay;

    public function __construct(PDO $db, array $config, ?McpTestRelay $relay = null)
    {
        $this->db = $db;
        $this->config = $config;
        $this->relay = $relay ?? new McpTestRelay();
    }

    public function test(array $request): array
    {
        $userId = (string) ($request['user_id'] ?? '');
        if ($userId === '') {
            return self::fail('Authentication required', 401);
        }
        return $this->run($request, $userId, false);
    }

    public function adminTest(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }
        return $this->run($request, '', true);
    }

    public static function endpointFor(string $url, string $transport, bool $sibling): ?string
    {
        $found = $transport === 'sse'
            ? (McpEndpoint::candidates($url, 'sse')[0] ?? null)
            : ($sibling ? (McpEndpoint::candidates($url, 'http')[1] ?? null) : $url);
        return $found === null ? null : McpEndpoint::internal($found);
    }

    private function run(array $request, string $userId, bool $admin): array
    {
        $in = (array) ($request['body'] ?? []);
        $message = $in['message'] ?? null;
        $version = $in['protocol_version'] ?? null;
        if (!is_array($message) || $message === [] || !is_string($version) || $version === '') {
            return self::fail('message and protocol_version are required', 400);
        }
        $sessionId = isset($in['session_id']) && is_string($in['session_id']) ? $in['session_id'] : null;
        $sibling = !empty($in['sibling']);
        $transport = ($in['transport'] ?? 'http') === 'sse' ? 'sse' : 'http';

        $serverId = $in['server_id'] ?? null;
        if ($serverId !== null && $serverId !== '') {
            if ($admin) {
                $stmt = $this->db->prepare('SELECT url, headers, transport FROM mcp_servers WHERE id = ?');
                $stmt->execute([(int) $serverId]);
            } else {
                $stmt = $this->db->prepare('SELECT url, headers, transport FROM mcp_servers WHERE id = ? AND (user_id IS NULL OR user_id = ?)');
                $stmt->execute([(int) $serverId, $userId]);
            }
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) {
                return self::fail('Unknown MCP server', 404);
            }
            $url = (string) $row['url'];
            $headers = McpEndpoint::decodeStoredHeaders($row['headers'] !== null ? (string) $row['headers'] : null);
            $transport = ($row['transport'] ?? 'http') === 'sse' ? 'sse' : 'http';
            if (isset($in['transport'])) {
                $transport = $in['transport'] === 'sse' ? 'sse' : 'http';
            }
        } elseif ($admin) {
            return self::fail('server_id is required', 400);
        } else {
            $url = $in['server_url'] ?? null;
            if (!is_string($url) || $url === '') {
                return self::fail('server_id or server_url is required', 400);
            }
            $headers = [];
            if (is_array($in['headers'] ?? null)) {
                foreach ($in['headers'] as $n => $v) {
                    if (is_string($n) && $n !== '' && is_scalar($v)) {
                        $headers[(string) preg_replace('/[\r\n:]/', '', $n)] = (string) preg_replace('/[\r\n]/', '', (string) $v);
                    }
                }
            }
        }

        $endpoint = self::endpointFor($url, $transport, $sibling);
        if ($endpoint === null) {
            return self::fail('No sibling /mcp endpoint for this URL', 400);
        }
        return [
            'success' => true,
            'relay' => $this->relay->relay($endpoint, $headers, $message, $sessionId, $version),
        ];
    }

    private static function fail(string $error, int $status): array
    {
        return ['success' => false, 'error' => $error, 'status_code' => $status];
    }
}
