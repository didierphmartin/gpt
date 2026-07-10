<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Services\PricingResolver;
use Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException;

/**
 * ExecutionTraceStore — Phase 0 of the self-healing design.
 *
 * Captures ONE structured, classified, outcome-labelled record per skill/agent
 * execution (a workflow node, or a chat skill invocation). This is the shared
 * substrate the three healers read (skill / workflow / foundation). No healing,
 * no LLM calls — capture + deterministic classification only.
 *
 * Spec: docs/specs/2026-06-13-phase0-trace-store.md
 *       docs/specs/2026-06-13-self-healing-design.md (§3, §4.1-4.2, §6)
 */
final class ExecutionTraceStore
{
    private PDO $db;
    private bool $tableEnsured = false;
    /** @var array<string,array{0:?float,1:?float}> provider => [priceIn, priceOut] per 1M */
    private array $pricingCache = [];

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /** Idempotently create the traces table (cached per instance). */
    public function ensureTable(): void
    {
        if ($this->tableEnsured) {
            return;
        }
        // Lean schema: only the fields we filter / group / index on are real
        // columns. Everything bulky (stdout, logs, argv, tool_calls, input,
        // output_files, final_text, model, timing flags) lives in `payload`
        // JSON. Same information, ~19 columns instead of ~32.
        $sql = <<<SQL
CREATE TABLE IF NOT EXISTS `execution_traces` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `run_id` VARCHAR(40) NOT NULL DEFAULT '',
  `ts` DATETIME NOT NULL,
  `env` VARCHAR(16) NOT NULL DEFAULT 'workflow',
  `invocation_mode` VARCHAR(20) NOT NULL DEFAULT 'workflow_node',
  `workflow_id` INT DEFAULT NULL,
  `node_id` INT DEFAULT NULL,
  `provider` VARCHAR(40) DEFAULT NULL,
  `skill_dir` VARCHAR(255) DEFAULT NULL,
  `success` TINYINT(1) NOT NULL DEFAULT 0,
  `error_class` VARCHAR(32) NOT NULL DEFAULT 'ok',
  `error_text` TEXT DEFAULT NULL,
  `outcome_quality` VARCHAR(16) NOT NULL DEFAULT 'unknown',
  `tokens_in` INT NOT NULL DEFAULT 0,
  `tokens_out` INT NOT NULL DEFAULT 0,
  `cost_usd` DECIMAL(12,6) DEFAULT NULL,
  `user_action` VARCHAR(12) NOT NULL DEFAULT 'none',
  `payload` LONGTEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_skill_dir` (`skill_dir`),
  KEY `idx_workflow` (`workflow_id`, `node_id`),
  KEY `idx_error_class` (`error_class`),
  KEY `idx_run` (`run_id`),
  KEY `idx_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL;
        try {
            $this->db->exec($sql);
        } catch (\PDOException $e) {
            error_log('[ExecutionTraceStore] ensureTable failed: ' . $e->getMessage());
        }
        $this->tableEnsured = true;
    }

