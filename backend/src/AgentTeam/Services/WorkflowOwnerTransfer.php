<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;

/**
 * Owner -> Robot (one way): the workflow and everything it uses that its owner owns (code components incl. the Start
 * option's, playbooks, agents and their playbooks) are moved to the robot in place, same ids, nothing copied; then
 * its schedule rows. Other users' rows (a public agent, a robot component) are left as they are.
 */
final class WorkflowOwnerTransfer
{
    public function __construct(private readonly PDO $db, private readonly RobotOwnership $ownership)
    {
    }

    /** @return array{needs_servers: string[], shared_with: array<array{id: int, name: string}>, clashes: array<array{kind: string, name: string}>} */
    public function preview(int $callerId, int $workflowId): array
    {
        [$robot, $owner, $name] = $this->load($callerId, $workflowId);
        $links = $this->links($workflowId);
        if ($owner === $robot) {
            return ['needs_servers' => $this->missingServers($robot, $links['servers']), 'shared_with' => [], 'clashes' => []];
        }
        $plan = $this->plan($owner, $links);
        return ['needs_servers' => $this->missingServers($robot, $links['servers']),
            'shared_with' => $this->sharedWith($owner, $workflowId, $plan),
            'clashes' => $this->clashes($robot, $workflowId, $name, $plan)];
    }

    /**
     * @return array{workflow_id: int, moved: array{components: int[], playbooks: int[], agents: int[], schedules: int[]}}
     * An already robot-owned workflow only has its schedule rows moved again (a repair).
     */
    public function toRobot(int $callerId, int $workflowId): array
    {
        [$robot, $owner, $name] = $this->load($callerId, $workflowId);
        $moved = ['components' => [], 'playbooks' => [], 'agents' => []];
        if ($owner !== $robot) {
            $moved = $this->plan($owner, $this->links($workflowId));
            $clashes = $this->clashes($robot, $workflowId, $name, $moved);
            if ($clashes !== []) {
                $names = implode(', ', array_map(fn($c) => "{$c['kind']} \"{$c['name']}\"", $clashes));
                throw new WorkflowTransferError('clash', "The robot already has $names: rename yours first.", 409, $clashes);
            }
            $this->db->beginTransaction();
            try {
                (new ActiveWorkflowService($this->db))->deactivate($owner, $workflowId);
                $this->db->prepare('UPDATE agent_workflows SET user_id = ? WHERE id = ? AND user_id = ?')->execute([$robot, $workflowId, $owner]);
                foreach (['components' => 'code_components', 'playbooks' => 'playbooks', 'agents' => 'agents'] as $kind => $table) {
                    if ($moved[$kind] !== []) {
                        $this->db->prepare("UPDATE $table SET user_id = ? WHERE user_id = ? AND id IN (" . $this->marks($moved[$kind]) . ')')
                            ->execute([$robot, $owner, ...$moved[$kind]]);
                    }
                }
                $this->db->commit();
            } catch (\Throwable $e) {
                $this->db->rollBack();
                throw $e;
            }
        }
        // scheduled_workflows is MyISAM: outside the transaction, and re-run on a robot workflow to repair it.
        $schedules = array_map('intval', $this->column('SELECT id FROM scheduled_workflows WHERE workflow_id = ? AND user_id <> ? ORDER BY id',
            [$workflowId, $robot]));
        if ($schedules !== []) {
            $this->db->prepare('UPDATE scheduled_workflows SET user_id = ? WHERE id IN (' . $this->marks($schedules) . ')')
                ->execute([$robot, ...$schedules]);
        }
        return ['workflow_id' => $workflowId, 'moved' => $moved + ['schedules' => $schedules]];
    }

    /** [robot id, owner id, workflow name]: the caller may use the robot and owns the workflow, or the robot does. */
    private function load(int $callerId, int $workflowId): array
    {
        $robot = $this->ownership->robotFor($callerId)
            ?? throw new WorkflowTransferError('forbidden', "Your role can't use the robot", 403);
        $st = $this->db->prepare('SELECT user_id, name FROM agent_workflows WHERE id = ?');
        $st->execute([$workflowId]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row || !in_array((int) $row['user_id'], [$callerId, $robot], true)) {
            throw new WorkflowTransferError('not_found', "Workflow #{$workflowId} not found", 404);
        }
        return [$robot, (int) $row['user_id'], (string) $row['name']];
    }

