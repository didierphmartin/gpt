from starlette.datastructures import Headers

from app.controllers.traces_controller import TracesController
from app.support.http import Ctx


class Db:
    def __init__(self): self.calls = []
    def fetch_all(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params)); return [{'t': 'execution_traces'}] if 'SHOW TABLES' in sql else []
    def fetch_one(self, *a): return None
    def fetch_column(self, *a): return []
    def execute(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 1
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 7


def ctx(body=None, query=None, user_id=3):
    c = Ctx(method='POST', uri='/api/v1/traces', headers=Headers({}), query=query or {}, body=body or {}, raw_body='', params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


def test_create_validation_and_mapping():
    c = TracesController(Db(), {})
    assert c.create(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert c.create(ctx(body={})) == {'success': False, 'error': 'Missing skill_dir', 'status_code': 400}
    db = Db(); c = TracesController(db, {})
    r = c.create(ctx(body={'skill_dir': 'docx', 'invocation_mode': 'bogus', 'success': 1, 'tokens_in': '12', 'exit_code': '0', 'output_files': 'nope', 'run_id': 99}))
    assert r == {'success': True, 'id': 7}
    sql, params = [x for x in db.calls if x[0].startswith('INSERT')][0]
    assert params[':invocation_mode'] == 'auto_discovery' and params[':env'] == 'chat' and params[':tokens_in'] == 12 and params[':run_id'] == '99' and params[':success'] == 1
    import json; payload = json.loads(params[':payload'])
    assert payload['output_files'] == [] and payload['skill_exit_code'] == 0


def test_diagnose_requires_auth_and_reads_days():
    c = TracesController(Db(), {})
    assert c.diagnose(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}
    r = c.diagnose(ctx(query={'days': '7'}))
    assert r['success'] is True and r['diagnosis']['window_days'] == 7 and r['diagnosis']['skills'] == []
