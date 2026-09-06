"""Port of Controllers/ContextController.php."""
from __future__ import annotations

import json

from app.support.phpcompat import mb_substr, php_empty


class ContextController:
    def __init__(self, db, config):
        self.db = db
        self.config = config

    def list(self, request) -> dict:
        rows = self.db.fetch_all(
            'SELECT id, title, provider, message_count, created_at, updated_at FROM conversation_contexts'
            ' WHERE user_id = ? ORDER BY updated_at DESC', [request['user_id']])
        return {'success': True, 'data': rows, 'status_code': 200}

    def get(self, request, id: int) -> dict:
        row = self.db.fetch_one(
            'SELECT id, title, context_data, provider, message_count, created_at, updated_at'
            ' FROM conversation_contexts WHERE id = ? AND user_id = ?', [id, request['user_id']])
        if not row:
            return {'success': False, 'message': 'Context not found', 'status_code': 404}
        try:
            row['context_data'] = json.loads(row['context_data']) if row['context_data'] is not None else None
        except ValueError:
            row['context_data'] = None
        return {'success': True, 'data': row, 'status_code': 200}

    def create(self, request) -> dict:
        user_id = request['user_id']
        inp = request['body']
        messages = inp.get('messages')
        if not messages or not isinstance(messages, list):
            return {'success': False, 'message': 'Messages array is required', 'status_code': 400}
        context_id = inp.get('id')
        metadata = inp.get('metadata')
        if metadata is None:
            metadata = []
        title = ''
        for msg in messages:
            if msg.get('role') == 'user':
                title = mb_substr(str(msg.get('content', '')), 0, 100)
                break
        if php_empty(title):
            title = 'Untitled Conversation'
        provider = 'unknown'
        for msg in reversed(messages):
            if msg.get('role') == 'assistant' and msg.get('provider'):
                provider = msg['provider']
                break
        message_count = len(messages)
        context_data = json.dumps({'messages': messages, 'metadata': metadata}, ensure_ascii=False,
                                  separators=(',', ':'))
        if not php_empty(context_id):
            self.db.execute(
                'UPDATE conversation_contexts SET title = ?, context_data = ?, provider = ?, message_count = ?,'
                ' updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                [title, context_data, provider, message_count, context_id, user_id])
            return {'success': True, 'message': 'Context updated successfully', 'data': {'id': context_id},
                    'status_code': 200}
        new_id = self.db.insert(
            'INSERT INTO conversation_contexts (user_id, title, context_data, provider, message_count)'
            ' VALUES (?, ?, ?, ?, ?)', [user_id, title, context_data, provider, message_count])
        return {'success': True, 'message': 'Context created successfully', 'data': {'id': int(new_id)},
                'status_code': 200}

    def update(self, request, id: int) -> dict:
        inp = request['body']
        if inp.get('title') is None or str(inp['title']).strip() == '':
            return {'success': False, 'message': 'Title is required', 'status_code': 400}
        n = self.db.execute('UPDATE conversation_contexts SET title = ? WHERE id = ? AND user_id = ?',
                            [str(inp['title']).strip(), id, request['user_id']])
        if n == 0:
            return {'success': False, 'message': 'Context not found', 'status_code': 404}
        return {'success': True, 'message': 'Context updated successfully', 'status_code': 200}

    def delete(self, request, id: int) -> dict:
        n = self.db.execute('DELETE FROM conversation_contexts WHERE id = ? AND user_id = ?', [id, request['user_id']])
        if n == 0:
            return {'success': False, 'message': 'Context not found', 'status_code': 404}
        return {'success': True, 'message': 'Context deleted successfully', 'status_code': 200}
