<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\WorkflowSchema;
use PDO;

/**
 * Workflow Schema Repository
 *
 * CRUD for the workflow_schemas table — reusable JSON Schemas attached
 * to agent nodes for constrained decoding.
 */
class WorkflowSchemaRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Find all schemas owned by a user.
     *
     * @return WorkflowSchema[]
     */
    public function findByUser(int $userId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_schemas WHERE user_id = ? ORDER BY name ASC"
        );
        $stmt->execute([$userId]);

        return array_map(
            fn($row) => new WorkflowSchema($row),
            $stmt->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    public function findById(int $id): ?WorkflowSchema
    {
        $stmt = $this->db->prepare("SELECT * FROM workflow_schemas WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ? new WorkflowSchema($row) : null;
    }

    public function findByName(int $userId, string $name): ?WorkflowSchema
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_schemas WHERE user_id = ? AND name = ? LIMIT 1"
        );
        $stmt->execute([$userId, $name]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ? new WorkflowSchema($row) : null;
    }

    public function create(WorkflowSchema $schema): WorkflowSchema
    {
        $stmt = $this->db->prepare(
            "INSERT INTO workflow_schemas (user_id, name, description, schema_json, strict)
             VALUES (?, ?, ?, ?, ?)"
        );
        $stmt->execute([
            $schema->getUserId(),
            $schema->getName(),
            $schema->getDescription(),
            json_encode($schema->getSchemaJson(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            $schema->isStrict() ? 1 : 0,
        ]);

        $schema->setId((int) $this->db->lastInsertId());
        return $schema;
    }

    public function update(WorkflowSchema $schema): WorkflowSchema
    {
        if (!$schema->getId()) {
            throw new \InvalidArgumentException('Cannot update schema without an ID');
        }

        $stmt = $this->db->prepare(
            "UPDATE workflow_schemas
             SET name = ?, description = ?, schema_json = ?, strict = ?
             WHERE id = ? AND user_id = ?"
        );
        $stmt->execute([
            $schema->getName(),
            $schema->getDescription(),
            json_encode($schema->getSchemaJson(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            $schema->isStrict() ? 1 : 0,
            $schema->getId(),
            $schema->getUserId(),
        ]);

        return $schema;
    }

    public function delete(int $id, int $userId): bool
    {
        $stmt = $this->db->prepare(
            "DELETE FROM workflow_schemas WHERE id = ? AND user_id = ?"
        );
        $stmt->execute([$id, $userId]);
        return $stmt->rowCount() > 0;
    }
}
