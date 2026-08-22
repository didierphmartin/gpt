<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * Login microservice admin controller (gpt_admin "Login" card).
 *
 * Manages the shared login DB (netfo587_login). Reads + non-secret edits run
 * here directly (gpt/backend holds the login-DB credentials). Secret operations
 * (app-key mint, password-reset email) are brokered to the login service in a
 * later phase. Admin-gated; an admin cannot delete or de-admin their OWN login
 * account (matched by email against the gpt admin identity).
 *
 * Phase 1: Overview stats + Users CRUD.
 */
class LoginAdminController
{
    private const ROLES = ['guest', 'prospect', 'user', 'admin', 'affiliate'];
    private const PROVIDERS = ['email', 'google', 'facebook', 'phone'];

    private array $config;
    private PDO $db; // chatbot DB — only to verify the caller's admin identity

    public function __construct(PDO $db, array $config)
    {
        $this->config = $config;
        $this->db = $db;
    }

    /** The authenticated caller's row IF they are an admin, else null. */
    private function adminRow(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId) return null;
        $s = $this->db->prepare('SELECT id, email, role FROM users WHERE id = :id LIMIT 1');
        $s->execute([':id' => $userId]);
        $r = $s->fetch(PDO::FETCH_ASSOC);
        return ($r && ($r['role'] ?? '') === 'admin') ? $r : null;
    }

    private function requireAdmin(array $request): ?array
    {
        if (!$this->adminRow($request)) {
            return ['success' => false, 'error' => 'Admin access required', 'status_code' => 403];
        }
        return null;
    }

    /** PDO to the login DB, or null if unconfigured/unreachable. */
    private function login(): ?PDO
    {
        static $pdo = false;
        if ($pdo !== false) return $pdo instanceof PDO ? $pdo : null;
        $c = $this->config['login_database'] ?? null;
        if (!is_array($c) || empty($c['username']) || empty($c['database'])) return $pdo = null;
        try {
            $pdo = new PDO(
                "mysql:host={$c['host']};dbname={$c['database']};charset=" . ($c['charset'] ?? 'utf8mb4'),
                (string)$c['username'], (string)$c['password'],
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_TIMEOUT => 6]
            );
        } catch (\Throwable $e) {
            error_log('[login-admin] DB connect failed: ' . $e->getMessage());
            $pdo = null;
        }
        return $pdo instanceof PDO ? $pdo : null;
    }

    private function loginUserById(PDO $l, int $id): ?array
    {
        $s = $l->prepare("SELECT id, email FROM users WHERE id = ? LIMIT 1");
        $s->execute([$id]);
        return $s->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    /** GET /api/v1/admin/login/stats — Overview counts. */
    public function getStats(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'available' => false,
            'message' => 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'];
        try {
            $stats = [
                'total_users' => (int)$l->query("SELECT COUNT(*) FROM users")->fetchColumn(),
                'by_provider' => $l->query("SELECT provider, COUNT(*) c FROM users GROUP BY provider")->fetchAll(),
                'verified'    => (int)$l->query("SELECT COUNT(*) FROM users WHERE email_verified = 1")->fetchColumn(),
                'apps'        => $l->query("SELECT COUNT(*) total, COALESCE(SUM(revoked_at IS NULL),0) active FROM registered_apps")->fetch(),
                'passkeys'    => (int)$l->query("SELECT COUNT(*) FROM webauthn_credentials")->fetchColumn(),
                'signups_7d'  => (int)$l->query("SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)")->fetchColumn(),
                'logins_7d'   => (int)$l->query("SELECT COUNT(*) FROM users WHERE last_login >= DATE_SUB(NOW(), INTERVAL 7 DAY)")->fetchColumn(),
            ];
            return ['success' => true, 'available' => true, 'stats' => $stats];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'message' => 'Stats query failed'];
        }
    }

    /** GET /api/v1/admin/login/users?q&role&provider — user list. */
    public function getUsers(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'available' => false, 'users' => [],
            'message' => 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'];
        $q = trim((string)($request['query']['q'] ?? ''));
        $provider = (string)($request['query']['provider'] ?? '');
        $where = []; $p = [];
        if ($q !== '') { $where[] = "(email LIKE :q OR first_name LIKE :q OR last_name LIKE :q OR phone LIKE :q)"; $p[':q'] = "%$q%"; }
        if (in_array($provider, self::PROVIDERS, true)) { $where[] = "provider = :prov"; $p[':prov'] = $provider; }
        $w = $where ? ('WHERE ' . implode(' AND ', $where)) : '';
        try {
            // Accounts are auth-only now — no role column (roles are per-app in app_user_roles).
            $s = $l->prepare("SELECT id, email, phone, first_name, last_name, provider,
                profile_picture, email_verified, last_login, created_at
                FROM users $w ORDER BY id DESC LIMIT 200");
            $s->execute($p);
            $rows = $s->fetchAll();
            foreach ($rows as &$r) {
                $r['email_verified'] = (int)$r['email_verified'];
                $name = trim(($r['first_name'] ?? '') . ' ' . ($r['last_name'] ?? ''));
                $r['name'] = $name !== '' ? $name : ($r['email'] ?? '');
            }
            return ['success' => true, 'available' => true, 'users' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'users' => [], 'message' => 'User query failed'];
        }
    }

    /** POST /api/v1/admin/login/users — create a user (no password; provider=email). */
    public function createUser(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'message' => 'Login DB not reachable'];
        $b = $request['body'] ?? [];
        $email = trim((string)($b['email'] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return ['success' => false, 'message' => 'A valid email is required'];
        try {
            // Account only (auth). Per-app roles are assigned separately (app_user_roles).
            $s = $l->prepare("INSERT INTO users (email, first_name, last_name, provider, email_verified)
                VALUES (:e, :f, :ln, 'email', 0)");
            $s->execute([':e' => $email, ':f' => (string)($b['first_name'] ?? ''), ':ln' => (string)($b['last_name'] ?? '')]);
            return ['success' => true, 'id' => (int)$l->lastInsertId()];
        } catch (\Throwable $e) {
            $dup = str_contains($e->getMessage(), 'Duplicate') || str_contains($e->getMessage(), '1062');
            return ['success' => false, 'message' => $dup ? 'That email already exists' : 'Create failed'];
        }
    }

    /** POST /api/v1/admin/login/users/update — edit account fields (profile /
     *  verification). Roles are per-app (app_user_roles), not editable here. */
    public function updateUser(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'message' => 'Login DB not reachable'];
        $b = $request['body'] ?? [];
        $id = (int)($b['id'] ?? 0);
        if ($id <= 0) return ['success' => false, 'message' => 'id is required'];
        $target = $this->loginUserById($l, $id);
        if (!$target) return ['success' => false, 'message' => 'User not found'];

        $fields = []; $p = [':id' => $id];
        foreach (['first_name', 'last_name', 'phone', 'profile_picture'] as $f) {
            if (array_key_exists($f, $b)) { $fields[] = "$f = :$f"; $p[":$f"] = (string)$b[$f]; }
        }
        if (array_key_exists('email_verified', $b)) { $fields[] = "email_verified = :ev"; $p[':ev'] = $b['email_verified'] ? 1 : 0; }
        if (!$fields) return ['success' => true];
        try {
            $s = $l->prepare("UPDATE users SET " . implode(', ', $fields) . " WHERE id = :id");
            $s->execute($p);
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Update failed'];
        }
    }

    /** POST /api/v1/admin/login/users/delete — delete a user + their passkeys.
     *  An admin cannot delete their own account. */
    public function deleteUser(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'message' => 'Login DB not reachable'];
        $id = (int)(($request['body'] ?? [])['id'] ?? 0);
        if ($id <= 0) return ['success' => false, 'message' => 'id is required'];
        $target = $this->loginUserById($l, $id);
        if (!$target) return ['success' => false, 'message' => 'User not found'];
        $admin = $this->adminRow($request);
        if ($admin && strcasecmp((string)$admin['email'], (string)$target['email']) === 0) {
            return ['success' => false, 'message' => "You can't delete your own account."];
        }
        try {
            $l->beginTransaction();
            $l->prepare("DELETE FROM webauthn_credentials WHERE user_id = ?")->execute([$id]);
            try { $l->prepare("DELETE FROM app_user_roles WHERE user_id = ?")->execute([$id]); } catch (\Throwable $e) { /* table may not exist */ }
            $l->prepare("DELETE FROM users WHERE id = ?")->execute([$id]);
            $l->commit();
            return ['success' => true];
        } catch (\Throwable $e) {
            if ($l->inTransaction()) $l->rollBack();
            return ['success' => false, 'message' => 'Delete failed'];
        }
    }

    // ---------- Applications (app-centric role management) ----------

    private function appIdBySlug(PDO $login, string $slug): ?int
    {
        $s = $login->prepare("SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1");
        $s->execute([$slug]);
        $r = $s->fetchColumn();
        return $r !== false ? (int)$r : null;
    }

    /** GET /api/v1/admin/login/apps — registered applications + their user counts. */
    public function getApps(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'available' => false, 'apps' => [],
            'message' => 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'];
        try {
            $rows = $l->query("SELECT id, app_id, name, key_prefix, entry_point, created_at, last_used_at, revoked_at
                               FROM registered_apps ORDER BY name")->fetchAll();
            $counts = [];
            foreach ($l->query("SELECT app_id, COUNT(*) c FROM app_user_roles GROUP BY app_id") as $rr) {
                $counts[(int)$rr['app_id']] = (int)$rr['c'];
            }
            foreach ($rows as &$r) {
                $r['users'] = $counts[(int)$r['id']] ?? 0;
                $r['revoked'] = $r['revoked_at'] !== null;
            }
            return ['success' => true, 'available' => true, 'apps' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'apps' => [], 'message' => 'Apps query failed'];
        }
    }

    /** GET /api/v1/admin/login/app-users?app=<slug>&q= — users + their role for one app. */
    public function getAppUsers(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'available' => false, 'users' => [],
            'message' => 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'];
        $slug = (string)($request['query']['app'] ?? '');
        $appId = $this->appIdBySlug($l, $slug);
        if ($appId === null) return ['success' => false, 'message' => 'Unknown application'];
        try {
            // MEMBERS of this app = users who have a role for it (in its context).
            $s = $l->prepare("SELECT u.id, u.email, u.first_name, u.last_name, u.provider,
                                     u.email_verified, u.last_login, r.role
                              FROM app_user_roles r JOIN users u ON u.id = r.user_id
                              WHERE r.app_id = ? ORDER BY u.id DESC");
            $s->execute([$appId]);
            $rows = $s->fetchAll();
            foreach ($rows as &$r) {
                $name = trim(($r['first_name'] ?? '') . ' ' . ($r['last_name'] ?? ''));
                $r['name'] = $name !== '' ? $name : ($r['email'] ?? '');
                $r['email_verified'] = (int)$r['email_verified'];
                unset($r['first_name'], $r['last_name']);
            }
            return ['success' => true, 'available' => true, 'app' => $slug, 'users' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'users' => [], 'message' => 'User query failed'];
        }
    }

    /** POST /api/v1/admin/login/app-users/role — set/clear a user's role for one app.
     *  Body: { app, user_id, role }. Empty/"none" role revokes access. */
    public function setAppUserRole(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'message' => 'Login DB not reachable'];
        $b = $request['body'] ?? [];
        $slug = (string)($b['app'] ?? '');
        $uid = (int)($b['user_id'] ?? 0);
        $role = (string)($b['role'] ?? '');
        $appId = $this->appIdBySlug($l, $slug);
        if ($appId === null) return ['success' => false, 'message' => 'Unknown application'];
        if ($uid <= 0) return ['success' => false, 'message' => 'user_id is required'];
        $adminId = is_numeric($request['user_id'] ?? null) ? (int)$request['user_id'] : null;
        try {
            if ($role === '' || $role === 'none') {
                $s = $l->prepare("DELETE FROM app_user_roles WHERE user_id = :u AND app_id = :a");
                $s->execute([':u' => $uid, ':a' => $appId]);
            } else {
                if (!in_array($role, self::ROLES, true)) return ['success' => false, 'message' => 'invalid role'];
                $s = $l->prepare("INSERT INTO app_user_roles (user_id, app_id, role, updated_by)
                    VALUES (:u, :a, :r, :by)
                    ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)");
                $s->execute([':u' => $uid, ':a' => $appId, ':r' => $role, ':by' => $adminId]);
            }
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }

    /** POST /api/v1/admin/login/app-users/add — add a member to an app, creating the
     *  account first if the email is new. Writes both `users` (auth-only, no
     *  password — completed via reset/social/passkey) and `app_user_roles`.
     *  Body: { app, email, first_name?, last_name?, role }. */
    public function addAppMember(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $l = $this->login();
        if (!$l) return ['success' => false, 'message' => 'Login DB not reachable'];
        $b = $request['body'] ?? [];
        $slug = (string)($b['app'] ?? '');
        $email = trim((string)($b['email'] ?? ''));
        $role = (string)($b['role'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return ['success' => false, 'message' => 'A valid email is required'];
        if (!in_array($role, self::ROLES, true)) return ['success' => false, 'message' => 'A valid role is required'];
        $appId = $this->appIdBySlug($l, $slug);
        if ($appId === null) return ['success' => false, 'message' => 'Unknown application'];
        $adminId = is_numeric($request['user_id'] ?? null) ? (int)$request['user_id'] : null;
        try {
            $l->beginTransaction();
            // 1) Find the user by email; create the account if it doesn't exist yet.
            $s = $l->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
            $s->execute([$email]);
            $uid = $s->fetchColumn();
            $created = false;
            if ($uid === false) {
                $ins = $l->prepare("INSERT INTO users (email, first_name, last_name, provider, email_verified)
                                    VALUES (?, ?, ?, 'email', 0)");
                $ins->execute([$email, (string)($b['first_name'] ?? ''), (string)($b['last_name'] ?? '')]);
                $uid = (int)$l->lastInsertId();
                $created = true;
            } else {
                $uid = (int)$uid;
            }
            // 2) Link the user to the application with the role.
            $up = $l->prepare("INSERT INTO app_user_roles (user_id, app_id, role, updated_by)
                               VALUES (?, ?, ?, ?)
                               ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)");
            $up->execute([$uid, $appId, $role, $adminId]);
            $l->commit();
            return ['success' => true, 'created' => $created, 'user_id' => $uid];
        } catch (\Throwable $e) {
            if ($l->inTransaction()) $l->rollBack();
            $dup = str_contains($e->getMessage(), 'Duplicate') || str_contains($e->getMessage(), '1062');
            return ['success' => false, 'message' => $dup ? 'That email already exists' : 'Add failed'];
        }
    }
}
