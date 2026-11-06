"""Port of backend/src/Controllers/CodeComponentsController.php.

/api/v1/code-components -- the code components collection (CRUD + used-by + Start option), over CodeComponentStore.
"""
from __future__ import annotations

from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.code_component.code_component_error import CodeComponentError
from app.code_component.code_component_store import CodeComponentStore
from app.support.logger import error_log
from app.services.robot_ownership import RobotOwnership
from app.support.phpcompat import php_intval, php_strval


class CodeComponentsController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the id is read from
    # request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        self.store = CodeComponentStore(db)

    def _robot(self, u: int) -> int | None:
        """The robot's id when the caller may use the robot (its components are shared), else None."""
        return RobotOwnership(self.db, self.config).robotFor(u)

    def index(self, request: dict) -> dict:
        return self._guard(request, lambda u: {'success': True, 'data': self.store.list(u, self._robot(u))})

    def show(self, request: dict, id=None) -> dict:
        return self._guard(request, lambda u: {'success': True, 'data': self._found(u, request)})

    def create(self, request: dict) -> dict:
        return self._guard(request, lambda u: {'success': True,
                                               'data': self.store.save(u, None, self._body(request), self._robot(u))})

    def update(self, request: dict, id=None) -> dict:
        return self._guard(request, lambda u: {'success': True,
                                               'data': self.store.save(u, self._id(request), self._body(request), self._robot(u))})

    def destroy(self, request: dict, id=None) -> dict:
        def action(u):
            self.store.delete(u, self._id(request), self._robot(u))
            return {'success': True}
        return self._guard(request, action)

    def usedBy(self, request: dict, id=None) -> dict:
        return self._guard(request, lambda u: {'success': True,
                                               'data': self.store.usedBy(u, self._found(u, request)['id'], self._robot(u))})

    def setStartOption(self, request: dict, id=None) -> dict:
        def action(u):
            locked = self._lockedGuard(u, self._id(request))
            if locked:
                return locked
            return {'success': True, 'data': self.store.setStartTrigger(u, self._id(request), self._body(request), self._robot(u))}
        return self._guard(request, action)

    def _lockedGuard(self, userId: int, componentId: int) -> dict | None:
        """The 423 body when a schedule on this Start option belongs to a running robot workflow, else None."""
        from app.agent_team.controllers.workflow_controller import WorkflowController
        if self.store.get(userId, componentId, self._robot(userId)) is None:
            return None   # not the caller's component: the store answers 404, never a lock
        own = RobotOwnership(self.db, self.config)
        for wf in self.db.fetch_column('SELECT DISTINCT workflow_id FROM scheduled_workflows WHERE trigger_component_id = ?',
                                       [componentId]):
            if own.isLocked(php_intval(wf)):
                row = self.db.fetch_one('SELECT name FROM agent_workflows WHERE id = ?', [wf])
                return WorkflowController.lockedResponse('' if row is None else php_strval(row['name']))
        return None

    def startOptionImpact(self, request: dict, id=None) -> dict:
        return self._guard(request, lambda u: {'success': True,
                                               'data': self.store.startTriggerImpact(u, self._found(u, request)['id'], self._robot(u))})

    def clearStartOption(self, request: dict, id=None) -> dict:
        def action(u):
            locked = self._lockedGuard(u, self._id(request))
            if locked:
                return locked
            data = self.store.clearStartTrigger(u, self._id(request), self._robot(u))
            self._sweepActive()   # reverted Starts: their mode is gone
            return {'success': True, 'data': data}
        return self._guard(request, action)

    def _sweepActive(self) -> None:
        try:   # never fails the write it follows: the write already happened, and the event worker sweeps every 5 s
            ActiveWorkflowService(self.db).sweep()
        except Exception as e:  # noqa: BLE001 -- PHP catch (\Throwable)
            error_log(f'[ActiveWorkflow] sweep failed: {e}')

    @staticmethod
    def _id(request: dict) -> int:
        params = request.get('params') or {}
        return php_intval(params.get('id') if params.get('id') is not None else 0)

    def _found(self, u: int, request: dict) -> dict:
        id = self._id(request)
        row = self.store.get(u, id, self._robot(u))
        if row is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        return row

    @staticmethod
    def _body(request: dict) -> dict:
        b = request.get('body')
        b = b if b is not None else {}
        return b if isinstance(b, dict) else {}

    @staticmethod
    def _guard(request: dict, action) -> dict:
        """Authentication, then the action; a CodeComponentError becomes {success: False, error, kind, status_code[, data]}."""
        userId = php_intval(request.get('user_id') if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'kind': 'auth', 'status_code': 401}
        try:
            return action(userId)
        except CodeComponentError as e:
            out = {'success': False, 'error': str(e), 'kind': e.kind, 'status_code': e.status}
            if e.data:
                out['data'] = e.data
            return out
