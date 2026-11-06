"""Port of backend/tests/Unit/Controllers/SkillStoreControllerTest.php and SkillNativeWheelsRouteTest.php."""
from __future__ import annotations

import base64
import json
import os

import pytest

from app.controllers.skill_store_controller import SkillStoreController
from app.services.skill_store import SkillStore
from app.services.skill_wheel_fetcher import SkillWheelFetcher
from tests.unit.playbook.conftest import sqlite_db


def b64(s) -> str:
    return base64.b64encode(s.encode() if isinstance(s, str) else s).decode()


@pytest.fixture
def root(tmp_path):
    return str(tmp_path / 'skills')


def ctl(root, volume=True, edition='individual', db=None):
    store = SkillStore(root, edition) if volume else None
    return SkillStoreController(db or sqlite_db(), {'edition': edition}, lambda: store)


def req(q=None, b=None, uid=7):
    return {'user_id': uid, 'query': q or {}, 'body': b or {}}


def imp(c, path='g/demo', text='hi'):
    return getattr(c, 'import')(req({}, {'path': path, 'visibility': 'private',
                                         'files': {'SKILL.md': b64(f'---\nname: demo\ndescription: d\n---\n{text}')}}))


def test_store_reports_folder_mode_without_skills_dir(monkeypatch):
    monkeypatch.delenv('SKILLS_DIR', raising=False)
    r = SkillStoreController(sqlite_db(), {}).store(req())
    assert r['success'] is True and r['data']['mode'] == 'folder'


def test_store_reports_volume_mode_and_edition(root):
    assert ctl(root, True, 'corporate').store(req())['data'] == {'mode': 'volume', 'edition': 'corporate'}


def test_routes_404_in_folder_mode(root):
    c = ctl(root, False)
    for r in (c.list(req()), c.files(req({'path': 'a'})), c.listing(req({'path': 'a'})), c.readFile(req({'path': 'a', 'rel': 'b'})),
              c.writeFile(req()), getattr(c, 'import')(req()), c.visibility(req()), c.move(req()), c.delete(req({'path': 'a'}))):
        assert r['status_code'] == 404
        assert r['data']['message'] == 'no skill store'


def test_listing_returns_rel_and_size_only(root):
    c = ctl(root)
    imp(c, 'g/demo', 'hi')
    r = c.listing(req({'path': 'g/demo'}))
    assert r['success'] is True
    assert list(r['data'].keys()) == ['files']
    assert [f['rel'] for f in r['data']['files']] == ['SKILL.md']
    assert list(r['data']['files'][0].keys()) == ['rel', 'size']
    assert 'hi' not in json.dumps(r['data']['files'])
    assert c.listing(req({'path': 'g/demo'}, {}, 9))['status_code'] == 404


def test_list_names_the_owner_of_skills_that_are_not_mine(root):
    db = sqlite_db('CREATE TABLE users (id INTEGER, email TEXT, first_name TEXT, last_name TEXT)')
    db.execute("INSERT INTO users VALUES (7, 'a@x.io', 'Ada', 'Lovelace'), (9, 'z@x.io', '', '')")
    store = SkillStore(root, 'corporate')
    c = SkillStoreController(db, {'edition': 'corporate'}, lambda: store)
    for name, uid in (('one', 7), ('two', 9), ('three', 55)):
        getattr(c, 'import')(req({}, {'path': name, 'visibility': 'public', 'files': {'SKILL.md': b64(f'---\nname: {name}\ndescription: d\n---\n')}}, uid))
    by = {r['path']: r['owner_name'] for r in c.list(req({}, {}, 8))['data']}
    assert dict(sorted(by.items())) == {'one': 'Ada Lovelace', 'three': '', 'two': 'z@x.io'}


def test_list_rows_carry_requires_and_never_another_users_private_skill(root):
    c = ctl(root)

    def md(n, r):
        return b64(f'---\nname: {n}\nrequires-skills: [{r}]\n---\n')
    getattr(c, 'import')(req({}, {'path': 'base', 'visibility': 'private', 'files': {'SKILL.md': md('base', '')}}))
    getattr(c, 'import')(req({}, {'path': 'app', 'visibility': 'private', 'files': {'SKILL.md': md('app', 'base')}}))
    getattr(c, 'import')(req({}, {'path': 'hidden', 'visibility': 'private', 'files': {'SKILL.md': md('hidden', '')}}, 99))
    assert 'requires' not in c.list(req())['data'][0]
    rows = {r['path']: r['requires'] for r in c.list(req({'requires': '1'}))['data']}
    assert dict(sorted(rows.items())) == {'app': ['base'], 'base': []}


def test_import_dry_run_writes_nothing(root):
    c = ctl(root)
    dry = getattr(c, 'import')(req({}, {'path': 'g/demo', 'visibility': 'private', 'dry_run': True,
                                        'files': {'SKILL.md': b64('---\nname: demo\n---\n')}}))
    assert dry['data']['status'] == 'new'
    assert c.list(req())['data'] == []


def test_a_required_skill_refuses_delete_with_required_by(root):
    c = ctl(root)
    getattr(c, 'import')(req({}, {'path': 'flow', 'files': {'SKILL.md': b64('---\nname: flow\n---\n')}}))
    getattr(c, 'import')(req({}, {'path': 'auto', 'files': {'SKILL.md': b64('---\nname: auto\n---\n'),
                                                            'scripts/a.py': b64("load_script('flow', 'c.py')\n")}}))
    r = c.delete(req({'path': 'flow'}))
    assert r['status_code'] == 409
    assert r['data']['required_by'] == ['auto']
    assert r['data']['reason'] == 'delete'
    assert c.visibility(req({}, {'path': 'auto', 'visibility': 'private'}))['data']['made_public'] == []


