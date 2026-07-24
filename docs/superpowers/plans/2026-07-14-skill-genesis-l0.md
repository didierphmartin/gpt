# Skill Genesis L0 + Foundation (PHP backend + frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the manual on-ramps of the skill-genesis design (spec: `docs/specs/2026-07-14-skill-genesis-design.md` §6 L0 + shared foundation): a "Create skill from this conversation" action and a workflow "Promote to skill…" action, backed by a server-side promotion store, budget gate, and one-shot reflection proposer — PHP backend only (TS port later).

**Architecture:** Client-orchestrated like the heal system: the server owns money/state (promotions table, authorize/record gate on a `kind`-scoped `heal_spend` ledger, reflection proposal generation) while the browser runs the build (writes the skill folder via the local-FS handle, optionally hardens with the existing SkillOpt loop). Proposal generation reuses `ChatController::agent` internally so DB provider settings, per-user keys and quota checks apply for free.

**Tech Stack:** PHP 8.1 + PDO + nikic/fast-route (existing), PHPUnit (existing `backend/tests/Unit`), vanilla JS frontend modules (existing patterns: `heal-panel.js`, `settings-panel.js`), File System Access API via `window.localFs`.

## Global Constraints

- PHP backend is the source of truth; response envelopes are plain arrays with optional `status_code` (default 200) — mirror `HealController` exactly for errors: `['success' => false, 'error' => '...', 'status_code' => 401]`.
- Auth arrives as `$request['user_id']`; every endpoint returns 401 `Authentication required` when falsy (copy the string verbatim).
- No runtime dependency additions. No framework. `declare(strict_types=1);` in every new PHP file.
- DDL follows the house lazy pattern: `CREATE TABLE IF NOT EXISTS` / probe-`SELECT`-then-`ALTER` in the controller, each ALTER individually try/caught (see `SettingsController::ensureHealColumnsExist`).
- Valid provider keys everywhere: `['claude','openai','gemini','grok','deepseek','kimi','glm','gamma4']`.
- Settings live as `users.genesis_*` columns; L0 subset only: `genesis_mode` (`off|suggest|ask|auto`), `genesis_daily_budget_usd` (3.00), `genesis_per_skill_ceiling_usd` (1.50), `genesis_max_skills_per_week` (2), `genesis_reflection_provider` (`kimi`). No L1/L2 columns yet (YAGNI).
- i18n: every new UI string gets keys in `frontend/assets/i18n/en.json`, `fr.json`, `es.json` under `genesis.*`.
- The skills catalog lives in the browser's local FS — the server never reads it. Any endpoint needing it (merge-router input) receives `catalog: [{name, description}]` in the request body.
- Unit tests: `backend/tests/Unit/`, namespace `Quantis\AIPortfolioAssistant\Tests\Unit`, run with `cd backend && vendor/bin/phpunit tests/Unit/<File>.php`.
- Commits: conventional prefix (`feat:`, `test:`), one commit per task minimum. Repo root: `/Applications/XAMPP/xamppfiles/htdocs/gpt`.

---

### Task 1: Genesis gate decision logic (pure) + promotions/ledger DDL

**Files:**
- Create: `backend/src/Controllers/GenesisController.php`
- Test: `backend/tests/Unit/GenesisDecideTest.php`

**Interfaces:**
- Produces: `GenesisController::__construct(PDO $db, array $config = [])`; `GenesisController::decide(string $mode, float $estimate, float $remaining, float $ceiling, int $bornThisWeek, int $weeklyMax, bool $approved): array{allowed:bool,requires_approval:bool,reason:string}`; `GenesisController::ensureTables(): void` (creates `skill_promotions`, adds `kind` to `heal_spend`).
- Consumes: nothing (first task).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/GenesisDecideTest.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\GenesisController;

class GenesisDecideTest extends TestCase
{
    private function gate(): GenesisController
    {
        // decide() is pure — no DB needed. Constructor accepts null PDO for tests.
        return new GenesisController(null);
    }

    public function testOffModeNeverAllows(): void
    {
        $d = $this->gate()->decide('off', 0.10, 3.0, 1.5, 0, 2, true);
        $this->assertFalse($d['allowed']);
        $this->assertSame('mode_off', $d['reason']);
    }

    public function testSuggestModeNeverBuilds(): void
    {
        $d = $this->gate()->decide('suggest', 0.10, 3.0, 1.5, 0, 2, true);
        $this->assertFalse($d['allowed']);
        $this->assertSame('suggest_only', $d['reason']);
    }

