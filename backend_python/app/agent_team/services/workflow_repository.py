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

    def findByUser(self, user_id: int, include_graph: bool = False, robotId: int | None = None) -> list[Workflow]:
        """PHP findByUser: the user's workflows, plus the robot's when `robotId` is given."""
        rows = self.db.fetch_all(
            "SELECT * FROM agent_workflows WHERE user_id = ? ORDER BY name ASC" if robotId is None
            else "SELECT * FROM agent_workflows WHERE user_id = ? OR user_id = ? ORDER BY name ASC",
            [user_id] if robotId is None else [user_id, robotId],
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
            "INSERT INTO agent_workflows (user_id, workspace_id, name, description, steps, triggers, variables, enabled, output_storage_enabled, output_folder, orchestration)\n"
            "                VALUES (:user_id, :workspace_id, :name, :description, :steps, :triggers, :variables, :enabled, :output_storage_enabled, :output_folder, :orchestration)"
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
            'orchestration': data['orchestration'] if data.get('orchestration') is not None else 'workflow',
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
            "                output_folder = :output_folder,\n"
            "                orchestration = :orchestration\n"
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
            'orchestration': data['orchestration'] if data.get('orchestration') is not None else 'workflow',
        })

        return self.findById(workflow.getId())

    def delete(self, id: int) -> bool:
        """PHP 187-191. `$stmt->execute([$id])` is the boolean success of the
        exec, not a rowCount check."""
        self.db.execute("DELETE FROM agent_workflows WHERE id = ?", [id])
        return True

    def canUserAccess(self, user_id: int, workflow_id: int, robotId: int | None = None) -> bool:
        """PHP canUserAccess: the owner, or anyone given `robotId` when the robot owns it."""
        workflow = self.findById(workflow_id)
        if not workflow:
            return False

        return workflow.getUserId() == user_id or (robotId is not None and workflow.getUserId() == robotId)

    def isOwner(self, user_id: int, workflow_id: int, robotId: int | None = None) -> bool:
        """PHP isOwner (same robot rule as canUserAccess)."""
        workflow = self.findById(workflow_id)
        return bool(workflow) and (workflow.getUserId() == user_id or (robotId is not None and workflow.getUserId() == robotId))

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
        copy.setName(new_name if new_name is not None else self._freeCopyName(original.getName(), new_user_id))

        # the graph is copied too (node ids remapped); a personal instance of a robot workflow, for one
        self.db.begin()
        try:
            created = self.create(copy)
            newId = created.getId()

            nodeMap: dict[int, int] = {}
            for n in self.db.fetch_all('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id', [workflow_id]):
                nodeMap[php_intval(n['id'])] = php_intval(self.db.insert(
                    'INSERT INTO workflow_nodes (workflow_id, node_type, agent_id, config, pos_x, pos_y, drawflow_node_id)\n'
                    '                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [newId, n.get('node_type'), n.get('agent_id'), n.get('config'), n.get('pos_x'), n.get('pos_y'), n.get('drawflow_node_id')]))

            for e in self.db.fetch_all('SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id', [workflow_id]):
                frm = nodeMap.get(php_intval(e['from_node_id']))
                to = nodeMap.get(php_intval(e['to_node_id']))
                if frm is None or to is None:
                    continue
                self.db.execute('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr)\n'
                                '                 VALUES (?, ?, ?, ?, ?, ?)',
                                [newId, frm, to, e.get('from_port'), e.get('to_port'), e.get('condition_expr')])
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

        self._copySchedules(workflow_id, newId, new_user_id)
        return created

    def _freeCopyName(self, name: str, userId: int) -> str:
        n = 1
        while True:
            candidate = name + (' (Copy)' if n == 1 else f' (Copy {n})')
            if not self.db.fetch_one('SELECT 1 FROM agent_workflows WHERE user_id = ? AND name = ?', [userId, candidate]):
                return candidate
            n += 1

    def _copySchedules(self, fromWorkflowId: int, toWorkflowId: int, userId: int) -> None:
        """The source's schedules, as the copier's and paused (a copy never fires on its own)."""
        for r in self.db.fetch_all('SELECT * FROM scheduled_workflows WHERE workflow_id = ? ORDER BY id', [fromWorkflowId]):
            self.db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type,\n"
                            "                repeat_interval, cron, event_trigger, trigger_component_id, next_run)\n"
                            "             VALUES (?, ?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?)",
                            [userId, toWorkflowId, r.get('input_prompt'), r.get('scheduled_time'), r.get('repeat_type'),
                             r.get('repeat_interval'), r.get('cron'), r.get('event_trigger'), r.get('trigger_component_id'), r.get('next_run')])
