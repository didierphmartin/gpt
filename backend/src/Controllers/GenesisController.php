<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * GenesisController — server-side enforcement gate + promotion store for
 * skill genesis (spec: docs/specs/2026-07-14-skill-genesis-design.md §6–7).
 *
 * Mirrors HealController's philosophy: the build LOOP runs client-side
 * (skill folder written via the browser's local-FS handle; optional SkillOpt
 * hardening in Pyodide), but whether it may SPEND, and how much, is decided
 * here. Ledger: heal_spend with kind='genesis' (heal rows default 'heal').
 */
final class GenesisController
{
    private ?PDO $db;
    private array $config;
    private bool $tablesEnsured = false;

    /** @param PDO|null $db null only in unit tests of the pure decide(). */
    public function __construct(?PDO $db, array $config = [])
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Pure decision: may this promotion build run? Extracted for testability
     * (precedent: HealController::decide).
     * @return array{allowed:bool,requires_approval:bool,reason:string}
     */
    public function decide(
        string $mode,
        float $estimate,
        float $remaining,
        float $ceiling,
        int $bornThisWeek,
        int $weeklyMax,
        bool $approved
    ): array {
        if ($mode === 'off') {
            return ['allowed' => false, 'requires_approval' => false, 'reason' => 'mode_off'];
        }
        if ($mode === 'suggest') {
            return ['allowed' => false, 'requires_approval' => false, 'reason' => 'suggest_only'];
        }
        if ($estimate > $remaining) {
            return ['allowed' => false, 'requires_approval' => false, 'reason' => 'over_budget'];
        }
        if ($bornThisWeek >= $weeklyMax) {
            return ['allowed' => false, 'requires_approval' => false, 'reason' => 'weekly_throttle'];
        }
        if ($mode === 'ask') {
            return $approved
                ? ['allowed' => true, 'requires_approval' => false, 'reason' => 'ask_approved']
                : ['allowed' => false, 'requires_approval' => true, 'reason' => 'ask'];
        }
        // auto: must also clear the per-skill ceiling.
        if ($estimate > $ceiling) {
            return ['allowed' => false, 'requires_approval' => true, 'reason' => 'over_ceiling'];
        }
        return ['allowed' => true, 'requires_approval' => false, 'reason' => 'auto'];
    }

    // ─── DDL (house lazy pattern) ────────────────────────────────────────────

    public function ensureTables(): void
    {
        if ($this->tablesEnsured || $this->db === null) {
            return;
        }
        try {
            $this->db->exec(
                "CREATE TABLE IF NOT EXISTS skill_promotions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    class TINYINT NOT NULL,
                    status ENUM('proposed','approved','building','born','merged','dismissed','failed')
                        NOT NULL DEFAULT 'proposed',
                    source_ref VARCHAR(191) NOT NULL,
                    skill_name VARCHAR(120) NOT NULL,
                    description TEXT NOT NULL,
                    eval_queries JSON NOT NULL,
                    parameter_schema JSON NULL,
                    merge_target VARCHAR(120) NULL,
                    est_cost_usd DECIMAL(8,4) NULL,
                    born_skill_dir VARCHAR(120) NULL,
                    created_at DATETIME NOT NULL,
                    decided_at DATETIME NULL,
                    UNIQUE KEY uq_user_skill (user_id, skill_name)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
            );
        } catch (\Throwable $e) {
            error_log('[GenesisController] ensureTables(skill_promotions) failed: ' . $e->getMessage());
        }
        // heal_spend.kind — probe then alter (PK must include kind so heal and
        // genesis rows upsert independently per (user, day)).
        try {
            $this->db->query('SELECT kind FROM heal_spend LIMIT 1');
        } catch (\PDOException $e) {
            foreach ([
                "ALTER TABLE heal_spend ADD COLUMN kind ENUM('heal','genesis') NOT NULL DEFAULT 'heal'",
                'ALTER TABLE heal_spend DROP PRIMARY KEY',
                'ALTER TABLE heal_spend ADD PRIMARY KEY (user_id, day, kind)',
            ] as $sql) {
                try { $this->db->exec($sql); } catch (\PDOException $e2) { /* already applied */ }
            }
        }
        $this->tablesEnsured = true;
    }
}
