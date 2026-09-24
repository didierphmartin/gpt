<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Throwable;

/**
 * The admin-role guard, in one place.
 *
 * Five controllers each carried their own byte-identical copy of this, and the
 * controller that most needed it — AdminController, with 34 admin endpoints —
 * had none at all. A rule written five times and omitted once is a rule that
 * will be omitted again, so it lives here now and the copies are gone.
 *
 * Why the role is re-read on every request instead of being carried in the JWT:
 * the token proves WHO the caller is (`sub`) and nothing more. Putting the role
 * inside it would save this query, but a token stays valid for eight hours, so
 * an admin demoted or deleted in that window would keep their access until it
 * expired. One indexed lookup buys correct authorization AND immediate
 * revocation; that is a good trade.
 *
 * Requires the using class to have `$this->db` pointing at the database that
 * holds `users` (the contexts DB — what index.php hands every controller).
 */
trait RequiresAdmin
{
    /**
     * Returns null when the caller is an admin, or an error array to return
     * as-is when they are not. Callers use it as a guard clause:
     *
     *     if ($err = $this->requireAdmin($request)) { return $err; }
     */
    protected function requireAdmin(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401,
            ];
        }

        try {
            $stmt = $this->db->prepare('SELECT role FROM users WHERE id = :id LIMIT 1');
            $stmt->execute([':id' => $userId]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            // A database failure must never read as "permission granted".
            error_log('[RequiresAdmin] role lookup failed: ' . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Admin access required',
                'status_code' => 403,
            ];
        }

        // Covers three cases at once: the row is gone (deleted user), the role
        // is not admin, and the role is one of the other values in the enum.
        if (!$user || ($user['role'] ?? '') !== 'admin') {
            return [
                'success' => false,
                'error' => 'Admin access required',
                'status_code' => 403,
            ];
        }

        return null;
    }
}
