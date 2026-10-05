"""Port of backend/src/Controllers/PlaybooksController.php.

/api/v1/playbooks: the playbook collection (CRUD + used-by), over PlaybookStore.
"""
from __future__ import annotations

from app.playbook.playbook_store import PlaybookStore, PlaybookStoreError
from app.support.phpcompat import php_intval, php_trim


class PlaybooksController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the id is
    # read from request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config: dict):
        self.store = PlaybookStore(db)

    def index(self, request: dict) -> dict:
        return self._guard(request, lambda u: {'success': True, 'data': self.store.list(u)})

    def show(self, request: dict, id: int = 0) -> dict:
        def action(u):
            id = self._id(request)
            row = self.store.get(u, id)
            if row is None:
                raise PlaybookStoreError('not_found', f'Playbook #{id} not found', 404)
            return {'success': True, 'data': row}
        return self._guard(request, action)

    def create(self, request: dict) -> dict:
        return self._guard(request, lambda u: {
            'success': True, 'data': self.store.save(u, None, self._text(request), self._key(request))})

    def update(self, request: dict, id: int = 0) -> dict:
        return self._guard(request, lambda u: {
            'success': True, 'data': self.store.save(u, self._id(request), self._text(request), self._key(request))})

    def destroy(self, request: dict, id: int = 0) -> dict:
        def action(u):
            self.store.delete(u, self._id(request))
            return {'success': True}
        return self._guard(request, action)

    def usedBy(self, request: dict, id: int = 0) -> dict:
        def action(u):
            id = self._id(request)
            if self.store.get(u, id) is None:
                raise PlaybookStoreError('not_found', f'Playbook #{id} not found', 404)
            return {'success': True, 'data': self.store.usedBy(u, id)}
        return self._guard(request, action)

    @staticmethod
    def _id(request: dict) -> int:
        params = request.get('params') or {}
        return php_intval(params.get('id') if params.get('id') is not None else 0)

    @staticmethod
    def _text(request: dict) -> str:
        body = request.get('body')
        text = body.get('text') if isinstance(body, dict) else None
        if not isinstance(text, str) or php_trim(text) == '':
            raise PlaybookStoreError('invalid_text', 'text is required (the playbook, as written).', 400)
        return text

    @staticmethod
    def _key(request: dict):
        body = request.get('body')
        k = body.get('pkey') if isinstance(body, dict) else None
        return php_trim(k) if isinstance(k, str) and php_trim(k) != '' else None

    @staticmethod
    def _guard(request: dict, action) -> dict:
        """Authentication, then the action; a PlaybookStoreError becomes
        {success: False, error, kind, status_code}."""
        userId = php_intval(request.get('user_id') if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'kind': 'auth', 'status_code': 401}
        try:
            return action(userId)
        except PlaybookStoreError as e:
            return {'success': False, 'error': str(e), 'kind': e.kind, 'status_code': e.status}
