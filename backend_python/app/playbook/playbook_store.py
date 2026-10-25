"""Port of backend/src/Playbook/PlaybookStore.php and PlaybookStoreError.php.

The playbook collection: the only code that touches the `playbooks` table.
A playbook is its Console text, stored verbatim, plus a key unique per user;
the title is copied from the text on every save. Owner-scoped throughout.
"""
from __future__ import annotations

import re
import unicodedata

from app.playbook.playbook_document import PlaybookDocument
from app.support.phpcompat import php_intval, php_trim
from app.support.phpjson import php_json_decode


class PlaybookStoreError(RuntimeError):
    """PlaybookStoreError.php: a refused collection operation: kind (not_found,
    invalid_text, invalid_key, key_taken, in_use, replaces), its HTTP status, and
    optional data for the client."""

    def __init__(self, kind: str, message: str, status: int, data: dict | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.data = data or {}


_COLS = 'id, pkey, title, text, updated_at'


class PlaybookStore:
    KEY_RE = re.compile(r'[a-z0-9]+(-[a-z0-9]+)*')
    KEY_MAX = 64
    TITLE_MAX = 255

    def __init__(self, db):
        self.db = db

    @staticmethod
    def keyFromTitle(title: str) -> str:
        """PHP 21-26. "Okta password reset" -> "okta-password-reset" (at most 64
        characters; "playbook" when nothing is left). Accents are dropped first (NFD,
        marks removed: "Ça va" -> "ca-va"). strtolower is ASCII-only."""
        title = ''.join(c for c in unicodedata.normalize('NFD', title) if not unicodedata.category(c).startswith('M'))
        lowered = ''.join(c.lower() if c.isascii() else c for c in title)
        key = re.sub(r'[^a-z0-9]+', '-', lowered).strip('-')
        key = key[:PlaybookStore.KEY_MAX].rstrip('-')
        return 'playbook' if key == '' else key

    @staticmethod
    def isValidKey(key: str) -> bool:
        """PHP 28-31 (fullmatch: PHP's `$` would also let a trailing newline through)."""
        return len(key) <= PlaybookStore.KEY_MAX and PlaybookStore.KEY_RE.fullmatch(key) is not None

    def freeKey(self, userId: int, base: str) -> str:
        """base when the user has no playbook with it, else base-2, base-3… (still at most 64 characters)."""
        key = base
        i = 2
        while self.getByKey(userId, key) is not None:
            suffix = f'-{i}'
            key = base[:self.KEY_MAX - len(suffix)].rstrip('-') + suffix
            i += 1
        return key

    def list(self, userId: int) -> list:
        """PHP 33-43."""
        # automation_id: the automation that manages the playbook (None = none); save_playbook_agent checks it on a key clash.
        rows = self.db.fetch_all(f'SELECT {_COLS}, automation_id FROM playbooks WHERE user_id = ? ORDER BY title', [userId])
        out = []
        for r in rows:
            r = dict(r)
            r['id'] = int(r['id'])
            r['automation_id'] = None if r['automation_id'] is None else int(r['automation_id'])
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
        if len(title) > self.TITLE_MAX:
            raise PlaybookStoreError(
                'invalid_text', f'The title is longer than 255 characters ({len(title)}); shorten the "Title:" line.', 422)
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

    def publish(self, userId: int, id: int, robotId: int, confirmReplace: bool) -> dict:
        """Publish the user's playbook to the robot as a frozen copy (one version). A source
        has at most one robot copy: republishing finds it by source_id and moves it to the
        current key. A key held by another robot row (another or a deleted source) is
        refused with `replaces` unless confirmReplace; then that row goes and ours takes the key."""
        src = self.get(userId, id)
        if src is None:
            raise PlaybookStoreError('not_found', f'Playbook #{id} not found', 404)
        own = self.db.fetch_one('SELECT id FROM playbooks WHERE user_id = ? AND source_id = ? ORDER BY id LIMIT 1',
                                [robotId, id])
        ownId = None if own is None else int(own['id'])
        holder = self.getByKey(robotId, src['pkey'])
        if holder is not None and holder['id'] == ownId:
            holder = None   # the key is already ours
        targetId = ownId
        if holder is not None:
            meta = self.db.fetch_one('SELECT source_id, published_by, published_at FROM playbooks WHERE id = ?',
                                     [holder['id']])
            sameSource = ownId is None and meta['source_id'] is not None and int(meta['source_id']) == id
            if sameSource:
                targetId = holder['id']
            elif not confirmReplace:
                by = self._person_name(meta['published_by'])
                raise PlaybookStoreError('replaces', f'The robot already has "{src["pkey"]}", published by {by}.', 409,
                                         {'published_by': by, 'published_at': meta['published_at']})
            elif ownId is None:
                targetId = holder['id']
        self.db.begin()
        try:
            if holder is not None and targetId == ownId and ownId is not None:
                # our copy moves onto a key another copy holds: that copy goes
                self.db.execute('DELETE FROM playbooks WHERE id = ? AND user_id = ?', [holder['id'], robotId])
            row = self.save(robotId, targetId, src['text'], src['pkey'])
            self.db.execute('UPDATE playbooks SET published_by = ?, published_at = CURRENT_TIMESTAMP, source_id = ? '
                            'WHERE id = ? AND user_id = ?', [userId, id, row['id'], robotId])
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        out = self.db.fetch_one('SELECT id, pkey, title, text, updated_at, published_by, published_at, source_id '
                                'FROM playbooks WHERE id = ?', [row['id']])
        return {**out, 'id': int(out['id'])}

    def robotList(self, robotId: int) -> list:
        """The robot's collection with who published each and the title of its source (None when the source is gone)."""
        rows = self.db.fetch_all(
            'SELECT p.id, p.pkey, p.title, p.text, p.updated_at, p.published_by, p.published_at, p.source_id, '
            's.title AS source_title '
            'FROM playbooks p LEFT JOIN playbooks s ON s.id = p.source_id WHERE p.user_id = ? ORDER BY p.title',
            [robotId])
        return [{**r, 'id': int(r['id']),
                 'published_by_name': None if r['published_by'] is None else self._person_name(r['published_by'])}
                for r in rows]

    def unpublish(self, robotId: int, robotPlaybookId: int) -> None:
        if self.get(robotId, robotPlaybookId) is None:
            raise PlaybookStoreError('not_found', f'Playbook #{robotPlaybookId} not found', 404)
        self.db.execute('DELETE FROM playbooks WHERE id = ? AND user_id = ?', [robotPlaybookId, robotId])

    def publishStatus(self, userId: int, robotId: int) -> dict:
        """source playbook id -> 'published' (robot copy equals the source) | 'changed' (the source was edited since)."""
        rows = self.db.fetch_all(
            'SELECT s.id, s.text AS source_text, r.text AS robot_text '
            'FROM playbooks r JOIN playbooks s ON s.id = r.source_id AND s.user_id = ? WHERE r.user_id = ? ORDER BY r.id',
            [userId, robotId])
        return {int(r['id']): 'published' if r['source_text'] == r['robot_text'] else 'changed' for r in rows}

    def _person_name(self, userId) -> str:
        """First + last name, else the email; '' when the user is gone."""
        if userId is None:
            return ''
        u = self.db.fetch_one('SELECT email, first_name, last_name FROM users WHERE id = ?', [userId])
        if u is None:
            return ''
        name = php_trim(php_trim(str(u['first_name'] or '')) + ' ' + php_trim(str(u['last_name'] or '')))
        return name if name != '' else str(u['email'] or '')

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
