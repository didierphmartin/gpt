"""Port of backend/src/AgentTeam/Controllers/UserMemoryController.php.

User Memory Controller

Endpoints:
- GET    /api/v1/user-memories                           -> both scopes + budgets + auto-update settings
- PUT    /api/v1/user-memories                           -> update one or both scopes + optional settings
- GET    /api/v1/user-memories/events                    -> recent audit events
- DELETE /api/v1/user-memories/events/{id}               -> remove an audit entry (undoing its change first if not already undone)
"""
from __future__ import annotations

from app.agent_team.services.user_memory_events_repository import UserMemoryEventsRepository
from app.agent_team.services.user_memory_repository import UserMemoryRepository
from app.agent_team.services.user_memory_settings_repository import UserMemorySettingsRepository
from app.support.phpcompat import php_bool, php_intval, php_strval


class UserMemoryController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.repository = UserMemoryRepository(db)
        self.events = UserMemoryEventsRepository(db)
        self.settings = UserMemorySettingsRepository(db)

    def show(self, request) -> dict:
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        both = self.repository.getBoth(userId)
        settings = self.settings.get(userId)

        return {
            'success': True,
            'data': {
                'memory': {
                    'content': both[UserMemoryRepository.SCOPE_MEMORY],
                    'budget': UserMemoryRepository.BUDGET_MEMORY,
                    'last_source': self.events.lastSource(userId, UserMemoryRepository.SCOPE_MEMORY),
                },
                'user': {
                    'content': both[UserMemoryRepository.SCOPE_USER],
                    'budget': UserMemoryRepository.BUDGET_USER,
                    'last_source': self.events.lastSource(userId, UserMemoryRepository.SCOPE_USER),
                },
                'auto_update': {
                    'enabled': settings['enabled'],
                    'model': settings['model'],
                    'allowed_models': UserMemorySettingsRepository.ALLOWED_MODELS,
                },
            },
        }

    def update(self, request) -> dict:
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        body = request.get('body') if request.get('body') is not None else {}
        written = []

        for scope in (UserMemoryRepository.SCOPE_MEMORY, UserMemoryRepository.SCOPE_USER):
            if scope in body:
                before = self.repository.get(userId, scope)
                after = php_strval(body[scope])
                self.repository.set(userId, scope, after)
                self.events.log(
                    userId,
                    scope,
                    UserMemoryEventsRepository.SOURCE_MANUAL,
                    before,
                    after,
                    None,
                    None,
                )
                written.append(scope)

        if 'auto_update' in body and isinstance(body['auto_update'], (dict, list)):
            autoUpdate = body['auto_update']
            current = self.settings.get(userId)
            # array_key_exists in PHP: a list JSON value has only integer keys,
            # so a string key like 'enabled'/'model' never matches it.
            isDict = isinstance(autoUpdate, dict)
            enabled = php_bool(autoUpdate['enabled']) if isDict and 'enabled' in autoUpdate else current['enabled']
            model = php_strval(autoUpdate['model']) if isDict and 'model' in autoUpdate else current['model']

            try:
                self.settings.set(userId, enabled, model)
                written.append('auto_update')
            except ValueError as e:
                return {'success': False, 'error': str(e), 'status_code': 400}

        if not written:
            return {
                'success': False,
                'error': 'Nothing to update — provide "memory", "user", or "auto_update"',
                'status_code': 400,
            }

        return {'success': True, 'data': {'updated': written}}

    def listEvents(self, request) -> dict:
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        query = request.get('query') if request.get('query') is not None else {}
        limit = php_intval(query['limit'] if query.get('limit') is not None else 50)
        rows = self.events.list(userId, limit)

        return {
            'success': True,
            'data': [
                {
                    'id': php_intval(e['id']),
                    'scope': e['scope'],
                    'source': e['source'],
                    'before': e['before_content'],
                    'after': e['after_content'],
                    'rationale': e['rationale'],
                    'session_id': e['session_id'],
                    'created_at': e['created_at'],
                }
                for e in rows
            ],
        }

    def deleteEvent(self, request, id: int = 0) -> dict:
        """Universal "remove this audit entry" action.

        For a normal entry (source = manual / auto_extract / compact) the
        change it records is first undone -- memory is restored to the
        event's before_content -- then the audit row is removed. This
        keeps the audit log and the live memory in sync: you can't have
        a "we changed X" row without the change still being applied.

        For a SOURCE_REVERT row (legacy data from before the revert
        path was changed to delete-in-place), the change was already
        undone at the time the revert was triggered, so there's no
        state to restore -- we just remove the row.
        """
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        eventId = php_intval(id)
        if not eventId:
            return {'success': False, 'error': 'Invalid event id', 'status_code': 400}

        event = self.events.get(userId, eventId)
        if not event:
            return {'success': False, 'error': 'Event not found', 'status_code': 404}

        scope = event['scope']
        reverted = False
        if event['source'] != UserMemoryEventsRepository.SOURCE_REVERT:
            self.repository.set(userId, scope, php_strval(event['before_content']))
            reverted = True

        deleted = self.events.delete(userId, eventId)

        return {
            'success': True,
            'data': {
                'deleted_event': eventId,
                'scope': scope,
                'reverted': reverted,
                'deleted': deleted,
            },
        }
