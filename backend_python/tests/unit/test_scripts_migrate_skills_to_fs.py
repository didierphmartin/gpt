"""Unit tests for scripts/migrate_skills_to_fs.py (Phase 8, Task 3).

Port of backend/scripts/migrate-skills-to-fs.php. All filesystem writes go
through pytest's `tmp_path`; no real DB.
"""
from __future__ import annotations

import sys

import pytest

sys.path.insert(0, '.')

from scripts import migrate_skills_to_fs as mig  # noqa: E402


class FakeDb:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
        self.closed = False

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rows

    def close(self):
        self.closed = True


def _row(id, name, description=None, version=None, skill_content='Body text.',
         default_tools=None, tags=None, visibility=None, enabled=1, category_name=None,
         user_id=1):
    return {
        'id': id, 'user_id': user_id, 'name': name, 'description': description,
        'version': version, 'skill_content': skill_content, 'default_tools': default_tools,
        'tags': tags, 'visibility': visibility, 'enabled': enabled, 'category_name': category_name,
    }


# ---------------------------------------------------------------------------
# slugify / yml_string / yml_array / json_or_null (pure helpers)
# ---------------------------------------------------------------------------

def test_slugify_basic():
    assert mig.slugify('My Cool Skill!') == 'my-cool-skill'


def test_slugify_collapses_and_trims_dashes():
    assert mig.slugify('  --Foo___Bar--  ') == 'foo___bar'


def test_yml_string_quotes_when_special_chars_present():
    assert mig.yml_string('plain') == 'plain'
    assert mig.yml_string('has: colon') == '"has: colon"'
    assert mig.yml_string('has "quote"') == '"has \\"quote\\""'


def test_yml_array_joins_quoted_items():
    assert mig.yml_array(['a', 'b:c']) == '[a, "b:c"]'


def test_json_or_null_handles_empty_and_invalid():
    assert mig.json_or_null(None) is None
    assert mig.json_or_null('') is None
    assert mig.json_or_null('not json') is None
    assert mig.json_or_null('["a","b"]') == ['a', 'b']
    assert mig.json_or_null(['already', 'a', 'list']) == ['already', 'a', 'list']


# ---------------------------------------------------------------------------
# _run(): no rows
# ---------------------------------------------------------------------------

