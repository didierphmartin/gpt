<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/**
 * A workflow published to the robot (task B2): a frozen copy owned by the robot, with its graph, the code components
 * its nodes link to (copied to robot-owned rows of the same name), their Start options and the source's schedule rows.
 * The robot's copy of a workflow is its row with source_id = that workflow; a republish replaces it in place.
 */
final class WorkflowRobotPublisher
{
    /** agent_workflows columns the copy does not take from its source: its identity, and links into the publisher's data. */
    private const WORKFLOW_OWN = ['id', 'user_id', 'workspace_id', 'automation_id', 'created_at', 'updated_at',
        'published_by', 'published_at', 'source_id'];
    /** scheduled_workflows columns a copied row starts fresh on. */
    private const SCHEDULE_OWN = ['id', 'user_id', 'workflow_id', 'trigger_component_id', 'last_run', 'running_since',
        'error_message', 'created_at'];

    public function __construct(private readonly PDO $db, private readonly CodeComponentStore $components)
    {
    }

    /** @return array{robot_workflow_id: int, replaced: bool, needs_servers: string[]} */
    public function publish(int $userId, int $workflowId, int $robotId, bool $confirmReplace): array
    {
        $st = $this->db->prepare('SELECT * FROM agent_workflows WHERE id = ?');
        $st->execute([$workflowId]);
        $src = $st->fetch(PDO::FETCH_ASSOC);
        if (!$src || (int) $src['user_id'] !== $userId) {
            throw new WorkflowPublishError('not_found', "Workflow #{$workflowId} not found", 404);
        }
        $copyId = $this->copyOf($robotId, $workflowId);
        $wasActive = $copyId !== null && $this->isActive($robotId, $copyId);
        if ($wasActive && !$confirmReplace) {
            throw new WorkflowPublishError('replaces',
                "The robot is running \"{$src['name']}\": publishing replaces it while it is active.", 409);
        }
        $replaced = $copyId !== null;
        $outer = !$this->db->inTransaction();
        if ($outer) {
            $this->db->beginTransaction();
        }
        try {
            $map = [];   // the publisher's component id => the robot's
            $servers = [];
            $robotComponent = function (int $id) use ($userId, $robotId, &$map, &$servers): ?int {
                if (!isset($map[$id])) {
                    $c = $this->components->get($userId, $id);
                    if ($c === null) {
                        return null;
                    }
                    $mine = $this->components->save($robotId, null, ['name' => $c['name'], 'description' => $c['description'],
                        'code' => $c['code'], 'exits' => $c['exits'], 'mcp_servers' => $c['mcp_servers'],
                        'timeout_s' => $c['timeout_s'], 'confirm_drop_links' => true]);
                    if ($c['start_trigger'] !== null) {
                        $this->components->setStartTrigger($robotId, $mine['id'], $c['start_trigger']);
                    }
                    $map[$id] = $mine['id'];
                    array_push($servers, ...$c['mcp_servers']);
                }
                return $map[$id];
            };

            $nodes = $this->rows('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id', [$workflowId]);
            foreach ($nodes as &$n) {
                $n['config'] = $this->remapConfig($n, $robotComponent);
            }
            unset($n);

            $copyId = $this->saveWorkflowRow($src, $userId, $robotId, $copyId);
            $this->replaceGraph($workflowId, $copyId, $nodes);
            $this->replaceSchedules($userId, $workflowId, $robotId, $copyId, $robotComponent);
            if ($outer) {
                $this->db->commit();
            }
        } catch (\Throwable $e) {
            if ($outer && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            if ($e instanceof CodeComponentError) {
                throw new WorkflowPublishError($e->kind, $e->getMessage(), $e->status);
            }
            throw $e;
        }
        if ($wasActive) {
            $this->reactivate($robotId, $copyId);
        }
        return ['robot_workflow_id' => $copyId, 'replaced' => $replaced,
            'needs_servers' => $this->missingServers($robotId, $servers)];
    }

    /** The robot's workflows: [{id, name, source_id, published_by, published_at, active}]. */
    public function robotList(int $robotId): array
    {
        $st = $this->db->prepare('SELECT w.id, w.name, w.source_id, w.published_by, w.published_at, a.workflow_id AS active_id
            FROM agent_workflows w LEFT JOIN active_workflows a ON a.user_id = w.user_id AND a.workflow_id = w.id
            WHERE w.user_id = ? ORDER BY w.name, w.id');
        $st->execute([$robotId]);
        return array_map(fn($r) => ['id' => (int) $r['id'], 'name' => (string) $r['name'],
            'source_id' => $r['source_id'] === null ? null : (int) $r['source_id'],
            'published_by' => $r['published_by'] === null ? null : (int) $r['published_by'],
            'published_at' => $r['published_at'], 'active' => $r['active_id'] !== null], $st->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Deactivate the robot's workflow, then delete it with its graph and schedule rows; its components stay. */
    public function unpublish(int $robotId, int $robotWorkflowId): void
    {
        $st = $this->db->prepare('SELECT id FROM agent_workflows WHERE id = ? AND user_id = ?');
        $st->execute([$robotWorkflowId, $robotId]);
        if ($st->fetchColumn() === false) {
            throw new WorkflowPublishError('not_found', "Workflow #{$robotWorkflowId} not found", 404);
        }
        (new ActiveWorkflowService($this->db))->deactivate($robotId, $robotWorkflowId);
        $outer = !$this->db->inTransaction();
        if ($outer) {
            $this->db->beginTransaction();
        }
        try {
            $this->db->prepare('DELETE FROM scheduled_workflows WHERE workflow_id = ? AND user_id = ?')->execute([$robotWorkflowId, $robotId]);
            $this->db->prepare('DELETE FROM workflow_edges WHERE workflow_id = ?')->execute([$robotWorkflowId]);
            $this->db->prepare('DELETE FROM workflow_nodes WHERE workflow_id = ?')->execute([$robotWorkflowId]);
            $this->db->prepare('DELETE FROM agent_workflows WHERE id = ? AND user_id = ?')->execute([$robotWorkflowId, $robotId]);
            if ($outer) {
                $this->db->commit();
            }
        } catch (\Throwable $e) {
            if ($outer && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function copyOf(int $robotId, int $workflowId): ?int
    {
        $st = $this->db->prepare('SELECT id FROM agent_workflows WHERE user_id = ? AND source_id = ? ORDER BY id LIMIT 1');
        $st->execute([$robotId, $workflowId]);
        $id = $st->fetchColumn();
        return $id === false ? null : (int) $id;
    }

    private function isActive(int $robotId, int $copyId): bool
    {
        $st = $this->db->prepare('SELECT 1 FROM active_workflows WHERE user_id = ? AND workflow_id = ?');
        $st->execute([$robotId, $copyId]);
        return $st->fetchColumn() !== false;
    }

    /**
     * The replaced copy was active: activate it again so its active row's mode and trigger are the new copy's. A copy
     * that can no longer be active (no trigger, Start unlinked) is deactivated rather than left on its old mode.
     */
    private function reactivate(int $robotId, int $copyId): void
    {
        $active = new ActiveWorkflowService($this->db);
        try {
            $active->activate($robotId, $copyId);
        } catch (ActiveWorkflowError) {
            $active->deactivate($robotId, $copyId);
        }
    }

    /** The node's config with its component links (a code node's, a Start option) pointing at the robot's rows. */
    private function remapConfig(array $node, callable $robotComponent): ?string
    {
        $cfg = json_decode((string) $node['config'], true);
        if (!is_array($cfg)) {
            return $node['config'];
        }
        $changed = false;
        $link = function (string $key) use (&$cfg, &$changed, $robotComponent): void {
            $id = (int) $cfg[$key];
            $cfg[$key] = $robotComponent($id) ?? throw new WorkflowPublishError('component_missing',
                "Code component #{$id} used by node \"" . ($cfg['name'] ?? $key) . '" is missing: fix the node before publishing.', 422);
            $changed = $changed || $cfg[$key] !== $id;
        };
        if (CodeComponentStore::isCodeNode($node['node_type'] ?? null, $cfg) && !empty($cfg['code_component_id'])) {
            $link('code_component_id');
        }
        if (StartOptionGraph::optionId(['node_type' => $node['node_type'] ?? '', 'config' => $cfg]) !== null) {
            $link('start_option');
        }
        // Nothing remapped: the source's text as it is ({} stays {}, not []).
        return $changed ? json_encode($cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : $node['config'];
    }

    /** Insert the robot's copy, or update it in place; returns its id. */
    private function saveWorkflowRow(array $src, int $userId, int $robotId, ?int $copyId): int
    {
        $cols = array_values(array_diff(array_keys($src), self::WORKFLOW_OWN));
        $vals = array_map(fn($c) => $src[$c], $cols);
        if ($copyId === null) {
            $this->db->prepare('INSERT INTO agent_workflows (' . implode(', ', [...$cols, 'user_id', 'published_by', 'source_id', 'published_at'])
                . ') VALUES (' . str_repeat('?, ', count($cols) + 3) . 'CURRENT_TIMESTAMP)')
                ->execute([...$vals, $robotId, $userId, (int) $src['id']]);
            return (int) $this->db->lastInsertId();
        }
        $set = implode('', array_map(fn($c) => "$c = ?, ", $cols));
        $this->db->prepare("UPDATE agent_workflows SET {$set}published_by = ?, published_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
            ->execute([...$vals, $userId, $copyId, $robotId]);
        return $copyId;
    }

    /** The copy's nodes and edges become the source's (configs already remapped), edges re-pointed at the new nodes. */
    private function replaceGraph(int $workflowId, int $copyId, array $nodes): void
    {
        $this->db->prepare('DELETE FROM workflow_edges WHERE workflow_id = ?')->execute([$copyId]);
        $this->db->prepare('DELETE FROM workflow_nodes WHERE workflow_id = ?')->execute([$copyId]);
        $ids = [];
        foreach ($nodes as $n) {
            $ids[$n['id']] = $this->insertCopy('workflow_nodes', $n, ['id', 'workflow_id', 'created_at'], ['workflow_id' => $copyId]);
        }
        foreach ($this->rows('SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id', [$workflowId]) as $e) {
            if (isset($ids[$e['from_node_id']], $ids[$e['to_node_id']])) {
                $this->insertCopy('workflow_edges', $e, ['id', 'workflow_id', 'created_at', 'from_node_id', 'to_node_id'],
                    ['workflow_id' => $copyId, 'from_node_id' => $ids[$e['from_node_id']], 'to_node_id' => $ids[$e['to_node_id']]]);
            }
        }
    }

    /**
     * The copy's schedule rows become the source's (its start mode): on the robot's component, not yet run. A row on a
     * component that is gone could never run and is not copied.
     */
    private function replaceSchedules(int $userId, int $workflowId, int $robotId, int $copyId, callable $robotComponent): void
    {
        $this->db->prepare('DELETE FROM scheduled_workflows WHERE workflow_id = ? AND user_id = ?')->execute([$copyId, $robotId]);
        foreach ($this->rows('SELECT * FROM scheduled_workflows WHERE workflow_id = ? AND user_id = ? ORDER BY id', [$workflowId, $userId]) as $s) {
            $cid = $s['trigger_component_id'] === null ? null : $robotComponent((int) $s['trigger_component_id']);
            if ($s['trigger_component_id'] !== null && $cid === null) {
                continue;
            }
            $this->insertCopy('scheduled_workflows', $s, self::SCHEDULE_OWN, ['user_id' => $robotId, 'workflow_id' => $copyId,
                'trigger_component_id' => $cid, 'status' => $s['status'] === 'running' ? 'pending' : $s['status']]);
        }
    }

    /** Insert $row into $table without the $skip columns, with $set on top; returns the new id. */
    private function insertCopy(string $table, array $row, array $skip, array $set): int
    {
        $data = array_merge(array_diff_key($row, array_flip($skip)), $set);
        $this->db->prepare("INSERT INTO $table (" . implode(', ', array_keys($data)) . ') VALUES ('
            . implode(', ', array_fill(0, count($data), '?')) . ')')->execute(array_values($data));
        return (int) $this->db->lastInsertId();
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

    private function rows(string $sql, array $args): array
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->fetchAll(PDO::FETCH_ASSOC);
    }
}
