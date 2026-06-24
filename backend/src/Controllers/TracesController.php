<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use AgentTeam\Services\ExecutionTraceStore;

/**
 * TracesController — records chat-path execution traces (Phase 0 self-healing).
 *
 * The workflow path captures traces server-side (the bridge holds the skill
 * result), but in CHAT the skill runs client-side and its result lives in the
 * browser. So chat.js posts one trace here after each skill run. The server
 * still owns classification + outcome labelling (ExecutionTraceStore).
 *
 * Route: POST /api/v1/traces
 * Spec:  docs/specs/2026-06-13-phase0-trace-store.md
 */
final class TracesController
{
    private PDO $db;

    public function __construct(PDO $db, array $config = [])
    {
        $this->db = $db;
    }

    public function create(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        $b = $request['body'] ?? [];
        if (!is_array($b) || empty($b['skill_dir'])) {
            return ['success' => false, 'error' => 'Missing skill_dir', 'status_code' => 400];
        }

        // Only the two chat-origin modes are accepted here; default to discovery.
        $mode = in_array($b['invocation_mode'] ?? '', ['auto_discovery', 'forced'], true)
            ? $b['invocation_mode'] : 'auto_discovery';

        $store = new ExecutionTraceStore($this->db);
        $id = $store->insert([
            'run_id'             => isset($b['run_id']) ? (string) $b['run_id'] : '',
            'ts'                 => date('Y-m-d H:i:s'),
            'env'                => 'chat',
            'invocation_mode'    => $mode,
            'workflow_id'        => null,
            'node_id'            => null,
            'provider'           => $b['provider'] ?? null,
            'model'              => $b['model'] ?? null,
            'skill_dir'          => (string) $b['skill_dir'],
            'script'             => $b['script'] ?? null,
            'argv'               => $b['argv'] ?? [],
            'input_snapshot'     => $b['input'] ?? null,
            'skill_exit_code'    => isset($b['exit_code']) ? (int) $b['exit_code'] : null,
            'skill_stdout'       => $b['stdout'] ?? null,
            'skill_log_messages' => $b['log_messages'] ?? null,
            'output_files'       => is_array($b['output_files'] ?? null) ? $b['output_files'] : [],
            'final_text'         => $b['final_text'] ?? null,
            'success'            => !empty($b['success']),
            'loop_detected'      => !empty($b['loop_detected']),
            'tokens_in'          => (int) ($b['tokens_in'] ?? 0),
            'tokens_out'         => (int) ($b['tokens_out'] ?? 0),
        ]);

        return ['success' => $id !== null, 'id' => $id];
    }

    /**
     * GET /api/v1/traces/diagnosis?days=30
     * Read-only diagnosis of recent traces: per-skill verdict (which layer/loop
     * should fix it) + heal-cost estimate. No LLM calls.
     */
    public function diagnose(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $days = (int) ($request['query']['days'] ?? 30);
        $days = max(1, min(365, $days));

        $store = new ExecutionTraceStore($this->db);
        return ['success' => true, 'diagnosis' => $store->diagnose($days)];
    }
}
