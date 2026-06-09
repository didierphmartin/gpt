<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Middleware;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use AgentTeam\Services\AppKeyRepository;
use PDO;
use Exception;

/**
 * Authentication Middleware
 *
 * Validates the `Authorization` header and injects identity into the
 * request. Two credential schemes are supported on the SAME header — the
 * scheme name is the switch:
 *
 *   Authorization: Bearer <jwt>     → user login (existing)
 *   Authorization: Bearer uak_<…>   → per-user app key (acts as that user's JWT)
 *   Authorization: AppKey ak_<…>    → app key (scoped client-code credential)
 *
 * All paths populate `$request['user_id']` so downstream controllers are
 * agnostic to which scheme was used. `auth_type` distinguishes them:
 * 'jwt' / 'user_app_key' / 'app_key'. The scoped app-key path additionally
 * sets `app_key_id`, `application_id`, and `app_key_scopes`.
 */
class AuthMiddleware
{
    private string $jwtSecret;
    private array $publicRoutes;
    private array $config;
    private ?PDO $db = null;

    /**
     * @param string $jwtSecret    HS256 secret for JWT validation.
     * @param array  $publicRoutes Routes that don't require auth.
     * @param array  $config       Full app config — needed to lazily open a
     *                             DB connection for app-key validation.
     */
    public function __construct(string $jwtSecret, array $publicRoutes = [], array $config = [])
    {
        $this->jwtSecret = $jwtSecret;
        $this->publicRoutes = $publicRoutes;
        $this->config = $config;
    }

    /**
     * Process authentication for the request.
     *
     * @param array $request Request data containing method, uri, headers.
     * @return array Request with identity injected, or an error response.
     */
    public function handle(array $request): array
    {
        $isPublic = $this->isPublicRoute($request['uri'], $request['method']);

        $auth = $this->extractAuth($request['headers']);

        // Resolve the credential into an identity, if it's valid.
        $identity = null;
        if ($auth !== null) {
            if ($auth['scheme'] === 'bearer') {
                // Per-user app keys travel on the same Bearer header and are
                // distinguished by their `uak_` prefix. Skip JWT decoding for
                // them so we don't burn an exception per request.
                if (str_starts_with($auth['token'], 'uak_')) {
                    $userId = $this->validateUserAppKey($auth['token']);
                    if ($userId !== null) {
                        $identity = ['user_id' => $userId, 'auth_type' => 'user_app_key'];
                    }
                } else {
                    $userId = $this->validateToken($auth['token']);
                    if ($userId !== null) {
                        $identity = ['user_id' => $userId, 'auth_type' => 'jwt'];
                    }
                }
            } elseif ($auth['scheme'] === 'appkey') {
                // A per-user key works on either scheme — `Bearer uak_…` and
                // `AppKey uak_…` resolve the same way, so a single key serves
                // both REST clients and WebMCP-style providers.
                if (str_starts_with($auth['token'], 'uak_')) {
                    $userId = $this->validateUserAppKey($auth['token']);
                    if ($userId !== null) {
                        $identity = ['user_id' => $userId, 'auth_type' => 'user_app_key'];
                    }
                } else {
                    $row = $this->validateAppKey($auth['token']);
                    if ($row !== null) {
                        $identity = [
                            'user_id'        => (int) $row['user_id'],
                            'auth_type'      => 'app_key',
                            'app_key_id'     => (int) $row['id'],
                            'application_id' => $row['application_id'],
                            'app_key_scopes' => $row['scopes'],
                        ];
                    }
                }
            }
        }

        // Public routes: don't require auth, but inject identity if present.
        if ($isPublic) {
            if ($identity !== null) {
                $request = array_merge($request, $identity);
            } else {
                $request['user_id'] = null;
            }
            $request['authenticated'] = $identity !== null;
            return $request;
        }

        // Protected routes: require a valid credential.
        if ($auth === null) {
            return $this->error(401, 'Authorization token required');
        }
        if ($identity === null) {
            return $this->error(401, 'Invalid or expired credential');
        }

        $request = array_merge($request, $identity);
        $request['authenticated'] = true;
        return $request;
    }

