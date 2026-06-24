<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * HealController — the server-side enforcement gate for self-healing.
 *
 * The healing LOOP runs client-side (SkillOpt scripts in Pyodide), but whether
 * it is allowed to spend, and how much, is decided HERE so a client bug can
 * never bypass the user's cost controls. Reads the per-user heal settings
 * (users.heal_*) and a daily spend ledger (heal_spend).
 *
 *   POST /api/v1/heal/authorize { skill_dir, estimate_usd } -> {allowed, mode, ...}
 *   POST /api/v1/heal/record    { actual_usd }              -> records spend
 *   GET  /api/v1/heal/status                                 -> {mode, spent_today, ...}
 *
 * Spec: docs/specs/2026-06-13-self-healing-design.md §4.4
 */
final class HealController
{
    private PDO $db;

    public function __construct(PDO $db, array $config = [])
    {
        $this->db = $db;
    }

    /** Decide whether a heal may run, per mode + budget + ceiling. */
    public function authorize(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $b = $request['body'] ?? [];
        $estimate = max(0.0, (float) ($b['estimate_usd'] ?? 0));
        $skillDir = (string) ($b['skill_dir'] ?? '');

        $cfg = $this->healConfig($userId);
        $spent = $this->spentToday($userId);
        $remaining = max(0.0, $cfg['budget'] - $spent);

        $base = [
            'success' => true,
            'mode' => $cfg['mode'],
            'skill_dir' => $skillDir,
            'estimate_usd' => round($estimate, 4),
            'spent_today_usd' => round($spent, 4),
            'budget_usd' => $cfg['budget'],
            'remaining_usd' => round($remaining, 4),
            'ceiling_usd' => $cfg['ceiling'],
        ];

        return $base + $this->decide($cfg['mode'], $estimate, $remaining, $cfg['ceiling']);
    }

    /**
     * Pure decision: given mode + estimate + remaining budget + ceiling,
     * decide whether a heal may run. Extracted for testability.
     * @return array{allowed:bool,requires_approval:bool,reason:string}
     */
    public function decide(string $mode, float $estimate, float $remaining, float $ceiling): array
    {
        if ($mode === 'off') {
            return ['allowed' => false, 'requires_approval' => false, 'reason' => 'mode_off'];
        }
        if ($estimate > $remaining) {
            return ['allowed' => false, 'requires_approval' => false, 'reason' => 'over_budget'];
        }
        if ($mode === 'ask') {
            // Allowed, but the client must show the approval overlay first.
            return ['allowed' => true, 'requires_approval' => true, 'reason' => 'ask'];
        }
        // auto: must also be under the per-heal ceiling.
        if ($estimate > $ceiling) {
            return ['allowed' => false, 'requires_approval' => true, 'reason' => 'over_ceiling'];
        }
        return ['allowed' => true, 'requires_approval' => false, 'reason' => 'auto'];
    }

    /** Record actual heal spend against today's ledger. */
    public function record(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $actual = max(0.0, (float) (($request['body'] ?? [])['actual_usd'] ?? 0));
        $this->ensureSpendTable();
        try {
            $stmt = $this->db->prepare(
                "INSERT INTO heal_spend (user_id, day, spent_usd) VALUES (:u, CURDATE(), :s)
                 ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2"
            );
            $stmt->execute([':u' => $userId, ':s' => $actual, ':s2' => $actual]);
        } catch (\Throwable $e) {
            error_log('[HealController] record failed: ' . $e->getMessage());
            return ['success' => false, 'error' => 'record failed', 'status_code' => 500];
        }
        return ['success' => true, 'spent_today_usd' => round($this->spentToday($userId), 4)];
    }

    /** Current mode + today's spend, for the UI. */
    public function status(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $cfg = $this->healConfig($userId);
        $spent = $this->spentToday($userId);
        return [
            'success' => true,
            'mode' => $cfg['mode'],
            'budget_usd' => $cfg['budget'],
            'ceiling_usd' => $cfg['ceiling'],
            'spent_today_usd' => round($spent, 4),
            'remaining_usd' => round(max(0.0, $cfg['budget'] - $spent), 4),
        ];
    }

    // ─── internals ──────────────────────────────────────────────────────────

    /** Read this user's heal mode/budget/ceiling (defaults if columns absent). */
    private function healConfig(int $userId): array
    {
        $out = ['mode' => 'off', 'budget' => 5.0, 'ceiling' => 1.0];
        try {
            $stmt = $this->db->prepare(
                "SELECT heal_mode, heal_daily_budget_usd, heal_per_heal_ceiling_usd FROM users WHERE id = ?"
            );
            $stmt->execute([$userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row) {
                if (in_array($row['heal_mode'] ?? null, ['off', 'ask', 'auto'], true)) {
                    $out['mode'] = $row['heal_mode'];
                }
                if ($row['heal_daily_budget_usd'] !== null)     $out['budget'] = (float) $row['heal_daily_budget_usd'];
                if ($row['heal_per_heal_ceiling_usd'] !== null) $out['ceiling'] = (float) $row['heal_per_heal_ceiling_usd'];
            }
        } catch (\Throwable $e) {
            // columns may not exist yet → defaults (mode off = safe)
        }
        return $out;
    }

    private function spentToday(int $userId): float
    {
        $this->ensureSpendTable();
        try {
            $stmt = $this->db->prepare(
                "SELECT spent_usd FROM heal_spend WHERE user_id = ? AND day = CURDATE()"
            );
            $stmt->execute([$userId]);
            $v = $stmt->fetchColumn();
            return $v !== false ? (float) $v : 0.0;
        } catch (\Throwable $e) {
            return 0.0;
        }
    }

    private bool $spendTableEnsured = false;

    private function ensureSpendTable(): void
    {
        if ($this->spendTableEnsured) {
            return;
        }
        try {
            $this->db->exec(
                "CREATE TABLE IF NOT EXISTS heal_spend (
                    user_id BIGINT UNSIGNED NOT NULL,
                    day DATE NOT NULL,
                    spent_usd DECIMAL(10,4) NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, day)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
            );
        } catch (\Throwable $e) {
            error_log('[HealController] ensureSpendTable failed: ' . $e->getMessage());
        }
        $this->spendTableEnsured = true;
    }
}
