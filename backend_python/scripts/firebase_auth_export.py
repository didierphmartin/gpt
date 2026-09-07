"""Port of backend/scripts/firebase-auth-export.php — local bcrypt -> Firebase
Auth migration helper.

What it does
  1. Scans the `users` table for email/password accounts that haven't yet
     been migrated to Firebase (provider='email', password set, no
     firebase_uid).
  2. By default, prints a dry-run report: total candidates, sample masked
     emails, and how many rows are skipped per reason.
  3. With --write, also emits a JSON file that `firebase auth:import`
     accepts (BCRYPT algorithm). The DB is NOT modified.

Usage
  # Dry run (read-only, just prints stats):
  .venv/bin/python -m scripts.firebase_auth_export

  # Same plus write the import file:
  .venv/bin/python -m scripts.firebase_auth_export --write

  # Custom output location:
  .venv/bin/python -m scripts.firebase_auth_export --write --out=/tmp/users.json

Safety
  - Read-only on the DB. The `password` column is NOT touched.

Deviations from the PHP source (see inline comments for each):
  - `--help` prints a pinned copy of the PHP file's first 2000 bytes
    (`_firebase_auth_export_help.txt`, captured via `php ... --help`,
    2026-09-07) rather than this Python file's own bytes — the PHP
    docstring is still the canonical usage text for this migration.
  - The "Config not found" / "no `database`/`contexts_database` section"
    guards do not apply: this port's bootstrap (`app/config.py:
    load_config`) is env-var based, not a `require`'d PHP config file, so
    there is no reachable "file exists but is missing a key" state.
  - The `--write` follow-up hint prints the Python re-run command, not
    `php firebase-auth-export.php --write` (this is a Python script now).
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from app.config import ConfigError, load_config
from app.db import open_primary
from app.support.phpcompat import b64url_encode, php_bool, php_coalesce, php_empty, php_trim, php_tz, validate_email
from app.support.phpjson import dumps_pretty

_HELP_PATH = Path(__file__).resolve().parent / '_firebase_auth_export_help.txt'


def _help_text() -> str:
    return _HELP_PATH.read_text(encoding='utf-8')


def _mask(email: str) -> str:
    """PHP's `$mask` closure (firebase-auth-export.php ~103-111)."""
    parts = email.split('@', 1)
    user = parts[0] if len(parts) > 0 else ''
    domain = parts[1] if len(parts) > 1 else ''
    if user == '' or domain == '':
        return '???'
    if len(user) <= 2:
        user_masked = '*' * len(user)
    else:
        user_masked = user[0] + '*' * max(0, len(user) - 2) + user[-1]
    return f"{user_masked}@{domain}"


def _to_ms(s) -> int:
    """PHP's `$toMs` closure (firebase-auth-export.php ~152-156):
    `strtotime((string)$s)` parsed in PHP's configured timezone, else "now"
    in ms if `$s` is falsy or unparseable."""
    if not s:
        return int(time.time() * 1000)
    try:
        # Deliberate narrowing of PHP's general-purpose `strtotime()` to the
        # single MySQL DATETIME shape this DB layer ever hands back
        # ('%Y-%m-%d %H:%M:%S') — not a full strtotime() reimplementation.
        dt = datetime.strptime(str(s), '%Y-%m-%d %H:%M:%S').replace(tzinfo=php_tz())
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return int(time.time() * 1000)


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='firebase_auth_export', add_help=False)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--out', default=None)
    parser.add_argument('--help', action='store_true', dest='help_flag')
    return parser


def main(argv: list[str] | None = None) -> int:
    args, _unknown = _build_arg_parser().parse_known_args(
        argv if argv is not None else sys.argv[1:]
    )

    if args.help_flag:
        sys.stdout.write(_help_text())
        return 0

    write = args.write
    out_path = args.out if args.out is not None else str(Path(tempfile.gettempdir()) / 'firebase-auth-export.json')

    try:
        config = load_config()
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        return 1

    try:
        db = open_primary(config)
    except Exception as e:  # noqa: BLE001 — PHP: catch (PDOException $e)
        print(f'DB connection failed: {e}', file=sys.stderr)
        return 1

    try:
        return _run(db, write, out_path)
    finally:
        db.close()


