<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\Team;
use AgentTeam\Services\TeamRepository;
use AgentTeam\Services\AgentRepository;
use PDO;

/**
 * Team Controller
 *
 * Handles REST API endpoints for team management.
 *
 * @see docs/agentDesign.md
 */
class TeamController
{
    private PDO $db;
    private array $config;
    private TeamRepository $teamRepository;
    private AgentRepository $agentRepository;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->agentRepository = new AgentRepository($db);
        $this->teamRepository = new TeamRepository($db, $this->agentRepository);
    }

    /**
     * GET /api/v1/teams
     * List all teams for the authenticated user
     */
    public function index(array $request): array
    {
        $userId = $request['user_id'] ?? 0;

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            $teams = $this->teamRepository->findByUserWithAgents($userId);

            return [
                'success' => true,
                'data' => array_map(
                    fn($team) => $team->toArrayWithAgents(),
                    $teams
                ),
                'count' => count($teams),
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * POST /api/v1/teams
     * Create a new team
     */
    public function create(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        // Validate required fields
        if (empty($body['name'])) {
            return [
                'success' => false,
                'error' => 'Team name is required',
                'status_code' => 400
            ];
        }

        try {
            $team = new Team();
            $team->setUserId($userId)
                 ->setName($body['name'])
                 ->setDescription($body['description'] ?? '')
                 ->setWorkspaceId($body['workspace_id'] ?? null);

            $created = $this->teamRepository->create($team);

            return [
                'success' => true,
                'data' => $created->toArray(),
                'message' => 'Team created successfully',
                'status_code' => 201
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/teams/{id}
     * Get a specific team with its agents
     */
    public function show(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $teamId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$teamId) {
            return [
                'success' => false,
                'error' => 'Team ID is required',
                'status_code' => 400
            ];
        }

        try {
            // Check access
            if (!$this->teamRepository->canUserAccess($userId, $teamId)) {
                return [
                    'success' => false,
                    'error' => 'Team not found or access denied',
                    'status_code' => 404
                ];
            }

            $team = $this->teamRepository->findByIdWithAgents($teamId);

            if (!$team) {
                return [
                    'success' => false,
                    'error' => 'Team not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'data' => $team->toArrayWithAgents(),
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * PUT /api/v1/teams/{id}
     * Update a team
     */
    public function update(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $teamId = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$teamId) {
            return [
                'success' => false,
                'error' => 'Team ID is required',
                'status_code' => 400
            ];
        }

        try {
            // Check ownership
            if (!$this->teamRepository->isOwner($userId, $teamId)) {
                return [
                    'success' => false,
                    'error' => 'Team not found or access denied',
                    'status_code' => 404
                ];
            }

            $team = $this->teamRepository->findById($teamId);

            if (!$team) {
                return [
                    'success' => false,
                    'error' => 'Team not found',
                    'status_code' => 404
                ];
            }

            // Update fields
            if (isset($body['name'])) {
                $team->setName($body['name']);
            }
            if (isset($body['description'])) {
                $team->setDescription($body['description']);
            }
            if (isset($body['workspace_id'])) {
                $team->setWorkspaceId($body['workspace_id']);
            }

            $updated = $this->teamRepository->update($team);

            return [
                'success' => true,
                'data' => $updated->toArray(),
                'message' => 'Team updated successfully',
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * DELETE /api/v1/teams/{id}
     * Delete a team
     */
    public function destroy(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $teamId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$teamId) {
            return [
                'success' => false,
                'error' => 'Team ID is required',
                'status_code' => 400
            ];
        }

        try {
            // Check ownership
            if (!$this->teamRepository->isOwner($userId, $teamId)) {
                return [
                    'success' => false,
                    'error' => 'Team not found or access denied',
                    'status_code' => 404
                ];
            }

            $this->teamRepository->delete($teamId);

            return [
                'success' => true,
                'message' => 'Team deleted successfully',
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/teams/{id}/agents
     * List all agents in a team with pipeline info
     *
     * Pipeline info includes:
     * - pipeline_position: Position in execution order (null for managers)
     * - pipeline_label: Human-readable label (e.g., "Step 1 of 3")
     * - can_reorder: Whether agent can be reordered (managers always stay at top)
     */
    public function agents(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $teamId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$teamId) {
            return [
                'success' => false,
                'error' => 'Team ID is required',
                'status_code' => 400
            ];
        }

        try {
            // Check access
            if (!$this->teamRepository->canUserAccess($userId, $teamId)) {
                return [
                    'success' => false,
                    'error' => 'Team not found or access denied',
                    'status_code' => 404
                ];
            }

            // Get agents with pipeline info
            $agentsWithInfo = $this->agentRepository->findByTeamIdWithPipelineInfo($teamId);

            // Format response
            $agents = array_map(function ($item) {
                $agentData = $item['agent']->toApiArray();
                $agentData['pipeline_position'] = $item['pipeline_position'];
                $agentData['pipeline_label'] = $item['pipeline_label'];
                $agentData['is_pipeline_head'] = $item['is_pipeline_head'];
                $agentData['is_pipeline_tail'] = $item['is_pipeline_tail'];
                $agentData['can_reorder'] = $item['can_reorder'];
                return $agentData;
            }, $agentsWithInfo);

            return [
                'success' => true,
                'data' => $agents,
                'count' => count($agents),
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }
}
