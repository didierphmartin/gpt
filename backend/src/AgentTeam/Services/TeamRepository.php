<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Team;
use PDO;

/**
 * Team Repository
 *
 * Handles CRUD operations for teams.
 *
 * @see docs/agentDesign.md
 */
class TeamRepository
{
    private PDO $db;
    private AgentRepository $agentRepository;

    public function __construct(PDO $db, ?AgentRepository $agentRepository = null)
    {
        $this->db = $db;
        $this->agentRepository = $agentRepository ?? new AgentRepository($db);
    }

    /**
     * Find a team by ID
     */
    public function findById(int $id): ?Team
    {
        $stmt = $this->db->prepare("SELECT * FROM agent_teams WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ? new Team($row) : null;
    }

    /**
     * Find a team by ID with its agents (includes pipeline info)
     */
    public function findByIdWithAgents(int $id): ?Team
    {
        $team = $this->findById($id);
        if (!$team) {
            return null;
        }

        // Get agents with pipeline position info
        $agentsWithInfo = $this->agentRepository->findByTeamIdWithPipelineInfo($id);
        $team->setAgentsWithPipelineInfo($agentsWithInfo);

        return $team;
    }

    /**
     * Find all teams for a user
     */
    public function findByUser(int $userId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agent_teams WHERE user_id = ? ORDER BY name ASC"
        );
        $stmt->execute([$userId]);

        return array_map(
            fn($row) => new Team($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Find all teams for a user with their agents (includes pipeline info)
     */
    public function findByUserWithAgents(int $userId): array
    {
        $teams = $this->findByUser($userId);

        foreach ($teams as $team) {
            // Get agents with pipeline position info
            $agentsWithInfo = $this->agentRepository->findByTeamIdWithPipelineInfo($team->getId());
            $team->setAgentsWithPipelineInfo($agentsWithInfo);
        }

        return $teams;
    }

    /**
     * Create a new team
     */
    public function create(Team $team): Team
    {
        $sql = "INSERT INTO agent_teams (user_id, workspace_id, name, description)
                VALUES (:user_id, :workspace_id, :name, :description)";

        $data = $team->toArray();

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'user_id' => $data['user_id'],
            'workspace_id' => $data['workspace_id'],
            'name' => $data['name'],
            'description' => $data['description'],
        ]);

        $id = (int) $this->db->lastInsertId();
        return $this->findById($id);
    }

    /**
     * Update an existing team
     */
    public function update(Team $team): Team
    {
        $sql = "UPDATE agent_teams SET
                name = :name,
                description = :description,
                workspace_id = :workspace_id
                WHERE id = :id";

        $data = $team->toArray();

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'id' => $data['id'],
            'name' => $data['name'],
            'description' => $data['description'],
            'workspace_id' => $data['workspace_id'],
        ]);

        return $this->findById($team->getId());
    }

    /**
     * Delete a team and all its agents
     */
    public function delete(int $id): bool
    {
        // First, delete all agents in this team
        $stmt = $this->db->prepare("DELETE FROM agents WHERE team_id = ?");
        $stmt->execute([$id]);

        // Then delete the team
        $stmt = $this->db->prepare("DELETE FROM agent_teams WHERE id = ?");
        return $stmt->execute([$id]);
    }

    /**
     * Check if a user can access a team
     */
    public function canUserAccess(int $userId, int $teamId): bool
    {
        $team = $this->findById($teamId);
        if (!$team) {
            return false;
        }

        // Owner always has access
        return $team->getUserId() === $userId;
    }

    /**
     * Check if a user owns a team
     */
    public function isOwner(int $userId, int $teamId): bool
    {
        $team = $this->findById($teamId);
        return $team && $team->getUserId() === $userId;
    }

    /**
     * Count teams for a user
     */
    public function countByUser(int $userId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) FROM agent_teams WHERE user_id = ?"
        );
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Count agents in a team
     */
    public function countAgents(int $teamId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) FROM agents WHERE team_id = ? AND enabled = 1"
        );
        $stmt->execute([$teamId]);
        return (int) $stmt->fetchColumn();
    }
}
