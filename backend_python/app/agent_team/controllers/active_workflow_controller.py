"""Port of backend/src/AgentTeam/Controllers/ActiveWorkflowController.php.

▶ on Start activates the workflow the event worker runs (spec 2026-10-14 event-worker §2). One per person; a robot
workflow's row is the robot's, and every user who may use the robot activates and deactivates (= Unlock) it.
"""
from __future__ import annotations

from app.agent_team.services.active_workflow_service import ActiveWorkflowError, ActiveWorkflowService
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.services.private_skills_refused import PrivateSkillsRefused
from app.services.robot_ownership import RobotOwnership
from app.services.robot_skill_policy import RobotSkillPolicy
from app.services.skill_store import SkillStore
from app.support.phpcompat import php_intval


class ActiveWorkflowController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the id is read from
    # request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config):
        self.active = ActiveWorkflowService(db, self._skillPolicy(db, config))
        self.ownership = RobotOwnership(db, config)
        self.workflows = WorkflowRepository(db)

    @staticmethod
    def _skillPolicy(db, config) -> RobotSkillPolicy:
        """The RobotSkillPolicy the robot's activations check."""
        return RobotSkillPolicy(db, config, SkillStore.fromEnv(config))

    @staticmethod
    def _user(request: dict) -> int:
        return php_intval(request.get('user_id') if request.get('user_id') is not None else 0)

    @staticmethod
    def _id(request: dict) -> int:
        params = request.get('params') or {}
        return php_intval(params.get('id') if params.get('id') is not None else 0)

    def show(self, request: dict) -> dict:
        """GET /api/v1/workflows/active: the caller's own row."""
        userId = self._user(request)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        return {'success': True, 'data': self.active.get(userId), 'status_code': 200}

    def forWorkflow(self, request: dict, id=None) -> dict:
        """GET /api/v1/workflows/{id}/active: the workflow's row, the robot's for a robot workflow."""
        return self._guarded(request, lambda userId, workflowId:
                             {'success': True, 'data': self.active.forWorkflow(workflowId), 'status_code': 200})

    def activate(self, request: dict, id=None) -> dict:
        """POST /api/v1/workflows/{id}/activate"""
        def fn(userId: int, workflowId: int) -> dict:
            try:
                data = self.active.activate(self.ownership.runAs(userId, workflowId), workflowId)
                return {'success': True, 'data': data, 'status_code': 200}
            except ActiveWorkflowError as e:
                return {'success': False, 'error': str(e), 'kind': e.kind, 'error_code': e.kind, 'status_code': e.status}
            except PrivateSkillsRefused as e:
                return RobotSkillPolicy.refusal(e.skills)
        return self._guarded(request, fn)

    def deactivate(self, request: dict, id=None) -> dict:
        """DELETE /api/v1/workflows/{id}/activate"""
        def fn(userId: int, workflowId: int) -> dict:
            self.active.deactivate(self.ownership.runAs(userId, workflowId), workflowId)
            return {'success': True, 'status_code': 200}
        return self._guarded(request, fn)

    def _guarded(self, request: dict, fn) -> dict:
        """Authenticated, and the workflow is the caller's or a robot workflow the caller may use; else 404, nothing more."""
        userId = self._user(request)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        workflowId = self._id(request)
        if not self.workflows.canUserAccess(userId, workflowId, self.ownership.robotFor(userId)):
            return {'success': False, 'error': 'Workflow not found', 'kind': 'not_found', 'status_code': 404}
        return fn(userId, workflowId)