def _run(db, write: bool, out_path: str) -> int:
    rows = db.fetch_all(
        "SELECT id, email, first_name, last_name, password, provider,\n"
        "           firebase_uid, email_verified, last_login, created_at\n"
        "    FROM users\n"
        "    ORDER BY id ASC"
    )

    candidates = []
    skipped = {'social': 0, 'no_password': 0, 'already_migrated': 0, 'invalid_email': 0}

    for r in rows:
        if not php_empty(r.get('firebase_uid')):
            skipped['already_migrated'] += 1
            continue
        provider = r.get('provider') if r.get('provider') is not None else 'email'
        if provider != 'email':
            skipped['social'] += 1
            continue
        if php_empty(r.get('password')):
            skipped['no_password'] += 1
            continue
        if not validate_email(php_coalesce(r.get('email'), '')):
            skipped['invalid_email'] += 1
            continue
        candidates.append(r)

    print("")
    print("Firebase Auth Export — dry run")
    print("=" * 50)
    print(f"Total rows scanned     : {len(rows)}")
    print(f"Candidates to import   : {len(candidates)}")
    print(f"Skipped (social login) : {skipped['social']}")
    print(f"Skipped (no password)  : {skipped['no_password']}")
    print(f"Skipped (already done) : {skipped['already_migrated']}")
    print(f"Skipped (bad email)    : {skipped['invalid_email']}")
    print("")

    if len(candidates) == 0:
        print("Nothing to import.")
        return 0

    print("Sample (first 10, masked):")
    for c in candidates[:10]:
        verified = 'yes' if c.get('email_verified') else 'no'
        print(f"  - id={c['id']}  {_mask(c['email'])}  hash={c['password'][:7]}...  verified={verified}")
    print("")

    if not write:
        print("Re-run with --write to emit the import file.")
        print("  .venv/bin/python -m scripts.firebase_auth_export --write")
        print("")
        return 0

    users = []
    for c in candidates:
        # base64_encode($c['password']) then strtr('+/', '-_') + rtrim('=')
        # — b64url_encode() already implements exactly that ("+/"->"-_",
        # padding stripped); bcrypt hash strings are always ASCII.
        password_hash_b64 = b64url_encode(c['password'].encode('ascii'))
        name = php_trim(f"{php_coalesce(c.get('first_name'), '')} {php_coalesce(c.get('last_name'), '')}")

        entry = {
            'localId': f"local-{c['id']}",
            'email': php_trim(c['email']).lower(),
            'emailVerified': php_bool(php_coalesce(c.get('email_verified'), False)),
            'passwordHash': password_hash_b64,
            'createdAt': _to_ms(c.get('created_at')),
            'lastLoginAt': _to_ms(c.get('last_login')),
        }
        if name != '':
            entry['displayName'] = name
        users.append(entry)

    payload = {'users': users}
    # JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES: unicode STAYS escaped
    # (no JSON_UNESCAPED_UNICODE), slashes are NOT escaped.
    Path(out_path).write_text(dumps_pretty(payload, unescaped=False, unescape_slashes=True), encoding='utf-8')

    print(f"Wrote {len(users)} user(s) to: {out_path}")
    print("")
    print("Next step (run from your Firebase CLI workspace):")
    print(f"  firebase auth:import {out_path} \\")
    print("    --hash-algo=BCRYPT \\")
    print("    --project=transledgersite")
    print("")
    print("After import, on each user's first sign-in via the new Firebase path,")
    print("the existing firebaseAuth() endpoint will populate firebase_uid in the")
    print("users row by email match — no further script needed.")

    return 0


if __name__ == '__main__':
    sys.exit(main())
