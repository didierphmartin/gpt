"""Port of Controllers/SkillStoreController.php.

/api/v1/skills — the Docker app's skills volume (SkillStore). Without SKILLS_DIR (folder mode) every route but
/store and /native-wheels answers 404. Paths travel as query/body fields because they contain "/"; file bytes are
base64 both ways. `as=robot` only narrows the view to what the robot may see, so any signed-in user may ask for it.
"""
from __future__ import annotations

import base64
import binascii
from typing import Callable

from app.services.robot_skill_policy import RobotSkillPolicy
from app.services.skill_errors import (SkillClashException, SkillForbidden, SkillInUse, SkillNotFound, SkillPathInvalid,
                                       SkillRequiredBy)
from app.services.skill_store import SkillStore
from app.services.skill_wheel_fetcher import SkillWheelError, SkillWheelFetcher
from app.support.phpcompat import php_intval, php_strval


def _b64(data) -> str:
    return base64.b64encode(data if isinstance(data, bytes) else str(data).encode('utf-8')).decode('ascii')


class SkillStoreController:
    def __init__(self, db, config: dict, storeFactory: Callable[[], SkillStore | None] | None = None,
                 wheels: SkillWheelFetcher | None = None):
        self.db = db
        self.config = config
        self.wheels = wheels or SkillWheelFetcher()
        self.storeFactory = storeFactory or (lambda: SkillStore.fromEnv(
            self.config, lambda leaf: RobotSkillPolicy(self.db, self.config, None).robotWorkflowsUsing(leaf)))

    def store(self, request: dict) -> dict:
        s = self.storeFactory()
        return {'success': True, 'data': {
            'mode': 'folder' if s is None else 'volume',
            'edition': php_strval(self.config.get('edition') if self.config.get('edition') is not None else ''),
        }, 'status_code': 200}

    def list(self, request: dict) -> dict:
        def fn(s: SkillStore):
            rows = s.list(self._uid(request), self._robot(request), self._q(request, 'requires') == '1')
            names = self._ownerNames([php_intval(r['owner_id']) for r in rows if not r.get('mine')])
            return [{**r, 'owner_name': names.get(php_intval(r['owner_id']), '')} for r in rows]
        return self._run(fn)

    def _ownerNames(self, ids: list) -> dict:
        """Display name (else email) per user id, one query; unknown ids absent."""
        ids = list(dict.fromkeys(ids))
        if not ids:
            return {}
        try:
            out = {}
            for u in self.db.fetch_all('SELECT id, email, first_name, last_name FROM users WHERE id IN (' + ','.join(['?'] * len(ids)) + ')', ids):
                name = (php_strval(u['first_name']).strip(' \t\n\r\0\x0b') + ' ' + php_strval(u['last_name']).strip(' \t\n\r\0\x0b')).strip(' \t\n\r\0\x0b')
                out[php_intval(u['id'])] = name if name != '' else php_strval(u['email'])
            return out
        except Exception:  # noqa: BLE001 -- PHP catch (\PDOException)
            return {}

    def files(self, request: dict) -> dict:
        def fn(s: SkillStore):
            # wheels=0: leave .wheels/ out (the caller would only drop it).
            files = s.files(self._uid(request), self._q(request, 'path'), self._robot(request), self._q(request, 'wheels') != '0')
            return {'files': {rel: _b64(b) for rel, b in files.items()}}
        return self._run(fn)

    def listing(self, request: dict) -> dict:
        return self._run(lambda s: {'files': s.listing(self._uid(request), self._q(request, 'path'), self._robot(request))})

    def readFile(self, request: dict) -> dict:
        return self._run(lambda s: {'content': _b64(
            s.readFile(self._uid(request), self._q(request, 'path'), self._q(request, 'rel'), self._robot(request)))})

    def writeFile(self, request: dict) -> dict:
        def fn(s: SkillStore):
            b = self._body(request)
            s.writeFile(self._uid(request), php_strval(b.get('path', '')), php_strval(b.get('rel', '')), self._decode(b.get('content')))
            return []
        return self._run(fn)

    def import_(self, request: dict) -> dict:
        def fn(s: SkillStore):
            b = self._body(request)
            in_ = b.get('files')
            if not isinstance(in_, (dict, list)):
                raise SkillPathInvalid('files must be an object of base64 contents.')
            files = {str(rel): self._decode(content) for rel, content in (in_.items() if isinstance(in_, dict) else enumerate(in_))}
            return s.import_(self._uid(request), php_strval(b.get('path', '')), files, php_strval(b.get('visibility', 'private')),
                             b.get('dry_run', False) is True,
                             [php_strval(x) for x in b['expect_public']] if isinstance(b.get('expect_public'), list) else None,
                             [php_strval(x) for x in b['incoming']] if isinstance(b.get('incoming'), list) else [])
        return self._run(fn)

    def visibility(self, request: dict) -> dict:
        def fn(s: SkillStore):
            b = self._body(request)
            return s.setVisibility(self._uid(request), php_strval(b.get('path', '')), php_strval(b.get('visibility', '')),
                                   b.get('dry_run', False) is True,
                                   [php_strval(x) for x in b['expect_public']] if isinstance(b.get('expect_public'), list) else None)
        return self._run(fn)

    def move(self, request: dict) -> dict:
        def fn(s: SkillStore):
            b = self._body(request)
            s.move(self._uid(request), php_strval(b.get('from', '')), php_strval(b.get('to', '')))
            return {'path': php_strval(b.get('to', ''))}
        return self._run(fn)

    def delete(self, request: dict) -> dict:
        def fn(s: SkillStore):
            # dry_run=1: only check; with=a,b: skills deleted together with it (a group) do not count as needing it.
            with_ = [x for x in self._q(request, 'with').split(',') if x != '']
            s.delete(self._uid(request), self._q(request, 'path'), self._q(request, 'dry_run') == '1', with_)
            return []
        return self._run(fn)

    def nativeWheels(self, request: dict) -> dict:
        """Works in both modes (the export needs it everywhere), so it bypasses the "no skill store" guard."""
        deps = self._body(request).get('dependencies')
        if not isinstance(deps, list) or [d for d in deps if not isinstance(d, str)]:
            return {'success': False, 'data': {'message': 'dependencies must be a list of strings.'},
                    'error': 'dependencies must be a list of strings.', 'status_code': 400}
        try:
            wheels = {name: _b64(b) for name, b in self.wheels.fetch(list(deps)).items()}
            return {'success': True, 'data': {'wheels': wheels}, 'status_code': 200}
        except SkillWheelError as e:
            return {'success': False, 'data': {'message': str(e), **e.data()}, 'error': str(e), 'status_code': e.statusCode()}

    def _run(self, fn) -> dict:
        s = self.storeFactory()
        if s is None:
            return {'success': False, 'data': {'message': 'no skill store'}, 'error': 'no skill store', 'status_code': 404}
        try:
            return {'success': True, 'data': fn(s), 'status_code': 200}
        except SkillRequiredBy as e:
            return {'success': False, 'data': e.data(), 'error': str(e), 'status_code': e.statusCode()}
        except SkillInUse as e:
            return {'success': False, 'data': {'message': str(e), 'robot_workflows': e.workflows()}, 'error': str(e),
                    'status_code': e.statusCode()}
        except SkillClashException as e:
            return {'success': False, 'data': {'clash': 'different', 'message': str(e)}, 'error': 'clash', 'status_code': 409}
        except (SkillNotFound, SkillForbidden, SkillPathInvalid) as e:
            return {'success': False, 'data': {'message': str(e)}, 'error': str(e), 'status_code': e.statusCode()}

    @staticmethod
    def _uid(request: dict) -> int:
        return php_intval(request.get('user_id'))

    @staticmethod
    def _robot(request: dict) -> bool:
        return (request.get('query') or {}).get('as', '') == 'robot'

    @staticmethod
    def _q(request: dict, key: str) -> str:
        v = (request.get('query') or {}).get(key)
        return php_strval(v if v is not None else '')

    @staticmethod
    def _body(request: dict) -> dict:
        b = request.get('body')
        return b if isinstance(b, dict) else {}

    @staticmethod
    def _decode(v) -> bytes:
        if isinstance(v, str):
            try:
                return base64.b64decode(v, validate=True)
            except (binascii.Error, ValueError):
                pass
        raise SkillPathInvalid('Content must be valid base64.')
setattr(SkillStoreController, 'import', SkillStoreController.import_)   # PHP's method name (a Python keyword)
