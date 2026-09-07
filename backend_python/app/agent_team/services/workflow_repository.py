"""Port of backend/src/AgentTeam/Services/WorkflowRepository.php (254 lines).

Handles CRUD operations for workflows.
"""
from __future__ import annotations

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.support.phpcompat import php_intval
from app.support.phpjson import php_json_encode


class WorkflowRepository:
    def __init__(self, db):
        self.db = db
        self.graphRepository: WorkflowGraphRepository | None = WorkflowGraphRepository(db)

    def getGraphRepository(self) -> WorkflowGraphRepository:
        """PHP 31-34."""
        return self.graphRepository

    def findById(self, id: int, include_graph: bool = False) -> Workflow | None:
        """PHP 41-60."""
        row = self.db.fetch_one("SELECT * FROM agent_workflows WHERE id = ?", [id])

        if not row:
            return None

        workflow = Workflow(row)

        # Optionally load graph data
        if include_graph:
            graph = self.graphRepository.getGraphForFrontend(id)
            workflow.setGraph(graph)

        return workflow

    def findByUser(self, user_id: int, include_graph: bool = False) -> list[Workflow]:
        """PHP 65-83."""
        rows = self.db.fetch_all(
            "SELECT * FROM agent_workflows WHERE user_id = ? ORDER BY name ASC", [user_id]
        )

        workflows = []
        for row in rows:
            workflow = Workflow(row)
            if include_graph:
                graph = self.graphRepository.getGraphForFrontend(workflow.getId())
                workflow.setGraph(graph)
            workflows.append(workflow)
        return workflows

    def findEnabledByUser(self, user_id: int) -> list[Workflow]:
        """PHP 88-99."""
        rows = self.db.fetch_all(
            "SELECT * FROM agent_workflows WHERE user_id = ? AND enabled = 1 ORDER BY name ASC",
            [user_id],
        )
        return [Workflow(row) for row in rows]

    def findByTriggerType(self, user_id: int, trigger_type: str) -> list[Workflow]:
        """PHP 104-118."""
        rows = self.db.fetch_all(
            "SELECT * FROM agent_workflows\n"
            "             WHERE user_id = ? AND enabled = 1\n"
            "             AND JSON_CONTAINS(triggers, JSON_OBJECT('type', ?))\n"
            "             ORDER BY name ASC",
            [user_id, trigger_type],
        )
        return [Workflow(row) for row in rows]

    def create(self, workflow: Workflow) -> Workflow:
        """PHP 123-146."""
        sql = (
            "INSERT INTO agent_workflows (user_id, workspace_id, name, description, steps, triggers, variables, enabled, output_storage_enabled, output_folder)\n"
            "                VALUES (:user_id, :workspace_id, :name, :description, :steps, :triggers, :variables, :enabled, :output_storage_enabled, :output_folder)"
        )

        data = workflow.toArray()

        new_id = self.db.insert(sql, {
            'user_id': data['user_id'],
            'workspace_id': data['workspace_id'],
            'name': data['name'],
            'description': data['description'],
            'steps': php_json_encode(data['steps']),
            'triggers': php_json_encode(data['triggers']),
            'variables': php_json_encode(data['variables']),
            'enabled': 1 if data['enabled'] else 0,
            'output_storage_enabled': 1 if data['output_storage_enabled'] else 0,
            'output_folder': data['output_folder'],
        })

        return self.findById(new_id)

    def update(self, workflow: Workflow) -> Workflow:
        """PHP 151-182."""
        sql = (
            "UPDATE agent_workflows SET\n"
            "                name = :name,\n"
            "                description = :description,\n"
            "                steps = :steps,\n"
            "                triggers = :triggers,\n"
            "                variables = :variables,\n"
            "                enabled = :enabled,\n"
            "                workspace_id = :workspace_id,\n"
            "                output_storage_enabled = :output_storage_enabled,\n"
            "                output_folder = :output_folder\n"
            "                WHERE id = :id"
        )

        data = workflow.toArray()

        self.db.execute(sql, {
            'id': data['id'],
            'name': data['name'],
            'description': data['description'],
            'steps': php_json_encode(data['steps']),
            'triggers': php_json_encode(data['triggers']),
            'variables': php_json_encode(data['variables']),
            'enabled': 1 if data['enabled'] else 0,
            'workspace_id': data['workspace_id'],
            'output_storage_enabled': 1 if data['output_storage_enabled'] else 0,
            'output_folder': data['output_folder'],
        })

        return self.findById(workflow.getId())

    def delete(self, id: int) -> bool:
        """PHP 187-191. `$stmt->execute([$id])` is the boolean success of the
        exec, not a rowCount check."""
        self.db.execute("DELETE FROM agent_workflows WHERE id = ?", [id])
        return True

    def canUserAccess(self, user_id: int, workflow_id: int) -> bool:
        """PHP 196-204."""
        workflow = self.findById(workflow_id)
        if not workflow:
            return False

        return workflow.getUserId() == user_id

    def isOwner(self, user_id: int, workflow_id: int) -> bool:
        """PHP 209-213."""
        workflow = self.findById(workflow_id)
        return bool(workflow) and workflow.getUserId() == user_id

    def countByUser(self, user_id: int) -> int:
        """PHP 218-225."""
        col = self.db.fetch_column("SELECT COUNT(*) FROM agent_workflows WHERE user_id = ?", [user_id])
        return php_intval(col[0]) if col else 0

    def toggleEnabled(self, id: int) -> bool:
        """PHP 230-236. `$stmt->execute([$id])` is the boolean success of the exec."""
        self.db.execute("UPDATE agent_workflows SET enabled = NOT enabled WHERE id = ?", [id])
        return True

    def duplicate(self, workflow_id: int, new_user_id: int, new_name: str | None = None) -> Workflow | None:
        """PHP 241-253."""
        original = self.findById(workflow_id)
        if not original:
            return None

        copy = Workflow(original.toArray())
        copy.setUserId(new_user_id)
        copy.setName(new_name if new_name is not None else original.getName() + ' (Copy)')

        return self.create(copy)
