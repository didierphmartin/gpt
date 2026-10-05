"""Port of backend/src/Playbook/PlaybookStore.php and PlaybookStoreError.php.

The playbook collection: the only code that touches the `playbooks` table.
A playbook is its Console text, stored verbatim, plus a key unique per user;
the title is copied from the text on every save. Owner-scoped throughout.
"""
from __future__ import annotations

import re

from app.playbook.playbook_document import PlaybookDocument
from app.support.phpcompat import php_intval
from app.support.phpjson import php_json_decode


class PlaybookStoreError(RuntimeError):
    """PlaybookStoreError.php: a refused collection operation: kind (not_found,
    invalid_text, invalid_key, key_taken, in_use) and its HTTP status."""

    def __init__(self, kind: str, message: str, status: int):
        super().__init__(message)
        self.kind = kind
        self.status = status


_COLS = 'id, pkey, title, text, updated_at'


class PlaybookStore:
    KEY_RE = re.compile(r'[a-z0-9]+(-[a-z0-9]+)*')
    KEY_MAX = 64

    def __init__(self, db):
        self.db = db

    @staticmethod
    def keyFromTitle(title: str) -> str:
        """PHP 21-26. "Okta password reset" -> "okta-password-reset" (at most 64
        characters; "playbook" when nothing is left). strtolower is ASCII-only."""
        lowered = ''.join(c.lower() if c.isascii() else c for c in title)
        key = re.sub(r'[^a-z0-9]+', '-', lowered).strip('-')
        key = key[:PlaybookStore.KEY_MAX].rstrip('-')
        return 'playbook' if key == '' else key

    @staticmethod
    def isValidKey(key: str) -> bool:
        """PHP 28-31 (fullmatch: PHP's `$` would also let a trailing newline through)."""
        return len(key) <= PlaybookStore.KEY_MAX and PlaybookStore.KEY_RE.fullmatch(key) is not None

    def list(self, userId: int) -> list:
        """PHP 33-43."""
        rows = self.db.fetch_all(f'SELECT {_COLS} FROM playbooks WHERE user_id = ? ORDER BY title', [userId])
        out = []
        for r in rows:
            r = dict(r)
            r['id'] = int(r['id'])
            used = self.usedBy(userId, r['id'])
            r['used_by'] = len(used['agents']) + len(used['nodes'])
            out.append(r)
        return out

    def get(self, userId: int, id: int):
        """PHP 45-50."""
        row = self.db.fetch_one(f'SELECT {_COLS} FROM playbooks WHERE id = ? AND user_id = ?', [id, userId])
        return None if not row else {**row, 'id': int(row['id'])}

    def getByKey(self, userId: int, pkey: str):
        """PHP 52-57."""
        row = self.db.fetch_one(f'SELECT {_COLS} FROM playbooks WHERE pkey = ? AND user_id = ?', [pkey, userId])
        return None if not row else {**row, 'id': int(row['id'])}

    def save(self, userId: int, id, text: str, pkey) -> dict:
        """PHP 59-90. Create (id None) or update. The text must parse; the key
        defaults to the title's (create) or stays (update)."""
        try:
            title = PlaybookDocument.fromConsoleText(text).title
        except ValueError as e:
            raise PlaybookStoreError('invalid_text', str(e), 422)
        current = None if id is None else self.get(userId, id)
        if id is not None and current is None:
            raise PlaybookStoreError('not_found', f'Playbook #{id} not found', 404)
        key = pkey if pkey is not None else (current['pkey'] if current is not None else self.keyFromTitle(title))
        if not self.isValidKey(key):
            raise PlaybookStoreError(
                'invalid_key',
                f'Key "{key}": lowercase letters, digits and single dashes, at most 64 characters (e.g. okta-reset).', 422)
        clash = self.getByKey(userId, key)
        if clash is not None and clash['id'] != id:
            raise PlaybookStoreError('key_taken', f'Key "{key}" is already used by "{clash["title"]}".', 409)
        if id is None:
            id = int(self.db.insert(
                'INSERT INTO playbooks (user_id, pkey, title, text, created_at, updated_at) '
                'VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
                [userId, key, title, text]))
        else:
            self.db.execute(
                'UPDATE playbooks SET pkey = ?, title = ?, text = ?, updated_at = CURRENT_TIMESTAMP '
                'WHERE id = ? AND user_id = ?',
                [key, title, text, id, userId])
        return self.get(userId, id)

    def delete(self, userId: int, id: int) -> None:
        """PHP 92-107."""
        if self.get(userId, id) is None:
            raise PlaybookStoreError('not_found', f'Playbook #{id} not found', 404)
        used = self.usedBy(userId, id)
        names = ([f'agent "{a["name"]}"' for a in used['agents']]
                 + [f'node "{n["node_name"]}" in workflow "{n["workflow_name"]}"' for n in used['nodes']])
        if names:
            raise PlaybookStoreError('in_use', 'This playbook is used by ' + ', '.join(names) + '.', 409)
        self.db.execute('DELETE FROM playbooks WHERE id = ? AND user_id = ?', [id, userId])

    def usedBy(self, userId: int, id: int) -> dict:
        """PHP 109-132. The agents and workflow nodes (the user's own) that link to the playbook."""
        rows = self.db.fetch_all('SELECT id, name FROM agents WHERE user_id = ? AND playbook_id = ? ORDER BY name',
                                 [userId, id])
        agents = [{'id': int(a['id']), 'name': str(a['name'])} for a in rows]

        # The node's link lives in its config JSON: decoded here, so the query stays portable (MySQL and SQLite).
        rows = self.db.fetch_all(
            "SELECT n.config, w.id AS workflow_id, w.name AS workflow_name "
            "FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id "
            "WHERE w.user_id = ? AND n.node_type = 'playbook' ORDER BY w.name, n.id",
            [str(userId)])
        nodes = []
        for r in rows:
            cfg = php_json_decode(r['config'] if r['config'] is not None else '')
            if isinstance(cfg, dict) and php_intval(cfg.get('playbook_id') if cfg.get('playbook_id') is not None else 0) == id:
                nodes.append({'workflow_id': int(r['workflow_id']), 'workflow_name': str(r['workflow_name']),
                              'node_name': str(cfg['name']) if cfg.get('name') is not None else 'Playbook'})
        return {'agents': agents, 'nodes': nodes}
