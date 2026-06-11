<?php

declare(strict_types=1);

namespace AgentTeam\Models;

/**
 * Team Model
 *
 * Represents a team that groups agents together.
 *
 * @see docs/agentDesign.md
 */
class Team
{
    private ?int $id = null;
    private int $userId = 0;
    private ?int $workspaceId = null;
    private string $name = '';
    private string $description = '';
    private ?string $createdAt = null;
    private ?string $updatedAt = null;

    // Related agents (loaded separately)
    private array $agents = [];

    // Agents with pipeline info (position, labels, etc.)
    private array $agentsWithPipelineInfo = [];

    /**
     * Create a new Team instance
     */
    public function __construct(array $data = [])
    {
        if (!empty($data)) {
            $this->hydrate($data);
        }
    }

    /**
     * Hydrate the team from an array (e.g., database row)
     */
    public function hydrate(array $data): self
    {
        $this->id = isset($data['id']) ? (int) $data['id'] : null;
        $this->userId = isset($data['user_id']) ? (int) $data['user_id'] : 0;
        $this->workspaceId = isset($data['workspace_id']) ? (int) $data['workspace_id'] : null;
        $this->name = $data['name'] ?? '';
        $this->description = $data['description'] ?? '';
        $this->createdAt = $data['created_at'] ?? null;
        $this->updatedAt = $data['updated_at'] ?? null;

        return $this;
    }

    /**
     * Convert the team to an array
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'user_id' => $this->userId,
            'workspace_id' => $this->workspaceId,
            'name' => $this->name,
            'description' => $this->description,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }

    /**
     * Convert to array with agents included (with pipeline info)
     */
    public function toArrayWithAgents(): array
    {
        $data = $this->toArray();

        // If we have agents with pipeline info, use that
        if (!empty($this->agentsWithPipelineInfo)) {
            $data['agents'] = array_map(function ($item) {
                $agentData = $item['agent']->toApiArray();
                $agentData['pipeline_position'] = $item['pipeline_position'];
                $agentData['pipeline_label'] = $item['pipeline_label'];
                $agentData['is_pipeline_head'] = $item['is_pipeline_head'];
                $agentData['is_pipeline_tail'] = $item['is_pipeline_tail'];
                $agentData['can_reorder'] = $item['can_reorder'];
                return $agentData;
            }, $this->agentsWithPipelineInfo);
        } else {
            // Fallback to basic agents array
            $data['agents'] = array_map(
                fn($agent) => $agent->toApiArray(),
                $this->agents
            );
        }

        return $data;
    }

    /**
     * Convert to array for JSON API response
     */
    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'description' => $this->description,
            'created_at' => $this->createdAt,
        ];
    }

    // ========================================
    // Getters
    // ========================================

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getUserId(): int
    {
        return $this->userId;
    }

    public function getWorkspaceId(): ?int
    {
        return $this->workspaceId;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getDescription(): string
    {
        return $this->description;
    }

    public function getCreatedAt(): ?string
    {
        return $this->createdAt;
    }

    public function getUpdatedAt(): ?string
    {
        return $this->updatedAt;
    }

    public function getAgents(): array
    {
        return $this->agents;
    }

    // ========================================
    // Setters (Fluent Interface)
    // ========================================

    public function setId(int $id): self
    {
        $this->id = $id;
        return $this;
    }

    public function setUserId(int $userId): self
    {
        $this->userId = $userId;
        return $this;
    }

    public function setWorkspaceId(?int $workspaceId): self
    {
        $this->workspaceId = $workspaceId;
        return $this;
    }

    public function setName(string $name): self
    {
        $this->name = $name;
        return $this;
    }

    public function setDescription(string $description): self
    {
        $this->description = $description;
        return $this;
    }

    public function setAgents(array $agents): self
    {
        $this->agents = $agents;
        return $this;
    }

    /**
     * Set agents with pipeline info (position, labels, etc.)
     *
     * @param array $agentsWithInfo Array of ['agent' => Agent, 'pipeline_position' => int|null, ...]
     */
    public function setAgentsWithPipelineInfo(array $agentsWithInfo): self
    {
        $this->agentsWithPipelineInfo = $agentsWithInfo;

        // Also populate basic agents array for backwards compatibility
        $this->agents = array_map(fn($item) => $item['agent'], $agentsWithInfo);

        return $this;
    }

    public function getAgentsWithPipelineInfo(): array
    {
        return $this->agentsWithPipelineInfo;
    }
}
