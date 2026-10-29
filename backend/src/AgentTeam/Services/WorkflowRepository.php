<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Workflow;
use PDO;

/**
 * Workflow Repository
 *
 * Handles CRUD operations for workflows.
 *
 * @see docs/agentDesign.md
 */
class WorkflowRepository
{
    private PDO $db;
    private ?WorkflowGraphRepository $graphRepository = null;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->graphRepository = new WorkflowGraphRepository($db);
    }

    /**
     * Get the graph repository
     */
    public function getGraphRepository(): WorkflowGraphRepository
    {
        return $this->graphRepository;
    }

    /**
     * Find a workflow by ID
     *
     * @param bool $includeGraph Whether to include nodes/edges graph data
     */
    public function findById(int $id, bool $includeGraph = false): ?Workflow
    {
        $stmt = $this->db->prepare("SELECT * FROM agent_workflows WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            return null;
        }

        $workflow = new Workflow($row);

        // Optionally load graph data
        if ($includeGraph) {
            $graph = $this->graphRepository->getGraphForFrontend($id);
            $workflow->setGraph($graph);
        }

        return $workflow;
    }

    /**
     * Find all workflows for a user
     */
    public function findByUser(int $userId, bool $includeGraph = false, ?int $robotId = null): array
    {
        $stmt = $this->db->prepare(
            $robotId === null
                ? "SELECT * FROM agent_workflows WHERE user_id = ? ORDER BY name ASC"
                : "SELECT * FROM agent_workflows WHERE user_id = ? OR user_id = ? ORDER BY name ASC"
        );
        $stmt->execute($robotId === null ? [$userId] : [$userId, $robotId]);

        return array_map(
            function ($row) use ($includeGraph) {
                $workflow = new Workflow($row);
                if ($includeGraph) {
                    $graph = $this->graphRepository->getGraphForFrontend($workflow->getId());
                    $workflow->setGraph($graph);
                }
                return $workflow;
            },
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Find enabled workflows for a user
     */
    public function findEnabledByUser(int $userId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agent_workflows WHERE user_id = ? AND enabled = 1 ORDER BY name ASC"
        );
        $stmt->execute([$userId]);

        return array_map(
            fn($row) => new Workflow($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Find workflows by trigger type
     */
    public function findByTriggerType(int $userId, string $triggerType): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agent_workflows
             WHERE user_id = ? AND enabled = 1
             AND JSON_CONTAINS(triggers, JSON_OBJECT('type', ?))
             ORDER BY name ASC"
        );
        $stmt->execute([$userId, $triggerType]);

        return array_map(
            fn($row) => new Workflow($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Create a new workflow
     */
    public function create(Workflow $workflow): Workflow
    {
        $sql = "INSERT INTO agent_workflows (user_id, workspace_id, name, description, steps, triggers, variables, enabled, output_storage_enabled, output_folder, orchestration)
                VALUES (:user_id, :workspace_id, :name, :description, :steps, :triggers, :variables, :enabled, :output_storage_enabled, :output_folder, :orchestration)";

        $data = $workflow->toArray();

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'user_id' => $data['user_id'],
            'workspace_id' => $data['workspace_id'],
            'name' => $data['name'],
            'description' => $data['description'],
            'steps' => json_encode($data['steps']),
            'triggers' => json_encode($data['triggers']),
            'variables' => json_encode($data['variables']),
            'enabled' => $data['enabled'] ? 1 : 0,
            'output_storage_enabled' => $data['output_storage_enabled'] ? 1 : 0,
            'output_folder' => $data['output_folder'],
            'orchestration' => $data['orchestration'] ?? 'workflow',
        ]);

        $id = (int) $this->db->lastInsertId();
        return $this->findById($id);
    }

    /**
     * Update an existing workflow
     */
    public function update(Workflow $workflow): Workflow
    {
        $sql = "UPDATE agent_workflows SET
                name = :name,
                description = :description,
                steps = :steps,
                triggers = :triggers,
                variables = :variables,
                enabled = :enabled,
                workspace_id = :workspace_id,
                output_storage_enabled = :output_storage_enabled,
                output_folder = :output_folder,
                orchestration = :orchestration
                WHERE id = :id";

        $data = $workflow->toArray();

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'id' => $data['id'],
            'name' => $data['name'],
            'description' => $data['description'],
            'steps' => json_encode($data['steps']),
            'triggers' => json_encode($data['triggers']),
            'variables' => json_encode($data['variables']),
            'enabled' => $data['enabled'] ? 1 : 0,
            'workspace_id' => $data['workspace_id'],
            'output_storage_enabled' => $data['output_storage_enabled'] ? 1 : 0,
            'output_folder' => $data['output_folder'],
            'orchestration' => $data['orchestration'] ?? 'workflow',
        ]);

        return $this->findById($workflow->getId());
    }

    /**
     * Delete a workflow and its schedules. scheduled_workflows is MyISAM (no foreign key, no transaction):
     * the workflow goes first, so a failure in between leaves an orphan schedule rather than a workflow
     * that lost its schedule.
     */
    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare("DELETE FROM agent_workflows WHERE id = ?");
        if (!$stmt->execute([$id])) {
            return false;
        }
        return $this->db->prepare("DELETE FROM scheduled_workflows WHERE workflow_id = ?")->execute([$id]);
    }

    /**
     * Check if a user can access a workflow
     */
    public function canUserAccess(int $userId, int $workflowId, ?int $robotId = null): bool
    {
        $workflow = $this->findById($workflowId);
        if (!$workflow) {
            return false;
        }

        return $workflow->getUserId() === $userId || ($robotId !== null && $workflow->getUserId() === $robotId);
    }

    /**
     * Check if a user owns a workflow
     */
    public function isOwner(int $userId, int $workflowId, ?int $robotId = null): bool
    {
        $workflow = $this->findById($workflowId);
        return $workflow && ($workflow->getUserId() === $userId || ($robotId !== null && $workflow->getUserId() === $robotId));
    }

    /**
     * Count workflows for a user
     */
    public function countByUser(int $userId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) FROM agent_workflows WHERE user_id = ?"
        );
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Toggle workflow enabled state
     */
    public function toggleEnabled(int $id): bool
    {
        $stmt = $this->db->prepare(
            "UPDATE agent_workflows SET enabled = NOT enabled WHERE id = ?"
        );
        return $stmt->execute([$id]);
    }

    /**
     * Copy a workflow for $newUserId: the row, every node and edge (raw rows, ids remapped, so component and
     * playbook links stay as they are) and its schedules, paused. No active_workflows row: a copy starts inactive.
     * Name: "<name> (Copy)", then "(Copy 2)", "(Copy 3)"... until free for that owner.
     */
    public function duplicate(int $workflowId, int $newUserId, ?string $newName = null): ?Workflow
    {
        $original = $this->findById($workflowId);
        if (!$original) {
            return null;
        }

        $copy = new Workflow($original->toArray());
        $copy->setUserId($newUserId);
        $copy->setName($newName ?? $this->freeCopyName($original->getName(), $newUserId));

        $this->db->beginTransaction();
        try {
            $created = $this->create($copy);
            $newId = $created->getId();

            $nodeMap = [];
            $nodes = $this->db->prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id');
            $nodes->execute([$workflowId]);
            $insertNode = $this->db->prepare(
                'INSERT INTO workflow_nodes (workflow_id, node_type, agent_id, config, pos_x, pos_y, drawflow_node_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            foreach ($nodes->fetchAll(PDO::FETCH_ASSOC) as $n) {
                $insertNode->execute([$newId, $n['node_type'], $n['agent_id'], $n['config'], $n['pos_x'], $n['pos_y'], $n['drawflow_node_id']]);
                $nodeMap[(int) $n['id']] = (int) $this->db->lastInsertId();
            }

            $edges = $this->db->prepare('SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id');
            $edges->execute([$workflowId]);
            $insertEdge = $this->db->prepare(
                'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr)
                 VALUES (?, ?, ?, ?, ?, ?)'
            );
            foreach ($edges->fetchAll(PDO::FETCH_ASSOC) as $e) {
                $from = $nodeMap[(int) $e['from_node_id']] ?? null;
                $to = $nodeMap[(int) $e['to_node_id']] ?? null;
                if ($from === null || $to === null) {
                    continue;
                }
                $insertEdge->execute([$newId, $from, $to, $e['from_port'], $e['to_port'], $e['condition_expr']]);
            }
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }

        $this->copySchedules($workflowId, $newId, $newUserId);
        return $created;
    }

    private function freeCopyName(string $name, int $userId): string
    {
        $taken = $this->db->prepare('SELECT 1 FROM agent_workflows WHERE user_id = ? AND name = ?');
        for ($n = 1;; $n++) {
            $candidate = $name . ($n === 1 ? ' (Copy)' : " (Copy $n)");
            $taken->execute([$userId, $candidate]);
            if (!$taken->fetchColumn()) {
                return $candidate;
            }
        }
    }

    /** The source's schedules, as the copier's and paused (a copy never fires on its own). */
    private function copySchedules(int $fromWorkflowId, int $toWorkflowId, int $userId): void
    {
        $rows = $this->db->prepare('SELECT * FROM scheduled_workflows WHERE workflow_id = ? ORDER BY id');
        $rows->execute([$fromWorkflowId]);
        $insert = $this->db->prepare(
            "INSERT INTO scheduled_workflows (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type,
                repeat_interval, cron, event_trigger, trigger_component_id, next_run)
             VALUES (?, ?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?)"
        );
        foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $insert->execute([$userId, $toWorkflowId, $r['input_prompt'], $r['scheduled_time'], $r['repeat_type'],
                $r['repeat_interval'], $r['cron'], $r['event_trigger'], $r['trigger_component_id'], $r['next_run']]);
        }
    }
}
