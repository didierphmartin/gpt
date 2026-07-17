<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\GenesisProposer;

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
        // heal_spend may not exist at all yet on a fresh install (HealController's
        // own ensureTables() may not have run). Bootstrap it here too so genesis
        // works standalone; log-and-continue mirrors the skill_promotions block.
        try {
            $this->db->exec(
                "CREATE TABLE IF NOT EXISTS heal_spend (
                    user_id BIGINT UNSIGNED NOT NULL,
                    day DATE NOT NULL,
                    kind ENUM('heal','genesis') NOT NULL DEFAULT 'heal',
                    spent_usd DECIMAL(10,4) NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, day, kind)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
            );
        } catch (\Throwable $e) {
            error_log('[GenesisController] ensureTables(heal_spend) failed: ' . $e->getMessage());
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

        $stmt = $this->db->prepare('SELECT status FROM skill_promotions WHERE id = ? AND user_id = ?');
        $stmt->execute([$promotionId, $userId]);
        $currentStatus = (string) $stmt->fetchColumn();
        if (!in_array($currentStatus, ['proposed', 'approved'], true)) {
            return ['success' => false, 'error' => 'Promotion already decided', 'status_code' => 409];
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
            $this->db->beginTransaction();
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
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
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
            $stmt = $this->db->prepare('SELECT id, name, description, steps FROM agent_workflows WHERE id = ? AND user_id = ?');
            $stmt->execute([$workflowId, $userId]);
            $wf = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$wf) {
                return ['success' => false, 'error' => 'Workflow not found', 'status_code' => 404];
            }
            // Editor-built workflows always persist steps = [] — the real graph lives in
            // workflow_nodes (AgentTeam/Services/WorkflowGraphRepository.php). Ownership was
            // already checked on the agent_workflows row above; workflow_nodes has no user_id
            // column of its own, so we scope by the already-verified workflow_id only.
            $stmt = $this->db->prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id');
            $stmt->execute([$workflowId]);
            $nodeRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            $wf['nodes'] = array_map(static function (array $row): array {
                $config = [];
                if (!empty($row['config'])) {
                    $decoded = json_decode((string) $row['config'], true);
                    if (is_array($decoded)) $config = $decoded;
                }
                $node = ['type' => $row['node_type'] ?? 'agent'];
                $name = $config['agent_name'] ?? $config['name'] ?? $config['title'] ?? null;
                if (is_string($name) && $name !== '') $node['name'] = $name;
                $instructions = $config['instructions'] ?? $config['systemPrompt'] ?? $config['prompt'] ?? null;
                if (is_string($instructions) && $instructions !== '') {
                    $node['instructions'] = mb_substr($instructions, 0, 160);
                }
                return $node;
            }, $nodeRows);
            // Manual on-ramp = an explicit user decision, and the workflow's
            // structure is already fully declared (name, description, nodes).
            // Nothing here needs LLM judgment — build the proposal
            // DETERMINISTICALLY: instant, free, and immune to reflection
            // failures. The LLM reflection below stays only for sources that
            // require extraction from unstructured text (conversation, prompt).
            $agentNames = [];
            foreach ($wf['nodes'] as $n) {
                if (($n['type'] ?? '') === 'agent' && !empty($n['name'])) {
                    $agentNames[] = $n['name'];
                }
            }
            $wfName = trim((string) ($wf['name'] ?? '')) !== '' ? trim((string) $wf['name']) : ('workflow ' . $workflowId);
            $name = strtolower($wfName);
            $name = preg_replace('/[^a-z0-9]+/', '-', $name);
            $name = trim(preg_replace('/-+/', '-', $name), '-');
            $name = substr($name !== '' ? $name : 'workflow-' . $workflowId, 0, 60);
            $wfDescr = trim((string) ($wf['description'] ?? ''));
            $descr = $wfDescr !== ''
                ? $wfDescr
                : sprintf(
                    "Runs the '%s' agent workflow (%d agents%s) on a user-supplied prompt.",
                    $wfName,
                    count($agentNames),
                    $agentNames ? ': ' . implode(', ', array_slice($agentNames, 0, 8)) : ''
                );
            $proposal = [
                'skill_name' => $name,
                'description' => mb_substr($descr, 0, 500),
                'eval_queries' => [],
                'parameter_schema' => null,
                'merge_target' => null,
                'rationale' => 'Manual workflow promotion — structure is explicit, no reflection needed.',
                'is_merge' => false,
            ];
            $class = 2;
            $sourceRef = 'workflow:' . $workflowId;
        } elseif ($source === 'prompt') {
            $promptId = (int) ($b['prompt_id'] ?? 0);
            $stmt = $this->db->prepare(
                "SELECT id, name, content FROM prompt_library WHERE id = ? AND user_id = ? AND type = 'prompt'"
            );
            $stmt->execute([$promptId, $userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) {
                return ['success' => false, 'error' => 'Prompt not found', 'status_code' => 404];
            }
            if (trim((string) $row['content']) === '') {
                return ['success' => false, 'error' => 'Prompt has no content', 'status_code' => 400];
            }
            $prompt = GenesisProposer::buildPromptLibraryPrompt((string) $row['name'], (string) $row['content'], $catalog);
            $class = 1;
            $sourceRef = 'prompt:' . $promptId;
        } else {
            return ['success' => false, 'error' => "source must be 'conversation', 'workflow' or 'prompt'", 'status_code' => 400];
        }

        // One-shot LLM reflection — only for sources whose procedure must be
        // EXTRACTED from unstructured text (conversation, prompt-library).
        // Workflow promotions arrive here with $proposal already built.
        if (!isset($proposal)) {
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
        }

        try {
            $stmt = $this->db->prepare(
                "INSERT INTO skill_promotions
                    (user_id, class, status, source_ref, skill_name, description, eval_queries,
                     parameter_schema, merge_target, created_at)
                 VALUES (:u, :c, 'proposed', :ref, :name, :descr, :evals, :params, :merge, NOW())
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), class = VALUES(class),
                     description = VALUES(description),
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
            'is_merge' => $proposal['is_merge'],
        ]];
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
}
