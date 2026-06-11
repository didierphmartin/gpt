<?php

declare(strict_types=1);

namespace AgentTeam\Models;

/**
 * Agent Model
 *
 * Represents an AI agent with its configuration, tools, and settings.
 * Supports three types: standard, manager, and worker.
 *
 * @see docs/agentDesign.md
 */
class Agent
{
    private ?int $id = null;
    private int $userId = 0;
    private ?int $teamId = null;
    private ?string $category = null;
    private string $name = '';
    private string $description = '';

    // Agent Type & Hierarchy
    private string $agentType = 'standard';  // standard, manager, worker
    private ?int $parentAgentId = null;
    private array $canDelegateTo = [];
    private int $displayOrder = 0;  // For drag-and-drop ordering within team

    // LLM Configuration
    private string $provider = 'claude';
    private ?string $model = null;
    private string $instructions = '';

    // Tools
    private array $tools = [];

    // Access Control
    private string $visibility = 'personal';  // personal, workspace, public
    private bool $enabled = true;

    // Settings
    private array $settings = [];

    // Timestamps
    private ?string $createdAt = null;
    private ?string $updatedAt = null;

    /**
     * Create a new Agent instance
     */
    public function __construct(array $data = [])
    {
        if (!empty($data)) {
            $this->hydrate($data);
        }
    }

    /**
     * Hydrate the agent from an array (e.g., database row)
     */
    public function hydrate(array $data): self
    {
        $this->id = isset($data['id']) ? (int) $data['id'] : null;
        $this->userId = isset($data['user_id']) ? (int) $data['user_id'] : 0;
        $this->teamId = isset($data['team_id']) ? (int) $data['team_id'] : null;
        $this->category = isset($data['category']) && $data['category'] !== '' ? (string) $data['category'] : null;
        $this->name = $data['name'] ?? '';
        $this->description = $data['description'] ?? '';

        $this->agentType = $data['agent_type'] ?? 'standard';
        $this->parentAgentId = isset($data['parent_agent_id']) ? (int) $data['parent_agent_id'] : null;
        $this->canDelegateTo = $this->decodeJson($data['can_delegate_to'] ?? []);
        $this->displayOrder = isset($data['display_order']) ? (int) $data['display_order'] : 0;

        $this->provider = $data['provider'] ?? 'claude';
        $this->model = $data['model'] ?? null;
        $this->instructions = $data['instructions'] ?? '';

        $this->tools = $this->decodeJson($data['tools'] ?? []);

        $this->visibility = $data['visibility'] ?? 'personal';
        $this->enabled = (bool) ($data['enabled'] ?? true);

        $this->settings = $this->decodeJson($data['settings'] ?? []);

        $this->createdAt = $data['created_at'] ?? null;
        $this->updatedAt = $data['updated_at'] ?? null;

        return $this;
    }

    /**
     * Decode JSON string or return array as-is
     */
    private function decodeJson($value): array
    {
        if (is_string($value) && !empty($value)) {
            $decoded = json_decode($value, true);
            return is_array($decoded) ? $decoded : [];
        }
        return is_array($value) ? $value : [];
    }