    public function testOverBudgetBlocks(): void
    {
        $d = $this->gate()->decide('auto', 2.0, 1.0, 5.0, 0, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertSame('over_budget', $d['reason']);
    }

    public function testWeeklyThrottleBlocks(): void
    {
        $d = $this->gate()->decide('auto', 0.10, 3.0, 1.5, 2, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertSame('weekly_throttle', $d['reason']);
    }

    public function testAskRequiresApproval(): void
    {
        $d = $this->gate()->decide('ask', 0.10, 3.0, 1.5, 0, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertTrue($d['requires_approval']);
        $this->assertSame('ask', $d['reason']);
    }

    public function testAskWithApprovalAllows(): void
    {
        $d = $this->gate()->decide('ask', 0.10, 3.0, 1.5, 0, 2, true);
        $this->assertTrue($d['allowed']);
        $this->assertSame('ask_approved', $d['reason']);
    }

    public function testAutoOverCeilingRequiresApproval(): void
    {
        $d = $this->gate()->decide('auto', 2.0, 3.0, 1.5, 0, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertTrue($d['requires_approval']);
        $this->assertSame('over_ceiling', $d['reason']);
    }

    public function testAutoUnderCeilingAllows(): void
    {
        $d = $this->gate()->decide('auto', 0.50, 3.0, 1.5, 1, 2, false);
        $this->assertTrue($d['allowed']);
        $this->assertFalse($d['requires_approval']);
        $this->assertSame('auto', $d['reason']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend && vendor/bin/phpunit tests/Unit/GenesisDecideTest.php`
Expected: FAIL — `Class "Quantis\AIPortfolioAssistant\Controllers\GenesisController" not found`

- [ ] **Step 3: Write the controller skeleton with decide() + DDL**

Create `backend/src/Controllers/GenesisController.php`:

```php
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend && vendor/bin/phpunit tests/Unit/GenesisDecideTest.php`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/Controllers/GenesisController.php backend/tests/Unit/GenesisDecideTest.php
git commit -m "feat(genesis): gate decision logic + skill_promotions/heal_spend.kind DDL"
```

---

### Task 2: Scope HealController's ledger to kind='heal'

**Files:**
- Modify: `backend/src/Controllers/HealController.php` (the `record()` INSERT and the `spentToday()` SELECT; `ensureSpendTable()` unchanged — GenesisController owns the `kind` ALTER, and both write paths run it via `ensureTables()`/first genesis use; before that ALTER exists these queries must still work)

**Interfaces:**
- Consumes: `GenesisController::ensureTables()` (Task 1) applies the `kind` column.
- Produces: heal spend rows tagged `kind='heal'`; `spentToday()` counts only heal rows once the column exists.

- [ ] **Step 1: Make the two queries kind-aware but backward-tolerant**

In `backend/src/Controllers/HealController.php`, replace the `record()` INSERT block:

```php
        $this->ensureSpendTable();
        try {
            // kind-scoped when the column exists (added by GenesisController);
            // fall back to the legacy shape on installs that pre-date it.
            try {
                $stmt = $this->db->prepare(
                    "INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (:u, CURDATE(), 'heal', :s)
                     ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2"
                );
                $stmt->execute([':u' => $userId, ':s' => $actual, ':s2' => $actual]);
            } catch (\PDOException $eKind) {
                $stmt = $this->db->prepare(
                    "INSERT INTO heal_spend (user_id, day, spent_usd) VALUES (:u, CURDATE(), :s)
                     ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2"
                );
                $stmt->execute([':u' => $userId, ':s' => $actual, ':s2' => $actual]);
            }
        } catch (\Throwable $e) {
```

And in `spentToday()` (locate it below `healConfig()`), replace the SELECT the same way:

```php
        try {
            try {
                $stmt = $this->db->prepare(
                    "SELECT COALESCE(SUM(spent_usd),0) FROM heal_spend
                     WHERE user_id = :u AND day = CURDATE() AND kind = 'heal'"
                );
                $stmt->execute([':u' => $userId]);
            } catch (\PDOException $eKind) {
                $stmt = $this->db->prepare(
                    "SELECT COALESCE(SUM(spent_usd),0) FROM heal_spend
                     WHERE user_id = :u AND day = CURDATE()"
                );
                $stmt->execute([':u' => $userId]);
            }
            return (float) $stmt->fetchColumn();
        } catch (\Throwable $e) {
```

(Adapt to the exact existing body — keep the surrounding error handling as-is. If `spentToday()` currently has a different variable name for the statement, keep it.)

- [ ] **Step 2: Verify heal endpoints still work (manual, real server)**

```bash
# $TOKEN = a valid JWT (log into the app, localStorage 'token')
curl -s http://localhost/gpt/backend/api/v1/heal/status -H "Authorization: Bearer $TOKEN"
```
Expected: `{"success":true,"mode":...,"spent_today_usd":...}` — same shape as before this task.

```bash
curl -s -X POST http://localhost/gpt/backend/api/v1/heal/record -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"actual_usd": 0.001}'
```
Expected: `{"success":true,"spent_today_usd":...}` (increased by 0.001).

- [ ] **Step 3: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/Controllers/HealController.php
git commit -m "feat(genesis): scope heal ledger writes/reads to kind='heal' (kind-column tolerant)"
```

---

### Task 3: Genesis settings (SettingsController block + routes)

**Files:**
- Modify: `backend/src/Controllers/SettingsController.php` (append after the heal-settings section, ~line 1000)
- Modify: `backend/src/routes.php` (beside lines 129–130, the heal settings routes)

**Interfaces:**
- Produces: `GET/POST /api/v1/settings/genesis` returning `{success, settings:{genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd, genesis_max_skills_per_week, genesis_reflection_provider}}`; `users.genesis_*` columns exist after first call.
- Consumes: nothing new.

- [ ] **Step 1: Add the settings block to SettingsController**

Append inside the class, after `saveHealSettings()`:

```php
    // ─── Skill-genesis settings (promotion mode + cost guards) ──────────────
    // Spec: docs/specs/2026-07-14-skill-genesis-design.md §8 (L0 subset).
    // Default mode 'off' = the system only lists proposals a user creates
    // manually; it never spends.

    private function genesisDefaults(): array
    {
        return [
            'genesis_mode'                 => 'off',  // off | suggest | ask | auto
            'genesis_daily_budget_usd'     => 3.00,
            'genesis_per_skill_ceiling_usd'=> 1.50,
            'genesis_max_skills_per_week'  => 2,
            'genesis_reflection_provider'  => 'kimi',
        ];
    }

    private function ensureGenesisColumnsExist(): void
    {
        try {
            $this->db->query("SELECT genesis_mode FROM users LIMIT 1");
        } catch (\PDOException $e) {
            $alters = [
                "ALTER TABLE users ADD COLUMN genesis_mode VARCHAR(8) DEFAULT 'off'",
                "ALTER TABLE users ADD COLUMN genesis_daily_budget_usd DECIMAL(8,2) DEFAULT 3.00",
                "ALTER TABLE users ADD COLUMN genesis_per_skill_ceiling_usd DECIMAL(8,2) DEFAULT 1.50",
                "ALTER TABLE users ADD COLUMN genesis_max_skills_per_week INT DEFAULT 2",
                "ALTER TABLE users ADD COLUMN genesis_reflection_provider VARCHAR(40) DEFAULT 'kimi'",
            ];
            foreach ($alters as $sql) {
                try { $this->db->exec($sql); } catch (\PDOException $e2) { /* already exists */ }
            }
        }
    }

    public function getGenesisSettings(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $defaults = $this->genesisDefaults();
        try {
            $this->ensureGenesisColumnsExist();
            $stmt = $this->db->prepare(
                "SELECT genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd,
                        genesis_max_skills_per_week, genesis_reflection_provider
                 FROM users WHERE id = ?"
            );
            $stmt->execute([$userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
            $s = $defaults;
            foreach ($defaults as $k => $def) {
                if (isset($row[$k]) && $row[$k] !== null) {
                    $s[$k] = is_int($def) ? (int) $row[$k] : (is_float($def) ? (float) $row[$k] : (string) $row[$k]);
                }
            }
            return ['success' => true, 'settings' => $s];
        } catch (\Throwable $e) {
            error_log('[SettingsController] getGenesisSettings failed: ' . $e->getMessage());
            return ['success' => true, 'settings' => $defaults];
        }
    }

    public function saveGenesisSettings(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $b = $request['body'] ?? [];
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'glm', 'gamma4'];
        $mode = in_array($b['genesis_mode'] ?? '', ['off', 'suggest', 'ask', 'auto'], true) ? $b['genesis_mode'] : 'off';
        $prov = in_array($b['genesis_reflection_provider'] ?? '', $validProviders, true) ? $b['genesis_reflection_provider'] : 'kimi';
        $budget  = max(0.0, min(1000.0, (float) ($b['genesis_daily_budget_usd'] ?? 3.0)));
        $ceiling = max(0.0, min(1000.0, (float) ($b['genesis_per_skill_ceiling_usd'] ?? 1.5)));
        $weekly  = max(0, min(50, (int) ($b['genesis_max_skills_per_week'] ?? 2)));
        try {
            $this->ensureGenesisColumnsExist();
            $stmt = $this->db->prepare(
                "UPDATE users SET genesis_mode = ?, genesis_daily_budget_usd = ?,
                        genesis_per_skill_ceiling_usd = ?, genesis_max_skills_per_week = ?,
                        genesis_reflection_provider = ? WHERE id = ?"
            );
            $stmt->execute([$mode, $budget, $ceiling, $weekly, $prov, $userId]);
            return ['success' => true, 'settings' => [
                'genesis_mode' => $mode, 'genesis_daily_budget_usd' => $budget,
                'genesis_per_skill_ceiling_usd' => $ceiling,
                'genesis_max_skills_per_week' => $weekly,
                'genesis_reflection_provider' => $prov,
            ]];
        } catch (\Throwable $e) {
            error_log('[SettingsController] saveGenesisSettings failed: ' . $e->getMessage());
            return ['success' => false, 'error' => 'Save failed', 'status_code' => 500];
        }
    }
```

- [ ] **Step 2: Register the routes**

In `backend/src/routes.php`, directly under the heal settings routes (lines 129–130):

```php
        $r->get('/api/v1/settings/genesis', ['SettingsController', 'getGenesisSettings']);
        $r->post('/api/v1/settings/genesis', ['SettingsController', 'saveGenesisSettings']);
```

- [ ] **Step 3: Verify with curl**

```bash
curl -s http://localhost/gpt/backend/api/v1/settings/genesis -H "Authorization: Bearer $TOKEN"
```
Expected: `{"success":true,"settings":{"genesis_mode":"off","genesis_daily_budget_usd":3, ...}}`

```bash
curl -s -X POST http://localhost/gpt/backend/api/v1/settings/genesis -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"genesis_mode":"ask","genesis_daily_budget_usd":2.5}'
```
Expected: `settings.genesis_mode == "ask"`, budget 2.5; re-GET returns the same.

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/Controllers/SettingsController.php backend/src/routes.php
git commit -m "feat(genesis): per-user genesis settings (mode/budget/ceiling/throttle/provider)"
```

---

### Task 4: Promotion store endpoints — list / authorize / record / dismiss

**Files:**
- Modify: `backend/src/Controllers/GenesisController.php` (add endpoint methods + private helpers)
- Modify: `backend/src/routes.php` (new genesis route block, place after the heal routes)

**Interfaces:**
- Consumes: `decide()` + `ensureTables()` (Task 1), `users.genesis_*` columns (Task 3).
- Produces:
  - `GET  /api/v1/genesis/promotions?status=proposed` → `{success, promotions:[row...]}` (row = table columns; `eval_queries`/`parameter_schema` JSON-decoded)
  - `POST /api/v1/genesis/authorize` body `{promotion_id:int, estimate_usd:float, approved?:bool}` → `{success, allowed, requires_approval, reason, mode, spent_today_usd, budget_usd, remaining_usd, ceiling_usd, born_this_week, weekly_max}`; on `allowed:true` sets promotion `status='approved'`
  - `POST /api/v1/genesis/record` body `{promotion_id:int, actual_usd:float, outcome:'born'|'failed'|'merged', skill_dir?:string}` → `{success, spent_today_usd}`; updates promotion status/`born_skill_dir`/`decided_at`, inserts ledger row `kind='genesis'`
  - `POST /api/v1/genesis/promotions/{id}/dismiss` → `{success}`

- [ ] **Step 1: Add endpoint methods to GenesisController**

Append inside the class (after `decide()`):

```php
    // ─── Endpoints ───────────────────────────────────────────────────────────

    /** GET /api/v1/genesis/promotions?status=proposed */
    public function listPromotions(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $this->ensureTables();
        $status = (string) ($request['query']['status'] ?? '');
        $sql = 'SELECT * FROM skill_promotions WHERE user_id = :u';
        $params = [':u' => $userId];
        if ($status !== '') {
            $sql .= ' AND status = :s';
            $params[':s'] = $status;
        }
        $sql .= ' ORDER BY created_at DESC LIMIT 100';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) {
            $r['eval_queries'] = json_decode((string) $r['eval_queries'], true) ?: [];
            $r['parameter_schema'] = $r['parameter_schema'] !== null
                ? (json_decode((string) $r['parameter_schema'], true) ?: null) : null;
        }
        return ['success' => true, 'promotions' => $rows];
    }

    /** POST /api/v1/genesis/authorize {promotion_id, estimate_usd, approved?} */
    public function authorize(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $this->ensureTables();
        $b = $request['body'] ?? [];
        $promotionId = (int) ($b['promotion_id'] ?? 0);
        $estimate = max(0.0, (float) ($b['estimate_usd'] ?? 0));
        $approved = !empty($b['approved']);

        if (!$this->promotionBelongsToUser($promotionId, $userId)) {
            return ['success' => false, 'error' => 'Promotion not found', 'status_code' => 404];
        }

        $cfg = $this->genesisConfig($userId);
        $spent = $this->spentToday($userId);
        $remaining = max(0.0, $cfg['budget'] - $spent);
        $born = $this->bornThisWeek($userId);

        $decision = $this->decide($cfg['mode'], $estimate, $remaining, $cfg['ceiling'], $born, $cfg['weekly_max'], $approved);

        if ($decision['allowed']) {
            $stmt = $this->db->prepare("UPDATE skill_promotions SET status = 'approved' WHERE id = ? AND user_id = ?");
            $stmt->execute([$promotionId, $userId]);
        }

        return [
            'success' => true,
            'mode' => $cfg['mode'],
            'estimate_usd' => round($estimate, 4),
            'spent_today_usd' => round($spent, 4),
            'budget_usd' => $cfg['budget'],
            'remaining_usd' => round($remaining, 4),
            'ceiling_usd' => $cfg['ceiling'],
            'born_this_week' => $born,
            'weekly_max' => $cfg['weekly_max'],
        ] + $decision;
    }

    /** POST /api/v1/genesis/record {promotion_id, actual_usd, outcome, skill_dir?} */
    public function record(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $this->ensureTables();
        $b = $request['body'] ?? [];
        $promotionId = (int) ($b['promotion_id'] ?? 0);
        $actual = max(0.0, (float) ($b['actual_usd'] ?? 0));
        $outcome = in_array($b['outcome'] ?? '', ['born', 'failed', 'merged'], true) ? $b['outcome'] : 'failed';
        $skillDir = isset($b['skill_dir']) ? (string) $b['skill_dir'] : null;

        if (!$this->promotionBelongsToUser($promotionId, $userId)) {
            return ['success' => false, 'error' => 'Promotion not found', 'status_code' => 404];
        }

        try {
            $stmt = $this->db->prepare(
                "UPDATE skill_promotions
                 SET status = :st, born_skill_dir = :dir, decided_at = NOW()
                 WHERE id = :id AND user_id = :u"
            );
            $stmt->execute([':st' => $outcome, ':dir' => $outcome === 'born' ? $skillDir : null,
                            ':id' => $promotionId, ':u' => $userId]);
            $stmt = $this->db->prepare(
                "INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (:u, CURDATE(), 'genesis', :s)
                 ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2"
            );
            $stmt->execute([':u' => $userId, ':s' => $actual, ':s2' => $actual]);
        } catch (\Throwable $e) {
            error_log('[GenesisController] record failed: ' . $e->getMessage());
            return ['success' => false, 'error' => 'record failed', 'status_code' => 500];
        }
        return ['success' => true, 'spent_today_usd' => round($this->spentToday($userId), 4)];
    }

    /** POST /api/v1/genesis/promotions/{id}/dismiss */
    public function dismiss(array $request, int $id): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $this->ensureTables();
        $stmt = $this->db->prepare(
            "UPDATE skill_promotions SET status = 'dismissed', decided_at = NOW()
             WHERE id = ? AND user_id = ?"
        );
        $stmt->execute([$id, $userId]);
        if ($stmt->rowCount() === 0) {
            return ['success' => false, 'error' => 'Promotion not found', 'status_code' => 404];
        }
        return ['success' => true];
    }

    // ─── internals ───────────────────────────────────────────────────────────

    private function promotionBelongsToUser(int $promotionId, int $userId): bool
    {
        if ($promotionId <= 0) return false;
        $stmt = $this->db->prepare('SELECT 1 FROM skill_promotions WHERE id = ? AND user_id = ?');
        $stmt->execute([$promotionId, $userId]);
        return (bool) $stmt->fetchColumn();
    }

    /** @return array{mode:string,budget:float,ceiling:float,weekly_max:int,provider:string} */
    private function genesisConfig(int $userId): array
    {
        $d = ['mode' => 'off', 'budget' => 3.00, 'ceiling' => 1.50, 'weekly_max' => 2, 'provider' => 'kimi'];
        try {
            $stmt = $this->db->prepare(
                "SELECT genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd,
                        genesis_max_skills_per_week, genesis_reflection_provider
                 FROM users WHERE id = ?"
            );
            $stmt->execute([$userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
            return [
                'mode' => (string) ($row['genesis_mode'] ?? $d['mode']) ?: $d['mode'],
                'budget' => isset($row['genesis_daily_budget_usd']) ? (float) $row['genesis_daily_budget_usd'] : $d['budget'],
                'ceiling' => isset($row['genesis_per_skill_ceiling_usd']) ? (float) $row['genesis_per_skill_ceiling_usd'] : $d['ceiling'],
                'weekly_max' => isset($row['genesis_max_skills_per_week']) ? (int) $row['genesis_max_skills_per_week'] : $d['weekly_max'],
                'provider' => (string) ($row['genesis_reflection_provider'] ?? $d['provider']) ?: $d['provider'],
            ];
        } catch (\Throwable $e) {
            return $d; // columns not created yet → defaults (mode off = safe)
        }
    }

    private function spentToday(int $userId): float
    {
        try {
            $stmt = $this->db->prepare(
                "SELECT COALESCE(SUM(spent_usd),0) FROM heal_spend
                 WHERE user_id = :u AND day = CURDATE() AND kind = 'genesis'"
            );
            $stmt->execute([':u' => $userId]);
            return (float) $stmt->fetchColumn();
        } catch (\Throwable $e) {
            return 0.0;
        }
    }

    private function bornThisWeek(int $userId): int
    {
        try {
            $stmt = $this->db->prepare(
                "SELECT COUNT(*) FROM skill_promotions
                 WHERE user_id = :u AND status = 'born' AND decided_at >= (NOW() - INTERVAL 7 DAY)"
            );
            $stmt->execute([':u' => $userId]);
            return (int) $stmt->fetchColumn();
        } catch (\Throwable $e) {
            return 0;
        }
    }
```

- [ ] **Step 2: Register routes**

In `backend/src/routes.php`, after the heal routes block:

```php
        // Skill genesis (spec: docs/specs/2026-07-14-skill-genesis-design.md §7)
        $r->get('/api/v1/genesis/promotions', ['GenesisController', 'listPromotions']);
        $r->post('/api/v1/genesis/authorize', ['GenesisController', 'authorize']);
        $r->post('/api/v1/genesis/record', ['GenesisController', 'record']);
        $r->post('/api/v1/genesis/promotions/{id:\d+}/dismiss', ['GenesisController', 'dismiss']);
```

Check how other two-arg handlers are dispatched (e.g. `ContextController::get($request, $id)`) — `dismiss(array $request, int $id)` follows the same convention, no dispatcher change needed.

- [ ] **Step 3: Verify with curl (empty store first, then a seeded row)**

```bash
curl -s "http://localhost/gpt/backend/api/v1/genesis/promotions" -H "Authorization: Bearer $TOKEN"
# → {"success":true,"promotions":[]}

# authorize against a nonexistent promotion:
curl -s -X POST http://localhost/gpt/backend/api/v1/genesis/authorize -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"promotion_id": 999999, "estimate_usd": 0.5}'
# → {"success":false,"error":"Promotion not found","status_code":404 as HTTP 404}
```

Seed one row via mysql, then exercise the full gate:

```bash
/Applications/XAMPP/xamppfiles/bin/mysql -u root <DBNAME> -e \
 "INSERT INTO skill_promotions (user_id,class,source_ref,skill_name,description,eval_queries,created_at)
  VALUES (<YOUR_USER_ID>,2,'workflow:1','test-genesis-gate','test','[]',NOW())"

curl -s -X POST http://localhost/gpt/backend/api/v1/genesis/authorize -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"promotion_id": <ID>, "estimate_usd": 0.5}'
# with genesis_mode=off → {"allowed":false,"reason":"mode_off",...}
# after POST /settings/genesis {"genesis_mode":"ask"} → {"allowed":false,"requires_approval":true,"reason":"ask"}
# with {"approved":true} → {"allowed":true,"reason":"ask_approved"} and the row flips to status='approved'

curl -s -X POST http://localhost/gpt/backend/api/v1/genesis/record -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"promotion_id": <ID>, "actual_usd": 0.01, "outcome": "failed"}'
# → {"success":true,"spent_today_usd":0.01}; heal/status spent_today_usd is UNCHANGED (kind separation works)
```

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/Controllers/GenesisController.php backend/src/routes.php
git commit -m "feat(genesis): promotion store + authorize/record/dismiss gate endpoints"
```

---

### Task 5: GenesisProposer — one-shot reflection from a conversation or workflow

**Files:**
- Create: `backend/src/Services/GenesisProposer.php`
- Modify: `backend/src/Controllers/GenesisController.php` (add `createProposal()`)
- Modify: `backend/src/routes.php` (one route)
- Test: `backend/tests/Unit/GenesisProposerTest.php`

**Interfaces:**
- Consumes: `conversation_contexts` rows (`context_data` JSON messages, per `ContextController::get`), `agent_workflows` + `agent_workflow_executions` (`input_variables` JSON), `ChatController::agent(array $request): array` (public; body `{prompt, provider, system?}` → `{success, response|text, ...}`).
- Produces:
  - `GenesisProposer::buildConversationPrompt(array $messages, array $catalog): string` (pure)
  - `GenesisProposer::buildWorkflowPrompt(array $workflow, array $runs, array $catalog): string` (pure)
  - `GenesisProposer::parseProposal(string $llmText): ?array` (pure) → `{skill_name, description, eval_queries[], parameter_schema|null, merge_target|null, rationale}`
  - `POST /api/v1/genesis/proposals` body `{source:'conversation'|'workflow', context_id?:int, workflow_id?:int, catalog?:[{name,description}]}` → `{success, promotion: <row>}`

- [ ] **Step 1: Write the failing tests for the pure functions**

Create `backend/tests/Unit/GenesisProposerTest.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\GenesisProposer;

class GenesisProposerTest extends TestCase
{
    public function testParseProposalExtractsFirstJsonObject(): void
    {
        $text = "Here is my proposal:\n{\"skill_name\":\"Competitor Price Scan!\"," .
            "\"description\":\"WHEN asked to scan competitor prices DO fetch, extract, chart\"," .
            "\"eval_queries\":[{\"query\":\"scan competitor prices\",\"should_trigger\":true}]," .
            "\"merge_target\":null,\"rationale\":\"seen 3 times\"}\nHope this helps.";
        $p = GenesisProposer::parseProposal($text);
        $this->assertNotNull($p);
        // name is sanitized to kebab-case
        $this->assertSame('competitor-price-scan', $p['skill_name']);
        $this->assertCount(1, $p['eval_queries']);
        $this->assertTrue($p['eval_queries'][0]['should_trigger']);
        $this->assertNull($p['merge_target']);
    }

    public function testParseProposalRejectsMissingFields(): void
    {
        $this->assertNull(GenesisProposer::parseProposal('{"description":"no name"}'));
        $this->assertNull(GenesisProposer::parseProposal('not json at all'));
    }

    public function testParseProposalDropsMalformedEvalQueries(): void
    {
        $text = '{"skill_name":"x-y","description":"d","eval_queries":' .
            '[{"query":"good","should_trigger":true},{"bad":"row"},{"query":"neg","should_trigger":false}]}';
        $p = GenesisProposer::parseProposal($text);
        $this->assertCount(2, $p['eval_queries']);
    }

    public function testConversationPromptContainsTranscriptAndCatalog(): void
    {
        $prompt = GenesisProposer::buildConversationPrompt(
            [['role' => 'user', 'content' => 'make me a newsletter about AI'],
             ['role' => 'assistant', 'content' => 'Here is your newsletter…']],
            [['name' => 'composed-newsletter', 'description' => 'WHEN asked for a newsletter…']]
        );
        $this->assertStringContainsString('make me a newsletter about AI', $prompt);
        $this->assertStringContainsString('composed-newsletter', $prompt);
        $this->assertStringContainsString('merge_target', $prompt);
    }

    public function testWorkflowPromptContainsRunDiffMaterial(): void
    {
        $prompt = GenesisProposer::buildWorkflowPrompt(
            ['id' => 7, 'name' => 'Newsletter Pipeline', 'description' => 'crypto+pubmed → publisher'],
            [['input_variables' => ['topic' => 'crypto']], ['input_variables' => ['topic' => 'biomed']]],
            []
        );
        $this->assertStringContainsString('Newsletter Pipeline', $prompt);
        $this->assertStringContainsString('"topic": "crypto"', $prompt);
        $this->assertStringContainsString('parameter_schema', $prompt);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend && vendor/bin/phpunit tests/Unit/GenesisProposerTest.php`
Expected: FAIL — `Class "Quantis\AIPortfolioAssistant\Services\GenesisProposer" not found`

- [ ] **Step 3: Implement GenesisProposer**

Create `backend/src/Services/GenesisProposer.php`:

```php
<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * GenesisProposer — pure prompt-building + response-parsing for the one-shot
 * "propose a skill from this conversation / workflow" reflection (L0 of
 * docs/specs/2026-07-14-skill-genesis-design.md). The LLM call itself is made
 * by the caller (GenesisController via ChatController::agent) so provider
 * settings, user keys and quota checks apply uniformly.
 */
final class GenesisProposer
{
    /** Cap transcript/run material so the reflection stays one cheap call. */
    private const MAX_TRANSCRIPT_CHARS = 12000;
    private const MAX_RUNS = 20;

    private const OUTPUT_CONTRACT = <<<'TXT'
Respond with ONE JSON object only — no markdown fences, no commentary:
{
  "skill_name": "<kebab-case name, max 60 chars>",
  "description": "<WHEN <trigger> DO <steps> — one paragraph, trigger-shaped, generalized (parameters, not literals)>",
  "eval_queries": [{"query": "<realistic user prompt>", "should_trigger": true|false}, ...  6-12 items, mix of positives (paraphrases of the real trigger) and negatives (adjacent but out-of-scope)],
  "parameter_schema": {"<param>": {"type": "string", "examples": ["..."], "default": "..."}} or null,
  "merge_target": "<existing skill name from the catalog that already covers this>" or null,
  "rationale": "<one sentence: why this is a repeatable procedure worth a skill>"
}
If an existing catalog skill already covers this procedure, you MUST set merge_target instead of inventing a near-duplicate name.
If the material contains no repeatable multi-step procedure, return {"skill_name": null}.
TXT;

    /** @param array<array{role:string,content:mixed}> $messages */
    public static function buildConversationPrompt(array $messages, array $catalog): string
    {
        $lines = [];
        foreach ($messages as $m) {
            $role = strtoupper((string) ($m['role'] ?? 'user'));
            $content = is_string($m['content'] ?? null) ? $m['content'] : json_encode($m['content'] ?? '');
            if (trim((string) $content) === '') continue;
            $lines[] = "$role: $content";
        }
        $transcript = self::truncate(implode("\n\n", $lines), self::MAX_TRANSCRIPT_CHARS);

        return "You analyse ONE conversation between a user and an AI assistant and decide whether it "
            . "contains a repeatable multi-step PROCEDURE the user is likely to want again — and if so, "
            . "propose a skill that encapsulates it.\n\n"
            . "EXISTING SKILL CATALOG (name — description):\n" . self::catalogBlock($catalog) . "\n\n"
            . "CONVERSATION TRANSCRIPT:\n---\n" . $transcript . "\n---\n\n"
            . self::OUTPUT_CONTRACT;
    }

    /**
     * @param array{id:int|string,name:string,description?:?string} $workflow
     * @param array<array{input_variables:mixed}> $runs
     */
    public static function buildWorkflowPrompt(array $workflow, array $runs, array $catalog): string
    {
        $runLines = [];
        foreach (array_slice($runs, 0, self::MAX_RUNS) as $i => $r) {
            $iv = $r['input_variables'] ?? [];
            if (is_string($iv)) $iv = json_decode($iv, true) ?: [];
            $runLines[] = 'run ' . ($i + 1) . ' inputs: '
                . json_encode($iv, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        }

        return "You analyse the run history of ONE user-built workflow and propose a skill that wraps it, "
            . "PARAMETERIZED so a chat prompt can trigger it with different inputs.\n"
            . "Diff the runs: whatever VARIED across inputs becomes a parameter (observed values are the "
            . "examples); whatever stayed CONSTANT stays baked in. If the runs are uniform, propose "
            . "parameters by inspecting what in the workflow's purpose is most likely to vary, and mark "
            . "them as inspection-based in the rationale.\n\n"
            . "WORKFLOW: #{$workflow['id']} \"{$workflow['name']}\""
            . (isset($workflow['description']) && $workflow['description'] !== null && $workflow['description'] !== ''
                ? " — {$workflow['description']}" : '') . "\n\n"
            . "RUN HISTORY:\n" . self::truncate(implode("\n", $runLines), self::MAX_TRANSCRIPT_CHARS) . "\n\n"
            . "EXISTING SKILL CATALOG (name — description):\n" . self::catalogBlock($catalog) . "\n\n"
            . self::OUTPUT_CONTRACT;
    }

    /** Parse + validate the LLM's proposal. Null = no usable proposal. */
    public static function parseProposal(string $llmText): ?array
    {
        if (!preg_match('/\{.*\}/s', $llmText, $m)) {
            return null;
        }
        $data = json_decode($m[0], true);
        if (!is_array($data)) return null;
        if (!isset($data['skill_name']) || !is_string($data['skill_name']) || $data['skill_name'] === '') {
            return null; // includes the explicit {"skill_name": null} no-procedure answer
        }
        if (!isset($data['description']) || !is_string($data['description']) || trim($data['description']) === '') {
            return null;
        }

        $name = strtolower(trim($data['skill_name']));
        $name = preg_replace('/[^a-z0-9]+/', '-', $name);
        $name = trim(preg_replace('/-+/', '-', $name), '-');
        $name = substr($name, 0, 60);
        if ($name === '') return null;

        $evals = [];
        foreach ((array) ($data['eval_queries'] ?? []) as $q) {
            if (is_array($q) && isset($q['query'], $q['should_trigger']) && is_string($q['query'])) {
                $evals[] = ['query' => $q['query'], 'should_trigger' => (bool) $q['should_trigger']];
            }
        }

        return [
            'skill_name' => $name,
            'description' => trim($data['description']),
            'eval_queries' => $evals,
            'parameter_schema' => is_array($data['parameter_schema'] ?? null) ? $data['parameter_schema'] : null,
            'merge_target' => (isset($data['merge_target']) && is_string($data['merge_target']) && $data['merge_target'] !== '')
                ? $data['merge_target'] : null,
            'rationale' => is_string($data['rationale'] ?? null) ? $data['rationale'] : '',
        ];
    }

    private static function catalogBlock(array $catalog): string
    {
        if (empty($catalog)) return '(catalog empty)';
        $lines = [];
        foreach ($catalog as $s) {
            if (!is_array($s) || empty($s['name'])) continue;
            $lines[] = '- ' . $s['name'] . ' — ' . (string) ($s['description'] ?? '');
        }
        return $lines ? implode("\n", $lines) : '(catalog empty)';
    }

    private static function truncate(string $text, int $max): string
    {
        if (mb_strlen($text) <= $max) return $text;
        return mb_substr($text, 0, $max) . "\n[…truncated…]";
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend && vendor/bin/phpunit tests/Unit/GenesisProposerTest.php`
Expected: PASS (5 tests)

- [ ] **Step 5: Add createProposal() to GenesisController + route**

Add `use Quantis\AIPortfolioAssistant\Services\GenesisProposer;` and append to `GenesisController`:

```php
    /**
     * POST /api/v1/genesis/proposals
     * {source:'conversation'|'workflow', context_id?|workflow_id?, catalog?:[{name,description}]}
     * Runs ONE reflection LLM call (via ChatController::agent so provider
     * settings/keys/quota apply) and stores the proposal as a promotion row.
     */
    public function createProposal(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $this->ensureTables();
        $b = $request['body'] ?? [];
        $source = (string) ($b['source'] ?? '');
        $catalog = is_array($b['catalog'] ?? null) ? $b['catalog'] : [];

        if ($source === 'conversation') {
            $contextId = (int) ($b['context_id'] ?? 0);
            $stmt = $this->db->prepare(
                'SELECT context_data FROM conversation_contexts WHERE id = ? AND user_id = ?'
            );
            $stmt->execute([$contextId, $userId]);
            $ctx = $stmt->fetchColumn();
            if ($ctx === false) {
                return ['success' => false, 'error' => 'Context not found', 'status_code' => 404];
            }
            $data = json_decode((string) $ctx, true) ?: [];
            $messages = is_array($data['messages'] ?? null) ? $data['messages'] : (is_array($data) ? $data : []);
            if (empty($messages)) {
                return ['success' => false, 'error' => 'Context has no messages', 'status_code' => 400];
            }
            $prompt = GenesisProposer::buildConversationPrompt($messages, $catalog);
            $class = 1;
            $sourceRef = 'context:' . $contextId;
        } elseif ($source === 'workflow') {
            $workflowId = (int) ($b['workflow_id'] ?? 0);
            $stmt = $this->db->prepare('SELECT id, name, description FROM agent_workflows WHERE id = ? AND user_id = ?');
            $stmt->execute([$workflowId, $userId]);
            $wf = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$wf) {
                return ['success' => false, 'error' => 'Workflow not found', 'status_code' => 404];
            }
            $stmt = $this->db->prepare(
                'SELECT input_variables FROM agent_workflow_executions
                 WHERE workflow_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 20'
            );
            $stmt->execute([$workflowId, $userId]);
            $runs = $stmt->fetchAll(PDO::FETCH_ASSOC);
            $prompt = GenesisProposer::buildWorkflowPrompt($wf, $runs, $catalog);
            $class = 2;
            $sourceRef = 'workflow:' . $workflowId;
        } else {
            return ['success' => false, 'error' => "source must be 'conversation' or 'workflow'", 'status_code' => 400];
        }

        // One-shot LLM call through the agent endpoint's machinery.
        $cfg = $this->genesisConfig($userId);
        $chat = new ChatController($this->db, $this->config);
        $resp = $chat->agent([
            'user_id' => $userId,
            'body' => ['prompt' => $prompt, 'provider' => $cfg['provider'], 'user_id' => $userId],
        ]);
        if (empty($resp['success'])) {
            return ['success' => false,
                'error' => 'Reflection call failed: ' . (string) ($resp['error'] ?? 'unknown'),
                'status_code' => 502];
        }
        $text = (string) ($resp['response'] ?? $resp['text'] ?? '');
        $proposal = GenesisProposer::parseProposal($text);
        if ($proposal === null) {
            return ['success' => true, 'promotion' => null,
                'message' => 'No repeatable procedure found in this material.'];
        }

        try {
            $stmt = $this->db->prepare(
                "INSERT INTO skill_promotions
                    (user_id, class, status, source_ref, skill_name, description, eval_queries,
                     parameter_schema, merge_target, created_at)
                 VALUES (:u, :c, 'proposed', :ref, :name, :descr, :evals, :params, :merge, NOW())
                 ON DUPLICATE KEY UPDATE description = VALUES(description),
                     eval_queries = VALUES(eval_queries), parameter_schema = VALUES(parameter_schema),
                     merge_target = VALUES(merge_target), status = 'proposed', decided_at = NULL"
            );
            $stmt->execute([
                ':u' => $userId, ':c' => $class, ':ref' => $sourceRef,
                ':name' => $proposal['skill_name'], ':descr' => $proposal['description'],
                ':evals' => json_encode($proposal['eval_queries']),
                ':params' => $proposal['parameter_schema'] !== null ? json_encode($proposal['parameter_schema']) : null,
                ':merge' => $proposal['merge_target'],
            ]);
            $id = (int) $this->db->lastInsertId();
        } catch (\Throwable $e) {
            error_log('[GenesisController] proposal insert failed: ' . $e->getMessage());
            return ['success' => false, 'error' => 'Could not store proposal', 'status_code' => 500];
        }

        return ['success' => true, 'promotion' => [
            'id' => $id, 'class' => $class, 'status' => 'proposed', 'source_ref' => $sourceRef,
            'skill_name' => $proposal['skill_name'], 'description' => $proposal['description'],
            'eval_queries' => $proposal['eval_queries'],
            'parameter_schema' => $proposal['parameter_schema'],
            'merge_target' => $proposal['merge_target'], 'rationale' => $proposal['rationale'],
        ]];
    }
```

Note: verify `agent_workflows` is the actual workflow table name — check with `grep -n "FROM agent_workflows" backend/src/AgentTeam` and adapt if the ownership column differs (some tables use `user_id`, verify before running).

Route, in the genesis block of `backend/src/routes.php`:

```php
        $r->post('/api/v1/genesis/proposals', ['GenesisController', 'createProposal']);
```

Also add the `use` import if controllers are autoloaded by FQCN in routes dispatch (check how `HealController` is resolved — follow the same string convention; no import needed in routes.php).

- [ ] **Step 6: Verify with curl (real conversation context)**

```bash
# find one of your context ids:
curl -s "http://localhost/gpt/backend/api/v1/contexts" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; [print(c['id'], c['title'][:40]) for c in json.load(sys.stdin)['data'][:5]]"

curl -s -X POST http://localhost/gpt/backend/api/v1/genesis/proposals -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source":"conversation","context_id":<ID>,"catalog":[{"name":"workflow-compile","description":"builds workflow DSL"}]}'
```
Expected: `{"success":true,"promotion":{"skill_name":"...","eval_queries":[...]}}` (or `promotion:null` with the no-procedure message for a trivial conversation). Then `GET /genesis/promotions` shows the row.

- [ ] **Step 7: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/Services/GenesisProposer.php backend/src/Controllers/GenesisController.php \
        backend/src/routes.php backend/tests/Unit/GenesisProposerTest.php
git commit -m "feat(genesis): one-shot reflection proposer from conversation or workflow run history"
```

---

### Task 6: Settings UI — Auto tab "Skill promotion" block + i18n

**Files:**
- Modify: `frontend/assets/js/settings-panel.js` (locate the heal settings section — search `heal_mode` — and append a sibling block)
- Modify: `frontend/assets/i18n/en.json`, `fr.json`, `es.json`

**Interfaces:**
- Consumes: `GET/POST /api/v1/settings/genesis` (Task 3).
- Produces: `window` settings UI persisting genesis settings; other tasks read nothing from this — independent.

- [ ] **Step 1: Add the genesis block to the Auto tab**

In `settings-panel.js`, find where the heal settings are rendered/loaded/saved (search `settings/heal`). Add, following the exact same render + load + save pattern the heal block uses (same CSS classes, same save handler wiring):

```javascript
// ── Skill promotion (genesis) — sibling of the heal block ──────────────────
// Renders: mode radio (off/suggest/ask/auto), budget, ceiling, weekly max,
// reflection provider select. Persisted via /settings/genesis.

function renderGenesisSection() {
    return `
    <div class="border-t border-gray-200 pt-4 mt-4">
        <h4 class="font-semibold text-sm mb-1">🧬 <span data-i18n="genesis.title">Skill promotion</span></h4>
        <p class="text-xs text-gray-500 mb-3" data-i18n="genesis.subtitle">Turn repeated conversations and workflows into skills. Suggest lists candidates only; Ask requires your approval before building; Auto builds within budget.</p>
        <div class="flex gap-3 mb-3" id="genesis-mode-group">
            ${['off','suggest','ask','auto'].map(m => `
            <label class="flex items-center gap-1 text-xs">
                <input type="radio" name="genesis_mode" value="${m}">
                <span data-i18n="genesis.mode.${m}">${m}</span>
            </label>`).join('')}
        </div>
        <div class="grid grid-cols-2 gap-3 text-xs">
            <label><span data-i18n="genesis.dailyBudget">Daily budget (USD)</span>
                <input type="number" step="0.5" min="0" id="genesis-budget" class="w-full border rounded px-2 py-1"></label>
            <label><span data-i18n="genesis.ceiling">Per-skill ceiling (USD)</span>
                <input type="number" step="0.25" min="0" id="genesis-ceiling" class="w-full border rounded px-2 py-1"></label>
            <label><span data-i18n="genesis.weeklyMax">Max new skills / week</span>
                <input type="number" step="1" min="0" id="genesis-weekly" class="w-full border rounded px-2 py-1"></label>
            <label><span data-i18n="genesis.provider">Reflection model</span>
                <select id="genesis-provider" class="w-full border rounded px-2 py-1">
                    ${['claude','openai','gemini','grok','deepseek','kimi','glm','gamma4']
                        .map(p => `<option value="${p}">${p}</option>`).join('')}
                </select></label>
        </div>
        <button id="genesis-save" class="mt-3 px-3 py-1.5 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
            data-i18n="genesis.save">Save promotion settings</button>
        <span id="genesis-save-status" class="text-xs text-gray-500 ml-2"></span>
    </div>`;
}

async function loadGenesisSettings() {
    const r = await fetch(window.apiUrl('/settings/genesis'), { headers: authHeaders() });
    const d = await r.json();
    if (!d.success) return;
    const s = d.settings;
    document.querySelector(`#genesis-mode-group input[value="${s.genesis_mode}"]`).checked = true;
    document.getElementById('genesis-budget').value = s.genesis_daily_budget_usd;
    document.getElementById('genesis-ceiling').value = s.genesis_per_skill_ceiling_usd;
    document.getElementById('genesis-weekly').value = s.genesis_max_skills_per_week;
    document.getElementById('genesis-provider').value = s.genesis_reflection_provider;
}

async function saveGenesisSettings() {
    const body = {
        genesis_mode: document.querySelector('#genesis-mode-group input:checked')?.value || 'off',
        genesis_daily_budget_usd: parseFloat(document.getElementById('genesis-budget').value) || 3,
        genesis_per_skill_ceiling_usd: parseFloat(document.getElementById('genesis-ceiling').value) || 1.5,
        genesis_max_skills_per_week: parseInt(document.getElementById('genesis-weekly').value, 10) || 2,
        genesis_reflection_provider: document.getElementById('genesis-provider').value,
    };
    const r = await fetch(window.apiUrl('/settings/genesis'), {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const d = await r.json();
    const st = document.getElementById('genesis-save-status');
    st.textContent = d.success ? '✓ saved' : '✗ save failed';
    setTimeout(() => { st.textContent = ''; }, 2500);
}
```

Wire `renderGenesisSection()` into the Auto tab's HTML right after the heal section render, call `loadGenesisSettings()` where `loadHealSettings` (or equivalent) is called, and bind `document.getElementById('genesis-save').addEventListener('click', saveGenesisSettings)` where the heal save button is bound. **Adapt helper names (`authHeaders`, apiUrl usage) to what the file actually uses — copy the heal block's exact idioms.**

- [ ] **Step 2: Add i18n keys**

In `frontend/assets/i18n/en.json` (and translated equivalents in `fr.json`, `es.json`), add under a new `genesis` object:

```json
"genesis": {
  "title": "Skill promotion",
  "subtitle": "Turn repeated conversations and workflows into skills. Suggest lists candidates only; Ask requires your approval before building; Auto builds within budget.",
  "mode": { "off": "Off", "suggest": "Suggest", "ask": "Ask", "auto": "Auto" },
  "dailyBudget": "Daily budget (USD)",
  "ceiling": "Per-skill ceiling (USD)",
  "weeklyMax": "Max new skills / week",
  "provider": "Reflection model",
  "save": "Save promotion settings",
  "createFromConversation": "Create skill from this conversation",
  "promoteWorkflow": "Promote to skill…",
  "proposalTitle": "Skill proposal",
  "noProcedure": "No repeatable procedure found in this conversation.",
  "approveBuild": "Create skill",
  "dismiss": "Dismiss",
  "mergeHint": "Overlaps existing skill:",
  "built": "Skill created",
  "buildFailed": "Skill creation failed"
}
```

French (`fr.json`): "Promotion en compétences", "Budget quotidien (USD)", "Plafond par compétence (USD)", "Nouvelles compétences max / semaine", "Modèle de réflexion", "Enregistrer", "Créer une compétence depuis cette conversation", "Promouvoir en compétence…", "Proposition de compétence", "Aucune procédure répétable trouvée dans cette conversation.", "Créer la compétence", "Ignorer", "Chevauche une compétence existante :", "Compétence créée", "Échec de la création". Spanish (`es.json`): "Promoción a habilidades", "Presupuesto diario (USD)", "Límite por habilidad (USD)", "Máx. habilidades nuevas / semana", "Modelo de reflexión", "Guardar", "Crear una habilidad desde esta conversación", "Promover a habilidad…", "Propuesta de habilidad", "No se encontró un procedimiento repetible en esta conversación.", "Crear habilidad", "Descartar", "Se superpone con una habilidad existente:", "Habilidad creada", "Error al crear la habilidad". Mode labels: fr `off/suggérer/demander/auto`, es `off/sugerir/preguntar/auto`.

- [ ] **Step 3: Verify in the browser**

Hard-refresh (Cmd+Shift+R) → Settings → Auto tab: the "Skill promotion" block renders under the heal block, loads current values, saving flips values (verify with `curl GET /settings/genesis`), and the three languages show translated labels.

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/settings-panel.js frontend/assets/i18n/en.json frontend/assets/i18n/fr.json frontend/assets/i18n/es.json
git commit -m "feat(genesis): Auto-tab skill-promotion settings block + i18n"
```

---

### Task 7: genesis-panel.js — proposal overlay, build, record

**Files:**
- Create: `frontend/assets/js/genesis-panel.js`
- Modify: `frontend/index.html` (one `<script>` tag beside `heal-panel.js`'s)

**Interfaces:**
- Consumes: `POST /genesis/authorize`, `POST /genesis/record`, `POST /genesis/promotions/{id}/dismiss` (Task 4); `window.localFs.resolvePath(path, {create})` (returns FSA directory handle); `window.skillsManager.refresh?.()` if present; i18n keys (Task 6).
- Produces: `window.genesisSystem = { showProposal(promotion), buildOne(promotion), dismiss(id) }` — used by Tasks 8 and 9.

- [ ] **Step 1: Write genesis-panel.js**

Create `frontend/assets/js/genesis-panel.js` (mirror `heal-panel.js`'s IIFE + injected-styles structure):

```javascript
/**
 * Skill-genesis orchestrator — L0 (manual on-ramps).
 * Spec: gpt/docs/specs/2026-07-14-skill-genesis-design.md §6.
 *
 * window.genesisSystem.showProposal(promotion):
 *   renders the approval overlay (name, description, eval count, merge hint,
 *   parameter table when present) → on approve: POST /genesis/authorize →
 *   buildOne() → POST /genesis/record.
 *
 * The BUILD is local: write skills/<name>/SKILL.md via window.localFs (the
 *   catalog lives in the user's local FS — the server never touches it).
 * The server gate (GenesisController) is authoritative for spend.
 */
(function () {
    'use strict';

    const t = (k, d) => (window.i18n && window.i18n.t && window.i18n.t(k)) || d;
    const tok = () => (localStorage.getItem('token') || (window.authManager && window.authManager.token) || '');
    const hdrs = () => ({ 'Authorization': `Bearer ${tok()}`, 'Content-Type': 'application/json' });
    // Flat estimate for an L0 build (write + optional short harden pass).
    const BUILD_ESTIMATE_USD = 0.25;

    (function injectStyles() {
        if (document.getElementById('genesis-panel-styles')) return;
        const st = document.createElement('style');
        st.id = 'genesis-panel-styles';
        st.textContent = `
        .gen-ov-backdrop{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
        .gen-ov{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(520px,94vw);max-height:86vh;overflow:auto;padding:20px}
        .gen-ov h3{font-size:16px;font-weight:700;color:#1e293b;margin:0 0 6px}
        .gen-ov-name{font-family:ui-monospace,monospace;font-size:13px;color:#4f46e5;margin:0 0 8px}
        .gen-ov-desc{font-size:13px;color:#475569;margin:0 0 12px;white-space:pre-wrap}
        .gen-ov-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#64748b;margin:0 0 12px}
        .gen-ov-merge{font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px;margin:0 0 12px}
        .gen-ov table{width:100%;border-collapse:collapse;font-size:12px;margin:0 0 12px}
        .gen-ov th,.gen-ov td{border:1px solid #e2e8f0;padding:4px 8px;text-align:left}
        .gen-ov-actions{display:flex;justify-content:flex-end;gap:8px}
        .gen-ov-actions button{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none}
        .gen-btn-dismiss{background:#fff;border:1px solid #cbd5e1!important;color:#475569}
        .gen-btn-approve{background:#4f46e5;color:#fff}
        .gen-btn-approve[disabled]{opacity:.6;cursor:default}`;
        document.head.appendChild(st);
    })();

    function toast(msg, kind) {
        // reuse heal-panel's toast if present, else alert-free console fallback
        if (window.healSystem && typeof window.healSystem.toast === 'function') {
            window.healSystem.toast(msg, kind);
        } else {
            console.log(`[genesis] ${kind || 'info'}: ${msg}`);
        }
    }

    /** Compose SKILL.md content from a promotion row. */
    function skillMd(p) {
        const params = p.parameter_schema
            ? '\n## Parameters\n' + Object.entries(p.parameter_schema).map(([k, v]) =>
                `- **${k}** (${(v && v.type) || 'string'})${v && v.default !== undefined ? ` — default: ${JSON.stringify(v.default)}` : ''}${v && v.examples ? ` — examples: ${JSON.stringify(v.examples)}` : ''}`
              ).join('\n') + '\n'
            : '';
        return `---\nname: ${p.skill_name}\ndescription: ${String(p.description).replace(/\n/g, ' ')}\n---\n\n# ${p.skill_name}\n\n${p.description}\n${params}\n## Provenance\n\nCreated by skill genesis (L0) from ${p.source_ref || 'user material'} on ${new Date().toISOString().slice(0, 10)}.\n\n## Eval queries\n\n\`\`\`json\n${JSON.stringify(p.eval_queries || [], null, 2)}\n\`\`\`\n`;
    }

    /** Write skills/<name>/SKILL.md through the local-FS handle. */
    async function writeSkillFolder(p) {
        if (!window.localFs || !(await window.localFs.getStatus()).connected) {
            throw new Error('Local skills folder is not connected (Skills panel → connect folder).');
        }
        const dir = await window.localFs.resolvePath(`skills/${p.skill_name}`, { create: true });
        const fh = await dir.getFileHandle('SKILL.md', { create: true });
        const w = await fh.createWritable();
        await w.write(skillMd(p));
        await w.close();
        return p.skill_name;
    }

    async function buildOne(p) {
        // 1. authorize (server gate is authoritative)
        let r = await fetch(window.apiUrl('/genesis/authorize'), {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ promotion_id: p.id, estimate_usd: BUILD_ESTIMATE_USD, approved: true }),
        });
        let d = await r.json();
        if (!d.success || !d.allowed) {
            toast(`${t('genesis.buildFailed', 'Skill creation failed')}: ${d.reason || d.error || 'not allowed'}`, 'error');
            return false;
        }
        // 2. build locally
        let outcome = 'failed'; let skillDir = null;
        try {
            skillDir = await writeSkillFolder(p);
            outcome = 'born';
        } catch (e) {
            console.error('[genesis] build failed:', e);
            toast(`${t('genesis.buildFailed', 'Skill creation failed')}: ${e.message}`, 'error');
        }
        // 3. record (spend ~0 for the local write; the reflection was already paid)
        await fetch(window.apiUrl('/genesis/record'), {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ promotion_id: p.id, actual_usd: 0, outcome, skill_dir: skillDir }),
        }).catch(() => {});
        if (outcome === 'born') {
            toast(`${t('genesis.built', 'Skill created')}: ${skillDir}`, 'ok');
            if (window.skillsManager && typeof window.skillsManager.loadSkills === 'function') {
                window.skillsManager.loadSkills().catch(() => {});
            }
        }
        return outcome === 'born';
    }

    async function dismiss(id) {
        await fetch(window.apiUrl(`/genesis/promotions/${id}/dismiss`), { method: 'POST', headers: hdrs() })
            .catch(() => {});
    }

    function showProposal(p) {
        if (!p) { toast(t('genesis.noProcedure', 'No repeatable procedure found in this conversation.'), 'info'); return; }
        const paramRows = p.parameter_schema
            ? Object.entries(p.parameter_schema).map(([k, v]) =>
                `<tr><td>${k}</td><td>${(v && v.type) || 'string'}</td><td>${v && v.examples ? v.examples.join(', ') : ''}</td></tr>`).join('')
            : '';
        const back = document.createElement('div');
        back.className = 'gen-ov-backdrop';
        back.innerHTML = `
        <div class="gen-ov">
            <h3>${t('genesis.proposalTitle', 'Skill proposal')}</h3>
            <p class="gen-ov-name">${p.skill_name}</p>
            <p class="gen-ov-desc">${p.description}</p>
            <div class="gen-ov-meta">
                <span>${(p.eval_queries || []).length} eval queries</span>
                ${p.rationale ? `<span>${p.rationale}</span>` : ''}
            </div>
            ${p.merge_target ? `<div class="gen-ov-merge">${t('genesis.mergeHint', 'Overlaps existing skill:')} <b>${p.merge_target}</b></div>` : ''}
            ${paramRows ? `<table><thead><tr><th>Parameter</th><th>Type</th><th>Examples</th></tr></thead><tbody>${paramRows}</tbody></table>` : ''}
            <div class="gen-ov-actions">
                <button class="gen-btn-dismiss">${t('genesis.dismiss', 'Dismiss')}</button>
                <button class="gen-btn-approve">${t('genesis.approveBuild', 'Create skill')}</button>
            </div>
        </div>`;
        back.querySelector('.gen-btn-dismiss').addEventListener('click', async () => {
            await dismiss(p.id); back.remove();
        });
        back.querySelector('.gen-btn-approve').addEventListener('click', async (e) => {
            e.target.disabled = true;
            const ok = await buildOne(p);
            if (ok) back.remove(); else e.target.disabled = false;
        });
        back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
        document.body.appendChild(back);
    }

    window.genesisSystem = { showProposal, buildOne, dismiss };
})();
```

- [ ] **Step 2: Load the module**

In `frontend/index.html`, add next to the existing `heal-panel.js` script tag (search for it):

```html
    <script src="assets/js/genesis-panel.js"></script>
```

- [ ] **Step 3: Verify in the browser console**

Hard refresh, then in DevTools:

```javascript
window.genesisSystem.showProposal({ id: 0, skill_name: 'test-overlay', description: 'WHEN testing DO render', eval_queries: [{query:'x',should_trigger:true}], parameter_schema: {topic:{type:'string',examples:['crypto']}}, merge_target: null, rationale: 'manual test' });
```
Expected: overlay renders with the parameter table; Dismiss closes it. (Approve will 404 on promotion_id 0 — expected.)

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/genesis-panel.js frontend/index.html
git commit -m "feat(genesis): proposal overlay + local skill build + record (genesis-panel.js)"
```

---

### Task 8: Chat on-ramp — "Create skill from this conversation"

**Files:**
- Modify: `frontend/index.html` (conversation context menu, ~line 4008)
- Modify: `frontend/assets/js/chat.js` (`handleConversationMenuAction`, ~line 9740)

**Interfaces:**
- Consumes: `POST /genesis/proposals` (Task 5), `window.genesisSystem.showProposal` (Task 7), `window.skillsManager.skills` (existing — array with `{name|dirName, description}` entries; verify exact fields by inspecting `skillsManager` in DevTools and adapt the catalog mapper).
- Produces: nothing consumed later — leaf task.

- [ ] **Step 1: Add the menu item**

In `frontend/index.html`, inside `#conversation-context-menu` before the delete button:

```html
        <button class="conversation-menu-item w-full text-left px-4 py-2 text-xs hover:bg-gray-100 transition" data-action="skillify">
            🧬 <span data-i18n="genesis.createFromConversation">Create skill from this conversation</span>
        </button>
```

- [ ] **Step 2: Handle the action in chat.js**

In `handleConversationMenuAction(action)` add a case beside `rename`/`delete` (the menu id `this.currentConversationMenuId` is the conversation/context id — confirm by reading the `rename` case and use the same id source):

```javascript
            case 'skillify':
                this.createSkillFromConversation(contextId);
                break;
```

And add the method to the class:

```javascript
    /**
     * L0 genesis on-ramp: one reflection call over this conversation's stored
     * context → proposal overlay (genesis-panel.js). The skills catalog is
     * client-side, so we pass name+description pairs for the merge-router.
     */
    async createSkillFromConversation(contextId) {
        try {
            const catalog = (window.skillsManager && Array.isArray(window.skillsManager.skills))
                ? window.skillsManager.skills.map(s => ({
                    name: s.dirName || s.name || '',
                    description: (s.description || '').slice(0, 200),
                  })).filter(s => s.name)
                : [];
            this.showNotification && this.showNotification('Analyzing conversation…', 'info');
            const resp = await fetch(window.apiUrl('/genesis/proposals'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: 'conversation', context_id: Number(contextId), catalog }),
            });
            const data = await resp.json();
            if (!data.success) {
                this.showNotification && this.showNotification(`Proposal failed: ${data.error || 'unknown'}`, 'error');
                return;
            }
            window.genesisSystem.showProposal(data.promotion); // null → "no procedure" toast
        } catch (e) {
            console.error('[genesis] createSkillFromConversation failed:', e);
            this.showNotification && this.showNotification('Proposal failed', 'error');
        }
    }
```

**Adapt:** confirm the id in `this.currentConversationMenuId` is the server context id (read the `delete` case — if it calls `/contexts/{id}`, it is). If conversations are keyed differently, map to the context id the same way `delete` does.

- [ ] **Step 3: Verify end-to-end in the browser**

Right-click (or ⋮) a conversation with a real multi-step exchange → "Create skill from this conversation" → after a few seconds the proposal overlay shows a kebab-case name + description + eval count. Approve with `genesis_mode=ask` → skill folder appears under your local `skills/` directory and the Skills panel lists it after refresh. `GET /genesis/promotions` shows `status='born'` with `born_skill_dir`.

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/index.html frontend/assets/js/chat.js
git commit -m "feat(genesis): conversation context-menu on-ramp (create skill from conversation)"
```

---

### Task 9: Workflow editor on-ramp — "Promote to skill…"

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` (run panel / toolbar — find where the run history or ▶ Run controls render; add the button beside them)

**Interfaces:**
- Consumes: `POST /genesis/proposals` with `{source:'workflow', workflow_id, catalog}` (Task 5), `window.genesisSystem.showProposal` (Task 7), `this.currentWorkflowId` (existing editor state — verified used at e.g. `workflow-editor.js:6510`).
- Produces: leaf task.

- [ ] **Step 1: Add the button and handler**

In `workflow-editor.js`, locate the toolbar render for a loaded workflow (search `currentWorkflowId` usages near run controls). Add a button with class conventions copied from adjacent buttons:

```javascript
// In the toolbar template, next to the run/history buttons:
`<button id="wf-promote-skill" class="..."  title="${(window.i18n && window.i18n.t('genesis.promoteWorkflow')) || 'Promote to skill…'}">🧬 ${(window.i18n && window.i18n.t('genesis.promoteWorkflow')) || 'Promote to skill…'}</button>`
```

And the handler (bind where sibling toolbar buttons are bound):

```javascript
        document.getElementById('wf-promote-skill')?.addEventListener('click', async () => {
            if (!this.currentWorkflowId) return;
            const catalog = (window.skillsManager && Array.isArray(window.skillsManager.skills))
                ? window.skillsManager.skills.map(s => ({
                    name: s.dirName || s.name || '',
                    description: (s.description || '').slice(0, 200),
                  })).filter(s => s.name)
                : [];
            try {
                const resp = await fetch(`${this.apiBase}/genesis/proposals`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source: 'workflow', workflow_id: this.currentWorkflowId, catalog }),
                });
                const data = await resp.json();
                if (!data.success) { alert(`Proposal failed: ${data.error || 'unknown'}`); return; }
                window.genesisSystem.showProposal(data.promotion);
            } catch (e) {
                console.error('[genesis] promote workflow failed:', e);
            }
        });
```

(`this.apiBase` is the editor's existing API base — verified used at `workflow-editor.js:6510`; follow its auth-header idiom if it has a helper.)

- [ ] **Step 2: Verify end-to-end**

Open a workflow that has been run several times (e.g. the newsletter pipeline) → "🧬 Promote to skill…" → overlay shows a proposal whose parameter table reflects what varied across the run inputs. Approve → wrapper `SKILL.md` written under `skills/<name>/` (the run.py dispatcher is L1 scope — the L0 SKILL.md documents the workflow reference in the Provenance section via `source_ref: workflow:<id>`).

- [ ] **Step 3: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/workflow-editor.js
git commit -m "feat(genesis): workflow-editor promote-to-skill on-ramp"
```

---

## Final verification (whole-feature)

- [ ] `cd backend && vendor/bin/phpunit tests/Unit/GenesisDecideTest.php tests/Unit/GenesisProposerTest.php` → all green.
- [ ] Heal regression: `GET /heal/status` unchanged; a `POST /heal/record` does NOT move `GET`-side genesis spend and vice versa (kind separation).
- [ ] Full browser flow A: conversation → menu → proposal → ask-approve → skill folder exists → Skills panel lists it → promotion row `born`.
- [ ] Full browser flow B: workflow → promote → proposal with parameters → approve → wrapper skill exists.
- [ ] `genesis_mode=off` → authorize returns `mode_off` and the overlay's approve path surfaces the reason.
- [ ] All three UI languages render the new strings.

## Out of scope (deliberately — spec phasing)

L1 SQL sensor + automatic candidates; a promotions **list view** for browsing stored proposals (the `GET /genesis/promotions` endpoint ships in Task 4; L0's UI is the per-proposal overlay only — suggest-mode browsing arrives with L1's genesis panel scan); the `run.py` workflow dispatcher inside wrapper skills (L0 wrapper SKILL.md documents the reference only); SkillOpt hardening of newborns (L0 writes the eval queries into SKILL.md for later use); PROCEDURES memory scope (L2); weekly reflection job (L2); Node/TS port (after PHP testing, per user decision).
