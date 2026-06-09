<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Agent;
use PDO;
use PDOException;

/**
 * Agent Repository
 *
 * Handles CRUD operations and access control for agents.
 *
 * @see docs/agentDesign.md
 */
class AgentRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Find an agent by ID
     */
    public function findById(int $id): ?Agent
    {
        $stmt = $this->db->prepare("SELECT * FROM agents WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ? new Agent($row) : null;
    }

    /**
     * Find an agent by name for a specific user
     */
    public function findByName(string $name, int $userId): ?Agent
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agents
             WHERE name = ?
             AND (user_id = ? OR visibility = 'public' OR visibility = 'workspace')
             AND enabled = 1
             LIMIT 1"
        );
        $stmt->execute([$name, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ? new Agent($row) : null;
    }

    /**
     * Find all agents accessible by a user
     */
    public function findAccessibleByUser(int $userId, array $filters = []): array
    {
        $sql = "SELECT * FROM agents WHERE (
            user_id = :user_id
            OR visibility = 'public'
            OR visibility = 'workspace'
        ) AND enabled = 1";

        $params = ['user_id' => $userId];

        // Filter by agent type
        if (!empty($filters['agent_type'])) {
            $sql .= " AND agent_type = :agent_type";
            $params['agent_type'] = $filters['agent_type'];
        }

        // Filter by provider
        if (!empty($filters['provider'])) {
            $sql .= " AND provider = :provider";
            $params['provider'] = $filters['provider'];
        }

        // Filter by visibility
        if (!empty($filters['visibility'])) {
            $sql .= " AND visibility = :visibility";
            $params['visibility'] = $filters['visibility'];
        }

        // Search by name
        if (!empty($filters['search'])) {
            $sql .= " AND (name LIKE :search OR description LIKE :search_desc)";
            $params['search'] = '%' . $filters['search'] . '%';
            $params['search_desc'] = '%' . $filters['search'] . '%';
        }

        // Filter by category. Special value '__none__' selects uncategorized
        // (NULL) agents. Any other string is an exact match.
        if (array_key_exists('category', $filters) && $filters['category'] !== null) {
            if ($filters['category'] === '__none__' || $filters['category'] === '') {
                $sql .= " AND category IS NULL";
            } else {
                $sql .= " AND category = :category";
                $params['category'] = $filters['category'];
            }
        }

        $sql .= " ORDER BY name ASC";

        // Pagination
        if (!empty($filters['limit'])) {
            $sql .= " LIMIT " . (int) $filters['limit'];
            if (!empty($filters['offset'])) {
                $sql .= " OFFSET " . (int) $filters['offset'];
            }
        }

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return array_map(
            fn($row) => new Agent($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Find worker agents that a manager can delegate to
     */
    public function findWorkerAgents(int $managerId): array
    {
        $manager = $this->findById($managerId);
        if (!$manager || !$manager->isManager()) {
            return [];
        }

        $canDelegateTo = $manager->getCanDelegateTo();

        if (empty($canDelegateTo)) {
            // Can delegate to all enabled workers
            $stmt = $this->db->prepare(
                "SELECT * FROM agents
                 WHERE agent_type IN ('worker', 'standard')
                 AND enabled = 1
                 ORDER BY display_order ASC, name ASC"
            );
            $stmt->execute();
        } else {
            // Can only delegate to specified agents, preserve display_order
            $placeholders = implode(',', array_fill(0, count($canDelegateTo), '?'));
            $stmt = $this->db->prepare(
                "SELECT * FROM agents
                 WHERE id IN ({$placeholders})
                 AND enabled = 1
                 ORDER BY display_order ASC, name ASC"
            );
            $stmt->execute($canDelegateTo);
        }

        return array_map(
            fn($row) => new Agent($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Get the execution pipeline for a manager agent
     *
     * Returns workers in display_order sequence for state machine execution.
     * The pipeline defines the order in which agents must be called.
     *
     * @param int $managerId The manager agent ID
     * @return array Array of pipeline steps with agent info
     */
    public function getPipelineForManager(int $managerId): array
    {
        $workers = $this->findWorkerAgents($managerId);

        $pipeline = [];
        foreach ($workers as $index => $agent) {
            $pipeline[] = [
                'step' => $index,
                'agent_id' => $agent->getId(),
                'agent_name' => $agent->getName(),
                'agent_type' => $agent->getAgentType(),
                'description' => $agent->getDescription(),
            ];
        }

        return $pipeline;
    }

    /**
     * Find agents by user ID (owned by user)
     */
    public function findByUserId(int $userId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agents WHERE user_id = ? ORDER BY name ASC"
        );
        $stmt->execute([$userId]);

        return array_map(
            fn($row) => new Agent($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Find agents by team ID
     */
    public function findByTeamId(int $teamId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agents WHERE team_id = ? AND enabled = 1 ORDER BY display_order ASC, name ASC"
        );
        $stmt->execute([$teamId]);

        return array_map(
            fn($row) => new Agent($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Find agents by team ID with pipeline position info
     *
     * Returns agents with additional pipeline metadata:
     * - pipeline_position: Position in execution order (null for managers)
     * - is_pipeline_head: True if this is the first worker in pipeline
     * - is_pipeline_tail: True if this is the last worker in pipeline
     *
     * @param int $teamId Team ID
     * @return array Array of agents with pipeline info
     */
    public function findByTeamIdWithPipelineInfo(int $teamId): array
    {
        $agents = $this->findByTeamId($teamId);

        if (empty($agents)) {
            return [];
        }

        // Separate managers and workers
        $managers = [];
        $workers = [];

        foreach ($agents as $agent) {
            if ($agent->isManager()) {
                $managers[] = $agent;
            } else {
                $workers[] = $agent;
            }
        }

        // Build result with pipeline info
        $result = [];
        $workerCount = count($workers);

        // Add managers first (no pipeline position)
        foreach ($managers as $agent) {
            $result[] = [
                'agent' => $agent,
                'pipeline_position' => null,
                'pipeline_label' => 'Manager',
                'is_pipeline_head' => false,
                'is_pipeline_tail' => false,
                'can_reorder' => false,  // Managers stay at top
            ];
        }

        // Add workers with pipeline position
        foreach ($workers as $index => $agent) {
            $position = $index + 1;
            $result[] = [
                'agent' => $agent,
                'pipeline_position' => $position,
                'pipeline_label' => "Step {$position}" . ($workerCount > 1 ? " of {$workerCount}" : ''),
                'is_pipeline_head' => $index === 0,
                'is_pipeline_tail' => $index === $workerCount - 1,
                'can_reorder' => true,
            ];
        }

        return $result;
    }

    /**
     * Create a new agent
     */
    public function create(Agent $agent): Agent
    {
        $sql = "INSERT INTO agents (
            user_id, team_id, category, name, description,
            agent_type, parent_agent_id, can_delegate_to, display_order,
            provider, model, instructions,
            tools, visibility, enabled, settings
        ) VALUES (
            :user_id, :team_id, :category, :name, :description,
            :agent_type, :parent_agent_id, :can_delegate_to, :display_order,
            :provider, :model, :instructions,
            :tools, :visibility, :enabled, :settings
        )";

        $data = $agent->toArray();

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'user_id' => $data['user_id'],
            'team_id' => $data['team_id'],
            'category' => $data['category'],
            'name' => $data['name'],
            'description' => $data['description'],
            'agent_type' => $data['agent_type'],
            'parent_agent_id' => $data['parent_agent_id'],
            'can_delegate_to' => json_encode($data['can_delegate_to']),
            'display_order' => $data['display_order'],
            'provider' => $data['provider'],
            'model' => $data['model'],
            'instructions' => $data['instructions'],
            'tools' => json_encode($data['tools']),
            'visibility' => $data['visibility'],
            'enabled' => $data['enabled'] ? 1 : 0,
            'settings' => json_encode($data['settings']),
        ]);

        $id = (int) $this->db->lastInsertId();
        return $this->findById($id);
    }

    /**
     * Update an existing agent
     */
    public function update(Agent $agent): Agent
    {
        $sql = "UPDATE agents SET
            team_id = :team_id,
            category = :category,
            name = :name,
            description = :description,
            agent_type = :agent_type,
            parent_agent_id = :parent_agent_id,
            can_delegate_to = :can_delegate_to,
            display_order = :display_order,
            provider = :provider,
            model = :model,
            instructions = :instructions,
            tools = :tools,
            visibility = :visibility,
            enabled = :enabled,
            settings = :settings
            WHERE id = :id";

        $data = $agent->toArray();

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'id' => $data['id'],
            'team_id' => $data['team_id'],
            'category' => $data['category'],
            'name' => $data['name'],
            'description' => $data['description'],
            'agent_type' => $data['agent_type'],
            'parent_agent_id' => $data['parent_agent_id'],
            'can_delegate_to' => json_encode($data['can_delegate_to']),
            'display_order' => $data['display_order'],
            'provider' => $data['provider'],
            'model' => $data['model'],
            'instructions' => $data['instructions'],
            'tools' => json_encode($data['tools']),
            'visibility' => $data['visibility'],
            'enabled' => $data['enabled'] ? 1 : 0,
            'settings' => json_encode($data['settings']),
        ]);

        return $this->findById($agent->getId());
    }

    /**
     * List distinct category names for a user (NULL categories excluded).
     * Used to render the container tree.
     *
     * @return string[]
     */
    public function findDistinctCategories(int $userId): array
    {
        $stmt = $this->db->prepare(
            "SELECT DISTINCT category FROM agents
             WHERE user_id = ? AND category IS NOT NULL AND category <> ''
             ORDER BY category ASC"
        );
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN, 0);
    }

    /**
     * Bulk-rename a category across all of a user's agents.
     * Returns the number of rows affected.
     */
    public function renameCategory(int $userId, string $oldName, string $newName): int
    {
        if ($oldName === '' || $newName === '') {
            return 0;
        }
        $stmt = $this->db->prepare(
            "UPDATE agents SET category = :new
             WHERE user_id = :user_id AND category = :old"
        );
        $stmt->execute([
            'new' => $newName,
            'user_id' => $userId,
            'old' => $oldName,
        ]);
        return $stmt->rowCount();
    }

    /**
     * Clear a category from all of the user's agents (agents fall back to
     * root/uncategorized). Returns the number of rows affected.
     */
    public function clearCategory(int $userId, string $name): int
    {
        if ($name === '') {
            return 0;
        }
        $stmt = $this->db->prepare(
            "UPDATE agents SET category = NULL
             WHERE user_id = :user_id AND category = :name"
        );
        $stmt->execute([
            'user_id' => $userId,
            'name' => $name,
        ]);
        return $stmt->rowCount();
    }

    /**
     * Delete an agent
     */
    public function delete(int $id): bool
    {
        $stmt = $this->db->prepare("DELETE FROM agents WHERE id = ?");
        return $stmt->execute([$id]);
    }

    /**
     * Check if a user can access an agent
     */
    public function canUserAccess(int $userId, int $agentId): bool
    {
        $agent = $this->findById($agentId);
        if (!$agent) {
            return false;
        }

        // Owner always has access
        if ($agent->getUserId() === $userId) {
            return true;
        }

        // Public agents are accessible to all
        if ($agent->getVisibility() === 'public') {
            return true;
        }

        // Workspace visibility - simplified (no workspace membership check)
        if ($agent->getVisibility() === 'workspace') {
            return true; // TODO: Add proper workspace membership check
        }

        return false;
    }

    /**
     * Check if a user owns an agent
     */
    public function isOwner(int $userId, int $agentId): bool
    {
        $agent = $this->findById($agentId);
        return $agent && $agent->getUserId() === $userId;
    }

    /**
     * Count agents for a user
     */
    public function countByUser(int $userId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) FROM agents WHERE user_id = ?"
        );
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Count all accessible agents for a user
     */
    public function countAccessible(int $userId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) FROM agents
             WHERE (user_id = ? OR visibility IN ('public', 'workspace'))
             AND enabled = 1"
        );
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Get agent execution statistics
     */
    public function getAgentStats(int $agentId): array
    {
        $stmt = $this->db->prepare(
            "SELECT
                COUNT(*) as total_executions,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(tokens_used) as total_tokens,
                SUM(cost_usd) as total_cost,
                AVG(response_time_ms) as avg_response_time
             FROM agent_executions
             WHERE agent_id = ?"
        );
        $stmt->execute([$agentId]);
        $stats = $stmt->fetch(PDO::FETCH_ASSOC);

        return [
            'total_executions' => (int) ($stats['total_executions'] ?? 0),
            'successful' => (int) ($stats['successful'] ?? 0),
            'failed' => (int) ($stats['failed'] ?? 0),
            'total_tokens' => (int) ($stats['total_tokens'] ?? 0),
            'total_cost' => (float) ($stats['total_cost'] ?? 0),
            'avg_response_time_ms' => (float) ($stats['avg_response_time'] ?? 0),
        ];
    }

    /**
     * Duplicate an agent
     */
    public function duplicate(int $agentId, int $newUserId, ?string $newName = null): ?Agent
    {
        $original = $this->findById($agentId);
        if (!$original) {
            return null;
        }

        $copy = new Agent($original->toArray());
        $copy->setUserId($newUserId);
        $copy->setName($newName ?? $original->getName() . ' (Copy)');
        $copy->setVisibility('personal');

        return $this->create($copy);
    }

    /**
     * Update display order for multiple agents in a team
     *
     * IMPORTANT: Manager agents are ALWAYS enforced at position 0.
     * The pipeline executes workers in display_order sequence (top to bottom).
     *
     * @param array $orderedIds Array of agent IDs in the desired order
     * @param int $teamId The team ID these agents belong to
     * @return array Result with success status and optional error/reordered IDs
     */
    public function updateAgentOrder(array $orderedIds, int $teamId): array
    {
        error_log("[REORDER] updateAgentOrder called: teamId={$teamId}, agentIds=" . json_encode($orderedIds));

        try {
            // Load all agents to check types
            $agents = [];
            $managerIds = [];
            $workerIds = [];

            foreach ($orderedIds as $agentId) {
                $agent = $this->findById((int) $agentId);
                if ($agent) {
                    $agentTeamId = $agent->getTeamId();
                    error_log("[REORDER] Agent {$agentId}: teamId={$agentTeamId}, expected={$teamId}, match=" . ($agentTeamId === $teamId ? 'YES' : 'NO'));

                    if ($agentTeamId === $teamId) {
                        $agents[$agentId] = $agent;
                        if ($agent->isManager()) {
                            $managerIds[] = $agentId;
                        } else {
                            $workerIds[] = $agentId;
                        }
                    }
                } else {
                    error_log("[REORDER] Agent {$agentId} not found!");
                }
            }

            // Enforce: managers first, then workers in their submitted order
            // This ensures manager is always at the top of the stack
            $enforcedOrder = array_merge($managerIds, $workerIds);

            error_log("[REORDER] Enforced order: " . json_encode($enforcedOrder));

            $this->db->beginTransaction();

            $stmt = $this->db->prepare(
                "UPDATE agents SET display_order = ? WHERE id = ? AND team_id = ?"
            );

            foreach ($enforcedOrder as $order => $agentId) {
                $stmt->execute([$order, (int) $agentId, $teamId]);
                error_log("[REORDER] Updated agent {$agentId} to display_order={$order}");
            }

            $this->db->commit();
            error_log("[REORDER] Transaction committed successfully");

            // Check if order was modified (manager was moved)
            $wasReordered = $orderedIds !== $enforcedOrder;

            return [
                'success' => true,
                'reordered' => $wasReordered,
                'enforced_order' => $enforcedOrder,
                'message' => $wasReordered
                    ? 'Order adjusted: Manager must remain at the top of the pipeline'
                    : null,
            ];
        } catch (PDOException $e) {
            $this->db->rollBack();
            error_log("Failed to update agent order: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to update agent order',
            ];
        }
    }

    /**
     * Move an agent up in the display order within its team
     *
     * @param int $agentId The agent to move
     * @return bool Success status
     */
    public function moveAgentUp(int $agentId): bool
    {
        $agent = $this->findById($agentId);
        if (!$agent || $agent->getTeamId() === null) {
            return false;
        }

        $teamAgents = $this->findByTeamId($agent->getTeamId());
        $currentIndex = -1;

        foreach ($teamAgents as $index => $teamAgent) {
            if ($teamAgent->getId() === $agentId) {
                $currentIndex = $index;
                break;
            }
        }

        // Already at top or not found
        if ($currentIndex <= 0) {
            return false;
        }

        // Swap with previous agent
        $prevAgent = $teamAgents[$currentIndex - 1];
        $prevOrder = $prevAgent->getDisplayOrder();
        $currentOrder = $agent->getDisplayOrder();

        try {
            $this->db->beginTransaction();

            $stmt = $this->db->prepare("UPDATE agents SET display_order = ? WHERE id = ?");
            $stmt->execute([$prevOrder, $agentId]);
            $stmt->execute([$currentOrder, $prevAgent->getId()]);

            $this->db->commit();
            return true;
        } catch (PDOException $e) {
            $this->db->rollBack();
            error_log("Failed to move agent up: " . $e->getMessage());
            return false;
        }
    }

    /**
     * Move an agent down in the display order within its team
     *
     * @param int $agentId The agent to move
     * @return bool Success status
     */
    public function moveAgentDown(int $agentId): bool
    {
        $agent = $this->findById($agentId);
        if (!$agent || $agent->getTeamId() === null) {
            return false;
        }

        $teamAgents = $this->findByTeamId($agent->getTeamId());
        $currentIndex = -1;

        foreach ($teamAgents as $index => $teamAgent) {
            if ($teamAgent->getId() === $agentId) {
                $currentIndex = $index;
                break;
            }
        }

        // Already at bottom or not found
        if ($currentIndex < 0 || $currentIndex >= count($teamAgents) - 1) {
            return false;
        }

        // Swap with next agent
        $nextAgent = $teamAgents[$currentIndex + 1];
        $nextOrder = $nextAgent->getDisplayOrder();
        $currentOrder = $agent->getDisplayOrder();

        try {
            $this->db->beginTransaction();

            $stmt = $this->db->prepare("UPDATE agents SET display_order = ? WHERE id = ?");
            $stmt->execute([$nextOrder, $agentId]);
            $stmt->execute([$currentOrder, $nextAgent->getId()]);

            $this->db->commit();
            return true;
        } catch (PDOException $e) {
            $this->db->rollBack();
            error_log("Failed to move agent down: " . $e->getMessage());
            return false;
        }
    }
}