    /**
     * Convert the agent to an array
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'user_id' => $this->userId,
            'team_id' => $this->teamId,
            'category' => $this->category,
            'name' => $this->name,
            'description' => $this->description,
            'agent_type' => $this->agentType,
            'parent_agent_id' => $this->parentAgentId,
            'can_delegate_to' => $this->canDelegateTo,
            'display_order' => $this->displayOrder,
            'provider' => $this->provider,
            'model' => $this->model,
            'instructions' => $this->instructions,
            'tools' => $this->tools,
            'visibility' => $this->visibility,
            'enabled' => $this->enabled,
            'settings' => $this->settings,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }

    /**
     * Convert to array for JSON API response (public-safe fields)
     */
    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'description' => $this->description,
            'category' => $this->category,
            'agent_type' => $this->agentType,
            'display_order' => $this->displayOrder,
            'provider' => $this->provider,
            'model' => $this->model,
            'instructions' => $this->instructions,
            'tools' => $this->tools,
            'settings' => $this->settings,
            'visibility' => $this->visibility,
            'enabled' => $this->enabled,
            'created_at' => $this->createdAt,
        ];
    }

    /**
     * Build the system prompt for this agent
     */
    public function buildSystemPrompt(): string
    {
        $prompt = "You are {$this->name}.";

        if (!empty($this->description)) {
            $prompt .= "\n\n{$this->description}";
        }

        if (!empty($this->instructions)) {
            $prompt .= "\n\n## Instructions\n{$this->instructions}";
        }

        // Add delegation info for manager agents
        if ($this->isManager()) {
            $prompt .= "\n\n## Agent Capabilities\n";
            $prompt .= "You are a manager agent with the ability to delegate tasks to specialized worker agents.\n";
            $prompt .= "Use the `list_available_agents` tool to see your team.\n";
            $prompt .= "Use `delegate_to_agent` to assign tasks to specific agents.\n";
            $prompt .= "Use `run_agents_parallel` to run multiple agents simultaneously.";
        }

        return $prompt;
    }

    /**
     * Check if this is a manager agent
     */
    public function isManager(): bool
    {
        return $this->agentType === 'manager';
    }

    /**
     * Check if this is a worker agent
     */
    public function isWorker(): bool
    {
        return $this->agentType === 'worker';
    }

    /**
     * Check if this is a standard agent
     */
    public function isStandard(): bool
    {
        return $this->agentType === 'standard';
    }

    /**
     * Check if this manager can delegate to a specific agent
     */
    public function canDelegateToAgent(int $agentId): bool
    {
        if (!$this->isManager()) {
            return false;
        }

        // Empty array means can delegate to any agent
        if (empty($this->canDelegateTo)) {
            return true;
        }

        return in_array($agentId, $this->canDelegateTo, true);
    }

    /**
     * Check if a user can access this agent
     */
    public function isAccessibleBy(int $userId): bool
    {
        // Owner always has access
        if ($this->userId === $userId) {
            return true;
        }

        // Public agents are accessible to all
        if ($this->visibility === 'public') {
            return true;
        }

        return false;
    }

    /**
     * Get a specific setting value
     */
    public function getSetting(string $key, $default = null)
    {
        return $this->settings[$key] ?? $default;
    }

    /**
     * Set a specific setting value
     */
    public function setSetting(string $key, $value): self
    {
        $this->settings[$key] = $value;
        return $this;
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

    public function getTeamId(): ?int
    {
        return $this->teamId;
    }

    public function getCategory(): ?string
    {
        return $this->category;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getDescription(): string
    {
        return $this->description;
    }

    public function getAgentType(): string
    {
        return $this->agentType;
    }

    public function getParentAgentId(): ?int
    {
        return $this->parentAgentId;
    }

    public function getCanDelegateTo(): array
    {
        return $this->canDelegateTo;
    }

    public function getDisplayOrder(): int
    {
        return $this->displayOrder;
    }

    public function getProvider(): string
    {
        return $this->provider;
    }

    public function getModel(): ?string
    {
        return $this->model;
    }

    public function getInstructions(): string
    {
        return $this->instructions;
    }

    public function getTools(): array
    {
        return $this->tools;
    }

    public function getVisibility(): string
    {
        return $this->visibility;
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    public function getSettings(): array
    {
        return $this->settings;
    }

    public function getCreatedAt(): ?string
    {
        return $this->createdAt;
    }

    public function getUpdatedAt(): ?string
    {
        return $this->updatedAt;
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

    public function setTeamId(?int $teamId): self
    {
        $this->teamId = $teamId;
        return $this;
    }

    public function setCategory(?string $category): self
    {
        $this->category = ($category === null || $category === '') ? null : $category;
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

    public function setAgentType(string $agentType): self
    {
        if (!in_array($agentType, ['standard', 'manager', 'worker'], true)) {
            throw new \InvalidArgumentException("Invalid agent type: {$agentType}");
        }
        $this->agentType = $agentType;
        return $this;
    }

    public function setParentAgentId(?int $parentAgentId): self
    {
        $this->parentAgentId = $parentAgentId;
        return $this;
    }

    public function setCanDelegateTo(array $agentIds): self
    {
        $this->canDelegateTo = array_map('intval', $agentIds);
        return $this;
    }

    public function setProvider(string $provider): self
    {
        $this->provider = $provider;
        return $this;
    }

    public function setModel(?string $model): self
    {
        $this->model = $model;
        return $this;
    }

    public function setInstructions(string $instructions): self
    {
        $this->instructions = $instructions;
        return $this;
    }

    public function setTools(array $tools): self
    {
        $this->tools = $tools;
        return $this;
    }

    public function addTool(string $tool): self
    {
        if (!in_array($tool, $this->tools, true)) {
            $this->tools[] = $tool;
        }
        return $this;
    }

    public function removeTool(string $tool): self
    {
        $this->tools = array_values(array_filter(
            $this->tools,
            fn($t) => $t !== $tool
        ));
        return $this;
    }

    public function setDisplayOrder(int $order): self
    {
        $this->displayOrder = $order;
        return $this;
    }

    public function setVisibility(string $visibility): self
    {
        if (!in_array($visibility, ['personal', 'workspace', 'public'], true)) {
            throw new \InvalidArgumentException("Invalid visibility: {$visibility}");
        }
        $this->visibility = $visibility;
        return $this;
    }

    public function setEnabled(bool $enabled): self
    {
        $this->enabled = $enabled;
        return $this;
    }

    public function setSettings(array $settings): self
    {
        $this->settings = $settings;
        return $this;
    }
}
