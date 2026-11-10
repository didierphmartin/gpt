<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\Edition;
use Quantis\AIPortfolioAssistant\Services\GitHubFetchError;
use Quantis\AIPortfolioAssistant\Services\GitHubServerFetcher;
use Quantis\AIPortfolioAssistant\Services\McpHostClient;

/**
 * /api/v1/mcp/host — relays signed-in users to the Docker app's server supervisor. A server is its installer's;
 * admins may act on any. In the corporate edition only admins install; in the individual edition the container is
 * the user's, so anyone signed in may. The supervisor's status and body pass through unchanged, except 503 (unreachable) and the
 * log tail, which only the owner (or an admin) sees. The token and request bodies are never logged or returned.
 */
final class McpHostController
{
    use RequiresAdmin;

    /** @var \Closure(): McpHostClient */
    private \Closure $clientFactory;

    /** @var \Closure(): object an object with fetch(string $url): array (GitHubServerFetcher) */
    private \Closure $fetcherFactory;

    public function __construct(private readonly PDO $db, private readonly array $config, ?\Closure $clientFactory = null, ?\Closure $fetcherFactory = null)
    {
        $this->fetcherFactory = $fetcherFactory ?? fn() => new GitHubServerFetcher();
        $this->clientFactory = $clientFactory
            ?? fn() => new McpHostClient((string) ($_ENV['MCPS_URL'] ?? ''), (string) ($_ENV['MCPS_TOKEN'] ?? ''));
    }

    private static function available(): bool
    {
        return !empty($_ENV['MCPS_URL']);
    }

    public function info(array $request): array
    {
        if (!self::available()) {
            return ['success' => true, 'data' => ['available' => false]];
        }
        return ['success' => true, 'data' => ['available' => true, 'gateway' => (string) ($_ENV['MCPS_PUBLIC_GATEWAY'] ?? '')]];
    }

    public function list(array $request): array
    {
        if (!self::available()) return self::none();
        $r = $this->client()->request('GET', '/servers');
        if ($r['status'] !== 200) return self::out($r);
        $admin = $this->isAdmin($request);
        $uid = (int) $request['user_id'];
        $rows = [];
        foreach ($r['body'] as $s) {
            if (!$admin && (int) ($s['installed_by'] ?? 0) !== $uid) {
                unset($s['log']);
            }
            $rows[] = $s;
        }
        return ['success' => true, 'data' => $rows, 'status_code' => 200];
    }

    public function install(array $request, string|int $folder): array
    {
        if (!self::available()) return self::none();
        if (!self::safe($folder = self::raw($request, $folder))) return self::bad();
        if (Edition::isCorporate($this->config) && !$this->isAdmin($request)) {
            $e = 'Only an admin can install MCP servers here.';
            return ['success' => false, 'data' => ['error' => $e], 'error' => $e, 'status_code' => 403];
        }
        $body = (array) ($request['body'] ?? []);
        $body['installed_by'] = (int) $request['user_id'];
        return self::out($this->client()->request('POST', "/servers/$folder/install", $body));
    }

    /** Reads one server folder from a public GitHub link; the browser then posts it to install. */
    public function fetch(array $request): array
    {
        if (!self::available()) return self::none();
        if (Edition::isCorporate($this->config) && !$this->isAdmin($request)) {
            $e = 'Only an admin can install MCP servers here.';
            return ['success' => false, 'data' => ['error' => $e], 'error' => $e, 'status_code' => 403];
        }
        $u = ((array) ($request['body'] ?? []))['url'] ?? '';
        $url = is_string($u) ? $u : '';
        try {
            $data = ($this->fetcherFactory)()->fetch($url);
        } catch (GitHubFetchError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => $e->status];
        } catch (\InvalidArgumentException $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
        return ['success' => true, 'data' => $data, 'status_code' => 200];
    }

    public function restart(array $request, string|int $folder): array
    {
        return $this->owned($request, $folder, 'POST', 'restart', false);
    }

    public function enabled(array $request, string|int $folder): array
    {
        return $this->owned($request, $folder, 'POST', 'enabled', true);
    }

    public function getSettings(array $request, string|int $folder): array
    {
        return $this->owned($request, $folder, 'GET', 'settings', false);
    }

    public function putSettings(array $request, string|int $folder): array
    {
        return $this->owned($request, $folder, 'PUT', 'settings', true);
    }

    public function source(array $request, string|int $folder): array
    {
        return $this->owned($request, $folder, 'GET', 'source', false);
    }

    public function delete(array $request, string|int $folder): array
    {
        return $this->owned($request, $folder, 'DELETE', '', false);
    }

    /** Owner-or-admin gate (from the supervisor's own list), then the relayed call. */
    private function owned(array $request, string|int $folder, string $method, string $sub, bool $withBody): array
    {
        if (!self::available()) return self::none();
        if (!self::safe($folder = self::raw($request, $folder))) return self::bad();
        $list = $this->client()->request('GET', '/servers');
        if ($list['status'] !== 200) return self::out($list);
        $found = null;
        foreach ($list['body'] as $s) {
            if (($s['folder'] ?? null) === $folder) { $found = $s; break; }
        }
        if ($found === null) return ['success' => false, 'data' => ['error' => 'not found'], 'error' => 'not found', 'status_code' => 404];
        if ((int) ($found['installed_by'] ?? 0) !== (int) $request['user_id'] && !$this->isAdmin($request)) {
            return ['success' => false, 'data' => ['error' => 'forbidden'], 'error' => 'forbidden', 'status_code' => 403];
        }
        $path = "/servers/$folder" . ($sub === '' ? '' : "/$sub");
        return self::out($this->client()->request($method, $path, $withBody ? (array) ($request['body'] ?? []) : null));
    }

    private function client(): McpHostClient
    {
        return ($this->clientFactory)();
    }

    private function isAdmin(array $request): bool
    {
        return $this->requireAdmin($request) === null;
    }

    /** index.php casts numeric-looking params ("007" -> 7); the raw segment is in request['params']. */
    private static function raw(array $request, string|int $folder): string
    {
        return (string) ($request['params']['folder'] ?? $folder);
    }

    /** Same shape the supervisor enforces: no leading dot, no separators. */
    private static function safe(string $folder): bool
    {
        return (bool) preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $folder);
    }

    private static function bad(): array
    {
        return ['success' => false, 'data' => ['error' => 'bad folder'], 'error' => 'bad folder', 'status_code' => 400];
    }

    private static function none(): array
    {
        return ['success' => false, 'data' => ['error' => 'no server host'], 'error' => 'no server host', 'status_code' => 404];
    }

    /** @param array{status:int, body:array} $r */
    private static function out(array $r): array
    {
        if ($r['status'] === 503) {
            $e = 'The server host is not reachable';
            return ['success' => false, 'data' => ['error' => $e], 'error' => $e, 'status_code' => 503];
        }
        $ok = $r['status'] < 400;
        $out = ['success' => $ok, 'data' => $r['body'], 'status_code' => $r['status']];
        if (!$ok) $out['error'] = (string) ($r['body']['error'] ?? 'error');
        return $out;
    }
}
