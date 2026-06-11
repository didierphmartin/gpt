<?php

declare(strict_types=1);

namespace AgentTeam\Models;

/**
 * WorkflowSchema Model
 *
 * Represents a reusable JSON Schema definition that can be attached to
 * agent workflow nodes for constrained decoding (structured outputs).
 *
 * Stored in the workflow_schemas table.
 */
class WorkflowSchema
{
    private ?int $id = null;
    private int $userId = 0;
    private string $name = '';
    private string $description = '';
    private array $schemaJson = [];
    private bool $strict = true;
    private ?string $createdAt = null;
    private ?string $updatedAt = null;

    public function __construct(array $data = [])
    {
        if (!empty($data)) {
            $this->hydrate($data);
        }
    }

    public function hydrate(array $data): self
    {
        $this->id = isset($data['id']) ? (int) $data['id'] : null;
        $this->userId = isset($data['user_id']) ? (int) $data['user_id'] : 0;
        $this->name = $data['name'] ?? '';
        $this->description = $data['description'] ?? '';
        $this->schemaJson = $this->decodeJson($data['schema_json'] ?? []);
        $this->strict = (bool) ($data['strict'] ?? true);
        $this->createdAt = $data['created_at'] ?? null;
        $this->updatedAt = $data['updated_at'] ?? null;

        return $this;
    }

    private function decodeJson($value): array
    {
        if (is_string($value) && $value !== '') {
            $decoded = json_decode($value, true);
            return is_array($decoded) ? $decoded : [];
        }
        return is_array($value) ? $value : [];
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'user_id' => $this->userId,
            'name' => $this->name,
            'description' => $this->description,
            'schema_json' => $this->schemaJson,
            'strict' => $this->strict,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }

    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'description' => $this->description,
            'schema_json' => $this->schemaJson,
            'strict' => $this->strict,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }

    /**
     * Build the canonical "output_schema" structure that gets passed
     * to providers for constrained decoding.
     */
    public function toOutputSchema(): array
    {
        return [
            'name' => $this->name,
            'description' => $this->description,
            'strict' => $this->strict,
            'schema' => $this->schemaJson,
        ];
    }

    /**
     * Validate that schema_json is a non-empty JSON Schema-like structure.
     * Returns array of error messages (empty = valid).
     */
    public function validate(): array
    {
        $errors = [];

        if ($this->name === '') {
            $errors[] = 'Schema name is required';
        }
        if (!preg_match('/^[a-zA-Z0-9_\-]+$/', $this->name)) {
            $errors[] = 'Schema name must contain only letters, numbers, dashes and underscores';
        }
        if (empty($this->schemaJson)) {
            $errors[] = 'schema_json is required';
        } else {
            $type = $this->schemaJson['type'] ?? null;
            if ($type !== 'object') {
                $errors[] = 'Top-level schema type must be "object"';
            }
            if (!isset($this->schemaJson['properties']) || !is_array($this->schemaJson['properties'])) {
                $errors[] = 'Schema must have a "properties" object';
            }
        }

        return $errors;
    }

    // Getters
    public function getId(): ?int { return $this->id; }
    public function getUserId(): int { return $this->userId; }
    public function getName(): string { return $this->name; }
    public function getDescription(): string { return $this->description; }
    public function getSchemaJson(): array { return $this->schemaJson; }
    public function isStrict(): bool { return $this->strict; }

    // Setters
    public function setId(?int $id): self { $this->id = $id; return $this; }
    public function setUserId(int $userId): self { $this->userId = $userId; return $this; }
    public function setName(string $name): self { $this->name = $name; return $this; }
    public function setDescription(string $description): self { $this->description = $description; return $this; }
    public function setSchemaJson(array $schemaJson): self { $this->schemaJson = $schemaJson; return $this; }
    public function setStrict(bool $strict): self { $this->strict = $strict; return $this; }
}
