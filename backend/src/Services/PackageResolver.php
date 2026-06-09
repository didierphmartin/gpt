<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * Package Resolver
 *
 * Resolves the effective capability package for a user by role. Packages are
 * edited by admins in gpt_admin and read by gpt at request time to decide what
 * providers / MCP servers / sidebar features / etc. a user can access.
 *
 * Convention within capabilities JSON:
 *   - mcp_servers / skills = null  ==> "all allowed"
 *   - mcp_servers / skills = array ==> explicit allowlist (names or ids)
 *   - providers.{name}.enabled boolean governs LLM availability
 *   - sidebar.{feature} boolean governs nav visibility
 *   - quota_tokens = null means no cap
 */
class PackageResolver
{
    private const VALID_ROLES = ['guest', 'prospect', 'user', 'admin'];

    private PDO $db;
    private array $cache = [];

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Resolve the effective package for the given user.
     *
     * Passing null (no authenticated user) returns the guest package.
     * If the user row exists but the package row is missing, falls back to
     * guest so nothing breaks.
     */
    public function resolveForUser(?int $userId): array
    {
        $role = $this->resolveRole($userId);
        return $this->loadPackage($role);
    }

    /**
     * Look up just the role for a user. Returns 'guest' when the id is null
     * or the user no longer exists.
     */
    public function resolveRole(?int $userId): string
    {
        if ($userId === null) {
            return 'guest';
        }

        $stmt = $this->db->prepare('SELECT role FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row || !in_array($row['role'], self::VALID_ROLES, true)) {
            return 'guest';
        }

        return (string) $row['role'];
    }

    /**
     * Load + decode the capabilities row for a role. Cached per-request.
     */
    public function loadPackage(string $role): array
    {
        if (!in_array($role, self::VALID_ROLES, true)) {
            $role = 'guest';
        }

        if (isset($this->cache[$role])) {
            return $this->cache[$role];
        }

        $stmt = $this->db->prepare(
            'SELECT capabilities, updated_at FROM packages WHERE role = :role LIMIT 1'
        );
        $stmt->execute([':role' => $role]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            // Seed row is missing; fall through to an empty-but-valid shape so
            // callers don't crash. Admin can fix via gpt_admin.
            $capabilities = [
                'providers' => [],
                'mcp_servers' => null,
                'skills' => null,
                'sidebar' => [],
                'quota_tokens' => null,
                'voice' => false,
                'avatar' => false,
            ];
            $updatedAt = null;
        } else {
            $decoded = json_decode((string) $row['capabilities'], true);
            $capabilities = is_array($decoded) ? $decoded : [];
            $updatedAt = $row['updated_at'];
        }

        $package = [
            'role' => $role,
            'capabilities' => $capabilities,
            'updated_at' => $updatedAt,
        ];

        $this->cache[$role] = $package;
        return $package;
    }

    /**
     * @return array<int,string> The canonical list of roles.
     */
    public static function validRoles(): array
    {
        return self::VALID_ROLES;
    }

    /**
     * Return the list of MCP server names the user's package allows, or
     * null when no restriction applies (package's mcp_servers === null).
     *
     * Callers should treat null as "allow everything" and an empty array as
     * "allow nothing".
     */
    public function allowedMcpServers(?int $userId): ?array
    {
        $package = $this->resolveForUser($userId);
        $list = $package['capabilities']['mcp_servers'] ?? null;
        if ($list === null) {
            return null;
        }
        if (!is_array($list)) {
            return [];
        }
        return array_values(array_filter($list, 'is_string'));
    }
}
