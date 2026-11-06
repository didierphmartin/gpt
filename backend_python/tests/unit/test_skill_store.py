"""Port of backend/tests/Unit/SkillStoreTest.php (the Docker app's skills volume)."""
from __future__ import annotations

import os

import pytest

from app.services.skill_errors import SkillClashException, SkillForbidden, SkillNotFound, SkillPathInvalid, SkillRequiredBy
from app.services.skill_store import SkillStore


@pytest.fixture
def root(tmp_path):
    return str(tmp_path / 'skills')


def store(root, edition='corporate'):
    return SkillStore(root, edition)


def skill(name='docx', extra=''):
    return {'SKILL.md': f'---\nname: {name}\ndescription: Does {name}\ndependencies: [python-docx, lxml]\n---\nBody{extra}\n'.encode(),
            'scripts/run.py': b"print('hi')\n"}


def test_import_defaults_private_and_lists_only_for_owner(root):
    s = store(root)
    assert s.import_(1, 'docx', skill()) == {'status': 'installed'}
    rows = s.list(1)
    assert len(rows) == 1
    assert (rows[0]['visibility'], rows[0]['mine'], rows[0]['name'], rows[0]['description']) == ('private', True, 'docx', 'Does docx')
    assert rows[0]['dependencies'] == ['python-docx', 'lxml']
    assert s.list(2) == []


def test_listing_strips_one_matching_quote_pair_and_reads_quoted_list_items(root):
    s = store(root)
    cases = {'say "hi"': 'say "hi"', "'say \"hi\"'": 'say "hi"', "\"'x'\"": "'x'", "'a' and 'b'": "a' and 'b", '"open': '"open'}
    for i, raw in enumerate(cases, 1):
        s.import_(1, f'q{i}', {'SKILL.md': f"---\nname: q{i}\ndescription: {raw}\ndependencies: [pandas>=2, 'numpy>=1.20,<2', 'requests[socks,security]']\n---\nB\n".encode()})
    rows = sorted(s.list(1), key=lambda r: r['path'])
    assert [r['description'] for r in rows] == list(cases.values())
    assert rows[0]['dependencies'] == ['pandas>=2', 'numpy>=1.20,<2', 'requests[socks,security]']