    /** What the workflow's nodes and schedule rows link to, whoever owns it: {components, playbooks, agents, servers}. */
    private function links(int $workflowId): array
    {
        $components = $playbooks = $agents = $servers = [];
        foreach ($this->rows('SELECT * FROM workflow_nodes WHERE workflow_id = ?', [$workflowId]) as $n) {
            $cfg = json_decode((string) $n['config'], true);
            $cfg = is_array($cfg) ? $cfg : [];
            if (CodeComponentStore::isCodeNode($n['node_type'] ?? null, $cfg)) {
                if (!empty($cfg['code_component_id'])) {
                    $components[] = (int) $cfg['code_component_id'];
                } elseif (is_array($cfg['mcp_servers'] ?? null)) {
                    array_push($servers, ...$cfg['mcp_servers']);   // an inline code node ticks its own
                }
            }
            if (($option = StartOptionGraph::optionId(['node_type' => $n['node_type'] ?? '', 'config' => $cfg])) !== null) {
                $components[] = $option;
            }
            if (($n['node_type'] ?? '') === 'playbook' && !empty($cfg['playbook_id'])) {
                $playbooks[] = (int) $cfg['playbook_id'];
            }
            if (!empty($n['agent_id'])) {
                $agents[] = (int) $n['agent_id'];
            }
        }
        foreach ($this->column('SELECT trigger_component_id FROM scheduled_workflows WHERE workflow_id = ? AND trigger_component_id IS NOT NULL',
            [$workflowId]) as $id) {
            $components[] = (int) $id;
        }
        $components = array_values(array_unique($components));
        if ($components !== []) {
            foreach ($this->column('SELECT mcp_servers FROM code_components WHERE id IN (' . $this->marks($components) . ')', $components) as $json) {
                array_push($servers, ...(json_decode((string) $json, true) ?: []));
            }
        }
        return ['components' => $components, 'playbooks' => array_values(array_unique($playbooks)),
            'agents' => array_values(array_unique($agents)), 'servers' => $servers];
    }

    /** The owner's rows among the links, ids sorted: what moves. A moved agent's playbook moves with it. */
    private function plan(int $owner, array $links): array
    {
        $agents = $this->owned('agents', $owner, $links['agents']);
        $playbooks = $links['playbooks'];
        if ($agents !== []) {
            foreach ($this->column('SELECT playbook_id FROM agents WHERE playbook_id IS NOT NULL AND id IN (' . $this->marks($agents) . ')', $agents) as $id) {
                $playbooks[] = (int) $id;
            }
        }
        return ['components' => $this->owned('code_components', $owner, $links['components']),
            'playbooks' => $this->owned('playbooks', $owner, array_values(array_unique($playbooks))), 'agents' => $agents];
    }

    private function owned(string $table, int $owner, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        return array_map('intval', $this->column("SELECT id FROM $table WHERE user_id = ? AND id IN (" . $this->marks($ids) . ') ORDER BY id',
            [$owner, ...$ids]));
    }

    /** The robot's rows with the unique key (per owner) of one being moved: [{kind, name}]. */
    private function clashes(int $robot, int $workflowId, string $name, array $plan): array
    {
        $clashes = [];
        if ($this->column('SELECT 1 FROM agent_workflows WHERE user_id = ? AND name = ? AND id <> ?', [$robot, $name, $workflowId]) !== []) {
            $clashes[] = ['kind' => 'workflow', 'name' => $name];
        }
        foreach ([['component', 'code_components', 'name', 'components'], ['playbook', 'playbooks', 'pkey', 'playbooks'],
                  ['agent', 'agents', 'name', 'agents']] as [$kind, $table, $key, $planKey]) {
            if ($plan[$planKey] === []) {
                continue;
            }
            $ids = $plan[$planKey];
            foreach ($this->column("SELECT m.$key FROM $table m JOIN $table r ON r.$key = m.$key AND r.user_id = ?
                WHERE m.id IN (" . $this->marks($ids) . ") ORDER BY m.$key", [$robot, ...$ids]) as $n) {
                $clashes[] = ['kind' => $kind, 'name' => (string) $n];
            }
        }
        return $clashes;
    }

    /** The owner's other workflows linking a moved item: they keep working, on the robot's rows. */
    private function sharedWith(int $owner, int $workflowId, array $plan): array
    {
        $shared = [];
        foreach ($this->rows('SELECT id, name FROM agent_workflows WHERE user_id = ? AND id <> ? ORDER BY name, id', [$owner, $workflowId]) as $w) {
            $links = $this->links((int) $w['id']);
            foreach (['components', 'playbooks', 'agents'] as $kind) {
                if (array_intersect($links[$kind], $plan[$kind]) !== []) {
                    $shared[] = ['id' => (int) $w['id'], 'name' => (string) $w['name']];
                    break;
                }
            }
        }
        return $shared;
    }

    /** The servers (by name, sorted) the robot has no enabled row for, as code nodes resolve them: by slug, its own or shared. */
    private function missingServers(int $robotId, array $names): array
    {
        $st = $this->db->prepare('SELECT name FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)');
        $st->execute([(string) $robotId]);
        $have = array_flip(array_map(fn($n) => CodeNodeEmit::slug((string) $n), $st->fetchAll(PDO::FETCH_COLUMN)));
        $missing = array_values(array_unique(array_filter($names, fn($n) => !isset($have[CodeNodeEmit::slug($n)]))));
        sort($missing);
        return $missing;
    }

    private function marks(array $ids): string
    {
        return implode(', ', array_fill(0, count($ids), '?'));
    }

    private function column(string $sql, array $args): array
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->fetchAll(PDO::FETCH_COLUMN);
    }

    private function rows(string $sql, array $args): array
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->fetchAll(PDO::FETCH_ASSOC);
    }
}
