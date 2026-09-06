"""Port of Controllers/PromptLibraryController.php."""
from __future__ import annotations

from app.support.phpcompat import php_empty, ucfirst

_SELECT = ('SELECT id, parent_id, type, name, content, sort_order, created_at, updated_at'
           ' FROM prompt_library')


def _loose_eq(a, b) -> bool:
    """PHP `==` for the parent_id comparison: null==null, "3"==3, 3==3."""
    if a is None or b is None:
        return a is None and b is None
    try:
        return int(a) == int(b)
    except (TypeError, ValueError):
        return str(a) == str(b)


def build_tree(items: list[dict], parent_id=None) -> list[dict]:
    branch = []
    for item in items:
        if _loose_eq(item.get('parent_id'), parent_id):
            node = dict(item)
            children = build_tree(items, int(item['id']))
            if children:
                node['children'] = children
            branch.append(node)
    return branch


class PromptLibraryController:
    def __init__(self, db, config):
        self.db = db
        self.config = config

    def getTree(self, request) -> dict:
        items = self.db.fetch_all(_SELECT + ' WHERE user_id = ? ORDER BY parent_id, sort_order, name',
                                  [request['user_id']])
        return {'success': True, 'data': build_tree(items), 'status_code': 200}

    def get(self, request, id: int) -> dict:
        item = self.db.fetch_one(_SELECT + ' WHERE id = ? AND user_id = ?', [id, request['user_id']])
        if not item:
            return {'success': False, 'message': 'Item not found', 'status_code': 404}
        return {'success': True, 'data': item, 'status_code': 200}

    def create(self, request) -> dict:
        user_id = request['user_id']
        inp = request['body']
        if not inp.get('type') or inp['type'] not in ('folder', 'prompt'):
            return {'success': False, 'message': 'Valid type (folder or prompt) is required', 'status_code': 400}
        if php_empty(inp.get('name')):
            return {'success': False, 'message': 'Name is required', 'status_code': 400}
        type_ = inp['type']
        name = str(inp['name']).strip()
        parent_id = inp.get('parent_id')
        content = inp['content'] if (type_ == 'prompt' and 'content' in inp) else None
        sort_order = inp.get('sort_order')
        if sort_order is None:
            sort_order = 0
        if parent_id is not None:
            if not self.db.fetch_one('SELECT id FROM prompt_library WHERE id = ? AND user_id = ?', [parent_id, user_id]):
                return {'success': False, 'message': 'Parent folder not found', 'status_code': 400}
        new_id = self.db.insert(
            'INSERT INTO prompt_library (user_id, parent_id, type, name, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, parent_id, type_, name, content, sort_order])
        return {'success': True, 'message': ucfirst(type_) + ' created successfully',
                'data': {'id': str(new_id), 'type': type_, 'name': name, 'parent_id': parent_id, 'content': content},
                'status_code': 200}

    def update(self, request, id: int) -> dict:
        user_id = request['user_id']
        inp = request['body']
        item = self.db.fetch_one('SELECT id, type FROM prompt_library WHERE id = ? AND user_id = ?', [id, user_id])
        if not item:
            return {'success': False, 'message': 'Item not found', 'status_code': 404}
        updates, params = [], []
        if inp.get('name') is not None and str(inp['name']).strip():
            updates.append('name = ?'); params.append(str(inp['name']).strip())
        if inp.get('content') is not None:
            updates.append('content = ?'); params.append(inp['content'])
        if inp.get('parent_id') is not None:
            updates.append('parent_id = ?'); params.append(inp['parent_id'])
        if inp.get('sort_order') is not None:
            updates.append('sort_order = ?'); params.append(inp['sort_order'])
        if not updates:
            return {'success': False, 'message': 'No fields to update', 'status_code': 400}
        params += [id, user_id]
        self.db.execute('UPDATE prompt_library SET ' + ', '.join(updates) + ' WHERE id = ? AND user_id = ?', params)
        return {'success': True, 'message': ucfirst(item['type']) + ' updated successfully', 'data': {'id': id},
                'status_code': 200}

    def delete(self, request, id: int) -> dict:
        user_id = request['user_id']
        item = self.db.fetch_one('SELECT id, type, name FROM prompt_library WHERE id = ? AND user_id = ?', [id, user_id])
        if not item:
            return {'success': False, 'message': 'Item not found', 'status_code': 404}
        self.db.execute('DELETE FROM prompt_library WHERE id = ? AND user_id = ?', [id, user_id])
        return {'success': True, 'message': ucfirst(item['type']) + ' deleted successfully', 'status_code': 200}
