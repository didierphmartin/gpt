"""Port of Services/SkillStore.php.

The skills volume of the Docker app: <root>/public/<path>/ and <root>/users/<uid>/<path>/, with
<root>/index.json recording owner and visibility of every skill. A skill path is "leaf" or "group/leaf";
the leaf name is unique across public skills and the caller's own area. The individual edition has no
public area. No database: the volume is the only state.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
from typing import Callable

from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.services import edition as Edition
from app.services.skill_errors import (SkillClashException, SkillForbidden, SkillInUse, SkillNotFound, SkillPathInvalid,
                                       SkillRequiredBy)
from app.support.phpcompat import php_intval

_CTRL = re.compile(r'[\x00-\x1f]')
_FM_LINE = re.compile(r'^(name|description):\s*(.*)$')


def _bkey(s: str) -> bytes:
    return s.encode('utf-8')


def _leaf(path: str) -> str:
    return path.rstrip('/').rsplit('/', 1)[-1]


class SkillStore:
    def __init__(self, root: str, edition: str, robotWorkflowsUsing: Callable[[str], list] | None = None):
        """robotWorkflowsUsing(leaf): the robot's workflows binding a leaf name, [{id, name}]."""
        self.root = root
        self.edition = edition
        self.robotWorkflowsUsing = robotWorkflowsUsing

    @classmethod
    def fromEnv(cls, config: dict, robotWorkflowsUsing: Callable[[str], list] | None = None) -> 'SkillStore | None':
        d = os.environ.get('SKILLS_DIR', '').strip()
        return None if d == '' else cls(d.rstrip('/'), Edition.current(config), robotWorkflowsUsing)

    def findPrivate(self, leaf: str) -> dict | None:
        """{path, owner_id} of the first skill named leaf in some user's private area, else None."""
        for key, e in self.index().items():
            area, path = self._splitKey(key)
            if area != 'public' and _leaf(path) == leaf and os.path.isdir(self._dir(area, path)):
                return {'path': path, 'owner_id': php_intval(e['owner'])}
        return None

    def list(self, userId: int, asRobot: bool = False, withRequires: bool = False) -> list:
        rows = []
        index = self.index()
        # Only when asked (reads each skill's scripts/): the names a row's requirements resolve against, built once.
        mine = public = None
        if withRequires:
            public = [str(k) for k in self._viewOf(index, -1)]   # no user -1: public skills only
            mine = public if asRobot and self.edition != 'individual' else [str(k) for k in self._viewOf(index, userId)]
        for key, e in index.items():
            area, path = self._splitKey(key)
            if not self._visible(e, userId, asRobot) or not os.path.isdir(self._dir(area, path)):
                continue
            md = self._readText(self._dir(area, path) + '/SKILL.md')
            fm = self._frontmatter(md)
            row = {
                'path': path,
                'name': fm.get('name', _leaf(path)),
                'description': fm.get('description', ''),
                'visibility': e['visibility'],
                'owner_id': php_intval(e['owner']),
                'mine': php_intval(e['owner']) == userId,
                'dependencies': LangGraphPackage.skillDependencies(md),
            }
            if withRequires:
                # Direct required skills (same rule as delete protection). My own: from my view (own, then public); another
                # user's public skill: against public skills only, as it resolves for its owner at run time.
                names = mine if php_intval(e['owner']) == userId else public
                row['requires'] = LangGraphPackage.requiredSkills(path, self._requiresFiles(area, path, md), names)['requires']
            rows.append(row)
        rows.sort(key=lambda r: _bkey(r['path']))
        return rows

    def files(self, userId: int, path: str, asRobot: bool = False, withWheels: bool = True) -> dict:
        """rel => bytes; .wheels/native/ is never included."""
        self._checkPath(path)
        r = self._resolve(userId, path, asRobot)
        if r is None:
            raise SkillNotFound('No such skill.')
        return self._readTree(self._dir(r[0], path), withWheels)

    def listing(self, userId: int, path: str, asRobot: bool = False) -> list:
        """A skill's files as paths and sizes (stat, contents never read): SKILL.md first, then byte order.
        Left out: `.wheels/`, `__pycache__/`, `*.pyc` and anything dot-named."""
        self._checkPath(path)
        r = self._resolve(userId, path, asRobot)
        if r is None:
            raise SkillNotFound('No such skill.')
        d = self._dir(r[0], path)
        out = []
        for rel, full in self._walk(d):
            if self._isPyCache(rel) or re.search(r'(^|/)\.', rel):
                continue
            out.append({'rel': rel, 'size': os.path.getsize(full)})
        out.sort(key=lambda f: (f['rel'] != 'SKILL.md', _bkey(f['rel'])))
        return out

    def readFile(self, userId: int, path: str, rel: str, asRobot: bool = False) -> bytes:
        self._checkPath(path)
        self._checkRel(rel)
        r = self._resolve(userId, path, asRobot)
        if r is None:
            raise SkillNotFound('No such skill.')
        f = self._dir(r[0], path) + '/' + rel
        if not os.path.isfile(f):
            raise SkillNotFound('No such file.')
        with open(f, 'rb') as fh:
            return fh.read()

    def writeFile(self, userId: int, path: str, rel: str, data: bytes) -> None:
        self._checkPath(path)
        self._checkRel(rel)

        def fn():
            area, _ = self._owned(userId, path)
            f = self._dir(area, path) + '/' + rel
            self._mkdir(os.path.dirname(f))
            self._put(f, data)
        self._locked(fn)

    def import_(self, userId: int, path: str, files: dict, visibility: str = 'private', dryRun: bool = False,
                expectPublic: list | None = None, batch: list | None = None) -> dict:
        """files: rel => bytes. dryRun: only say what the import would do: 'new' | 'identical', or the clash; nothing is
        written. expectPublic: (public) the required skills the user confirmed go public along; 409 when it differs.
        Returns {status[, made_public]}. A public import takes along the skills it requires that are still my own
        private ones (as setVisibility does), all or nothing. batch: the other skills of the same import (one zip),
        installed public with it: a requirement naming one of them resolves to it (after my own and the public skills)
        instead of being missing."""
        batch = batch or []
        self._checkPath(path)
        self._checkVisibility(visibility)
        for rel in files:
            self._checkRel(str(rel))

        def fn():
            index = self.index()
            for area in (self._areaFor(userId, 'private'), 'public'):
                e = index.get(f'{area}/{path}')
                if e is not None and php_intval(e['owner']) == userId:
                    same = (self._fingerprint(self._readTree(self._dir(area, path), False))
                            == self._fingerprint(self._withoutWheels(files)))
                    if same:
                        return {'status': 'identical'}
                    raise SkillClashException(f"A different skill is already installed at '{path}'.")
            incoming = self._fingerprint(self._withoutWheels(files))
            for key in index:
                a, p = self._splitKey(key)
                if ((a == 'public' or a == f'users/{userId}') and _leaf(p) == _leaf(path)
                        and self._fingerprint(self._readTree(self._dir(a, p), False)) == incoming):
                    return {'status': 'identical'}
            self._assertLeafFree(index, userId, path, True)
            area = self._areaFor(userId, visibility)
            along: list = []
            if visibility == 'public':
                along = self._privateRequired(index, userId, path, self._requiresOnly(self._withoutWheels(files)), None,
                                              [x for x in (str(b) for b in batch) if x != path])
                for q in along:
                    self._assertLeafFree(index, userId, q, False)
                self._assertExpected(path, along, expectPublic)
            if dryRun:
                return {'status': 'new', **({'made_public': along} if visibility == 'public' else {})}
            d = self._dir(area, path)
            self._rmtree(d)   # a folder with no index entry has no owner: never merge into it
            self._mkdir(d)
            for rel, data in files.items():
                f = d + '/' + rel
                self._mkdir(os.path.dirname(f))
                self._put(f, data)
            index[f'{area}/{path}'] = {'owner': userId, 'visibility': visibility}
            try:
                self._publishAll(index, userId, along)
            except BaseException:
                self._rmtree(d)   # all or nothing: the skill goes with the skills it needs, or not at all
                self._pruneGroup(area, path)
                raise
            self._saveIndex(index)
            return {'status': 'installed', **({'made_public': along} if visibility == 'public' else {})}
        return self._locked(fn)

    def setVisibility(self, userId: int, path: str, visibility: str, dryRun: bool = False, expectPublic: list | None = None) -> dict:
        """Make one of my skills public or private. Public takes along every skill it requires (closure) that is still
        my own private skill, all or nothing (a leaf clash in public for any of them changes nothing); a required skill
        I cannot make public refuses it. Private is refused while a public skill requires it.
        dryRun: only say what would be made public. Returns {made_public: [paths]}."""
        self._checkPath(path)
        self._checkVisibility(visibility)

        def fn():
            area, entry = self._owned(userId, path)
            to = self._areaFor(userId, visibility)
            index = self.index()
            if visibility == 'public':
                along = self._privateRequired(index, userId, path, None, area)
                moves = along if to == area else [path, *along]
                for p in moves:
                    self._assertLeafFree(index, userId, p, False)
                self._assertExpected(path, along, expectPublic)
                if not dryRun and moves:
                    self._publishAll(index, userId, moves)
                    self._saveIndex(index)
                return {'made_public': along}
            if to == area or dryRun:
                return {'made_public': []}
            if area == 'public':
                self._assertNotBoundByRobot(path)
                publicDeps = self._dependents(index, userId, area, path, True)
                if publicDeps:
                    lst = ', '.join(publicDeps)
                    raise SkillRequiredBy(f'"{_leaf(path)}" can\'t be made private: the public skill(s) {lst} need it to run.',
                                          'private', path, publicDeps)
            self._relocate(area, path, to, path)
            index.pop(f'{area}/{path}', None)
            index[f'{to}/{path}'] = {'owner': userId, 'visibility': visibility}
            self._saveIndex(index)
            return {'made_public': []}
        return self._locked(fn)

    def delete(self, userId: int, path: str, dryRun: bool = False, with_: list | None = None) -> None:
        """dryRun: only check (a group delete checks every skill first). with_: skills deleted together with this one
        (the rest of the group): they do not count as skills that need it."""
        self._checkPath(path)

        def fn():
            area, _ = self._owned(userId, path)
            if area == 'public':
                self._assertNotBoundByRobot(path)
            # The rest of the group, as the skills of mine at those paths (area + path, never someone else's same path).
            except_ = []
            for w in with_ or []:
                r = self._resolve(userId, str(w), False)
                if r is not None and php_intval(r[1]['owner']) == userId:
                    except_.append(r[0] + '/' + str(w))
            self._assertNotRequired(userId, area, path, 'delete', except_)
            if dryRun:
                return None
            self._rmtree(self._dir(area, path))
            self._pruneGroup(area, path)
            index = self.index()
            index.pop(f'{area}/{path}', None)
            self._saveIndex(index)
            return None
        self._locked(fn)

    def move(self, userId: int, frm: str, to: str) -> None:
        self._checkPath(frm)
        self._checkPath(to)

        def fn():
            area, entry = self._owned(userId, frm)
            if frm == to:
                return None
            if area == 'public' and _leaf(frm) != _leaf(to):
                self._assertNotBoundByRobot(frm)
            if _leaf(frm) != _leaf(to):   # regrouping keeps the leaf: the skills that need it still find it
                self._assertNotRequired(userId, area, frm, 'rename')
            index = self.index()
            if f'{area}/{to}' in index:
                raise SkillClashException(f"A skill already exists at '{to}'.")
            index.pop(f'{area}/{frm}', None)
            self._assertLeafFree(index, userId, to, True)
            self._relocate(area, frm, area, to)
            index[f'{area}/{to}'] = entry
            self._saveIndex(index)
            return None
        self._locked(fn)

    def compileResolver(self, ownerId: int, asRobot: bool):
        """What a compile reads skills through (LangGraphPackage.skillFiles): (dir, from) -> folder | None, the folder
        of the skill the owner sees at dir, else (a required skill named by its leaf) one with that leaf: in the group
        of from (the skill that needs it), then the owner's own, then public; None otherwise."""
        def resolve(d: str, frm: str | None = None):
            try:
                path = self.absolutePath(ownerId, d, asRobot)
                if path is None and '/' not in d:
                    # By leaf: in the group of the skill that needs it, then the owner's own skill, then a public one.
                    hits = [r for r in self.list(ownerId, asRobot) if _leaf(r['path']) == d]
                    group = frm.split('/')[0] if frm is not None and '/' in frm else None
                    hits.sort(key=lambda r: (0 if group is not None and r['path'].startswith(f'{group}/') else 1,
                                             0 if r['mine'] else 1, _bkey(r['path'])))
                    return None if not hits else self.absolutePath(ownerId, hits[0]['path'], asRobot)
                return path
            except SkillPathInvalid:
                return None   # reported as any skill the owner cannot see
        return resolve

    def absolutePath(self, ownerId: int, path: str, asRobot: bool = False) -> str | None:
        self._checkPath(path)
        r = self._resolve(ownerId, path, asRobot)
        return None if r is None else self._dir(r[0], path)

    # ---- required skills (LangGraphPackage.requiredSkills) ----------------------------------------------

    def _visibleEntries(self, index: dict, userId: int) -> list:
        """[area, path] of every skill userId sees (own + public), existing folders."""
        out = []
        for key, e in index.items():
            area, p = self._splitKey(key)
            if self._visible(e, userId, False) and os.path.isdir(self._dir(area, p)):
                out.append([area, p])
        return out

    def _viewOf(self, index: dict, userId: int, incoming: list | None = None) -> dict:
        """path => area a user resolves a skill path to: their own skill first, then a public one (never another's private)."""
        own: dict = {}
        pub: dict = {}
        for key in index:
            area, p = self._splitKey(key)
            if not os.path.isdir(self._dir(area, p)):
                continue
            if area == f'users/{userId}':
                own[p] = area
            elif area == 'public':
                pub[p] = area
        # The rest of the same import (to be installed public with it): only where nothing of mine or public is.
        out = dict(own)
        for k, v in pub.items():
            out.setdefault(k, v)
        for k in incoming or []:
            out.setdefault(k, 'incoming')
        return out

    @staticmethod
    def _requiresOnly(files: dict) -> dict:
        """Only what the requires rule reads: SKILL.md and scripts/**."""
        return {rel: b for rel, b in files.items() if rel == 'SKILL.md' or str(rel).startswith('scripts/')}

    def _requiresFiles(self, area: str, path: str, md: str | None = None) -> dict:
        """SKILL.md and scripts/** of a skill, read from disk (nothing else of the tree)."""
        d = self._dir(area, path)
        if md is not None:
            out = {'SKILL.md': md}
        else:
            out = {'SKILL.md': self._readText(f'{d}/SKILL.md')} if os.path.isfile(f'{d}/SKILL.md') else {}
        for rel, b in self._readTree(f'{d}/scripts', False).items():
            out[f'scripts/{rel}'] = b
        return out

    def _requirementsOf(self, index: dict, owner: int, area: str, p: str, files: dict | None = None,
                        incoming: list | None = None) -> dict:
        """What skill p (in area, owned by owner) requires, resolved from its owner's viewpoint: [[area, path]], plus the
        declared names that resolve to nothing."""
        view = self._viewOf(index, owner, incoming)
        req = LangGraphPackage.requiredSkills(p, files if files is not None else self._requiresFiles(area, p), [str(k) for k in view])
        return {'resolved': [[view[q], q] for q in req['requires']], 'missing': req['missing']}

    def _dependents(self, index: dict, userId: int, area: str, path: str, publicOnly: bool = False,
                    except_: list | None = None) -> list:
        """The skills userId sees (only public ones when publicOnly; except_: "area/path" keys left out) whose
        requirement, resolved from their owner's viewpoint, is the skill at area/path. Sorted paths."""
        out = []
        for a, p in self._visibleEntries(index, userId):
            if (a == area and p == path) or (publicOnly and a != 'public') or f'{a}/{p}' in (except_ or []):
                continue
            owner = php_intval((index.get(f'{a}/{p}') or {}).get('owner') or 0)
            for qa, q in self._requirementsOf(index, owner, a, p)['resolved']:
                if qa == area and q == path:
                    out.append(p)
                    break
        out.sort(key=_bkey)
        return out

    def _assertNotRequired(self, userId: int, area: str, path: str, reason: str, except_: list | None = None) -> None:
        deps = self._dependents(self.index(), userId, area, path, False, except_)
        if not deps:
            return
        name = _leaf(path)
        lst = ', '.join(deps)
        raise SkillRequiredBy(
            f'"{name}" can\'t be deleted: {lst} need(s) it to run (listed in its required skills). Delete {lst} first, or remove "{name}" from its required skills.'
            if reason == 'delete' else f'"{name}" can\'t be renamed: {lst} need(s) it to run (listed in its required skills).',
            reason, path, deps)

    def _privateRequired(self, index: dict, userId: int, path: str, files: dict | None = None, startArea: str | None = None,
                         incoming: list | None = None) -> list:
        """The skills path requires, transitively, that are still userId's own private skills (what making it public
        takes along), in discovery order. A required skill that is neither mine nor public refuses it. files: the
        skill's files when it is not stored yet (an import)."""
        own = self._areaFor(userId, 'private')
        along = []
        seen = {path: True}
        queue = [[startArea if startArea is not None else own, path, files]]
        while queue:
            a, p, f = queue.pop(0)
            req = self._requirementsOf(index, userId, a, p, f, incoming)
            for m in req['missing']:
                raise SkillRequiredBy(f'"{_leaf(p)}" needs "{m}", which you can\'t make public.', 'public', p, [], m)
            for qa, q in req['resolved']:
                if q in seen:
                    continue
                seen[q] = True
                if qa == own:
                    along.append(q)
                    queue.append([qa, q, None])
        return along

    @staticmethod
    def _assertExpected(path: str, along: list, expect: list | None) -> None:
        """The user confirmed which skills go public along: refuse when the closure is no longer that."""
        if expect is None:
            return
        if sorted(along, key=_bkey) != sorted((str(x) for x in expect), key=_bkey):
            raise SkillRequiredBy(f'The skills that go public with "{_leaf(path)}" changed: ' + (', '.join(along) or '-') + '. Try again.',
                                  'changed', path, along)

    def _publishAll(self, index: dict, userId: int, paths: list) -> None:
        """Move my private skills paths to public, all or nothing (moves already done are undone on a failure)."""
        own = self._areaFor(userId, 'private')
        done = []
        try:
            for p in paths:
                self._relocate(own, p, 'public', p)
                done.append(p)
        except BaseException:
            for p in reversed(done):
                try:
                    self._relocate('public', p, own, p)
                except Exception:  # noqa: BLE001 -- best effort: the index below is left unchanged either way
                    pass
            raise
        for p in paths:
            index.pop(f'{own}/{p}', None)
            index[f'public/{p}'] = {'owner': userId, 'visibility': 'public'}

    # ---- internals -------------------------------------------------------------------------------

    def _areaFor(self, userId: int, visibility: str) -> str:
        if visibility == 'public':
            if self.edition == 'individual':
                raise SkillForbidden('Skills cannot be made public in this edition.')
            return 'public'
        return f'users/{userId}'

    @staticmethod
    def _checkVisibility(v: str) -> None:
        if v not in ('public', 'private'):
            raise SkillPathInvalid('Visibility must be public or private.')

    def _visible(self, e: dict, userId: int, asRobot: bool) -> bool:
        if asRobot:
            return e.get('visibility') == 'public' or self.edition == 'individual'
        return php_intval(e.get('owner')) == userId or e.get('visibility') == 'public'

    def _resolve(self, userId: int, path: str, asRobot: bool):
        """(area, entry) of the skill userId sees at path: own, then public, then (robot) any; else None."""
        index = self.index()
        candidates = [f'users/{userId}/{path}', f'public/{path}']
        if asRobot and self.edition != 'individual':
            candidates = [f'public/{path}']   # a corporate robot sees public skills only
        if asRobot and self.edition == 'individual':
            for key in index:
                if key.startswith('users/') and self._splitKey(key)[1] == path:
                    candidates.append(key)
        for key in candidates:
            if key in index and os.path.isdir(self._dir(*self._splitKey(key))):
                return self._splitKey(key)[0], index[key]
        return None

    def _owned(self, userId: int, path: str):
        """The caller's own skill at path, else NotFound (invisible) or Forbidden (visible, not theirs)."""
        r = self._resolve(userId, path, False)
        if r is None:
            raise SkillNotFound('No such skill.')
        if php_intval(r[1].get('owner')) != userId:
            raise SkillForbidden('Only the owner can change this skill.')
        return r

    def _assertNotBoundByRobot(self, path: str) -> None:
        """A public skill a robot workflow binds keeps its public name: the robot could no longer find it otherwise."""
        if self.edition == 'corporate' and self.robotWorkflowsUsing is not None:
            workflows = self.robotWorkflowsUsing(_leaf(path))
            if workflows:
                raise SkillInUse(workflows)

    def _assertLeafFree(self, index: dict, userId: int, path: str, withOwn: bool) -> None:
        """Leaf unique across public + the caller's area (or public only when withOwn is false), ignoring the skill's own path."""
        leaf = _leaf(path)
        for key, e in index.items():
            area, p = self._splitKey(key)
            relevant = area == 'public' or (withOwn and area == f'users/{userId}')
            if not relevant or _leaf(p) != leaf or (p == path and php_intval(e.get('owner')) == userId):
                continue
            raise SkillClashException(f"A public skill named '{leaf}' already exists." if area == 'public'
                                      else f"You already have a skill named '{leaf}'.")

    @staticmethod
    def _checkPath(path: str) -> None:
        if path == '' or '\\' in path or path.startswith('/') or '//' in path:
            raise SkillPathInvalid('Invalid skill path.')
        segs = path.split('/')
        if len(segs) > 2:
            raise SkillPathInvalid('A skill path has at most one group level.')
        for s in segs:
            if s == '' or s[0] == '.' or _CTRL.search(s):
                raise SkillPathInvalid('Invalid skill path.')

    @staticmethod
    def _checkRel(rel: str) -> None:
        """A file path inside a skill: dot-prefixed segments are allowed (.wheels), traversal is not."""
        if rel == '' or '\\' in rel or rel.startswith('/') or '//' in rel or _CTRL.search(rel):
            raise SkillPathInvalid('Invalid file path.')
        for s in rel.split('/'):
            if s in ('', '.', '..'):
                raise SkillPathInvalid('Invalid file path.')

    def _dir(self, area: str, path: str) -> str:
        return f'{self.root}/{area}/{path}'

    @staticmethod
    def _splitKey(key: str):
        if key.startswith('public/'):
            return 'public', key[7:]
        parts = key.split('/', 2)
        return f'{parts[0]}/{parts[1] if len(parts) > 1 else ""}', parts[2] if len(parts) > 2 else ''

    @staticmethod
    def _mkdir(d: str) -> None:
        if not os.path.isdir(d):
            try:
                os.makedirs(d, 0o775, exist_ok=True)
            except OSError:
                if not os.path.isdir(d):
                    raise RuntimeError(f'Cannot create {d}')

    def _relocate(self, fromArea: str, frm: str, toArea: str, to: str) -> None:
        dest = self._dir(toArea, to)
        self._mkdir(os.path.dirname(dest))
        try:
            if os.path.exists(dest):   # PHP rename() over an existing folder fails unless it is empty
                os.rmdir(dest)
            os.rename(self._dir(fromArea, frm), dest)
        except OSError:
            raise RuntimeError('Cannot move the skill folder.')
        self._pruneGroup(fromArea, frm)

    def _pruneGroup(self, area: str, path: str) -> None:
        if '/' in path:
            try:
                os.rmdir(self.root + '/' + area + '/' + os.path.dirname(path))
            except OSError:
                pass

    @staticmethod
    def _rmtree(d: str) -> None:
        if not os.path.isdir(d):
            return
        for dirpath, dirnames, filenames in os.walk(d, topdown=False):
            for fn in filenames:
                try:
                    os.unlink(os.path.join(dirpath, fn))
                except OSError:
                    pass
            for dn in dirnames:
                full = os.path.join(dirpath, dn)
                try:
                    os.unlink(full) if os.path.islink(full) else os.rmdir(full)
                except OSError:
                    pass
        try:
            os.rmdir(d)
        except OSError:
            pass

    @staticmethod
    def _walk(d: str):
        """(rel, full path) of every file under d, recursively (symlinked folders not entered), in byte order."""
        out = []
        if not os.path.isdir(d):
            return out
        for dirpath, dirnames, filenames in os.walk(d):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                if os.path.isfile(full):
                    out.append((full[len(d) + 1:], full))
        out.sort(key=lambda t: _bkey(t[0]))
        return out

    def _readTree(self, d: str, withWheels: bool) -> dict:
        out = {}
        for rel, full in self._walk(d):
            if rel.startswith('.wheels/native/') or (not withWheels and rel.startswith('.wheels/')) or self._isPyCache(rel):
                continue
            with open(full, 'rb') as fh:
                out[rel] = fh.read()
        return out

    @staticmethod
    def _withoutWheels(files: dict) -> dict:
        return {k: v for k, v in files.items() if not str(k).startswith('.wheels/')}

    @staticmethod
    def _isPyCache(rel: str) -> bool:
        """Python's bytecode cache (`__pycache__/`, `*.pyc`): never part of a skill's content."""
        return '__pycache__' in rel.split('/') or rel.endswith('.pyc')

    def _fingerprint(self, files: dict) -> dict:
        out = {}
        for rel, data in files.items():
            if self._isPyCache(str(rel)):
                continue
            out[str(rel)] = hashlib.sha256(data if isinstance(data, bytes) else str(data).encode('utf-8')).hexdigest()
        return dict(sorted(out.items(), key=lambda kv: _bkey(kv[0])))

    @staticmethod
    def _frontmatter(md: str) -> dict:
        lines = re.split(r'\r\n|\r|\n', md)
        out: dict = {}
        if (lines[0] if lines else '').strip(' \t\n\r\0\x0b') != '---':
            return out
        for line in lines[1:]:
            if line.strip(' \t\n\r\0\x0b') == '---':
                break
            m = _FM_LINE.match(line)
            if m:
                v = m.group(2).strip(' \t\n\r\0\x0b')
                # one matching outer quote pair only: `say "hi"` stays as written
                if len(v) >= 2 and v[0] in ('"', "'") and v[-1] == v[0]:
                    v = v[1:-1]
                out[m.group(1)] = v
        return out

    @staticmethod
    def _readText(f: str) -> str:
        try:
            with open(f, 'rb') as fh:
                return fh.read().decode('utf-8', errors='replace')
        except OSError:
            return ''

    def index(self) -> dict:
        try:
            with open(self.root + '/index.json', 'rb') as fh:
                data = json.loads(fh.read())
        except (OSError, ValueError):
            return {}
        if isinstance(data, list):   # PHP json_decode of [] (an empty index)
            return {}
        return data if isinstance(data, dict) else {}

    def _saveIndex(self, index: dict) -> None:
        tmp = self.root + '/index.json.' + secrets.token_hex(4) + '.tmp'
        # json_encode(JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT): an empty index is []
        self._put(tmp, (json.dumps(index, indent=4) if index else '[]').encode('utf-8'))
        try:
            os.replace(tmp, self.root + '/index.json')
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise RuntimeError('Cannot update the skills index.')

    @staticmethod
    def _put(f: str, data) -> None:
        try:
            with open(f, 'wb') as fh:
                fh.write(data if isinstance(data, bytes) else str(data).encode('utf-8'))
        except OSError:
            raise RuntimeError(f'Cannot write {f}')

    def _locked(self, fn):
        self._mkdir(self.root)
        try:
            h = open(self.root + '/.lock', 'a')
        except OSError:
            raise RuntimeError('Cannot lock the skills folder.')
        try:
            fcntl.flock(h, fcntl.LOCK_EX)
            try:
                return fn()
            finally:
                fcntl.flock(h, fcntl.LOCK_UN)
        finally:
            h.close()
