"""Port of backend/src/Automation/AutomationStore.php.

The automation record: the only code that touches `automations` / `automation_instances`. Owner-scoped throughout.
An instance's environment is not a column (the connector profile is its only source); the last check keeps what the
connector reported inside `detail` as JSON {"environment": ..., "text": ...} for display.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from app.automation.automation_error import AutomationError
from app.support.phpcompat import php_intval, php_strval, php_trim
from app.support.phpjson import php_json_decode


def _gmnow() -> str:
    """gmdate('Y-m-d H:i:s')."""
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


def _json_unescaped(v) -> str:
    """json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."""
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


class AutomationStore:
    KEY_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,40}$')
    COLS = 'id, automation_key, title, version, spec_json, playbook_id, workflow_id, sn_scope, updated_at'

    def __init__(self, db):
        self.db = db

    def save(self, userId: int, key: str, title: str, spec) -> dict:
        """Creates version 1, or bumps the owner's existing key (same id) and stores the new title + spec."""
        if not self.KEY_RE.match(key):
            raise AutomationError('key must match ^[a-z0-9][a-z0-9-]{1,40}$')
        title = php_trim(title)
        if title == '' or len(title) > 255:
            raise AutomationError('title is required (max 255 characters)')
        if spec == [] or spec == {}:
            raise AutomationError('spec must be a non-empty object')
        js = _json_unescaped(spec)
        now = _gmnow()
        col = self.db.fetch_column('SELECT id FROM automations WHERE user_id = ? AND automation_key = ?', [userId, key])
        if col:
            id = col[0]
            self.db.execute('UPDATE automations SET version = version + 1, title = ?, spec_json = ?, updated_at = ? WHERE id = ? AND user_id = ?',
                            [title, js, now, id, userId])
        else:
            id = self.db.insert('INSERT INTO automations (user_id, automation_key, title, version, spec_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
                                [userId, key, title, js, now, now])
        return self.get(userId, php_intval(id))

    def replaceSpec(self, userId: int, id: int, spec) -> None:
        """Replaces the stored spec without touching the version (a PUT edit; only save() on an existing key bumps)."""
        self._require(userId, id)
        self.db.execute('UPDATE automations SET spec_json = ?, updated_at = ? WHERE id = ? AND user_id = ?',
                        [_json_unescaped(spec), _gmnow(), id, userId])

    def link(self, userId: int, id: int, playbookId: int | None, workflowId: int | None) -> dict:
        """Links the owner's playbook / workflow (None = leave as is) and stamps automation_id on those rows."""
        self._require(userId, id)
        pairs = [('playbooks', 'playbook_id', playbookId), ('agent_workflows', 'workflow_id', workflowId)]
        for table, col, rid in pairs:
            if rid is None:
                continue
            if not self.db.fetch_column(f'SELECT 1 FROM {table} WHERE id = ? AND user_id = ?', [rid, userId]):
                raise AutomationError(f'{col} not found', 404, 'not_found')
        for table, col, rid in pairs:
            if rid is None:
                continue
            self.db.execute(f'UPDATE {table} SET automation_id = ? WHERE id = ? AND user_id = ?', [id, rid, userId])
            self.db.execute(f'UPDATE automations SET {col} = ? WHERE id = ? AND user_id = ?', [rid, id, userId])
        return self.get(userId, id)

    def setScope(self, userId: int, id: int, scope: str) -> None:
        self.db.execute('UPDATE automations SET sn_scope = ? WHERE id = ? AND user_id = ?', [scope, id, userId])

    def get(self, userId: int, id: int) -> dict | None:
        r = self.db.fetch_one('SELECT ' + self.COLS + ' FROM automations WHERE id = ? AND user_id = ?', [id, userId])
        return self._row(r) if r else None

    def list(self, userId: int) -> list[dict]:
        out = []
        for r in self.db.fetch_all('SELECT ' + self.COLS + ' FROM automations WHERE user_id = ? ORDER BY automation_key', [userId]):
            row = self._row(r)
            row['instances'] = self.instances(row['id'])
            out.append(row)
        return out

    def instances(self, automationId: int) -> list[dict]:
        """The automation's instances (call only after the owner check)."""
        out = []
        for r in self.db.fetch_all('SELECT mcp_server_id, installed_version, sn_item_sys_id, last_check_at, status, detail\n'
                                   '            FROM automation_instances WHERE automation_id = ? ORDER BY mcp_server_id', [automationId]):
            env, text = self._decodeDetail(r.get('detail'))
            out.append({'mcp_server_id': php_intval(r['mcp_server_id']),
                        'installed_version': None if r['installed_version'] is None else php_intval(r['installed_version']),
                        'sn_item_sys_id': r['sn_item_sys_id'], 'last_check_at': r['last_check_at'],
                        'status': r['status'], 'environment': env, 'detail': text})
        return out

    def saveInstance(self, automationId: int, serverId: int, status: str, version: int | None, sysId: str | None,
                     environment: str | None, text: str) -> None:
        # json_encode($v, JSON_UNESCAPED_UNICODE): slashes stay escaped
        detail = json.dumps({'environment': environment, 'text': text}, ensure_ascii=False, separators=(',', ':')).replace('/', '\\/')
        now = _gmnow()
        if not self.db.fetch_column('SELECT 1 FROM automation_instances WHERE automation_id = ? AND mcp_server_id = ?',
                                    [automationId, serverId]):
            self.db.execute('INSERT INTO automation_instances (automation_id, mcp_server_id, installed_version, sn_item_sys_id, last_check_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
                            [automationId, serverId, version, sysId, now, status, detail])
        else:
            self.db.execute('UPDATE automation_instances SET installed_version = ?, sn_item_sys_id = ?, last_check_at = ?, status = ?, detail = ? WHERE automation_id = ? AND mcp_server_id = ?',
                            [version, sysId, now, status, detail, automationId, serverId])

    def servers(self, userId: int) -> list[dict]:
        """The owner's MCP servers whose name starts with "ServiceNow": [{id, name, environment|None}], environment from
        the latest check of any of the owner's automations on that server. Never includes URL or headers."""
        out = []
        for r in self.db.fetch_all('SELECT id, name FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY id', [str(userId)]):
            if not php_strval(r['name']).startswith('ServiceNow'):
                continue
            d = self.db.fetch_column('SELECT i.detail FROM automation_instances i JOIN automations a ON a.id = i.automation_id\n'
                                     '                WHERE a.user_id = ? AND i.mcp_server_id = ? AND i.last_check_at IS NOT NULL ORDER BY i.last_check_at DESC, i.automation_id DESC LIMIT 1',
                                     [userId, r['id']])
            out.append({'id': php_intval(r['id']), 'name': php_strval(r['name']),
                        'environment': None if not d else self._decodeDetail(d[0])[0]})
        return out

    def serverRow(self, userId: int, serverId: int) -> dict | None:
        """The owner's enabled server row (id, name, url, headers JSON) or None."""
        r = self.db.fetch_one('SELECT id, name, url, headers FROM mcp_servers WHERE id = ? AND user_id = ? AND enabled = 1',
                              [serverId, str(userId)])
        return r if r else None

    def _require(self, userId: int, id: int) -> None:
        if self.get(userId, id) is None:
            raise AutomationError('automation not found', 404, 'not_found')

    @staticmethod
    def _row(r: dict) -> dict:
        spec = php_json_decode(php_strval(r['spec_json']))
        return {'id': php_intval(r['id']), 'key': php_strval(r['automation_key']), 'title': php_strval(r['title']),
                'version': php_intval(r['version']), 'spec': spec if isinstance(spec, (dict, list)) else [],
                'playbook_id': None if r['playbook_id'] is None else php_intval(r['playbook_id']),
                'workflow_id': None if r['workflow_id'] is None else php_intval(r['workflow_id']),
                'sn_scope': r['sn_scope'], 'updated_at': r['updated_at']}

    @staticmethod
    def _decodeDetail(detail) -> tuple:
        """(environment|None, text) from a detail column (JSON, or legacy plain text)."""
        d = None
        if isinstance(detail, str):
            try:
                d = json.loads(detail)
            except ValueError:
                d = None
        if not isinstance(d, (dict, list)):
            return None, php_strval(detail if detail is not None else '')
        d = d if isinstance(d, dict) else {}
        env = d.get('environment')
        text = d.get('text')
        return (env if isinstance(env, str) else None), php_strval(text if text is not None else '')