    /**
     * Classify + label a trace and insert it. Tolerant of missing keys.
     * Returns the inserted id, or null on failure (never throws — tracing
     * must not break a workflow run).
     */
    public function insert(array $t): ?int
    {
        try {
            $this->ensureTable();

            // Classify on the FULL record (these signals live in $t and the
            // payload, not in their own columns).
            $t['error_class'] = $this->classify($t);
            $t['outcome_quality'] = $this->outcomeQuality($t, $t['error_class']);

            // Queryable columns (NOT user_action — its DEFAULT 'none' applies;
            // it is backfilled later via setUserAction()).
            $kept = [
                'run_id', 'ts', 'env', 'invocation_mode', 'workflow_id', 'node_id',
                'provider', 'skill_dir', 'success', 'error_class', 'error_text',
                'outcome_quality', 'tokens_in', 'tokens_out', 'cost_usd',
            ];
            // Everything bulky folds into one JSON blob.
            $payload = [
                'model'              => $t['model'] ?? null,
                'latency_ms'         => $t['latency_ms'] ?? null,
                'script'             => $t['script'] ?? null,
                'argv'               => $t['argv'] ?? [],
                'input_snapshot'     => $t['input_snapshot'] ?? null,
                'tool_calls'         => $t['tool_calls'] ?? [],
                'skill_exit_code'    => $t['skill_exit_code'] ?? null,
                'skill_stdout'       => $t['skill_stdout'] ?? null,
                'skill_log_messages' => $t['skill_log_messages'] ?? null,
                'output_files'       => $t['output_files'] ?? [],
                'final_text'         => $t['final_text'] ?? null,
                'rounds'             => $t['rounds'] ?? null,
                'round_limit_hit'    => !empty($t['round_limit_hit']),
                'loop_detected'      => !empty($t['loop_detected']),
            ];

            $cols = array_merge($kept, ['payload']);
            $placeholders = implode(', ', array_map(fn($c) => ':' . $c, $cols));
            $sql = 'INSERT INTO `execution_traces` (`' . implode('`, `', $cols) . "`) VALUES ($placeholders)";

            $params = [];
            foreach ($kept as $c) {
                $params[':' . $c] = $this->coerce($c, $t[$c] ?? null);
            }
            $params[':payload'] = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);

            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            return (int) $this->db->lastInsertId();
        } catch (\Throwable $e) {
            error_log('[ExecutionTraceStore] insert failed: ' . $e->getMessage());
            return null;
        }
    }

    /** Backfill a user action (accept|retry|abort) onto a run's traces. */
    public function setUserAction(string $runId, string $action, ?int $nodeId = null): void
    {
        try {
            $this->ensureTable();
            $sql = 'UPDATE `execution_traces` SET `user_action` = :a WHERE `run_id` = :r';
            $params = [':a' => $action, ':r' => $runId];
            if ($nodeId !== null) {
                $sql .= ' AND `node_id` = :n';
                $params[':n'] = $nodeId;
            }
            $this->db->prepare($sql)->execute($params);
        } catch (\Throwable $e) {
            error_log('[ExecutionTraceStore] setUserAction failed: ' . $e->getMessage());
        }
    }

    // ─── Deterministic classifier (no LLM) ──────────────────────────────────

    /** Assign error_class. First match wins. See spec §4.1. */
    public function classify(array $t): string
    {
        $err = strtolower((string) ($t['error_text'] ?? ''));
        $logs = strtolower((string) ($t['skill_log_messages'] ?? ''));
        $body = strtolower((string) (($t['final_text'] ?? '') . ' ' . ($t['skill_stdout'] ?? '')));
        $success = !empty($t['success']);
        $exit = $t['skill_exit_code'] ?? null;
        $argv = strtolower(is_string($t['argv'] ?? null) ? $t['argv'] : json_encode($t['argv'] ?? []));

        // e — transient / external (provider outage, rate limit)
        if (preg_match('/\b(429|503|500|overloaded|rate.?limit|service unavailable|quota exceeded|temporarily|try again)\b/', $err)) {
            return 'e_transient_external';
        }
        // d — foundation / plumbing bug (NOT fixable by a skill edit)
        if (preg_match('/not registered|undefined variable|provider .* not found|thought_signature|reasoning_content|must be passed back|unsupported|fatal error|call to undefined|\.php on line/', $err)) {
            return 'd_foundation_code';
        }
        // b — skill script error
        if (($exit !== null && (int) $exit !== 0)
            || strpos($logs, 'traceback (most recent call last)') !== false) {
            return 'b_skill_script';
        }
        // a — skill-prompt weakness: ran "successfully" but misbehaved
        $helpProbe = (strpos($argv, '"-h"') !== false || strpos($argv, '"--help"') !== false);
        $apology = (bool) preg_match('/\b(i\'?m unable|i am unable|i cannot|i can\'?t|apolog|not available in (my|this))/', $body);
        if ($success && (!empty($t['loop_detected']) || !empty($t['round_limit_hit']) || $helpProbe || $apology)) {
            return 'a_skill_prompt';
        }
        // c — workflow-config: failed inside a workflow node, not obviously a/b/d/e
        if (!$success && ($t['env'] ?? '') === 'workflow') {
            return 'c_workflow_config';
        }
        if (!$success) {
            return 'a_skill_prompt';
        }
        return 'ok';
    }

    /** Derive outcome_quality from free signals only. See spec §4.2. */
    public function outcomeQuality(array $t, ?string $class = null): string
    {
        $success = !empty($t['success']);
        if (!$success) {
            return 'failed';
        }
        $loop = !empty($t['loop_detected']) || !empty($t['round_limit_hit']);
        $body = strtolower((string) (($t['final_text'] ?? '') . ' ' . ($t['skill_stdout'] ?? '')));
        $apology = (bool) preg_match('/\b(i\'?m unable|i am unable|i cannot|i can\'?t|apolog|not available in (my|this))/', $body);
        if ($loop || $apology || $class === 'a_skill_prompt') {
            return 'degraded';
        }
        $exit = $t['skill_exit_code'] ?? null;
        if ($exit === null || (int) $exit === 0) {
            return 'good';
        }
        return 'unknown';
    }

    // ─── Read surface (Phase 0 = queries only) ──────────────────────────────

    /** Skill reader: recurring degraded/failed runs for a skill, grouped. */
    public function skillWeaknesses(string $skillDir, int $sinceDays = 30): array
    {
        return $this->query(
            "SELECT error_class, invocation_mode, provider, COUNT(*) AS n
             FROM execution_traces
             WHERE skill_dir = :d AND outcome_quality IN ('degraded','failed')
               AND ts >= (NOW() - INTERVAL :days DAY)
             GROUP BY error_class, invocation_mode, provider
             ORDER BY n DESC",
            [':d' => $skillDir, ':days' => $sinceDays]
        );
    }

    /** Workflow reader: per-node trace of one run (credit assignment). */
    public function workflowTrace(int $workflowId, ?string $runId = null): array
    {
        $sql = "SELECT node_id, provider, skill_dir, success, outcome_quality, error_class,
                       error_text, tokens_in, tokens_out, cost_usd
                FROM execution_traces WHERE workflow_id = :w";
        $params = [':w' => $workflowId];
        if ($runId !== null) {
            $sql .= ' AND run_id = :r';
            $params[':r'] = $runId;
        }
        $sql .= ' ORDER BY node_id';
        return $this->query($sql, $params);
    }

    /** Foundation reader: recurring class-d bugs, ranked by frequency. */
    public function foundationBugs(int $sinceDays = 30): array
    {
        return $this->query(
            "SELECT provider, LEFT(error_text, 120) AS signature, COUNT(*) AS n
             FROM execution_traces
             WHERE error_class = 'd_foundation_code'
               AND ts >= (NOW() - INTERVAL :days DAY)
             GROUP BY provider, signature
             ORDER BY n DESC",
            [':days' => $sinceDays]
        );
    }

    // ─── Diagnosis layer (read-only, no LLM) — design §4 ────────────────────

    /**
     * Turn raw traces into an actionable diagnosis: per skill that has any
     * degraded/failed runs, a verdict (which layer/loop should fix it) using
     * the invocation-mode ablation, plus a heal-cost estimate for the
     * skill-text cases. This is what the approval overlay and the miner read.
     */
    public function diagnose(int $sinceDays = 30): array
    {
        $rows = $this->query(
            "SELECT skill_dir, invocation_mode, error_class, outcome_quality, provider, COUNT(*) AS n
             FROM execution_traces
             WHERE skill_dir IS NOT NULL AND skill_dir <> ''
               AND ts >= (NOW() - INTERVAL :d DAY)
             GROUP BY skill_dir, invocation_mode, error_class, outcome_quality, provider",
            [':d' => $sinceDays]
        );

        $skills = [];
        foreach ($rows as $r) {
            $sd = $r['skill_dir'];
            if (!isset($skills[$sd])) {
                $skills[$sd] = ['skill_dir' => $sd, 'total' => 0, 'bad' => 0,
                    'by_mode' => [], 'by_class' => [], 'providers' => []];
            }
            $n = (int) $r['n'];
            $bad = in_array($r['outcome_quality'], ['degraded', 'failed'], true);
            $skills[$sd]['total'] += $n;
            $mode = $r['invocation_mode'] ?: 'unknown';
            if (!isset($skills[$sd]['by_mode'][$mode])) {
                $skills[$sd]['by_mode'][$mode] = ['total' => 0, 'bad' => 0];
            }
            $skills[$sd]['by_mode'][$mode]['total'] += $n;
            if ($bad) {
                $skills[$sd]['bad'] += $n;
                $skills[$sd]['by_mode'][$mode]['bad'] += $n;
                $skills[$sd]['by_class'][$r['error_class']] = ($skills[$sd]['by_class'][$r['error_class']] ?? 0) + $n;
                $prov = $r['provider'] ?: 'unknown';
                $skills[$sd]['providers'][$prov] = ($skills[$sd]['providers'][$prov] ?? 0) + $n;
            }
        }

        $out = [];
        foreach ($skills as $s) {
            if ($s['bad'] === 0) {
                continue; // only report skills with problems
            }
            $verdict = $this->verdict($s);
            $rec = $this->recommend($verdict);
            $s['verdict'] = $verdict;
            $s['recommended'] = $rec;
            if (in_array($verdict, ['skill_description', 'skill_body'], true)) {
                $provs = array_keys($s['providers']) ?: ['claude'];
                $s['estimate'] = $this->estimateHealCost($provs);
            }
            $out[] = $s;
        }
        usort($out, fn($a, $b) => $b['bad'] <=> $a['bad']);

        return [
            'window_days' => $sinceDays,
            'skills' => $out,
            'foundation_bugs' => $this->foundationBugs($sinceDays),
        ];
    }

    /** Decide which layer/loop should fix a skill, using class + the ablation. */
    private function verdict(array $s): string
    {
        $cls = $s['by_class'];
        arsort($cls);
        $top = array_key_first($cls) ?? 'a_skill_prompt';
        if ($top === 'e_transient_external') return 'transient_external';
        if ($top === 'd_foundation_code')    return 'foundation_code';
        if ($top === 'b_skill_script')        return 'skill_script';
        if ($top === 'c_workflow_config')     return 'workflow_config';

        // a_skill_prompt: use the invocation-mode ablation to split
        // description (selection) faults from body (execution) faults.
        $rate = function ($m) {
            return ($m && $m['total'] > 0) ? $m['bad'] / $m['total'] : null;
        };
        $ra = $rate($s['by_mode']['auto_discovery'] ?? null);
        $rf = $rate($s['by_mode']['forced'] ?? null);
        $rw = $rate($s['by_mode']['workflow_node'] ?? null);
        // Bad when discovered, but fine when explicitly selected → description.
        if ($ra !== null && $ra > 0.3
            && (($rf !== null && $rf < 0.2) || ($rw !== null && $rw < 0.2))) {
            return 'skill_description';
        }
        return 'skill_body';
    }

    /** Map a verdict to a layer + loop + human action. */
    private function recommend(string $verdict): array
    {
        return match ($verdict) {
            'skill_description'  => ['layer' => 'skill', 'loop' => 'run_loop',      'action' => 'Optimize the skill DESCRIPTION (it is being mis-discovered).'],
            'skill_body'         => ['layer' => 'skill', 'loop' => 'run_body_loop', 'action' => 'Optimize the skill BODY (it runs but misbehaves).'],
            'skill_script'       => ['layer' => 'skill', 'loop' => null,            'action' => 'Fix the Python script (code, but isolated to the skill).'],
            'workflow_config'    => ['layer' => 'workflow', 'loop' => null,         'action' => 'Adjust workflow node config (provider / topology / forcing).'],
            'foundation_code'    => ['layer' => 'foundation', 'loop' => null,       'action' => 'File a PR — runtime/plumbing bug, NOT auto-healable.'],
            'transient_external' => ['layer' => 'none', 'loop' => null,             'action' => 'Retry/backoff — external outage, nothing to fix.'],
            default              => ['layer' => 'skill', 'loop' => 'run_body_loop', 'action' => 'Optimize the skill body.'],
        };
    }

    // ─── Cost estimate (for the future approval overlay, design §4.4) ───────

    /**
     * Forecast the token + USD cost of a heal loop. Pure function.
     * calls = Q*R*2*(1+I) + I ; eval calls priced on the (cheap) eval model,
     * the I proposer calls on the (strong) proposer model.
     *
     * @param string[] $providers providers the loop will optimize (loop runs per provider)
     */
    public function estimateHealCost(
        array $providers,
        int $Q = 10,
        int $R = 3,
        int $I = 3,
        string $evalProvider = 'kimi',
        string $proposerProvider = 'claude',
        int $avgEvalTokens = 4000,
        int $avgProposerTokens = 9000
    ): array {
        $nProv = max(1, count($providers));
        $proposerCalls = $I * $nProv;
        $evalCalls = ($Q * $R * 2 * (1 + $I)) * $nProv;
        $totalCalls = $evalCalls + $proposerCalls;

        $evalTokens = $evalCalls * $avgEvalTokens;
        $proposerTokens = $proposerCalls * $avgProposerTokens;
        $tokens = $evalTokens + $proposerTokens;

        // ~80% input / 20% output blend.
        $usd = $this->blendedCost($evalProvider, $evalTokens)
             + $this->blendedCost($proposerProvider, $proposerTokens);

        return [
            'calls' => $totalCalls,
            'tokens' => $tokens,
            'usd' => round($usd, 4),
            'usd_range' => [round($usd * 0.7, 4), round($usd * 1.4, 4)],
            'assumptions' => compact('providers', 'Q', 'R', 'I', 'evalProvider', 'proposerProvider'),
        ];
    }

    private function blendedCost(string $provider, int $tokens): float
    {
        [$pin, $pout] = $this->pricing($provider);
        $pin = $pin ?? 0.0;
        $pout = $pout ?? 0.0;
        return (0.8 * $tokens * $pin + 0.2 * $tokens * $pout) / 1_000_000;
    }

    /** Per-1M [in,out] USD via PricingResolver (single source of truth).
     *  [null, null] when pricing is unavailable — never a hardcoded number,
     *  never a throw. Mirrors GraphWorkflowRunner::getProviderPricing. */
    private function pricing(string $provider): array
    {
        $provider = strtolower($provider);
        $key = ['anthropic' => 'claude', 'google' => 'gemini'][$provider] ?? $provider;
        if (isset($this->pricingCache[$key])) {
            return $this->pricingCache[$key];
        }
        try {
            $resolver = new PricingResolver($this->db);
            [$in, $out] = $resolver->resolve($key);
        } catch (PricingUnavailableException $e) {
            [$in, $out] = [null, null];
        }
        return $this->pricingCache[$key] = [$in, $out];
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    private function query(string $sql, array $params): array
    {
        try {
            $this->ensureTable();
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        } catch (\Throwable $e) {
            error_log('[ExecutionTraceStore] query failed: ' . $e->getMessage());
            return [];
        }
    }

    /** Coerce a kept-column value to a DB-storable scalar. */
    private function coerce(string $col, mixed $v): mixed
    {
        if ($col === 'success') {
            return !empty($v) ? 1 : 0;
        }
        if (is_array($v)) {
            return json_encode($v, JSON_UNESCAPED_SLASHES);
        }
        return $v;
    }
}