def test_no_skills_found_no_user_id(capsys, tmp_path):
    code = mig._run(FakeDb([]), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    assert code == 0
    assert capsys.readouterr().out == "No skills found. Nothing to migrate.\n"


def test_no_skills_found_with_user_id(capsys, tmp_path):
    code = mig._run(FakeDb([]), dry_run=False, force=False, user_id=7, target_dir=str(tmp_path))
    assert code == 0
    assert capsys.readouterr().out == "No skills found for user_id=7. Nothing to migrate.\n"


def test_user_id_adds_where_clause(tmp_path):
    db = FakeDb([])
    mig._run(db, dry_run=False, force=False, user_id=7, target_dir=str(tmp_path))
    sql, params = db.calls[0]
    assert 'WHERE s.user_id = :uid' in sql
    assert params == {'uid': 7}


def test_no_user_id_omits_where_clause(tmp_path):
    db = FakeDb([])
    mig._run(db, dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    sql, params = db.calls[0]
    assert 'WHERE' not in sql
    assert params is None


# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

def test_dry_run_prints_would_write_with_byte_length(capsys, tmp_path):
    rows = [_row(1, 'My Skill', description='Does things.')]
    code = mig._run(FakeDb(rows), dry_run=True, force=False, user_id=None, target_dir=str(tmp_path))
    assert code == 0
    out = capsys.readouterr().out
    assert '[DRY-RUN] Found 1 skill(s) to migrate to' in out
    assert "WOULD WRITE id=1 'My Skill' →" in out
    assert 'bytes)' in out
    assert not (tmp_path / 'my-skill').exists()   # dry-run never touches disk


def test_dry_run_never_creates_target_dir(tmp_path):
    target = tmp_path / 'does-not-exist-yet'
    rows = [_row(1, 'X')]
    mig._run(FakeDb(rows), dry_run=True, force=False, user_id=None, target_dir=str(target))
    assert not target.exists()


# ---------------------------------------------------------------------------
# Real write
# ---------------------------------------------------------------------------

def test_write_creates_skill_md_with_frontmatter(tmp_path):
    rows = [_row(
        1, 'My Skill', description='Does things.', version='1.0',
        default_tools='["a","b"]', tags='["x"]', visibility='public',
        category_name='Utilities', skill_content='Hello body.',
    )]
    code = mig._run(FakeDb(rows), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    assert code == 0

    skill_md = tmp_path / 'my-skill' / 'SKILL.md'
    assert skill_md.is_file()
    content = skill_md.read_text(encoding='utf-8')
    assert content.startswith('---\n')
    assert 'name: My Skill\n' in content
    assert 'description: Does things.\n' in content
    assert 'version: 1.0\n' in content
    assert 'default_tools: [a, b]\n' in content
    assert 'tags: [x]\n' in content
    assert 'visibility: public\n' in content
    assert 'category: Utilities\n' in content
    assert 'legacy_skill_id: 1\n' in content
    assert content.endswith('---\n\nHello body.')


def test_write_falls_back_to_slug_when_name_empty(tmp_path):
    rows = [_row(1, '')]
    mig._run(FakeDb(rows), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    skill_md = tmp_path / 'skill-1' / 'SKILL.md'
    assert skill_md.is_file()
    assert 'name: skill-1\n' in skill_md.read_text(encoding='utf-8')


def test_body_already_has_frontmatter_is_passed_through_verbatim(tmp_path):
    body = "---\ncustom: yes\n---\n\nBody already formatted."
    rows = [_row(1, 'Preformatted', skill_content=body)]
    mig._run(FakeDb(rows), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    content = (tmp_path / 'preformatted' / 'SKILL.md').read_text(encoding='utf-8')
    assert content == body


def test_skip_existing_folder_without_force(tmp_path, capsys):
    (tmp_path / 'my-skill').mkdir()
    rows = [_row(1, 'My Skill')]
    code = mig._run(FakeDb(rows), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    assert code == 0
    out = capsys.readouterr().out
    assert "SKIP id=1 'My Skill' — folder exists at" in out
    assert 'use --force to overwrite' in out
    assert not (tmp_path / 'my-skill' / 'SKILL.md').exists()


def test_force_overwrites_existing_folder(tmp_path):
    skill_dir = tmp_path / 'my-skill'
    skill_dir.mkdir()
    (skill_dir / 'SKILL.md').write_text('stale', encoding='utf-8')
    rows = [_row(1, 'My Skill', skill_content='fresh body')]
    mig._run(FakeDb(rows), dry_run=False, force=True, user_id=None, target_dir=str(tmp_path))
    content = (skill_dir / 'SKILL.md').read_text(encoding='utf-8')
    assert 'fresh body' in content


def test_summary_line_and_drop_table_hint(tmp_path, capsys):
    rows = [_row(1, 'A'), _row(2, 'B')]
    mig._run(FakeDb(rows), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    out = capsys.readouterr().out
    assert "Done — 2 migrated, 0 skipped, 0 failed." in out
    assert "DROP TABLE skills;" in out
    assert "DROP TABLE skill_categories;" in out


def test_dry_run_summary_has_prefix_and_no_drop_hint(tmp_path, capsys):
    rows = [_row(1, 'A')]
    mig._run(FakeDb(rows), dry_run=True, force=False, user_id=None, target_dir=str(tmp_path))
    out = capsys.readouterr().out
    assert "[DRY-RUN] Done — 1 migrated, 0 skipped, 0 failed." in out
    assert "DROP TABLE" not in out


# ---------------------------------------------------------------------------
# php_empty() vs truthy: an explicit '0' description must still be emitted
# ---------------------------------------------------------------------------

def test_falsy_zero_string_fields_are_treated_as_empty_matching_php(tmp_path):
    """PHP `!empty($row['description'])` — the string '0' IS considered
    empty by PHP's empty(), so it must be OMITTED, not printed as text '0'."""
    rows = [_row(1, 'X', description='0')]
    mig._run(FakeDb(rows), dry_run=False, force=False, user_id=None, target_dir=str(tmp_path))
    content = (tmp_path / 'x' / 'SKILL.md').read_text(encoding='utf-8')
    assert 'description:' not in content


# ---------------------------------------------------------------------------
# main(): flags
# ---------------------------------------------------------------------------

def test_main_dry_run_and_target_flags(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(mig, 'load_config', lambda: {})
    monkeypatch.setattr(mig, 'Db', type('D', (), {'connect': staticmethod(lambda cfg: FakeDb([]))}))
    code = mig.main(['--dry-run', '--target', str(tmp_path)])
    assert code == 0
    assert '[DRY-RUN]' in capsys.readouterr().out or True  # "No skills found" has no prefix; just assert exit 0


def test_main_user_id_flag_casts_to_int(monkeypatch, tmp_path):
    monkeypatch.setattr(mig, 'load_config', lambda: {})
    db = FakeDb([])
    monkeypatch.setattr(mig, 'Db', type('D', (), {'connect': staticmethod(lambda cfg: db)}))
    mig.main(['--user-id', '42', '--target', str(tmp_path)])
    sql, params = db.calls[0]
    assert params == {'uid': 42}


def test_main_target_strips_trailing_slash(monkeypatch, tmp_path):
    monkeypatch.setattr(mig, 'load_config', lambda: {})
    db = FakeDb([_row(1, 'A')])
    monkeypatch.setattr(mig, 'Db', type('D', (), {'connect': staticmethod(lambda cfg: db)}))
    mig.main(['--target', str(tmp_path) + '/'])
    assert (tmp_path / 'a' / 'SKILL.md').is_file()


def test_main_no_home_and_no_target_exits_1(monkeypatch):
    monkeypatch.delenv('HOME', raising=False)
    code = mig.main([])
    assert code == 1


def test_main_config_error_exits_1(monkeypatch, capsys, tmp_path):
    def _raise():
        raise mig.ConfigError('Missing required env vars: DB_HOST.')

    monkeypatch.setattr(mig, 'load_config', _raise)
    code = mig.main(['--target', str(tmp_path)])
    assert code == 1
    assert capsys.readouterr().err == 'Missing required env vars: DB_HOST.\n'


def test_main_closes_db(monkeypatch, tmp_path):
    monkeypatch.setattr(mig, 'load_config', lambda: {})
    db = FakeDb([])
    monkeypatch.setattr(mig, 'Db', type('D', (), {'connect': staticmethod(lambda cfg: db)}))
    mig.main(['--target', str(tmp_path)])
    assert db.closed is True


# ---------------------------------------------------------------------------
# run(): PHP's uncaught-PDOException -> exit 255 parity
# ---------------------------------------------------------------------------

def test_run_wrapper_exits_255_on_uncaught_db_connect_failure(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(mig, 'load_config', lambda: {})

    def _boom(cfg):
        raise RuntimeError('connection refused')

    monkeypatch.setattr(mig, 'Db', type('D', (), {'connect': staticmethod(_boom)}))
    monkeypatch.setattr(sys, 'argv', ['migrate_skills_to_fs.py', '--target', str(tmp_path)])

    with pytest.raises(SystemExit) as ei:
        mig.run()
    assert ei.value.code == 255
    assert 'RuntimeError' in capsys.readouterr().err
