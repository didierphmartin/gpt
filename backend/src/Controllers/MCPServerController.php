<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\Services\PackageResolver;
use PDO;
use PDOException;
use Exception;

/**
 * MCP Server Controller
 *
 * Read-only access to global MCP servers for users.
 * Server management is done via AdminController.
 */
class MCPServerController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->ensureTablesExist();
    }

    /**
     * List enabled MCP servers visible to the caller: every global server
     * (user_id IS NULL) plus the caller's own per-user servers.
     */
    public function list(array $request): array
    {
        $userId = (string) ($request['query']['user_id'] ?? $request['user_id'] ?? '');

        $sql = "
            SELECT s.*,
                   COUNT(t.id) as tool_count,
                   SUM(CASE WHEN t.has_ui = 1 THEN 1 ELSE 0 END) as ui_tool_count
            FROM mcp_servers s
            LEFT JOIN mcp_server_tools t ON s.id = t.server_id
            WHERE s.enabled = 1 AND (s.user_id IS NULL" . ($userId !== '' ? " OR s.user_id = :uid" : "") . ")
            GROUP BY s.id
            ORDER BY s.name ASC
        ";
        $stmt = $this->db->prepare($sql);
        if ($userId !== '') {
            $stmt->bindValue(':uid', $userId);
        }
        $stmt->execute();
        $servers = $stmt->fetchAll();

        // Apply the caller's package MCP allowlist: hide servers the role isn't permitted to use.
        $servers = $this->applyPackageAllowlist($servers, $userId);

        return [
            'success' => true,
            'servers' => $servers,
            'status_code' => 200
        ];
    }

    /**
     * Resolve whether a single (server_id, server_name, is_private) combo is
     * effective for the caller. Used by getTools() and getAllTools() so they
     * stay aligned with list() / MCPToolsLoader on the cascade.
     */
    private function isServerEffective(int $serverId, ?string $serverName, bool $isPrivate, ?int $userIdInt): bool
    {
        try {
            if ($userIdInt !== null) {
                $stmt = $this->db->prepare("SELECT allowed FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?");
                $stmt->execute([$userIdInt, $serverId]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row !== false) {
                    return (bool)$row['allowed'];
                }
            }
            if ($isPrivate) {
                return true;
            }
            $allow = (new PackageResolver($this->db))->allowedMcpServers($userIdInt);
            if ($allow === null) {
                return true;
            }
            return $serverName !== null && in_array($serverName, $allow, true);
        } catch (Exception $e) {
            error_log("[MCPServerController] isServerEffective failed: " . $e->getMessage());
            return true; // fail open
        }
    }

    /**
     * Apply the cascade — package allowlist, then per-user overrides — to a
     * list of MCP server rows. Rows must contain `name`, `id`, and `user_id`.
     *
     * - Per-user override (allowed=true|false) wins when present.
     * - Otherwise: caller's own per-user servers always pass; globals are
     *   gated by the package's mcp_servers allowlist (null = unrestricted).
     */
    private function applyPackageAllowlist(array $rows, string $userId): array
    {
        try {
            $userIdInt = is_numeric($userId) ? (int)$userId : null;

            // Pull per-user overrides keyed by server_id.
            $overrides = [];
            if ($userIdInt !== null) {
                $stmt = $this->db->prepare("SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?");
                $stmt->execute([$userIdInt]);
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $overrides[(int)$row['server_id']] = (bool)$row['allowed'];
                }
            }

            $resolver = new PackageResolver($this->db);
            $allow = $resolver->allowedMcpServers($userIdInt);

            return array_values(array_filter(
                $rows,
                function (array $row) use ($allow, $overrides) {
                    $serverId  = (int)($row['id'] ?? 0);
                    $isPrivate = ($row['user_id'] ?? null) !== null;

                    if (array_key_exists($serverId, $overrides)) {
                        return $overrides[$serverId];
                    }
                    if ($isPrivate) {
                        return true;
                    }
                    if ($allow === null) {
                        return true;
                    }
                    return in_array($row['name'] ?? '', $allow, true);
                }
            ));
        } catch (Exception $e) {
            error_log("[MCPServerController] Cascade filter failed: " . $e->getMessage());
            return $rows; // fail open
        }
    }

    /**
     * Get tools for a specific global server
     */
    public function getTools(array $request): array
    {
        $serverId = $request['query']['server_id'] ?? null;

        if (!$serverId) {
            return [
                'success' => true,
                'tools' => [],
                'status_code' => 200
            ];
        }

        // Verify server is an enabled server owned globally or by the caller
        $userId = (string) ($request['query']['user_id'] ?? $request['user_id'] ?? '');
        $sql = "SELECT id, name, user_id FROM mcp_servers WHERE id = ? AND enabled = 1 AND (user_id IS NULL"
            . ($userId !== '' ? " OR user_id = ?" : "") . ")";
        $stmt = $this->db->prepare($sql);
        $params = [$serverId];
        if ($userId !== '') $params[] = $userId;
        $stmt->execute($params);
        $row = $stmt->fetch();
        if (!$row) {
            return [
                'success' => false,
                'error' => 'Server not found',
                'status_code' => 404
            ];
        }

        // Enforce the full cascade (package + per-user override) — a server
        // the admin overrode off should look 404 to the chat-side picker.
        $isPrivate = ($row['user_id'] ?? null) !== null;
        $userIdInt = is_numeric($userId) ? (int)$userId : null;
        if (!$this->isServerEffective((int)$row['id'], $row['name'] ?? null, $isPrivate, $userIdInt)) {
            return [
                'success' => false,
                'error' => 'Server not found',
                'status_code' => 404
            ];
        }

        $stmt = $this->db->prepare("
            SELECT * FROM mcp_server_tools WHERE server_id = ? ORDER BY tool_name ASC
        ");
        $stmt->execute([$serverId]);
        $tools = $stmt->fetchAll();

        // Parse JSON fields
        foreach ($tools as &$tool) {
            $tool['input_schema'] = json_decode($tool['input_schema'], true);
        }

        return [
            'success' => true,
            'tools' => $tools,
            'status_code' => 200
        ];
    }

    /**
     * Get all tools from all enabled global servers
     */
    public function getAllTools(array $request): array
    {
        // Get tools from all enabled servers visible to the caller
        $userId = (string) ($request['query']['user_id'] ?? $request['user_id'] ?? '');
        $sql = "SELECT t.*, s.name as server_name, s.url as server_url, s.user_id as server_user_id
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND (s.user_id IS NULL"
            . ($userId !== '' ? " OR s.user_id = :uid" : "") . ")
                ORDER BY s.name ASC, t.tool_name ASC";
        $stmt = $this->db->prepare($sql);
        if ($userId !== '') $stmt->bindValue(':uid', $userId);
        $stmt->execute();
        $tools = $stmt->fetchAll();

        // Parse JSON fields
        foreach ($tools as &$tool) {
            $tool['input_schema'] = json_decode($tool['input_schema'], true);
        }
        unset($tool);

        // Apply the full cascade (package + per-user override) so chat-side
        // tool listings match what MCPToolsLoader will actually load at chat
        // time. Without this, the picker would show tools the LLM never sees.
        $userIdInt = is_numeric($userId) ? (int)$userId : null;
        $tools = array_values(array_filter($tools, function (array $t) use ($userIdInt) {
            $serverId  = (int)($t['server_id'] ?? 0);
            $isPrivate = ($t['server_user_id'] ?? null) !== null;
            return $this->isServerEffective($serverId, $t['server_name'] ?? null, $isPrivate, $userIdInt);
        }));

        return [
            'success' => true,
            'tools' => $tools,
            'status_code' => 200
        ];
    }

    /**
     * Add a new MCP server
     */
    public function create(array $request): array
    {
        $input = $request['body'];
        $userId = $input['user_id'] ?? $request['user_id'] ?? 'demo-user';

        $name = trim($input['name'] ?? '');
        $url = trim($input['url'] ?? '');
        $description = trim($input['description'] ?? '');

        if (!$name || !$url) {
            return [
                'success' => false,
                'error' => 'Name and URL are required',
                'status_code' => 400
            ];
        }

        // Validate URL format
        if (!filter_var($url, FILTER_VALIDATE_URL)) {
            return [
                'success' => false,
                'error' => 'Invalid URL format',
                'status_code' => 400
            ];
        }

        try {
            $stmt = $this->db->prepare("
                INSERT INTO mcp_servers (user_id, name, url, description)
                VALUES (?, ?, ?, ?)
            ");
            $stmt->execute([$userId, $name, $url, $description]);

            $serverId = $this->db->lastInsertId();

            return [
                'success' => true,
                'server_id' => $serverId,
                'message' => 'Server added successfully',
                'status_code' => 200
            ];
        } catch (PDOException $e) {
            if ($e->getCode() == 23000) {
                return [
                    'success' => false,
                    'error' => 'A server with this name already exists',
                    'status_code' => 409
                ];
            }
            throw $e;
        }
    }

    /**
     * Update an existing MCP server
     */
    public function update(array $request): array
    {
        $input = $request['body'];
        $userId = $input['user_id'] ?? $request['user_id'] ?? 'demo-user';

        $serverId = $input['server_id'] ?? null;
        $name = trim($input['name'] ?? '');
        $url = trim($input['url'] ?? '');
        $description = trim($input['description'] ?? '');

        if (!$serverId) {
            return [
                'success' => false,
                'error' => 'Server ID required',
                'status_code' => 400
            ];
        }

        if (!$name || !$url) {
            return [
                'success' => false,
                'error' => 'Name and URL are required',
                'status_code' => 400
            ];
        }

        $stmt = $this->db->prepare("
            UPDATE mcp_servers
            SET name = ?, url = ?, description = ?
            WHERE id = ? AND user_id = ?
        ");
        $stmt->execute([$name, $url, $description, $serverId, $userId]);

        if ($stmt->rowCount() === 0) {
            return [
                'success' => false,
                'error' => 'Server not found',
                'status_code' => 404
            ];
        }

        // Clear cached tools when URL changes
        $stmt = $this->db->prepare("DELETE FROM mcp_server_tools WHERE server_id = ?");
        $stmt->execute([$serverId]);

        return [
            'success' => true,
            'message' => 'Server updated successfully',
            'status_code' => 200
        ];
    }

    /**
     * Toggle server enabled/disabled state
     */
    public function toggle(array $request): array
    {
        $input = $request['body'];
        $userId = $input['user_id'] ?? $request['user_id'] ?? 'demo-user';

        $serverId = $input['server_id'] ?? null;
        $enabled = $input['enabled'] ?? true;

        if (!$serverId) {
            return [
                'success' => false,
                'error' => 'Server ID required',
                'status_code' => 400
            ];
        }

        $stmt = $this->db->prepare("
            UPDATE mcp_servers SET enabled = ? WHERE id = ? AND user_id = ?
        ");
        $stmt->execute([$enabled ? 1 : 0, $serverId, $userId]);

        return [
            'success' => true,
            'message' => $enabled ? 'Server enabled' : 'Server disabled',
            'status_code' => 200
        ];
    }

    /**
     * Delete an MCP server
     */
    public function delete(array $request): array
    {
        $serverId = $request['query']['server_id'] ?? null;
        $userId = $request['query']['user_id'] ?? $request['user_id'] ?? 'demo-user';

        if (!$serverId) {
            return [
                'success' => false,
                'error' => 'Server ID required',
                'status_code' => 400
            ];
        }

        $stmt = $this->db->prepare("
            DELETE FROM mcp_servers WHERE id = ? AND user_id = ?
        ");
        $stmt->execute([$serverId, $userId]);

        if ($stmt->rowCount() === 0) {
            return [
                'success' => false,
                'error' => 'Server not found',
                'status_code' => 404
            ];
        }

        return [
            'success' => true,
            'message' => 'Server deleted successfully',
            'status_code' => 200
        ];
    }

    /**
     * Ensure required tables exist
     */
    private function ensureTablesExist(): void
    {
        $this->db->exec("
            CREATE TABLE IF NOT EXISTS mcp_servers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NULL,
                name VARCHAR(255) NOT NULL,
                url VARCHAR(500) NOT NULL,
                description TEXT,
                enabled TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_server_name (name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");

        $this->db->exec("
            CREATE TABLE IF NOT EXISTS mcp_server_tools (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                tool_name VARCHAR(255) NOT NULL,
                tool_description TEXT,
                input_schema JSON,
                has_ui TINYINT(1) DEFAULT 0,
                ui_resource_uri VARCHAR(500),
                cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
                UNIQUE KEY unique_server_tool (server_id, tool_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
    }
}
