<?php

declare(strict_types=1);

namespace AgentTeam\Models;

/**
 * Workflow Model
 *
 * Represents a multi-step automated workflow that orchestrates agents.
 *
 * @see docs/agentDesign.md
 */
class Workflow
{
    private ?int $id = null;
    private int $userId = 0;
    private ?int $workspaceId = null;
    private string $name = '';
    private string $description = '';
    private array $steps = [];
    private array $triggers = [];
    private array $variables = [];
    private bool $enabled = true;
    private ?string $createdAt = null;
    private ?string $updatedAt = null;

    // Output storage settings
    private bool $outputStorageEnabled = false;
    private ?string $outputFolder = null;

    // Graph structure (normalized nodes/edges from database)
    private ?array $graph = null;

    /**
     * Create a new Workflow instance
     */
    public function __construct(array $data = [])
    {
        if (!empty($data)) {
            $this->hydrate($data);
        }
    }

    /**
     * Hydrate the workflow from an array (e.g., database row)
     */
    public function hydrate(array $data): self
    {
        $this->id = isset($data['id']) ? (int) $data['id'] : null;
        $this->userId = isset($data['user_id']) ? (int) $data['user_id'] : 0;
        $this->workspaceId = isset($data['workspace_id']) ? (int) $data['workspace_id'] : null;
        $this->name = $data['name'] ?? '';
        $this->description = $data['description'] ?? '';
        $this->steps = $this->decodeJson($data['steps'] ?? []);
        $this->triggers = $this->decodeJson($data['triggers'] ?? []);
        $this->variables = $this->decodeJson($data['variables'] ?? []);
        $this->enabled = (bool) ($data['enabled'] ?? true);
        $this->createdAt = $data['created_at'] ?? null;
        $this->updatedAt = $data['updated_at'] ?? null;

        // Output storage settings
        $this->outputStorageEnabled = (bool) ($data['output_storage_enabled'] ?? false);
        $this->outputFolder = $data['output_folder'] ?? null;

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
     * Convert the workflow to an array
     */
    public function toArray(): array
    {
        $data = [
            'id' => $this->id,
            'user_id' => $this->userId,
            'workspace_id' => $this->workspaceId,
            'name' => $this->name,
            'description' => $this->description,
            'steps' => $this->steps,
            'triggers' => $this->triggers,
            'variables' => $this->variables,
            'enabled' => $this->enabled,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
            'output_storage_enabled' => $this->outputStorageEnabled,
            'output_folder' => $this->outputFolder,
        ];

        // Include graph if available
        if ($this->graph !== null) {
            $data['graph'] = $this->graph;
        }

        return $data;
    }

    /**
     * Convert to array for JSON API response
     */
    public function toApiArray(): array
    {
        $data = [
            'id' => $this->id,
            'name' => $this->name,
            'description' => $this->description,
            'steps' => $this->steps,
            'triggers' => $this->triggers,
            'variables' => $this->variables,
            'enabled' => $this->enabled,
            'created_at' => $this->createdAt,
            'output_storage_enabled' => $this->outputStorageEnabled,
            'output_folder' => $this->outputFolder,
            'schedule_enabled' => $this->isScheduleEnabled(), // Computed from triggers
            'runtime_mode' => $this->detectRuntimeMode(),
        ];

        // Include graph if available
        if ($this->graph !== null) {
            $data['graph'] = $this->graph;
        }

        return $data;
    }

    /**
     * Infer runtime mode ('realtime' or 'batch') from loaded graph node types.
     * Falls back to 'batch' when no graph is loaded.
     */
    private function detectRuntimeMode(): string
    {
        $nodes = $this->graph['nodes'] ?? [];
        foreach ($nodes as $n) {
            $type = $n['type'] ?? $n['node_type'] ?? ($n['config']['type'] ?? '');
            if (is_string($type) && strpos($type, 'realtime-') === 0) {
                return 'realtime';
            }
            if (($n['config']['runtime_mode'] ?? null) === 'realtime') {
                return 'realtime';
            }
        }
        return 'batch';
    }

    /**
     * Validate workflow steps
     */
    public function validateSteps(): array
    {
        $errors = [];

        if (empty($this->steps)) {
            $errors[] = 'Workflow must have at least one step';
            return $errors;
        }

        foreach ($this->steps as $index => $step) {
            if (empty($step['id'])) {
                $errors[] = "Step {$index}: missing 'id'";
            }
            if (empty($step['type'])) {
                $errors[] = "Step {$index}: missing 'type'";
            }
            if (!in_array($step['type'] ?? '', ['agent', 'condition', 'transform'])) {
                $errors[] = "Step {$index}: invalid type '{$step['type']}'";
            }
        }

        return $errors;
    }

    /**
     * Get step by ID
     */
    public function getStep(string $stepId): ?array
    {
        foreach ($this->steps as $step) {
            if (($step['id'] ?? '') === $stepId) {
                return $step;
            }
        }
        return null;
    }

    /**
     * Get steps that depend on a given step
     */
    public function getDependentSteps(string $stepId): array
    {
        $dependents = [];
        foreach ($this->steps as $step) {
            $dependsOn = $step['depends_on'] ?? [];
            if (in_array($stepId, $dependsOn)) {
                $dependents[] = $step;
            }
        }
        return $dependents;
    }

    /**
     * Get steps with no dependencies (entry points)
     */
    public function getEntrySteps(): array
    {
        $entrySteps = [];
        foreach ($this->steps as $step) {
            if (empty($step['depends_on'])) {
                $entrySteps[] = $step;
            }
        }
        return $entrySteps;
    }

    /**
     * Replace variables in a template string
     */
    public function interpolateVariables(string $template, array $context = []): string
    {
        $allVars = array_merge($this->variables, $context);

        return preg_replace_callback('/\{\{(\w+)\}\}/', function ($matches) use ($allVars) {
            $key = $matches[1];
            return $allVars[$key] ?? $matches[0];
        }, $template);
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

    public function getSteps(): array
    {
        return $this->steps;
    }

    public function getTriggers(): array
    {
        return $this->triggers;
    }

    public function getVariables(): array
    {
        return $this->variables;
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    public function getCreatedAt(): ?string
    {
        return $this->createdAt;
    }

    public function getUpdatedAt(): ?string
    {
        return $this->updatedAt;
    }

    public function isOutputStorageEnabled(): bool
    {
        return $this->outputStorageEnabled;
    }

    public function getOutputFolder(): ?string
    {
        return $this->outputFolder;
    }

    /**
     * Check if workflow has scheduling enabled (from triggers JSON)
     * When schedule is enabled, document attachments must use remote storage
     */
    public function isScheduleEnabled(): bool
    {
        return !empty($this->triggers['schedule']['enabled']);
    }

    /**
     * Get schedule configuration from triggers
     */
    public function getScheduleConfig(): ?array
    {
        return $this->triggers['schedule'] ?? null;
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

    public function setSteps(array $steps): self
    {
        $this->steps = $steps;
        return $this;
    }

    public function setTriggers(array $triggers): self
    {
        $this->triggers = $triggers;
        return $this;
    }

    public function setVariables(array $variables): self
    {
        $this->variables = $variables;
        return $this;
    }

    public function setEnabled(bool $enabled): self
    {
        $this->enabled = $enabled;
        return $this;
    }

    public function setOutputStorageEnabled(bool $enabled): self
    {
        $this->outputStorageEnabled = $enabled;
        return $this;
    }

    public function setOutputFolder(?string $folder): self
    {
        $this->outputFolder = $folder;
        return $this;
    }

    // ========================================
    // Graph Data (Nodes & Edges)
    // ========================================

    public function getGraph(): ?array
    {
        return $this->graph;
    }

    public function setGraph(?array $graph): self
    {
        $this->graph = $graph;
        return $this;
    }

    public function hasGraph(): bool
    {
        return $this->graph !== null &&
               !empty($this->graph['nodes']);
    }
}
