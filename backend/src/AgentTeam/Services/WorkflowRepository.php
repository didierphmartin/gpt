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
    public function findByUser(int $userId, bool $includeGraph = false): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agent_workflows WHERE user_id = ? ORDER BY name ASC"
        );
        $stmt->execute([$userId]);

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
        $sql = "INSERT INTO agent_workflows (user_id, workspace_id, name, description, steps, triggers, variables, enabled, output_storage_enabled, output_folder)
                VALUES (:user_id, :workspace_id, :name, :description, :steps, :triggers, :variables, :enabled, :output_storage_enabled, :output_folder)";

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
                output_folder = :output_folder
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
        ]);

        return $this->findById($workflow->getId());
    }

    /**
     * Delete a workflow
     */
    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare("DELETE FROM agent_workflows WHERE id = ?");
        return $stmt->execute([$id]);
    }

    /**
     * Check if a user can access a workflow
     */
    public function canUserAccess(int $userId, int $workflowId): bool
    {
        $workflow = $this->findById($workflowId);
        if (!$workflow) {
            return false;
        }

        return $workflow->getUserId() === $userId;
    }

    /**
     * Check if a user owns a workflow
     */
    public function isOwner(int $userId, int $workflowId): bool
    {
        $workflow = $this->findById($workflowId);
        return $workflow && $workflow->getUserId() === $userId;
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
     * Duplicate a workflow
     */
    public function duplicate(int $workflowId, int $newUserId, ?string $newName = null): ?Workflow
    {
        $original = $this->findById($workflowId);
        if (!$original) {
            return null;
        }

        $copy = new Workflow($original->toArray());
        $copy->setUserId($newUserId);
        $copy->setName($newName ?? $original->getName() . ' (Copy)');

        return $this->create($copy);
    }
}
