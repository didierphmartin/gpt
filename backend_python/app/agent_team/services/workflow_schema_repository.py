"""Port of backend/src/AgentTeam/Services/WorkflowSchemaRepository.php (112 lines).

CRUD for the workflow_schemas table — reusable JSON Schemas attached to
agent nodes for constrained decoding.
"""
from __future__ import annotations

from app.agent_team.models.workflow_schema import WorkflowSchema
from app.support.phpjson import dumps as php_json_dumps


class WorkflowSchemaRepository:
    def __init__(self, db):
        self.db = db

    def findByUser(self, user_id: int) -> list[WorkflowSchema]:
        """PHP 30-41."""
        rows = self.db.fetch_all(
            "SELECT * FROM workflow_schemas WHERE user_id = ? ORDER BY name ASC", [user_id]
        )
        return [WorkflowSchema(row) for row in rows]

    def findById(self, id: int) -> WorkflowSchema | None:
        """PHP 43-50."""
        row = self.db.fetch_one("SELECT * FROM workflow_schemas WHERE id = ?", [id])
        return WorkflowSchema(row) if row else None

    def findByName(self, user_id: int, name: str) -> WorkflowSchema | None:
        """PHP 52-61."""
        row = self.db.fetch_one(
            "SELECT * FROM workflow_schemas WHERE user_id = ? AND name = ? LIMIT 1",
            [user_id, name],
        )
        return WorkflowSchema(row) if row else None

    def create(self, schema: WorkflowSchema) -> WorkflowSchema:
        """PHP 63-79. json_encode with JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE."""
        new_id = self.db.insert(
            "INSERT INTO workflow_schemas (user_id, name, description, schema_json, strict)\n"
            "             VALUES (?, ?, ?, ?, ?)",
            [
                schema.getUserId(),
                schema.getName(),
                schema.getDescription(),
                php_json_dumps(schema.getSchemaJson()),
                1 if schema.isStrict() else 0,
            ],
        )

        schema.setId(new_id)
        return schema

    def update(self, schema: WorkflowSchema) -> WorkflowSchema:
        """PHP 81-102."""
        if not schema.getId():
            raise ValueError('Cannot update schema without an ID')

        self.db.execute(
            "UPDATE workflow_schemas\n"
            "             SET name = ?, description = ?, schema_json = ?, strict = ?\n"
            "             WHERE id = ? AND user_id = ?",
            [
                schema.getName(),
                schema.getDescription(),
                php_json_dumps(schema.getSchemaJson()),
                1 if schema.isStrict() else 0,
                schema.getId(),
                schema.getUserId(),
            ],
        )

        return schema

    def delete(self, id: int, user_id: int) -> bool:
        """PHP 104-111."""
        return self.db.execute(
            "DELETE FROM workflow_schemas WHERE id = ? AND user_id = ?", [id, user_id]
        ) > 0
