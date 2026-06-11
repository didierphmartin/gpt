<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\Services\PackageResolver;
use PDO;

/**
 * Package Controller
 *
 * Exposes the effective role-based capability package to the frontend, and
 * provides admin CRUD for editing packages via gpt_admin.
 *
 * Routes:
 *   GET  /api/v1/me/package                - current user's effective package
 *   GET  /api/v1/admin/packages            - all 4 packages (admin only)
 *   GET  /api/v1/admin/packages/{role}     - single package (admin only)
 *   PUT  /api/v1/admin/packages/{role}     - update capabilities (admin only)
 */
class PackageController
{
    private PDO $db;
    private array $config;
    private PackageResolver $resolver;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->resolver = new PackageResolver($db);
    }

    /**
     * Return the package for the currently authenticated user. Callers include
     * both gpt (to render sidebar, filter providers) and gpt_admin (to confirm
     * the caller is an admin before unlocking the UI).
     */
    public function me(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        $userIdInt = is_numeric($userId) ? (int) $userId : null;

        $package = $this->resolver->resolveForUser($userIdInt);

        return [
            'success' => true,
            'role' => $package['role'],
            'capabilities' => $package['capabilities'],
            'updated_at' => $package['updated_at'],
        ];
    }

    /**
     * List all 4 packages. Admin only.
     */
    public function adminList(array $request): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }

        $packages = [];
        foreach (PackageResolver::validRoles() as $role) {
            $packages[] = $this->resolver->loadPackage($role);
        }

        return [
            'success' => true,
            'packages' => $packages,
        ];
    }

    /**
     * Get a single package by role. Admin only.
     */
    public function adminGet(array $request, string $role): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }

        if (!in_array($role, PackageResolver::validRoles(), true)) {
            return [
                'success' => false,
                'error' => 'Invalid role',
                'status_code' => 400,
            ];
        }

        return [
            'success' => true,
            'package' => $this->resolver->loadPackage($role),
        ];
    }

    /**
     * Replace the capabilities JSON for a role. Admin only.
     * Expects body: { "capabilities": { ... } }
     */
    public function adminUpdate(array $request, string $role): array
    {
        if ($err = $this->requireAdmin($request)) {
            return $err;
        }

        if (!in_array($role, PackageResolver::validRoles(), true)) {
            return [
                'success' => false,
                'error' => 'Invalid role',
                'status_code' => 400,
            ];
        }

        $body = $request['body'] ?? [];
        $capabilities = $body['capabilities'] ?? null;

        if (!is_array($capabilities)) {
            return [
                'success' => false,
                'error' => 'capabilities object is required',
                'status_code' => 400,
            ];
        }

        $validationError = $this->validateCapabilities($capabilities);
        if ($validationError !== null) {
            return [
                'success' => false,
                'error' => $validationError,
                'status_code' => 400,
            ];
        }

        $encoded = json_encode($capabilities, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded === false) {
            return [
                'success' => false,
                'error' => 'Failed to encode capabilities: ' . json_last_error_msg(),
                'status_code' => 400,
            ];
        }

        $adminId = is_numeric($request['user_id'] ?? null) ? (int) $request['user_id'] : null;

        // Atomic upsert via INSERT ... ON DUPLICATE KEY UPDATE.
        //
        // Why not "UPDATE first, INSERT if rowCount() === 0":
        //   MySQL's PDO::rowCount() for UPDATE returns the number of rows
        //   that were *modified*, NOT the number that *matched*. So if the
        //   admin clicks Save twice in a row (or saves with no actual
        //   capability change), the second UPDATE returns rowCount=0 even
        //   though the row exists — the fallback then runs INSERT and hits
        //   "Duplicate entry 'X' for key 'packages.PRIMARY'".
        //   This was reported as a 500 in the gpt_admin Packages editor.
        //
        // ON DUPLICATE KEY UPDATE handles both insert and update in one
        // statement and is rowCount-semantics-immune: if the row exists,
        // capabilities + updated_by get overwritten; if not, the row is
        // created. Either way, exactly one final row.
        $stmt = $this->db->prepare(
            'INSERT INTO packages (role, capabilities, updated_by) VALUES (:role, :caps, :uid)
             ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), updated_by = VALUES(updated_by)'
        );
        $stmt->execute([
            ':role' => $role,
            ':caps' => $encoded,
            ':uid' => $adminId,
        ]);

        return [
            'success' => true,
            'package' => $this->resolver->loadPackage($role),
        ];
    }

    /**
     * Enforce that the current request is authenticated AND the user's role is admin.
     * Mirrors SystemSettingsController::requireAdmin.
     */
    private function requireAdmin(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401,
            ];
        }

        $stmt = $this->db->prepare('SELECT role FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$user || ($user['role'] ?? '') !== 'admin') {
            return [
                'success' => false,
                'error' => 'Admin access required',
                'status_code' => 403,
            ];
        }

        return null;
    }

    /**
     * Shallow shape check. Deeper validation stays loose so gpt_admin can add
     * new knobs (e.g. new provider names) without needing a backend change.
     */
    private function validateCapabilities(array $caps): ?string
    {
        foreach (['providers', 'sidebar'] as $required) {
            if (!array_key_exists($required, $caps) || !is_array($caps[$required])) {
                return "capabilities.{$required} must be an object";
            }
        }

        foreach (['mcp_servers', 'skills'] as $optional) {
            if (array_key_exists($optional, $caps)
                && $caps[$optional] !== null
                && !is_array($caps[$optional])) {
                return "capabilities.{$optional} must be null or an array";
            }
        }

        if (array_key_exists('quota_tokens', $caps)
            && $caps['quota_tokens'] !== null
            && !is_int($caps['quota_tokens'])) {
            return 'capabilities.quota_tokens must be null or an integer';
        }

        return null;
    }
}
