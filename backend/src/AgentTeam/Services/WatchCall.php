<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * The event worker's call to a Start option's waiting tool (spec 2026-10-14 event-worker §3): which server, the
 * JSON-RPC request (the one MCPToolsLoader::callMCPServer sends), and what the answer means. A waiting tool answers
 * {"status": "ready"|"timeout", "via"?, "events"?} -- Outlook's wait_for_new, or any later event source.
 */
final class WatchCall
{
    /** The user's enabled server named $name (by slug, as code nodes match it); the user's own row wins over a global one. */
    public static function server(PDO $db, int $userId, string $name): ?array
    {
        $st = $db->prepare('SELECT name, url, headers, user_id FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)');
        $st->execute([$userId]);
        $found = null;
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            if (CodeNodeEmit::slug((string) $r['name']) === CodeNodeEmit::slug($name) && ($found === null || $r['user_id'] !== null)) {
                $found = $r;
            }
        }
        if ($found === null) {
            return null;
        }
        $headers = is_string($found['headers'] ?? null) ? json_decode($found['headers'], true) : null;
        return ['url' => (string) $found['url'], 'headers' => is_array($headers) ? array_map('strval', $headers) : []];
    }

    /** [url, header lines, body]: the stored URL byte-for-byte, the stored headers, watch.tool with watch.args as stored. */
    public static function request(array $server, array $watch, int $id): array
    {
        $args = $watch['args'] ?? [];
        $body = json_encode(['jsonrpc' => '2.0', 'id' => $id, 'method' => 'tools/call',
            'params' => ['name' => (string) ($watch['tool'] ?? ''), 'arguments' => $args === [] ? new \stdClass() : $args]],
            JSON_UNESCAPED_SLASHES);
        $lines = ['Content-Type: application/json', 'Accept: application/json, text/event-stream'];
        foreach ($server['headers'] as $k => $v) {
            $lines[] = $k . ': ' . $v;
        }
        return [$server['url'], $lines, $body];
    }

    public static function answer(string|false $body, int $http, string $curlError): array
    {
        $error = static fn(string $m) => ['status' => 'error', 'message' => $m];
        if ($body === false || $curlError !== '') {
            return $error('unreachable');
        }
        if ($http >= 400) {
            return $error('http_' . $http);
        }
        $rpc = json_decode(self::lastData($body), true);
        if (!is_array($rpc)) {
            return $error('bad_answer');
        }
        if (isset($rpc['error'])) {
            return $error('rpc_error');
        }
        $result = $rpc['result'] ?? [];
        $payload = is_array($result['structuredContent'] ?? null) ? $result['structuredContent']
            : json_decode((string) ($result['content'][0]['text'] ?? ''), true);
        if (!is_array($payload)) {
            return $error('bad_answer');
        }
        if (isset($payload['error'])) {
            $e = $payload['error'];   // a string, or {code, message} (the ServiceNow connector)
            return $error(is_array($e) ? (string) ($e['code'] ?? 'tool_error') : (string) $e);
        }
        $status = $payload['status'] ?? null;
        if ($status !== 'ready' && $status !== 'timeout') {
            return $error('bad_answer');
        }
        return ['status' => $status, 'via' => $payload['via'] ?? null, 'events' => $payload['events'] ?? null];
    }

    /** A plain JSON body as is; an SSE body's last "data:" line. */
    private static function lastData(string $body): string
    {
        if (!preg_match_all('/^data:\s?(.*)$/m', $body, $m)) {
            return $body;
        }
        return (string) end($m[1]);
    }
}
