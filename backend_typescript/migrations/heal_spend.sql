-- heal_spend: per-user daily heal-spend ledger (self-healing budget enforcement).
-- Mirrors HealController::ensureSpendTable() (src/Controllers/HealController.php ~line 175).
-- The runtime ensureSpendTable() creates this on demand; this standalone migration is
-- provided so it can be applied manually instead.
CREATE TABLE IF NOT EXISTS heal_spend (
    user_id BIGINT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    spent_usd DECIMAL(10,4) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
