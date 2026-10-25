"""Port of backend/src/AgentTeam/Controllers/ActiveWorkflowController.php.

▶ on Start activates the workflow the event worker runs (spec 2026-10-14 event-worker §2). One per user.
"""
from __future__ import annotations

from app.agent_team.services.active_workflow_service import ActiveWorkflowError, ActiveWorkflowService
from app.support.phpcompat import php_intval


class ActiveWorkflowController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the id is read from
    # request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config):
        self.active = ActiveWorkflowService(db)

    @staticmethod
    def _user(request: dict) -> int:
        return php_intval(request.get('user_id') if request.get('user_id') is not None else 0)

    @staticmethod
    def _id(request: dict) -> int:
        params = request.get('params') or {}
        return php_intval(params.get('id') if params.get('id') is not None else 0)

    def show(self, request: dict) -> dict:
        """GET /api/v1/workflows/active"""
        userId = self._user(request)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        return {'success': True, 'data': self.active.get(userId), 'status_code': 200}

    def activate(self, request: dict, id=None) -> dict:
        """POST /api/v1/workflows/{id}/activate"""
        userId = self._user(request)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        try:
            return {'success': True, 'data': self.active.activate(userId, self._id(request)), 'status_code': 200}
        except ActiveWorkflowError as e:
            return {'success': False, 'error': str(e), 'kind': e.kind, 'status_code': e.status}

    def deactivate(self, request: dict, id=None) -> dict:
        """DELETE /api/v1/workflows/{id}/activate"""
        userId = self._user(request)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        self.active.deactivate(userId, self._id(request))
        return {'success': True, 'status_code': 200}
