"""Port of Controllers/RobotServersController.php.

/api/v1/robot/mcp-servers — the robot account's own MCP server rows (e.g. an "Outlook" row holding an
organization connection key). Every route needs use_robot and acts only on rows owned by the robot.
Header values are secrets: responses carry header NAMES only -- except compile-env, which hands them to a compiled
robot workflow's .env (the person compiling may use the robot; decided 2026-11-02).
"""
from __future__ import annotations

import json
import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.controllers.mcp_proxy_controller import MCPProxyController
from app.services.robot_account import RobotAccount
from app.services.robot_policy import RobotPolicy
from app.support.phpcompat import filter_validate_url, php_bool, php_empty, php_intval, php_items, php_strval, php_trim
from app.support.phpjson import dumps, php_json_encode

# PCRE's \s without the u flag: space, \t, \n, \v, \f, \r (Python's \s is the Unicode set)
_BAD_HEADER_NAME = re.compile(r'[\r\n: \t\x0b\x0c]')
_BAD_KEY = re.compile(r'[\r\n]')


class RobotServersController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the id is
    # read from request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config: dict, proxyFactory=None):
        self.db = db
        self.config = config
        self.policy = RobotPolicy(db, config)
        self.proxyFactory = proxyFactory if proxyFactory is not None else (lambda: MCPProxyController(self.db, self.config))

    def index(self, request: dict) -> dict:
        def action(robot: int):
            rows = self.db.fetch_all('SELECT id, name, url, description, enabled, headers FROM mcp_servers WHERE user_id = ? ORDER BY name',
                                     [str(robot)])
            out = [{'id': php_intval(r['id']), 'name': r['name'], 'url': r['url'], 'description': php_strval(r['description']),
                    'enabled': php_bool(r['enabled']), 'header_names': [php_strval(k) for k, _ in php_items(self._headers(r['headers']))]}
                   for r in rows]
            return {'success': True, 'data': out}
        return self._guard(request, action)

    def compileEnv(self, request: dict) -> dict:
        """GET /robot/mcp-servers/compile-env — {vars: {MCP_HEADERS_<SLUG>: headers JSON}} of the robot's enabled servers
        that hold headers: what the interpreter sends when the robot runs, for the package .env of a compiled robot
        workflow. The values are never logged."""
        def action(robot: int):
            rows = self.db.fetch_all('SELECT name, headers FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY name', [str(robot)])
            vars_: dict = {}
            for r in rows:
                h = self._headers(r['headers'])
                if h:
                    vars_['MCP_HEADERS_' + CodeNodeEmit.slug(php_strval(r['name'])).upper()] = dumps(h)
            return {'success': True, 'data': {'vars': vars_}}
        return self._guard(request, action)

    def create(self, request: dict) -> dict:
        def action(robot: int):
            b = self._body(request)
            name = php_trim(php_strval(b.get('name') if b.get('name') is not None else ''))
            url = php_trim(php_strval(b.get('url') if b.get('url') is not None else ''))
            if name == '' or not filter_validate_url(url):
                return self._fail('Name and a valid URL are required', 400)
            if self._row(robot, None, name) is not None:
                return self._fail('A server with this name already exists', 409)
            id = self.db.insert('INSERT INTO mcp_servers (user_id, name, url, description) VALUES (?, ?, ?, ?)',
                                [str(robot), name, url,
                                 php_trim(php_strval(b.get('description') if b.get('description') is not None else ''))])
            return {'success': True, 'data': {'id': php_intval(id)}}
        return self._guard(request, action)

    def update(self, request: dict, id: int = 0) -> dict:
        def action(robot: int):
            id = self._id(request)
            row = self._row(robot, id)
            if row is None:
                return self._notFound()
            b = self._body(request)
            set_: list[str] = []
            args: list = []
            for f in ('name', 'url', 'description'):
                if isinstance(b.get(f), str):
                    v = php_trim(b[f])
                    if f == 'url' and not filter_validate_url(v):
                        return self._fail('Invalid URL format', 400)
                    if f == 'name' and v != row['name'] and self._row(robot, None, v) is not None:
                        return self._fail('A server with this name already exists', 409)
                    if f == 'url' and v != row['url']:
                        # the stored key must never travel to a different host: re-Connect is required
                        set_.append('headers = NULL')
                    set_.append(f'{f} = ?')
                    args.append(v)
            if 'enabled' in b:
                set_.append('enabled = ?')
                args.append(1 if php_bool(b['enabled']) else 0)
            if set_:
                self.db.execute('UPDATE mcp_servers SET ' + ', '.join(set_) + ' WHERE id = ? AND user_id = ?',
                                [*args, id, str(robot)])
            return {'success': True}
        return self._guard(request, action)

    def destroy(self, request: dict, id: int = 0) -> dict:
        def action(robot: int):
            id = self._id(request)
            if self._row(robot, id) is None:
                return self._notFound()
            self.db.execute('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?', [id, str(robot)])
            return {'success': True}
        return self._guard(request, action)

    def call(self, request: dict, id: int = 0) -> dict:
        """POST .../{id}/call {tool, arguments}: a tools/call through the /mcp/proxy path, with the row's stored headers."""
        def action(robot: int):
            id = self._id(request)
            row = self._row(robot, id)
            if row is None:
                return self._notFound()
            if php_empty(row['enabled']):
                return self._fail('Server is disabled', 409)
            b = self._body(request)
            tool = b.get('tool')
            if not isinstance(tool, str) or tool == '':
                return self._fail('tool is required', 400)
            r = self.proxyFactory().forward({'user_id': str(robot), 'body': {
                'action': 'proxy', 'server_id': id, 'server_url': row['url'],
                'jsonrpc': {'method': 'tools/call', 'params': {
                    'name': tool, 'arguments': b.get('arguments') if b.get('arguments') is not None else []}},
            }})
            if not r.get('success'):
                err = r.get('error')
                msg = err.get('message') if isinstance(err, dict) else None
                return {'success': False, 'error': msg if msg is not None else 'MCP call failed',
                        'status_code': r.get('status_code') if r.get('status_code') is not None else 500}
            return {'success': True, 'data': r.get('response')}
        return self._guard(request, action)

    def saveKey(self, request: dict, id: int = 0) -> dict:
        """POST .../{id}/key {header, key}: merges {header: key} into the row's headers (the Connect box's save step)."""
        def action(robot: int):
            id = self._id(request)
            row = self._row(robot, id)
            if row is None:
                return self._notFound()
            b = self._body(request)
            name = php_trim(php_strval(b.get('header') if b.get('header') is not None else ''))
            key = php_strval(b.get('key') if b.get('key') is not None else '')
            if name == '' or _BAD_HEADER_NAME.search(name) or key == '' or _BAD_KEY.search(key):
                return self._fail('A header name and a key are required', 400)
            headers = dict(php_items(self._headers(row['headers'])))
            headers[name] = key
            self.db.execute('UPDATE mcp_servers SET headers = ? WHERE id = ? AND user_id = ?',
                            [php_json_encode(headers), id, str(robot)])
            return {'success': True, 'data': {'header_names': [php_strval(k) for k in headers]}}
        return self._guard(request, action)

    @staticmethod
    def _body(request: dict) -> dict:
        b = request.get('body')
        return b if isinstance(b, dict) else {}

    @staticmethod
    def _id(request: dict) -> int:
        params = request.get('params') or {}
        return php_intval(params.get('id') if params.get('id') is not None else 0)

    def _row(self, robot: int, id: int | None, name: str | None = None) -> dict | None:
        """The robot's row by id or by name, else None."""
        if id is not None:
            return self.db.fetch_one('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?', [id, str(robot)])
        return self.db.fetch_one('SELECT * FROM mcp_servers WHERE name = ? AND user_id = ?', [name, str(robot)])

    @staticmethod
    def _headers(raw):
        """The stored headers JSON decoded (a dict, or a list when the JSON is one), else {}."""
        h = None
        if isinstance(raw, str) and raw != '':
            try:
                h = json.loads(raw)
            except ValueError:
                h = None
        return h if isinstance(h, (dict, list)) else {}

    @staticmethod
    def _fail(msg: str, status: int) -> dict:
        return {'success': False, 'error': msg, 'status_code': status}

    @classmethod
    def _notFound(cls) -> dict:
        return cls._fail('Server not found', 404)

    def _guard(self, request: dict, action) -> dict:
        userId = php_intval(request.get('user_id') if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'kind': 'auth', 'status_code': 401}
        if not self.policy.canUse(userId):
            return {'success': False, 'error': "Your role can't use the robot", 'kind': 'forbidden', 'status_code': 403}
        return action(RobotAccount.ensure(self.db))
