"""Port of Controllers/RobotController.php.

/api/v1/robot: the robot account's status and its published-playbook collection.
"""
from __future__ import annotations

from app.playbook.playbook_store import PlaybookStore, PlaybookStoreError
from app.services import edition
from app.services.robot_account import RobotAccount
from app.services.robot_policy import RobotPolicy
from app.support.phpcompat import php_intval


class RobotController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the id is
    # read from request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        self.policy = RobotPolicy(db, config)

    def show(self, request: dict) -> dict:
        def action(u):
            RobotAccount.ensure(self.db)
            return {'success': True, 'data': {
                'exists': True,
                'name': RobotAccount.NAME,
                'can_use': self.policy.canUse(u),
                'can_manage': self.policy.canManage(u),
                'edition': edition.current(self.config),
            }}
        return self._guard(request, action)

    def playbooks(self, request: dict) -> dict:
        def action(u):
            self._require_access(u)
            return {'success': True, 'data': PlaybookStore(self.db).robotList(RobotAccount.ensure(self.db))}
        return self._guard(request, action)

    def unpublish(self, request: dict, id: int = 0) -> dict:
        def action(u):
            self._require_access(u)
            params = request.get('params') or {}
            PlaybookStore(self.db).unpublish(RobotAccount.ensure(self.db),
                                             php_intval(params.get('id') if params.get('id') is not None else 0))
            return {'success': True}
        return self._guard(request, action)

    def _require_access(self, userId: int) -> None:
        if not self.policy.canUse(userId) and not self.policy.canManage(userId):
            raise PlaybookStoreError('forbidden', "Your role can't use the robot", 403)

    @staticmethod
    def _guard(request: dict, action) -> dict:
        userId = php_intval(request.get('user_id') if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'kind': 'auth', 'status_code': 401}
        try:
            return action(userId)
        except PlaybookStoreError as e:
            return {'success': False, 'error': str(e), 'kind': e.kind, 'status_code': e.status}
