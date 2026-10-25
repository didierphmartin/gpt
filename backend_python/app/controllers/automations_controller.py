"""Port of backend/src/Controllers/AutomationsController.php.

/api/v1/automations -- the automation record, its drift check against the owner's ServiceNow MCP servers, and the
dev/test install through the connector's deploy toolset. Owner-scoped on every route. Stored server headers are
sent to the deploy URL and never returned or logged.
"""
from __future__ import annotations

import json
import re

from app.automation.automation_error import AutomationError
from app.automation.automation_mcp import LiveAutomationMcp
from app.automation.automation_store import AutomationStore
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_empty, php_intval, php_strval

_SCOPE = re.compile(r'^[A-Za-z0-9_]{1,100}$')
_DEPLOY = re.compile(r'/jobs(?:/mcp)?/?$')
# A PHP array key that is a canonical decimal integer string becomes an int key (json_decode('{"0": ...}', true)).
_INT_KEY = re.compile(r'^(?:0|-?[1-9][0-9]{0,18})$')


class AutomationsController:
    STAMP_VARIABLE = 'synergyai_automation'
    INSTALL_TIMEOUT_S = 900

    def __init__(self, db, config: dict, mcp=None, reconnect=None):
        """reconnect: a fresh connection to the same database (default: config contexts_database, like AgentRunner)."""
        self.db = db
        self.store = AutomationStore(db)
        self.mcp = mcp if mcp is not None else LiveAutomationMcp(db)

        def default_reconnect():
            from app.db import Db
            c = config.get('contexts_database') or config.get('database') or {}
            return Db.connect(c)
        self.reconnect = reconnect if reconnect is not None else default_reconnect

    def _reconnectIfGone(self) -> None:
        """After a minutes-long call the server may have closed the idle connection (MySQL 2006): open a fresh one.
        The fresh connection is not closed by main.py (it closes the request's own); it is released with the controller."""
        try:
            self.db.fetch_column('SELECT 1')
        except Exception as e:  # noqa: BLE001 -- PHP: catch (\PDOException $e)
            error_log('[AutomationsController] DB connection lost during the install, reconnecting: ' + str(e))
            self.db = self.reconnect()
            self.store = AutomationStore(self.db)
            self.mcp = LiveAutomationMcp(self.db) if isinstance(self.mcp, LiveAutomationMcp) else self.mcp

    def index(self, request: dict) -> dict:
        def action(u):
            rows = self.store.list(u)
            servers = self.store.servers(u)
            for r in rows:
                r['servers'] = servers
            return {'success': True, 'data': rows, 'status_code': 200}
        return self._guard(request, action)

    def create(self, request: dict) -> dict:
        def action(u):
            b = self._body(request)
            if not isinstance(b.get('key'), str) or not isinstance(b.get('title'), str) or not isinstance(b.get('spec'), (dict, list)):
                raise AutomationError('body must be {key, title, spec}')
            a = self.store.save(u, b['key'], b['title'], b['spec'])
            return {'success': True, 'data': self._summary(u, a), 'status_code': 201}
        return self._guard(request, action)

    def update(self, request: dict, id=None) -> dict:
        def action(u):
            id = self._id(request)
            b = self._body(request)
            if self.store.get(u, id) is None:
                raise AutomationError('automation not found', 404, 'not_found')
            if 'spec' in b:
                if not isinstance(b['spec'], (dict, list)) or b['spec'] in ([], {}):
                    raise AutomationError('spec must be a non-empty object')
                self.store.replaceSpec(u, id, b['spec'])
            a = self.store.link(u, id, self._optId(b, 'playbook_id'), self._optId(b, 'workflow_id'))
            return {'success': True, 'data': self._summary(u, a), 'status_code': 200}
        return self._guard(request, action)

    def check(self, request: dict, id=None) -> dict:
        def action(u):
            a = self._owned(u, request)
            for s in self.store.servers(u):
                self._checkOne(u, a, s)
            return {'success': True, 'data': {'instances': self.store.instances(a['id']), 'servers': self.store.servers(u)},
                    'status_code': 200}
        return self._guard(request, action)

    def install(self, request: dict, id=None) -> dict:
        def action(u):
            a = self._owned(u, request)
            b = self._body(request)
            serverId = php_intval(b.get('server_id') if b.get('server_id') is not None else 0)
            scope = b.get('scope')
            files = b.get('files')
            if (serverId <= 0 or not isinstance(scope, str) or not _SCOPE.match(scope)
                    or not self._isFileMap(files)):
                raise AutomationError('body must be {server_id, scope, files: {path: text}}')
            server = self.store.serverRow(u, serverId)
            if server is None:
                raise AutomationError('server not found', 404, 'not_found')
            url = self.deployUrl(php_strval(server['url'])) if php_strval(server['name']).startswith('ServiceNow') else None
            if url is None:
                raise AutomationError('not a ServiceNow connector server URL (.../jobs)')
            r = self.mcp.install(url, self._headerLines(server.get('headers')), {'scope': scope, 'files': files},
                                 self.INSTALL_TIMEOUT_S)
            self._reconnectIfGone()
            payload, err = self._payload(r)
            if err is not None:
                status = {'not_allowed': 409, 'bad_argument': 400}.get(err, 502)
                # the connector's message (for install_failed: the failing step and its log tail), so the cause is visible
                res = r.get('result')
                sc = res.get('structuredContent') if isinstance(res, dict) else None
                e = sc.get('error') if isinstance(sc, dict) else None
                msg = e.get('message') if isinstance(e, dict) else None
                msg = msg[:2000] if isinstance(msg, str) and msg != '' else None
                return {'success': False, 'error': f'{err}: {msg}' if msg is not None else err, 'code': err, 'message': msg,
                        'status_code': status}
            self.store.setScope(u, a['id'], scope)
            return {'success': True, 'data': payload, 'status_code': 200}
        return self._guard(request, action)

    @staticmethod
    def _isFileMap(files) -> bool:
        """{path: text}: a non-empty object whose keys are strings (not integer-like: PHP makes those int keys)
        and whose values are strings."""
        if not isinstance(files, dict) or not files:
            return False
        return all(isinstance(k, str) and not _INT_KEY.match(k) and isinstance(v, str) for k, v in files.items())

    @staticmethod
    def deployUrl(serverUrl: str) -> str | None:
        """The deploy URL for a connector server URL: the final /jobs (optionally followed by /mcp) becomes /deploy."""
        new, n = _DEPLOY.subn('/deploy', serverUrl, count=1)
        return new if n == 1 else None

    def _checkOne(self, u: int, a: dict, server: dict) -> None:
        r = self.mcp.describe(u, server['name'], a['key'])
        payload, err = self._payload(r)
        if err is not None:
            self.store.saveInstance(a['id'], server['id'], 'out_of_sync', None, None, None, 'cannot check: ' + err)
            return
        env = payload.get('environment') if isinstance(payload.get('environment'), str) else None
        # item None = not installed; no item key, or not an object = a garbled answer the check cannot read
        if 'item' not in payload or (payload['item'] is not None and not isinstance(payload['item'], (dict, list))):
            self.store.saveInstance(a['id'], server['id'], 'out_of_sync', None, None, env, 'cannot check: bad_answer')
            return
        item = payload['item']
        if item is None:
            self.store.saveInstance(a['id'], server['id'], 'not_installed', None, None, env, '')
            return
        item = item if isinstance(item, dict) else dict(enumerate(item))
        version = php_intval(item['version']) if item.get('version') is not None and is_numeric(item['version']) else None
        diffs = self._differences(a, item, version)
        self.store.saveInstance(a['id'], server['id'], 'in_sync' if not diffs else 'out_of_sync', version,
                                item.get('sys_id') if isinstance(item.get('sys_id'), str) else None, env, '; '.join(diffs))

    @classmethod
    def _differences(cls, a: dict, item: dict, version: int | None) -> list[str]:
        """Variable names and mandatory flags (bool, default false; the stamp variable ignored), then the version."""
        spec = a['spec'] if isinstance(a['spec'], dict) else {}
        form = spec.get('form') if isinstance(spec.get('form'), dict) else {}
        want: dict = {}
        for v in cls._values(form.get('variables')):
            if isinstance(v, dict) and isinstance(v.get('name'), str):
                want[v['name']] = v.get('mandatory', False) is True
        have: dict = {}
        for v in cls._values(item.get('variables')):
            if isinstance(v, dict) and isinstance(v.get('name'), str) and v['name'] != cls.STAMP_VARIABLE:
                have[v['name']] = v.get('mandatory', False) is True
        d = []
        for n, m in want.items():
            if n not in have:
                d.append(f'variable {n} missing in ServiceNow')
            elif have[n] != m:
                d.append(f'variable {n} mandatory is ' + ('true' if have[n] else 'false') + ' in ServiceNow, '
                         + ('true' if m else 'false') + ' in the spec')
        for n in have:
            if n not in want:
                d.append(f'variable {n} exists in ServiceNow but not in the spec')
        if version is None:
            d.append(f"version unknown in ServiceNow, spec is {a['version']}")
        elif version != a['version']:
            d.append(f"version {version} in ServiceNow, spec is {a['version']}")
        return d

    @staticmethod
    def _values(v) -> list:
        if isinstance(v, dict):
            return list(v.values())
        return v if isinstance(v, list) else []

    @staticmethod
    def _payload(r: dict) -> tuple:
        """(payload, None) or (None, reason): the structured payload of a callRaw answer, or the connector error code /
        transport reason."""
        if php_empty(r.get('ok')):
            return None, php_strval(r.get('error') if r.get('error') is not None else 'unreachable')
        res = r.get('result')
        res = res if isinstance(res, dict) else {}
        if isinstance(res.get('structuredContent'), (dict, list)):
            p = res['structuredContent']
        else:
            content = res.get('content')
            first = content[0] if isinstance(content, list) and content else None
            text = first.get('text') if isinstance(first, dict) else None
            try:
                p = json.loads(php_strval(text if text is not None else ''))
            except ValueError:
                p = None
        p = p if isinstance(p, dict) else ({} if not isinstance(p, list) else dict(enumerate(p)))
        if not php_empty(res.get('isError')) or p.get('error') is not None:
            e = p.get('error')
            code = e.get('code') if isinstance(e, dict) else e
            return None, (code if isinstance(code, str) and code != '' else 'tool_error')
        return p, None

    @staticmethod
    def _headerLines(js) -> list[str]:
        """Stored headers JSON -> header lines (CR/LF/colon stripped from names, CR/LF from values)."""
        h = None
        if isinstance(js, str):
            try:
                h = json.loads(js)
            except ValueError:
                h = None
        out = []
        for k, v in (h.items() if isinstance(h, dict) else []):
            if isinstance(k, str) and k != '' and not _INT_KEY.match(k) and isinstance(v, (str, int, float, bool)):
                out.append(re.sub(r'[\r\n:]', '', k) + ': ' + re.sub(r'[\r\n]', '', php_strval(v)))
        return out

    def _summary(self, u: int, a: dict) -> dict:
        return {'id': a['id'], 'key': a['key'], 'version': a['version'], 'playbook_id': a['playbook_id'],
                'workflow_id': a['workflow_id'], 'servers': self.store.servers(u)}

    @staticmethod
    def _id(request: dict) -> int:
        params = request.get('params') or {}
        return php_intval(params.get('id') if params.get('id') is not None else 0)

    def _owned(self, u: int, request: dict) -> dict:
        a = self.store.get(u, self._id(request))
        if a is None:
            raise AutomationError('automation not found', 404, 'not_found')
        return a

    @staticmethod
    def _optId(b: dict, k: str) -> int | None:
        if b.get(k) is None:
            return None
        if not isinstance(b[k], int) or isinstance(b[k], bool) or b[k] <= 0:
            raise AutomationError(f'{k} must be a positive integer')
        return b[k]

    @staticmethod
    def _body(request: dict) -> dict:
        b = request.get('body')
        return b if isinstance(b, dict) else {}

    @staticmethod
    def _guard(request: dict, fn) -> dict:
        u = php_intval(request.get('user_id') if request.get('user_id') is not None else 0)
        if u <= 0:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        try:
            return fn(u)
        except AutomationError as e:
            return {'success': False, 'error': str(e), 'code': e.errorCode, 'status_code': e.status}