def test_public_skill_listed_for_everyone_with_owner(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    s.setVisibility(1, 'docx', 'public')
    rows = s.list(2)
    assert len(rows) == 1
    assert (rows[0]['visibility'], rows[0]['mine'], rows[0]['owner_id']) == ('public', False, 1)
    assert os.path.isdir(root + '/public/docx')
    assert not os.path.isdir(root + '/users/1/docx')


def test_individual_edition_never_public(root):
    s = store(root, 'individual')
    s.import_(1, 'docx', skill())
    with pytest.raises(SkillForbidden):
        s.setVisibility(1, 'docx', 'public')


def test_robot_sees_all_in_individual_public_only_in_corporate(root):
    for edition, expected in (('individual', 2), ('corporate', 1)):
        r = root + '/' + edition
        os.makedirs(r)
        s = SkillStore(r, edition)
        s.import_(1, 'a', skill('a'))
        s.import_(2, 'b', skill('b'))
        if edition == 'corporate':
            s.setVisibility(1, 'a', 'public')
        assert len(s.list(99, True)) == expected, edition
    assert SkillStore(root + '/individual', 'individual').readFile(99, 'b', 'scripts/run.py', True) == b"print('hi')\n"


def test_python_bytecode_is_not_skill_content(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    # A run left Python's bytecode cache in the stored skill (older clients saved it back).
    s.writeFile(1, 'docx', 'scripts/__pycache__/run.cpython-312.pyc', b'\x00bytecode')
    s.writeFile(1, 'docx', 'scripts/old.pyc', b'\x00bytecode')
    assert s.import_(1, 'docx', skill()) == {'status': 'identical'}
    assert s.import_(1, 'g/docx', skill())['status'] == 'identical'
    # Incoming bytecode does not make an otherwise identical copy different either.
    assert s.import_(1, 'docx', {**skill(), 'scripts/__pycache__/x.pyc': b'b'}) == {'status': 'identical'}
    # And it is never served.
    assert sorted(s.files(1, 'docx')) == ['SKILL.md', 'scripts/run.py']


def test_dry_run_import_reports_without_writing(root):
    s = store(root)
    assert s.import_(1, 'docx', skill(), 'private', True) == {'status': 'new'}
    assert s.list(1) == []
    assert not os.path.isfile(root + '/users/1/docx/SKILL.md')
    s.import_(1, 'docx', skill())
    assert s.import_(1, 'docx', skill(), 'private', True) == {'status': 'identical'}
    with pytest.raises(SkillClashException):
        s.import_(1, 'docx', skill('docx', 'changed'), 'private', True)


def test_different_reimport_throws_clash(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    with pytest.raises(SkillClashException):
        s.import_(1, 'docx', skill('docx', 'changed'))


def test_leaf_name_unique_across_public_and_own_private(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    s.setVisibility(1, 'docx', 'public')
    with pytest.raises(SkillClashException) as e:
        s.import_(2, 'x/docx', skill('docx', 'other'))
    assert e.value.statusCode() == 409
    assert 'users/1' not in str(e.value) and 'owner' not in str(e.value).lower()
    # A's private skill does not block B.
    s.import_(1, 'pdf', skill('pdf'))
    assert s.import_(2, 'x/pdf', skill('pdf')) == {'status': 'installed'}
    # B's own private skill blocks B.
    with pytest.raises(SkillClashException):
        s.import_(2, 'y/pdf', skill('pdf', 'other'))


def test_clash_with_other_private_never_reveals(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    assert s.import_(2, 'docx', skill('docx', 'mine')) == {'status': 'installed'}


def test_make_public_blocked_by_existing_public_leaf(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    s.import_(2, 'g/docx', skill('docx', 'b'))
    s.setVisibility(1, 'docx', 'public')
    with pytest.raises(SkillClashException):
        s.setVisibility(2, 'g/docx', 'public')


def test_only_owner_writes_deletes_moves_changes_visibility(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    s.setVisibility(1, 'docx', 'public')
    for op in (lambda: s.writeFile(2, 'docx', 'SKILL.md', b'x'), lambda: s.delete(2, 'docx'),
               lambda: s.move(2, 'docx', 'other'), lambda: s.setVisibility(2, 'docx', 'private')):
        with pytest.raises(SkillForbidden) as e:
            op()
        assert e.value.statusCode() == 403
    assert s.readFile(2, 'docx', 'scripts/run.py') == b"print('hi')\n"


def test_private_of_other_is_not_found(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    with pytest.raises(SkillNotFound):
        s.files(2, 'docx')


def test_owner_write_and_delete(root):
    s = store(root)
    s.import_(1, 'g/docx', skill())
    s.writeFile(1, 'g/docx', 'notes/a.txt', b'A')
    assert s.readFile(1, 'g/docx', 'notes/a.txt') == b'A'
    s.delete(1, 'g/docx')
    assert s.list(1) == []
    assert s.absolutePath(1, 'g/docx') is None


def test_group_paths(root):
    s = store(root)
    s.import_(1, 'GEO/geo-report', skill('geo-report'))
    assert s.list(1)[0]['path'] == 'GEO/geo-report'
    assert b'Body' in s.readFile(1, 'GEO/geo-report', 'SKILL.md')
    s.move(1, 'GEO/geo-report', 'geo-report')
    assert s.list(1)[0]['path'] == 'geo-report'
    assert not os.path.isdir(root + '/users/1/GEO')
    assert s.absolutePath(1, 'geo-report') is not None


def test_rejects_unsafe_paths(root):
    s = store(root)
    for bad in ('../x', '/x', 'a/.hidden', 'a//b', '', 'a\\b', 'a/b/c'):
        with pytest.raises(SkillPathInvalid) as e:
            s.import_(1, bad, skill())
        assert e.value.statusCode() == 400
    s.import_(1, 'ok', skill())
    with pytest.raises(SkillPathInvalid):
        s.readFile(1, 'ok', '../../secret')


def test_listing_gives_paths_and_sizes_sorted_without_hidden_files(root):
    s = store(root)
    f = {**skill(), 'references/b.md': b'bb', 'references/a.md': b'a', 'Zed.txt': b'zzz', '.hidden': b'h',
         '.wheels/a.whl': b'W', 'scripts/__pycache__/x.pyc': b'P', 'scripts/.dot/y.py': b'y', 'scripts/mod.pyc': b'P'}
    s.import_(1, 'docx', f)
    out = s.listing(1, 'docx')
    assert [o['rel'] for o in out] == ['SKILL.md', 'Zed.txt', 'references/a.md', 'references/b.md', 'scripts/run.py']
    assert out[0]['size'] == len(f['SKILL.md'])
    assert list(out[1].keys()) == ['rel', 'size']
    assert out[1]['size'] == 3


def test_listing_of_other_users_private_skill_is_not_found(root):
    s = store(root)
    s.import_(1, 'docx', skill())
    assert [o['rel'] for o in s.listing(1, 'docx')] == ['SKILL.md', 'scripts/run.py']
    with pytest.raises(SkillNotFound):
        s.listing(2, 'docx')
    with pytest.raises(SkillPathInvalid):
        store(root).listing(1, '../x')


def test_files_excludes_native_wheels(root):
    s = store(root)
    s.import_(1, 'docx', {**skill(), '.wheels/a.whl': b'W', '.wheels/native/b.whl': b'N'})
    assert sorted(s.files(1, 'docx')) == ['.wheels/a.whl', 'SKILL.md', 'scripts/run.py']
    assert sorted(s.files(1, 'docx', False, False)) == ['SKILL.md', 'scripts/run.py']


def requiring(name, needs):
    return {'SKILL.md': f'---\nname: {name}\nrequires-skills: [{", ".join(needs)}]\n---\nB\n'.encode()}


def test_delete_and_rename_refused_while_another_skill_requires_it_regroup_allowed(root):
    s = store(root)
    s.import_(1, 'base', skill('base'))
    s.import_(1, 'user', requiring('user', ['base']))
    with pytest.raises(SkillRequiredBy) as e:
        s.delete(1, 'base')
    assert e.value.data()['reason'] == 'delete' and e.value.data()['required_by'] == ['user']
    with pytest.raises(SkillRequiredBy):
        s.move(1, 'base', 'renamed')
    s.move(1, 'base', 'g/base')   # regrouping keeps the leaf
    s.delete(1, 'user')
    s.delete(1, 'g/base')
    assert s.list(1) == []


def test_make_public_takes_own_private_required_skills_along_atomically(root):
    s = store(root)
    s.import_(1, 'base', skill('base'))
    s.import_(1, 'user', requiring('user', ['base']))
    assert s.setVisibility(1, 'user', 'public', True) == {'made_public': ['base']}
    assert {r['path']: r['visibility'] for r in s.list(1)} == {'base': 'private', 'user': 'private'}   # dry run
    with pytest.raises(SkillRequiredBy) as e:
        s.setVisibility(1, 'user', 'public', False, [])
    assert e.value.data()['reason'] == 'changed'
    assert s.setVisibility(1, 'user', 'public', False, ['base']) == {'made_public': ['base']}
    assert {r['path']: r['visibility'] for r in s.list(1)} == {'base': 'public', 'user': 'public'}
    with pytest.raises(SkillRequiredBy) as e:
        s.setVisibility(1, 'base', 'private')
    assert e.value.data()['reason'] == 'private'


def test_make_public_refused_when_a_required_skill_cannot_be_made_public(root):
    s = store(root)
    s.import_(1, 'user', requiring('user', ['nowhere']))
    with pytest.raises(SkillRequiredBy) as e:
        s.setVisibility(1, 'user', 'public')
    assert e.value.data()['needs'] == 'nowhere'


def test_list_rows_carry_direct_requires_and_compile_resolver_prefers_the_group(root):
    s = store(root)
    s.import_(1, 'base', skill('base'))
    s.import_(1, 'g/base2', skill('base2'))
    s.import_(1, 'user', requiring('user', ['base']))
    rows = {r['path']: r for r in s.list(1, False, True)}
    assert rows['user']['requires'] == ['base']
    assert 'requires' not in s.list(1)[0]
    resolve = s.compileResolver(1, False)
    assert resolve('base2', 'g/x') == root + '/users/1/g/base2'
    assert resolve('nope', None) is None
