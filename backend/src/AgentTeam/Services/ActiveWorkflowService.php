<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;

/**
 * The workflow each user activated with ▶ on Start (spec 2026-10-14 event-worker): the event worker runs it on its
 * schedule, or on its Start option's event. One per person; the robot keeps one per workflow (several robot workflows
 * watch at once). Ticking a mode never activates; a mode change deactivates.
 */
final class ActiveWorkflowService
{
    public const TIMED = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'cron'];

    public function __construct(private PDO $db)
    {
    }

    /**
     * The workflow's input mode, read from its saved data as the editor's StartOptions.active() reads it: the newest
     * pending/running schedule row decides; an event row counts only while Start is on that row's option.
     */
    public function mode(int $workflowId): array
    {
        $st = $this->db->prepare("SELECT * FROM scheduled_workflows WHERE workflow_id = ? AND status IN ('pending', 'running')
            ORDER BY id DESC LIMIT 1");
        $st->execute([$workflowId]);
        $row = $st->fetch(PDO::FETCH_ASSOC) ?: null;
        if ($row === null) {
            return ['mode' => 'prompt', 'schedule' => null, 'component_id' => null];
        }
        if (($row['repeat_type'] ?? '') !== 'event') {
            return ['mode' => in_array($row['repeat_type'], self::TIMED, true) ? 'schedule' : 'mode_gone',
                'schedule' => $row, 'component_id' => null];
        }
        $cid = (int) ($row['trigger_component_id'] ?? 0);
        $start = $this->startNode($workflowId);
        $onIt = $cid > 0 && $start !== null && (int) ($start['config']['start_option'] ?? 0) === $cid && $this->isOption($cid);
        return ['mode' => $onIt ? 'option' : 'mode_gone', 'schedule' => $row, 'component_id' => $cid ?: null];
    }

    /** Only what Start reaches is active: a Start with no outgoing edge has nothing to run. */
    public function startHasLinks(int $workflowId): bool
    {
        $start = $this->startNode($workflowId);
        if ($start === null) {
            return false;
        }
        $st = $this->db->prepare('SELECT COUNT(*) FROM workflow_edges WHERE from_node_id = ?');
        $st->execute([$start['id']]);
        return (int) $st->fetchColumn() > 0;
    }

    public function activate(int $userId, int $workflowId): array
    {
        $st = $this->db->prepare('SELECT id, user_id, name FROM agent_workflows WHERE id = ?');
        $st->execute([$workflowId]);
        $wf = $st->fetch(PDO::FETCH_ASSOC);
        if (!$wf || (int) $wf['user_id'] !== $userId) {
            throw new ActiveWorkflowError('not_found', 'Workflow not found', 404);
        }
        $mode = $this->mode($workflowId);
        if (!in_array($mode['mode'], ['schedule', 'option'], true)) {
            throw new ActiveWorkflowError('no_trigger', 'Pick Set Schedule or a code option first', 422);
        }
        if (!$this->startHasLinks($workflowId)) {
            throw new ActiveWorkflowError('no_links', 'Start has no links', 422);
        }
        $several = RobotAccount::id($this->db) === $userId;
        $before = $several ? null : $this->get($userId);
        $replaced = $before && (int) $before['workflow_id'] !== $workflowId
            ? ['workflow_id' => (int) $before['workflow_id'], 'workflow_name' => $before['workflow_name']] : null;
        $this->db->beginTransaction();
        try {
            // a person's other active workflow is replaced; the robot's other rows stay
            $this->db->prepare('DELETE FROM active_workflows WHERE user_id = ?' . ($several ? ' AND workflow_id = ?' : ''))
                ->execute($several ? [$userId, $workflowId] : [$userId]);
            $this->db->prepare("INSERT INTO active_workflows (user_id, workflow_id, mode, trigger_component_id, activated_at, watch_state)
                VALUES (?, ?, ?, ?, NOW(), 'starting')")->execute([$userId, $workflowId, $mode['mode'], $mode['component_id']]);
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        return ['active' => $this->row($userId, $workflowId), 'replaced' => $replaced];
    }

    public function deactivate(int $userId, int $workflowId): void
    {
        $this->db->prepare('DELETE FROM active_workflows WHERE user_id = ? AND workflow_id = ?')->execute([$userId, $workflowId]);
    }

    /** The user's active row (a person has one), or null; ages in seconds from the database's NOW() (the worker's clock). */
    public function get(int $userId): ?array
    {
        return $this->fetchAged('a.user_id = ? ORDER BY a.workflow_id', [$userId]);
    }

    /** The workflow's active row, whoever's it is (the robot's for a robot workflow), or null; ages as get(). */
    public function forWorkflow(int $workflowId): ?array
    {
        return $this->fetchAged('a.workflow_id = ? ORDER BY a.user_id', [$workflowId]);
    }

    private function row(int $userId, int $workflowId): ?array
    {
        return $this->fetchAged('a.user_id = ? AND a.workflow_id = ?', [$userId, $workflowId]);
    }

    private function fetchAged(string $where, array $params): ?array
    {
        $st = $this->db->prepare('SELECT a.*, w.name AS workflow_name, NOW() AS db_now FROM active_workflows a
            LEFT JOIN agent_workflows w ON w.id = a.workflow_id WHERE ' . $where . ' LIMIT 1');
        $st->execute($params);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $now = strtotime((string) $row['db_now']);
        $row['checked_age_s'] = $row['watch_checked_at'] ? $now - strtotime((string) $row['watch_checked_at']) : null;
        $row['activated_age_s'] = $now - strtotime((string) $row['activated_at']);
        unset($row['db_now']);
        return $row;
    }

    /** Every active row with its workflow's owner, enabled flag and the row user's kind ('service' = the robot): the worker's reconcile. */
    public function all(): array
    {
        return $this->db->query('SELECT a.*, w.user_id AS owner_id, w.enabled, u.kind AS user_kind FROM active_workflows a
            JOIN agent_workflows w ON w.id = a.workflow_id LEFT JOIN users u ON u.id = a.user_id
            ORDER BY a.user_id, a.workflow_id')->fetchAll(PDO::FETCH_ASSOC);
    }

    /** Whether the worker may serve the row now; a row that may not is idle, not deactivated (fixing it resumes it). */
    public function check(array $row): array
    {
        $mode = $this->mode((int) $row['workflow_id']);
        $reason = match (true) {
            (int) ($row['enabled'] ?? 1) !== 1 => 'disabled',
            $mode['mode'] !== $row['mode'] => 'mode_gone',
            !$this->startHasLinks((int) $row['workflow_id']) => 'no_links',
            default => null,
        };
        return ['ok' => $reason === null, 'reason' => $reason, 'mode' => $mode];
    }

    /** Deactivate the rows whose workflow's mode (or option) is no longer the one activated; returns their workflow ids. */
    public function sweep(): array
    {
        $gone = [];
        foreach ($this->all() as $row) {
            $mode = $this->mode((int) $row['workflow_id']);
            $same = $mode['mode'] === $row['mode']
                && ($row['mode'] !== 'option' || (int) $mode['component_id'] === (int) $row['trigger_component_id']);
            if (!$same) {
                $this->deactivate((int) $row['user_id'], (int) $row['workflow_id']);
                $gone[] = (int) $row['workflow_id'];
            }
        }
        return $gone;
    }

    public function setState(int $userId, int $workflowId, string $state, ?string $message): void
    {
        $this->db->prepare('UPDATE active_workflows SET watch_state = ?, watch_message = ?, watch_checked_at = NOW()
            WHERE user_id = ? AND workflow_id = ?')->execute([$state, $message, $userId, $workflowId]);
    }

    /**
     * The schedule-mode workflows the scheduler tick may run: only the rows that qualify now (check(): enabled, Start
     * linked, still in schedule mode), the ones the worker shows as scheduled -- an idle one must not run.
     * @return int[]
     */
    public function scheduleWorkflowIds(): array
    {
        $ids = [];
        foreach ($this->all() as $row) {
            if ($row['mode'] === 'schedule' && $this->check($row)['ok']) {
                $ids[] = (int) $row['workflow_id'];
            }
        }
        return $ids;
    }

    /** The workflow's Start node (not its other nodes), config decoded. */
    private function startNode(int $workflowId): ?array
    {
        $st = $this->db->prepare("SELECT id, config FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'start' ORDER BY id LIMIT 1");
        $st->execute([$workflowId]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $cfg = is_string($row['config']) ? json_decode($row['config'], true) : null;
        return ['id' => (int) $row['id'], 'config' => is_array($cfg) ? $cfg : []];
    }

    private function isOption(int $componentId): bool
    {
        $st = $this->db->prepare('SELECT start_trigger FROM code_components WHERE id = ?');
        $st->execute([$componentId]);
        $t = $st->fetchColumn();
        return is_string($t) && trim($t) !== '' && trim($t) !== 'null';
    }
}
