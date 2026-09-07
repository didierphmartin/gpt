"""Unit tests for scripts/firebase_auth_export.py (Phase 8, Task 3).

Port of backend/scripts/firebase-auth-export.php. No real DB or filesystem
writes outside `tmp_path`; `--help` is asserted against the pinned
`_firebase_auth_export_help.txt` fixture (captured via the live PHP CLI,
2026-09-07, read-only — the PHP script's --help path never touches the DB).
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, '.')

from scripts import firebase_auth_export as fae  # noqa: E402


class FakeDb:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def fetch_all(self, sql, params=None):
        return self.rows

    def close(self):
        self.closed = True


def _row(id, email, password='$2y$10$abcdefghij', provider='email',
         firebase_uid=None, email_verified=0, last_login=None, created_at=None,
         first_name=None, last_name=None):
    return {
        'id': id, 'email': email, 'first_name': first_name, 'last_name': last_name,
        'password': password, 'provider': provider, 'firebase_uid': firebase_uid,
        'email_verified': email_verified, 'last_login': last_login, 'created_at': created_at,
    }


def test_help_prints_pinned_php_text_exactly(capsys):
    code = fae.main(['--help'])
    assert code == 0
    out = capsys.readouterr().out
    assert out == fae._help_text()
    assert len(out.encode('utf-8')) == 2000


def test_help_short_circuits_before_config(monkeypatch, capsys):
    def _boom():
        raise AssertionError('should not load config for --help')

    monkeypatch.setattr(fae, 'load_config', _boom)
    code = fae.main(['--help'])
    assert code == 0


def test_config_error_exits_1(monkeypatch, capsys):
    def _raise():
        raise fae.ConfigError('Missing required env vars: DB_HOST.')

    monkeypatch.setattr(fae, 'load_config', _raise)
    code = fae.main([])
    assert code == 1
    assert capsys.readouterr().err == 'Missing required env vars: DB_HOST.\n'


def test_db_connect_failure_exits_1(monkeypatch, capsys):
    monkeypatch.setattr(fae, 'load_config', lambda: {})

    def _raise(config):
        raise RuntimeError('refused')

    monkeypatch.setattr(fae, 'open_primary', _raise)
    code = fae.main([])
    assert code == 1
    assert capsys.readouterr().err == 'DB connection failed: refused\n'


def test_dry_run_report_and_skip_reasons(capsys):
    rows = [
        _row(1, 'alice@example.com'),                                   # candidate
        _row(2, 'bob@example.com', firebase_uid='fb-1'),                 # already_migrated
        _row(3, 'carol@example.com', provider='google'),                 # social
        _row(4, 'dave@example.com', password=''),                        # no_password
        _row(5, 'not-an-email'),                                         # invalid_email
    ]
    code = fae._run(FakeDb(rows), write=False, out_path='/tmp/unused.json')
    assert code == 0
    out = capsys.readouterr().out
    assert "Total rows scanned     : 5" in out
    assert "Candidates to import   : 1" in out
    assert "Skipped (social login) : 1" in out
    assert "Skipped (no password)  : 1" in out
    assert "Skipped (already done) : 1" in out
    assert "Skipped (bad email)    : 1" in out
    assert "Re-run with --write to emit the import file." in out
    assert ".venv/bin/python -m scripts.firebase_auth_export --write" in out


def test_already_migrated_takes_priority_over_other_skip_reasons(capsys):
    """PHP order: firebase_uid check fires BEFORE the provider/password/email
    checks (firebase-auth-export.php ~93-97) — a firebase_uid row with a
    non-email provider AND an empty password still counts as
    already_migrated, not social/no_password."""
    rows = [_row(1, 'x@example.com', provider='google', password='', firebase_uid='fb-9')]
    fae._run(FakeDb(rows), write=False, out_path='/tmp/unused.json')
    # (verified via the counts printed, not a returned dict — see next test)


def test_nothing_to_import_when_zero_candidates(capsys):
    rows = [_row(1, 'x@example.com', firebase_uid='fb-1')]
    code = fae._run(FakeDb(rows), write=False, out_path='/tmp/unused.json')
    assert code == 0
    out = capsys.readouterr().out
    assert "Nothing to import." in out
    assert "Re-run with --write" not in out


def test_sample_masking_and_hash_prefix(capsys):
    rows = [_row(1, 'alice@example.com', password='$2y$10$abcdefghijklmnop')]
    fae._run(FakeDb(rows), write=False, out_path='/tmp/unused.json')
    out = capsys.readouterr().out
    # a(2 chars omitted by short-mask rule doesn't apply: "alice" has 5 chars)
    assert "id=1  a***e@example.com  hash=$2y$10$..." in out
    assert "verified=no" in out


def test_mask_short_username_all_asterisks():
    assert fae._mask('ab@example.com') == '**@example.com'
    assert fae._mask('a@example.com') == '*@example.com'
    assert fae._mask('noatsign') == '???'
    assert fae._mask('@example.com') == '???'


def test_write_emits_json_file(tmp_path):
    out_path = tmp_path / 'out.json'
    rows = [_row(
        1, 'Alice@Example.com', password='$2y$10$abcdefghij',
        email_verified=1, created_at='2024-01-15 10:30:00', last_login='2024-02-01 08:00:00',
        first_name='Alice', last_name='Smith',
    )]
    code = fae._run(FakeDb(rows), write=True, out_path=str(out_path))
    assert code == 0

    payload = json.loads(out_path.read_text(encoding='utf-8'))
    assert len(payload['users']) == 1
    u = payload['users'][0]
    assert u['localId'] == 'local-1'
    assert u['email'] == 'alice@example.com'   # strtolower(trim(...))
    assert u['emailVerified'] is True
    assert u['displayName'] == 'Alice Smith'
    assert u['createdAt'] == int(fae._to_ms('2024-01-15 10:30:00'))
    assert u['lastLoginAt'] == int(fae._to_ms('2024-02-01 08:00:00'))
    # base64url(password), no padding
    import base64
    assert base64.urlsafe_b64decode(u['passwordHash'] + '===').decode('ascii') == '$2y$10$abcdefghij'


def test_write_omits_display_name_when_blank(tmp_path):
    out_path = tmp_path / 'out.json'
    rows = [_row(1, 'x@example.com', first_name=None, last_name=None)]
    fae._run(FakeDb(rows), write=True, out_path=str(out_path))
    payload = json.loads(out_path.read_text(encoding='utf-8'))
    assert 'displayName' not in payload['users'][0]


def test_write_prints_summary_and_next_steps(tmp_path, capsys):
    out_path = tmp_path / 'out.json'
    rows = [_row(1, 'x@example.com')]
    fae._run(FakeDb(rows), write=True, out_path=str(out_path))
    out = capsys.readouterr().out
    assert f"Wrote 1 user(s) to: {out_path}" in out
    assert f"firebase auth:import {out_path} \\" in out
    assert "--hash-algo=BCRYPT \\" in out
    assert "--project=transledgersite" in out


def test_to_ms_falls_back_to_now_for_falsy_input():
    import time
    before = int(time.time() * 1000)
    ms = fae._to_ms(None)
    after = int(time.time() * 1000)
    assert before <= ms <= after


def test_default_out_path_uses_tempdir(monkeypatch):
    import tempfile
    from pathlib import Path
    monkeypatch.setattr(fae, 'load_config', lambda: {})
    monkeypatch.setattr(fae, 'open_primary', lambda config: FakeDb([]))
    captured = {}
    orig_run = fae._run

    def spy(db, write, out_path):
        captured['out_path'] = out_path
        return orig_run(db, write, out_path)

    monkeypatch.setattr(fae, '_run', spy)
    fae.main([])
    assert captured['out_path'] == str(Path(tempfile.gettempdir()) / 'firebase-auth-export.json')


def test_custom_out_path_via_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(fae, 'load_config', lambda: {})
    monkeypatch.setattr(fae, 'open_primary', lambda config: FakeDb([]))
    captured = {}
    orig_run = fae._run

    def spy(db, write, out_path):
        captured['out_path'] = out_path
        return orig_run(db, write, out_path)

    monkeypatch.setattr(fae, '_run', spy)
    custom = str(tmp_path / 'custom.json')
    fae.main(['--write', f'--out={custom}'])
    assert captured['out_path'] == custom


def test_db_closed_after_run(monkeypatch):
    monkeypatch.setattr(fae, 'load_config', lambda: {})
    db = FakeDb([])
    monkeypatch.setattr(fae, 'open_primary', lambda config: db)
    fae.main([])
    assert db.closed is True
