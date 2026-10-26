<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Services\RobotPolicy;

/**
 * /api/v1/robot/mcp-servers — the robot account's own MCP server rows (e.g. an "Outlook" row holding an
 * organization connection key). Every route needs use_robot and acts only on rows owned by the robot.
 * Header values are secrets: responses carry header NAMES only.
 */
final class RobotServersController
{
    private RobotPolicy $policy;
    /** @var \Closure(): MCPProxyController */
    private \Closure $proxyFactory;

    public function __construct(private readonly PDO $db, private readonly array $config, ?\Closure $proxyFactory = null)
    {
        $this->policy = new RobotPolicy($db, $config);
        $this->proxyFactory = $proxyFactory ?? fn() => new MCPProxyController($this->db, $this->config);
    }

    public function index(array $request): array
    {
        return $this->guard($request, function (int $robot) {
            $st = $this->db->prepare('SELECT id, name, url, description, enabled, headers FROM mcp_servers WHERE user_id = ? ORDER BY name');
            $st->execute([(string) $robot]);
            $out = [];
            foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $out[] = ['id' => (int) $r['id'], 'name' => $r['name'], 'url' => $r['url'], 'description' => (string) $r['description'],
                    'enabled' => (bool) $r['enabled'], 'header_names' => array_map('strval', array_keys($this->headers($r['headers'])))];
            }
            return ['success' => true, 'data' => $out];
        });
    }

    public function create(array $request): array
    {
        return $this->guard($request, function (int $robot) use ($request) {
            $b = $request['body'] ?? [];
            $name = trim((string) ($b['name'] ?? ''));
            $url = trim((string) ($b['url'] ?? ''));
            if ($name === '' || !filter_var($url, FILTER_VALIDATE_URL)) {
                return self::fail('Name and a valid URL are required', 400);
            }
            if ($this->row($robot, null, $name) !== null) {
                return self::fail('A server with this name already exists', 409);
            }
            $this->db->prepare('INSERT INTO mcp_servers (user_id, name, url, description) VALUES (?, ?, ?, ?)')
                ->execute([(string) $robot, $name, $url, trim((string) ($b['description'] ?? ''))]);
            return ['success' => true, 'data' => ['id' => (int) $this->db->lastInsertId()]];
        });
    }

    public function update(array $request): array
    {
        return $this->guard($request, function (int $robot) use ($request) {
            $id = $this->id($request);
            $row = $this->row($robot, $id);
            if ($row === null) {
                return self::notFound();
            }
            $b = $request['body'] ?? [];
            $set = [];
            $args = [];
            foreach (['name', 'url', 'description'] as $f) {
                if (isset($b[$f]) && is_string($b[$f])) {
                    if ($f === 'url' && !filter_var(trim($b[$f]), FILTER_VALIDATE_URL)) {
                        return self::fail('Invalid URL format', 400);
                    }
                    if ($f === 'name' && trim($b[$f]) !== $row['name'] && $this->row($robot, null, trim($b[$f])) !== null) {
                        return self::fail('A server with this name already exists', 409);
                    }
                    if ($f === 'url' && trim($b[$f]) !== $row['url']) {
                        // the stored key must never travel to a different host: re-Connect is required
                        $set[] = 'headers = NULL';
                    }
                    $set[] = "$f = ?";
                    $args[] = trim($b[$f]);
                }
            }
            if (array_key_exists('enabled', $b)) {
                $set[] = 'enabled = ?';
                $args[] = $b['enabled'] ? 1 : 0;
            }
            if ($set) {
                $this->db->prepare('UPDATE mcp_servers SET ' . implode(', ', $set) . ' WHERE id = ? AND user_id = ?')
                    ->execute([...$args, $id, (string) $robot]);
            }
            return ['success' => true];
        });
    }

    public function destroy(array $request): array
    {
        return $this->guard($request, function (int $robot) use ($request) {
            $id = $this->id($request);
            if ($this->row($robot, $id) === null) {
                return self::notFound();
            }
            $this->db->prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?')->execute([$id, (string) $robot]);
            return ['success' => true];
        });
    }

    /** POST .../{id}/call {tool, arguments}: a tools/call through the /mcp/proxy path, with the row's stored headers. */
    public function call(array $request): array
    {
        return $this->guard($request, function (int $robot) use ($request) {
            $id = $this->id($request);
            $row = $this->row($robot, $id);
            if ($row === null) {
                return self::notFound();
            }
            if (!$row['enabled']) {
                return self::fail('Server is disabled', 409);
            }
            $b = $request['body'] ?? [];
            if (!is_string($b['tool'] ?? null) || $b['tool'] === '') {
                return self::fail('tool is required', 400);
            }
            $r = ($this->proxyFactory)()->forward(['user_id' => (string) $robot, 'body' => [
                'action' => 'proxy', 'server_id' => $id, 'server_url' => $row['url'],
                'jsonrpc' => ['method' => 'tools/call', 'params' => ['name' => $b['tool'], 'arguments' => $b['arguments'] ?? []]],
            ]]);
            if (!($r['success'] ?? false)) {
                return ['success' => false, 'error' => $r['error']['message'] ?? 'MCP call failed', 'status_code' => $r['status_code'] ?? 500];
            }
            return ['success' => true, 'data' => $r['response']];
        });
    }

    /** POST .../{id}/key {header, key}: merges {header: key} into the row's headers (the Connect box's save step). */
    public function saveKey(array $request): array
    {
        return $this->guard($request, function (int $robot) use ($request) {
            $id = $this->id($request);
            $row = $this->row($robot, $id);
            if ($row === null) {
                return self::notFound();
            }
            $b = $request['body'] ?? [];
            $name = trim((string) ($b['header'] ?? ''));
            $key = (string) ($b['key'] ?? '');
            if ($name === '' || preg_match('/[\r\n:\s]/', $name) || $key === '' || preg_match('/[\r\n]/', $key)) {
                return self::fail('A header name and a key are required', 400);
            }
            $headers = $this->headers($row['headers']);
            $headers[$name] = $key;
            $this->db->prepare('UPDATE mcp_servers SET headers = ? WHERE id = ? AND user_id = ?')
                ->execute([json_encode($headers), $id, (string) $robot]);
            return ['success' => true, 'data' => ['header_names' => array_map('strval', array_keys($headers))]];
        });
    }

    private function id(array $request): int
    {
        return (int) ($request['params']['id'] ?? 0);
    }

    /** The robot's row by id or by name, else null. */
    private function row(int $robot, ?int $id, ?string $name = null): ?array
    {
        $st = $id !== null
            ? $this->db->prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
            : $this->db->prepare('SELECT * FROM mcp_servers WHERE name = ? AND user_id = ?');
        $st->execute([$id ?? $name, (string) $robot]);
        return $st->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    private function headers(mixed $json): array
    {
        $h = is_string($json) && $json !== '' ? json_decode($json, true) : null;
        return is_array($h) ? $h : [];
    }

    private static function fail(string $msg, int $status): array
    {
        return ['success' => false, 'error' => $msg, 'status_code' => $status];
    }

    private static function notFound(): array
    {
        return self::fail('Server not found', 404);
    }

    private function guard(array $request, \Closure $action): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'kind' => 'auth', 'status_code' => 401];
        }
        if (!$this->policy->canUse($userId)) {
            return ['success' => false, 'error' => "Your role can't use the robot", 'kind' => 'forbidden', 'status_code' => 403];
        }
        return $action(RobotAccount::ensure($this->db));
    }
}
