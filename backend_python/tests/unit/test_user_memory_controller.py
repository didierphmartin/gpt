from starlette.datastructures import Headers

from app.agent_team.controllers.user_memory_controller import UserMemoryController
from app.support.http import Ctx


class FakeDb:
    """Records queries; answers fetch_one/fetch_all from a canned queue."""
    def __init__(self, one=None, all_=None, rowcount=1, insert_id=5):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
        self.insert_id = insert_id
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        return self.all_.pop(0) if self.all_ else []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append((sql, params))
        return self.insert_id


UNAUTH = {'success': False, 'error': 'Authentication required', 'status_code': 401}


def ctx(body=None, query=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
               params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


# --- auth guard on every method -------------------------------------------

def test_all_methods_401_when_unauthenticated():
    db = FakeDb()
    c = UserMemoryController(db, {})
    assert c.show(ctx(user_id=None)) == UNAUTH
    assert c.update(ctx(user_id=None)) == UNAUTH
    assert c.listEvents(ctx(user_id=None)) == UNAUTH
    assert c.deleteEvent(ctx(user_id=None), 1) == UNAUTH
    assert not db.calls


def test_all_methods_401_when_user_id_zero():
    db = FakeDb()
    c = UserMemoryController(db, {})
    assert c.show(ctx(user_id=0)) == UNAUTH


# --- show -------------------------------------------------------------

def test_show_assembles_both_scopes_budgets_and_settings():
    db = FakeDb(
        all_=[[{'scope': 'memory', 'content': 'env facts'}, {'scope': 'user', 'content': 'likes tea'}]],
        # popped in call order: settings.get(), events.lastSource(memory), events.lastSource(user)
        one=[{'auto_update_enabled': 1, 'auto_update_model': 'claude-haiku-4-5-20251001'},
             {'source': 'manual'}, {'source': 'auto_extract'}],
    )
    r = UserMemoryController(db, {}).show(ctx())
    assert r == {
        'success': True,
        'data': {
            'memory': {'content': 'env facts', 'budget': 2200, 'last_source': 'manual'},
            'user': {'content': 'likes tea', 'budget': 1375, 'last_source': 'auto_extract'},
            'auto_update': {
                'enabled': True,
                'model': 'claude-haiku-4-5-20251001',
                'allowed_models': [
                    'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929',
                    'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307',
                ],
            },
        },
    }


# --- update -------------------------------------------------------------

def test_update_memory_scope_logs_event_and_reports_written():
    db = FakeDb(one=[{'content': 'old content'}])   # UserMemoryRepository.get(...) before write
    r = UserMemoryController(db, {}).update(ctx(body={'memory': 'new content'}))
    assert r == {'success': True, 'data': {'updated': ['memory']}}
    set_call = next(p for s, p in db.calls if s.startswith('INSERT INTO user_memories'))
    assert set_call == {'user_id': 3, 'scope': 'memory', 'content': 'new content'}
    log_call = next(p for s, p in db.calls if s.startswith('INSERT INTO user_memory_events'))
    assert log_call == {'user_id': 3, 'scope': 'memory', 'source': 'manual', 'before': 'old content',
                        'after': 'new content', 'rationale': None, 'session_id': None}


def test_update_both_scopes_written_in_order():
    db = FakeDb(one=[{'content': ''}, {'content': ''}])
    r = UserMemoryController(db, {}).update(ctx(body={'memory': 'm', 'user': 'u'}))
    assert r['data']['updated'] == ['memory', 'user']


def test_update_no_write_when_before_equals_after_skips_event_log():
    db = FakeDb(one=[{'content': 'same'}])
    r = UserMemoryController(db, {}).update(ctx(body={'memory': 'same'}))
    assert r['data']['updated'] == ['memory']
    assert not any(s.startswith('INSERT INTO user_memory_events') for s, _ in db.calls)


def test_update_non_string_body_value_coerced_via_php_strval():
    db = FakeDb(one=[{'content': ''}])
    UserMemoryController(db, {}).update(ctx(body={'memory': 123}))
    set_call = next(p for s, p in db.calls if s.startswith('INSERT INTO user_memories'))
    assert set_call['content'] == '123'


def test_update_auto_update_partial_fields_keep_current_values():
    db = FakeDb(one=[{'auto_update_enabled': 1, 'auto_update_model': 'claude-3-haiku-20240307'}])
    r = UserMemoryController(db, {}).update(ctx(body={'auto_update': {'enabled': False}}))
    assert r == {'success': True, 'data': {'updated': ['auto_update']}}
    settings_call = next(p for s, p in db.calls if s.startswith('INSERT INTO user_memory_settings'))
    assert settings_call == {'user_id': 3, 'enabled': 0, 'model': 'claude-3-haiku-20240307'}


def test_update_auto_update_invalid_model_returns_php_error_string():
    db = FakeDb(one=[{'auto_update_enabled': 1, 'auto_update_model': 'claude-haiku-4-5-20251001'}])
    r = UserMemoryController(db, {}).update(ctx(body={'auto_update': {'model': 'not-a-real-model'}}))
    assert r == {'success': False, 'error': 'Unsupported model: not-a-real-model', 'status_code': 400}


def test_update_auto_update_non_array_value_is_ignored():
    db = FakeDb()
    r = UserMemoryController(db, {}).update(ctx(body={'auto_update': 'not-an-object'}))
    assert r == {'success': False, 'error': 'Nothing to update — provide "memory", "user", or "auto_update"',
                'status_code': 400}


def test_update_nothing_to_update_returns_php_error_string():
    db = FakeDb()
    r = UserMemoryController(db, {}).update(ctx(body={}))
    assert r == {'success': False, 'error': 'Nothing to update — provide "memory", "user", or "auto_update"',
                'status_code': 400}
    assert not db.calls


# --- listEvents -------------------------------------------------------------

def test_list_events_default_limit_50_and_maps_fields():
    db = FakeDb(all_=[[{
        'id': 7, 'scope': 'memory', 'source': 'manual', 'before_content': 'a', 'after_content': 'b',
        'rationale': None, 'session_id': None, 'created_at': '2026-09-01 00:00:00',
    }]])
    r = UserMemoryController(db, {}).listEvents(ctx())
    assert r == {'success': True, 'data': [{
        'id': 7, 'scope': 'memory', 'source': 'manual', 'before': 'a', 'after': 'b',
        'rationale': None, 'session_id': None, 'created_at': '2026-09-01 00:00:00',
    }]}
    sql, _ = db.calls[-1]
    assert 'LIMIT 50' in sql


def test_list_events_custom_limit():
    db = FakeDb(all_=[[]])
    UserMemoryController(db, {}).listEvents(ctx(query={'limit': '5'}))
    sql, _ = db.calls[-1]
    assert 'LIMIT 5' in sql


# --- deleteEvent -------------------------------------------------------------

def test_delete_event_invalid_id_returns_400():
    db = FakeDb()
    r = UserMemoryController(db, {}).deleteEvent(ctx(), 0)
    assert r == {'success': False, 'error': 'Invalid event id', 'status_code': 400}
    assert not db.calls


def test_delete_event_not_found_returns_404():
    db = FakeDb(one=[None])
    r = UserMemoryController(db, {}).deleteEvent(ctx(), 999)
    assert r == {'success': False, 'error': 'Event not found', 'status_code': 404}


def test_delete_event_normal_source_restores_before_content_then_deletes():
    db = FakeDb(one=[{'id': 9, 'scope': 'memory', 'source': 'manual', 'before_content': 'old', 'after_content': 'new'}])
    r = UserMemoryController(db, {}).deleteEvent(ctx(), 9)
    assert r == {'success': True, 'data': {'deleted_event': 9, 'scope': 'memory', 'reverted': True, 'deleted': True}}
    restore_call = next(p for s, p in db.calls if s.startswith('INSERT INTO user_memories'))
    assert restore_call == {'user_id': 3, 'scope': 'memory', 'content': 'old'}
    delete_call = next(p for s, p in db.calls if s.startswith('DELETE FROM user_memory_events'))
    assert delete_call == [9, 3]


def test_delete_event_revert_source_does_not_restore_content():
    db = FakeDb(one=[{'id': 9, 'scope': 'user', 'source': 'revert', 'before_content': 'old', 'after_content': 'new'}])
    r = UserMemoryController(db, {}).deleteEvent(ctx(), 9)
    assert r == {'success': True, 'data': {'deleted_event': 9, 'scope': 'user', 'reverted': False, 'deleted': True}}
    assert not any(s.startswith('INSERT INTO user_memories') for s, _ in db.calls)
