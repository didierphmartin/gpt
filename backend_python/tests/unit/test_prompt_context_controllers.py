import json
from starlette.datastructures import Headers
from app.controllers.prompt_library_controller import PromptLibraryController, build_tree
from app.controllers.context_controller import ContextController
from app.support.http import Ctx


class FakeDb:
    def __init__(self, one=None, all_=None, rowcount=1, insert_id=55):
        self.one = list(one or []); self.all_ = list(all_ or []); self.rowcount = rowcount
        self.insert_id = insert_id; self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one.pop(0) if self.one else None
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return self.all_.pop(0) if self.all_ else []
    def execute(self, s, p=None): self.calls.append((s, p)); return self.rowcount
    def insert(self, s, p=None): self.calls.append((s, p)); return self.insert_id


def ctx(body=None, user_id=3):
    return Ctx(method='POST', uri='/', headers=Headers({}), query={}, body=body or {}, raw_body='', params={},
               user_id=user_id, authenticated=True, remote_addr='')


def test_build_tree_loose_match_drops_orphans_and_children_only_when_present():
    items = [{'id': 1, 'parent_id': None, 'name': 'root'}, {'id': 2, 'parent_id': 1, 'name': 'c'},
             {'id': 3, 'parent_id': 99, 'name': 'orphan'}, {'id': 4, 'parent_id': '1', 'name': 'str-parent'}]
    tree = build_tree(items)
    assert [n['id'] for n in tree] == [1]
    assert [c['id'] for c in tree[0]['children']] == [2, 4]
    assert 'children' not in tree[0]['children'][0]


def test_prompt_create_validation_and_string_id():
    c = PromptLibraryController(FakeDb(), {})
    assert c.create(ctx({'type': 'x', 'name': 'n'}))['message'] == 'Valid type (folder or prompt) is required'
    assert c.create(ctx({'type': 'prompt'}))['message'] == 'Name is required'
    db = FakeDb(one=[None])
    assert PromptLibraryController(db, {}).create(ctx({'type': 'prompt', 'name': 'n', 'parent_id': 9}))['message'] == 'Parent folder not found'
    r = PromptLibraryController(FakeDb(insert_id=55), {}).create(ctx({'type': 'folder', 'name': ' F ', 'content': 'ignored'}))
    assert r == {'success': True, 'message': 'Folder created successfully',
                 'data': {'id': '55', 'type': 'folder', 'name': 'F', 'parent_id': None, 'content': None}, 'status_code': 200}


def test_prompt_update_builds_dynamic_set():
    db = FakeDb(one=[{'id': 5, 'type': 'prompt'}])
    r = PromptLibraryController(db, {}).update(ctx({'name': ' N ', 'sort_order': 2}), 5)
    assert r == {'success': True, 'message': 'Prompt updated successfully', 'data': {'id': 5}, 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == 'UPDATE prompt_library SET name = ?, sort_order = ? WHERE id = ? AND user_id = ?' and params == ['N', 2, 5, 3]
    db2 = FakeDb(one=[{'id': 5, 'type': 'prompt'}])
    assert PromptLibraryController(db2, {}).update(ctx({'name': '  '}), 5)['message'] == 'No fields to update'
    assert PromptLibraryController(FakeDb(one=[None]), {}).update(ctx({'name': 'x'}), 5)['status_code'] == 404


def test_context_create_derives_title_provider_count_and_int_id():
    db = FakeDb(insert_id=9)
    msgs = [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'é' * 150},
            {'role': 'assistant', 'content': 'a', 'provider': 'claude'}, {'role': 'assistant', 'content': 'b'}]
    r = ContextController(db, {}).create(ctx({'messages': msgs, 'metadata': {'k': 1}}))
    assert r == {'success': True, 'message': 'Context created successfully', 'data': {'id': 9}, 'status_code': 200}
    sql, params = db.calls[-1]
    assert params[1] == 'é' * 100 and params[3] == 'claude' and params[4] == 4
    assert json.loads(params[2]) == {'messages': msgs, 'metadata': {'k': 1}}
    assert ContextController(FakeDb(), {}).create(ctx({'messages': []}))['message'] == 'Messages array is required'
    r2 = ContextController(FakeDb(), {}).create(ctx({'id': 4, 'messages': [{'role': 'assistant', 'content': 'x'}]}))
    assert r2['message'] == 'Context updated successfully' and r2['data'] == {'id': 4}


def test_context_get_decodes_json_and_update_delete_404_on_zero_rows():
    db = FakeDb(one=[{'id': 1, 'title': 't', 'context_data': '{"messages":[]}', 'provider': 'p', 'message_count': 0,
                      'created_at': 'c', 'updated_at': 'u'}])
    r = ContextController(db, {}).get(ctx(), 1)
    assert r['data']['context_data'] == {'messages': []}
    assert ContextController(FakeDb(rowcount=0), {}).update(ctx({'title': 'x'}), 1)['status_code'] == 404
    assert ContextController(FakeDb(rowcount=0), {}).delete(ctx(), 1)['status_code'] == 404
    assert ContextController(FakeDb(), {}).update(ctx({'title': ' '}), 1)['message'] == 'Title is required'