def test_import_list_files_file_roundtrip(root):
    c = ctl(root)
    assert imp(c)['data'] == {'status': 'installed'}
    assert imp(c)['data']['status'] == 'identical'
    assert c.list(req())['data'][0]['path'] == 'g/demo'
    assert list(c.files(req({'path': 'g/demo'}))['data']['files'].keys()) == ['SKILL.md']
    assert c.writeFile(req({}, {'path': 'g/demo', 'rel': 'a/b.txt', 'content': b64(b'x\0y')}))['success'] is True
    g = c.readFile(req({'path': 'g/demo', 'rel': 'a/b.txt'}))
    assert base64.b64decode(g['data']['content']) == b'x\0y'


def test_files_leaves_wheels_out_when_wheels_is_0(root):
    c = ctl(root)
    getattr(c, 'import')(req({}, {'path': 'g/demo', 'visibility': 'private', 'files': {
        'SKILL.md': b64('---\nname: demo\ndescription: d\n---\nhi'), '.wheels/pyodide/a.whl': b64('W')}}))
    assert sorted(c.files(req({'path': 'g/demo'}))['data']['files']) == ['.wheels/pyodide/a.whl', 'SKILL.md']
    assert list(c.files(req({'path': 'g/demo', 'wheels': '0'}))['data']['files'].keys()) == ['SKILL.md']


def test_exception_status_codes_pass_through(root):
    c = ctl(root, True, 'corporate')
    imp(c)
    c.visibility(req({}, {'path': 'g/demo', 'visibility': 'public'}))
    clash = imp(c, 'g/demo', 'other')
    assert clash['status_code'] == 409
    assert clash['data'] == {'clash': 'different', 'message': "A different skill is already installed at 'g/demo'."}
    imp(c, 'g/a', 'a')
    imp(c, 'g/b', 'b')
    mv = c.move(req({}, {'from': 'g/a', 'to': 'g/b'}))
    assert mv['status_code'] == 409
    assert mv['data'] == {'clash': 'different', 'message': "A skill already exists at 'g/b'."}
    assert c.files(req({'path': 'nope'}))['status_code'] == 404
    assert c.writeFile(req({}, {'path': 'g/demo', 'rel': 'x', 'content': ''}, 8))['status_code'] == 403
    assert c.readFile(req({'path': 'g/demo', 'rel': 'zzz'}, {}, 7))['status_code'] == 404


def test_bad_path_and_bad_base64_are_400(root):
    c = ctl(root)
    assert c.files(req({'path': '../x'}))['status_code'] == 400
    assert getattr(c, 'import')(req({}, {'path': '../x', 'files': []}))['status_code'] == 400
    assert getattr(c, 'import')(req({}, {'path': 'a', 'files': {'SKILL.md': '***'}}))['status_code'] == 400
    assert c.writeFile(req({}, {'path': 'a', 'rel': 'x', 'content': '!!'}))['status_code'] == 400
    assert getattr(c, 'import')(req({}, {'path': 'a', 'files': 'nope'}))['status_code'] == 400


def test_as_robot_only_narrows_the_view(root):
    c = ctl(root, True, 'corporate')
    imp(c)
    assert len(c.list(req())['data']) == 1
    r = c.list(req({'as': 'robot'}, {}, 8))
    assert r['success'] is True and r['data'] == []
    assert c.files(req({'path': 'g/demo', 'as': 'robot'}))['status_code'] == 404


def test_visibility_move_delete(root):
    c = ctl(root, True, 'corporate')
    imp(c)
    assert c.visibility(req({}, {'path': 'g/demo', 'visibility': 'public'}))['success'] is True
    assert c.list(req())['data'][0]['visibility'] == 'public'
    assert c.move(req({}, {'from': 'g/demo', 'to': 'g/new'}))['data'] == {'path': 'g/new'}
    assert c.delete(req({'path': 'g/new'}))['success'] is True
    assert c.list(req())['data'] == []


# ---------------------------------------------------------------- POST /skills/native-wheels (SkillNativeWheelsRouteTest)

def call(body, runner):
    # No store factory result (folder mode): the route must still work.
    return SkillStoreController(sqlite_db(), {}, lambda: None, SkillWheelFetcher(runner)).nativeWheels({'user_id': 1, 'body': body})


def never(argv):
    raise AssertionError('no command expected')


def test_bad_dependencies_are_400():
    assert call({'dependencies': 'foo'}, never)['status_code'] == 400
    assert call({}, never)['status_code'] == 400
    assert call({'dependencies': ['--index-url=x']}, lambda argv: {'code': 0, 'out': ''})['status_code'] == 400


def test_empty_list_gives_empty_wheels_object():
    r = call({'dependencies': []}, never)
    assert r['status_code'] == 200
    assert json.dumps(r['data'], separators=(',', ':')) == '{"wheels":{}}'


def test_no_wheel_is_422_with_library_and_platform():
    def runner(argv):
        if '--version' in argv:
            return {'code': 0, 'out': ''}
        if argv[3] == 'wheel':
            return {'code': 1, 'out': 'build failed'}
        return {'code': 1, 'out': 'ERROR: No matching distribution found for foo'}
    r = call({'dependencies': ['foo']}, runner)
    assert r['status_code'] == 422
    assert (r['data']['library'], r['data']['platform']) == ('foo', 'manylinux_2_17_x86_64')


def test_wheels_come_back_base64():
    def runner(argv):
        if '--version' not in argv:
            d = argv[argv.index('--dest') + 1]
            with open(f'{d}/foo-1-py3-none-any.whl', 'wb') as fh:
                fh.write(b'abc')
        return {'code': 0, 'out': ''}
    assert call({'dependencies': ['foo']}, runner)['data']['wheels'] == {'foo-1-py3-none-any.whl': b64('abc')}