    /**
     * Check if the route is public (doesn't require authentication).
     */
    private function isPublicRoute(string $uri, string $method): bool
    {
        foreach ($this->publicRoutes as $route) {
            $pattern = str_replace('*', '.*', $route['pattern']);
            $routeMethods = (array)($route['methods'] ?? ['GET', 'POST', 'PUT', 'DELETE']);
            if (preg_match("#^{$pattern}$#", $uri) && in_array($method, $routeMethods)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Parse the Authorization header into {scheme, token}.
     * Recognizes the `Bearer` and `AppKey` schemes; null otherwise.
     */
    private function extractAuth(array $headers): ?array
    {
        $authHeader = $headers['Authorization'] ?? $headers['authorization'] ?? '';
        if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
            return ['scheme' => 'bearer', 'token' => trim($m[1])];
        }
        if (preg_match('/^AppKey\s+(.+)$/i', $authHeader, $m)) {
            return ['scheme' => 'appkey', 'token' => trim($m[1])];
        }
        return null;
    }

    /**
     * Validate a JWT and return its user id, or null.
     */
    private function validateToken(string $token): ?int
    {
        try {
            $decoded = JWT::decode($token, new Key($this->jwtSecret, 'HS256'));
            return isset($decoded->sub) ? (int)$decoded->sub : null;
        } catch (Exception $e) {
            error_log("[AuthMiddleware] JWT validation failed: " . $e->getMessage());
            return null;
        }
    }

    /**
     * Validate an app key against the database. Returns the key row
     * (user_id, id, application_id, scopes) or null. Records last-used on
     * success. All failure modes (no config, DB down, bad key) return null
     * so the caller treats it as an auth failure rather than a 500.
     */
    private function validateAppKey(string $key): ?array
    {
        try {
            $secret = (string) ($this->config['auth']['app_key_secret'] ?? '');
            if ($secret === '') {
                error_log('[AuthMiddleware] app_key_secret is not configured — app keys disabled.');
                return null;
            }
            $repo = new AppKeyRepository($this->getDb(), $secret);
            $row = $repo->findByKey($key);
            if ($row !== null) {
                $repo->recordUse((int) $row['id']);
            }
            return $row;
        } catch (\Throwable $e) {
            error_log('[AuthMiddleware] app key validation error: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Validate a per-user app key against `users.app_key_hash`. Returns the
     * matching user id or null. Pepper is the same as AuthController's:
     * `auth.user_app_key_secret` if set, else derived from `jwt_secret` so
     * the feature works out-of-box.
     */
    private function validateUserAppKey(string $key): ?int
    {
        try {
            $explicit = (string) ($this->config['auth']['user_app_key_secret'] ?? '');
            $pepper = $explicit !== '' ? $explicit : hash_hmac('sha256', 'user_app_key.v1', $this->jwtSecret);
            $hash = hash_hmac('sha256', $key, $pepper);
            $stmt = $this->getDb()->prepare('SELECT id FROM users WHERE app_key_hash = ? LIMIT 1');
            $stmt->execute([$hash]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return $row ? (int) $row['id'] : null;
        } catch (\Throwable $e) {
            error_log('[AuthMiddleware] user app key validation error: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Lazily open the DB connection used for app-key lookups. Built only
     * the first time an app key is actually presented, so JWT-only and
     * public traffic never pays for a connection.
     */
    private function getDb(): PDO
    {
        if ($this->db !== null) {
            return $this->db;
        }
        $cfg = $this->config['contexts_database'] ?? $this->config['database'] ?? null;
        if (!$cfg) {
            throw new \RuntimeException('AuthMiddleware: no database config for app-key validation.');
        }
        $dsn = "mysql:host={$cfg['host']};dbname={$cfg['database']};charset={$cfg['charset']}";
        $this->db = new PDO($dsn, $cfg['username'], $cfg['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        return $this->db;
    }

    private function error(int $statusCode, string $message): array
    {
        return [
            'error' => true,
            'status_code' => $statusCode,
            'body' => ['success' => false, 'message' => $message],
        ];
    }

    /**
     * Get user ID from headers (static helper, JWT only — unchanged).
     */
    public static function getUserIdFromHeaders(string $jwtSecret): ?int
    {
        $headers = self::getAllHeaders();
        $authHeader = $headers['Authorization'] ?? $headers['authorization'] ?? '';

        if (!preg_match('/Bearer\s+(.*)$/i', $authHeader, $matches)) {
            return null;
        }

        try {
            $decoded = JWT::decode($matches[1], new Key($jwtSecret, 'HS256'));
            return isset($decoded->sub) ? (int)$decoded->sub : null;
        } catch (Exception $e) {
            return null;
        }
    }

    /**
     * Polyfill for getallheaders().
     */
    private static function getAllHeaders(): array
    {
        if (function_exists('getallheaders')) {
            $headers = getallheaders();
            return is_array($headers) ? $headers : [];
        }

        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (substr($name, 0, 5) === 'HTTP_') {
                $headerName = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))));
                $headers[$headerName] = $value;
            }
        }
        return $headers;
    }
}
