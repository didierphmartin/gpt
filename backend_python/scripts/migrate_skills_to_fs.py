"""Port of backend/scripts/migrate-skills-to-fs.php — one-shot migration:
copy every row from the legacy `skills` table to a folder-backed skill under
~/Documents/synergyAI/skills/<slug>/ (canonical filesystem path — kept
verbatim from PHP, see MEMORY: "Skills canonical filesystem path").

Output layout per row:
  ~/Documents/synergyAI/skills/<slug>/
      SKILL.md             <- frontmatter + skill_content body

Usage:
  .venv/bin/python -m scripts.migrate_skills_to_fs               # do it
  .venv/bin/python -m scripts.migrate_skills_to_fs --dry-run      # preview only
  .venv/bin/python -m scripts.migrate_skills_to_fs --user-id 5    # only one user's rows
  .venv/bin/python -m scripts.migrate_skills_to_fs --target /abs/path  # override target dir
  .venv/bin/python -m scripts.migrate_skills_to_fs --force        # overwrite if folder exists

After verification, drop the legacy tables yourself:
  DROP TABLE skills;
  DROP TABLE skill_categories;

Deviations from the PHP source:
  - PHP's `$dbConfig = $config['contexts_database'] ?? $config['database'] ??
    null; if (!$dbConfig) { ...exit(1); }` guard has no reachable equivalent
    here: this port's `load_config()` always populates both keys (or raises
    `ConfigError` first for missing required env vars) — see `main()`.
  - PHP never wraps `new PDO(...)` in try/catch for this script, so a
    connection failure is an UNCAUGHT PDOException -> PHP CLI's fatal-error
    handler prints a trace and exits **255**. This module reproduces that
    exit code via the `run()` wrapper at the bottom (`__main__` calls
    `run()`, not `main()`) rather than Python's default exit(1) for an
    uncaught exception, since "same exit codes" is an explicit constraint.
  - `strlen($output)` (PHP, byte length) is ported as
    `len(output.encode('utf-8'))`, not `len(output)` (char length).
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import traceback
from pathlib import Path

from app.config import ConfigError, load_config
from app.db import Db
from app.support.phpcompat import is_php_array, php_coalesce, php_empty, php_intval, php_strval, php_trim, php_values
from app.support.phpjson import php_json_decode

_SLUG_STRIP_RE = re.compile(r'[^a-z0-9\-_]+', re.IGNORECASE)
_SLUG_DASH_RE = re.compile(r'-+')
_FRONTMATTER_RE = re.compile(r'^---\s*\n.*?\n---\s*\n', re.DOTALL)
_YML_ESCAPE_RE = re.compile(r'[:#\[\]\{\}\&\*!\|\>\'"%@`\n]')


def slugify(name: str) -> str:
    """PHP `slugify()` (migrate-skills-to-fs.php ~190-196)."""
    s = php_trim(name).lower()
    s = _SLUG_STRIP_RE.sub('-', s)
    s = _SLUG_DASH_RE.sub('-', s)
    return s.strip('-_')


def json_or_null(v):
    """PHP `jsonOrNull()` (~198-204)."""
    if v is None or v == '':
        return None
    if is_php_array(v):
        return v
    decoded = php_json_decode(str(v))
    return decoded if is_php_array(decoded) else None


def yml_string(s: str) -> str:
    """PHP `ymlString()` (~206-214)."""
    if _YML_ESCAPE_RE.search(s):
        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return s


def yml_array(a) -> str:
    """PHP `ymlArray()` (~216-219)."""
    return '[' + ', '.join(yml_string(str(x)) for x in php_values(a)) + ']'


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='migrate_skills_to_fs', add_help=False)
    parser.add_argument('--dry-run', action='store_true', dest='dry_run')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--user-id', dest='user_id', default=None)
    parser.add_argument('--target', dest='target', default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args, _unknown = _build_arg_parser().parse_known_args(
        argv if argv is not None else sys.argv[1:]
    )

    dry_run = args.dry_run
    force = args.force
    user_id = php_intval(args.user_id) if args.user_id is not None else None
    target_dir = args.target.rstrip('/') if args.target is not None else None

    if target_dir is None:
        home = os.environ.get('HOME', '')
        if home == '':
            print("ERROR: cannot resolve $HOME; pass --target /abs/path", file=sys.stderr)
            return 1
        target_dir = home + '/Documents/synergyAI/skills'

    try:
        config = load_config()
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        return 1

    # PHP: $dbConfig = $config['contexts_database'] ?? $config['database'] ??
    # null; no reachable failure path once load_config() has succeeded (see
    # module docstring) — kept as a direct index for structural parity.
    db_config = php_coalesce(config.get('contexts_database'), config.get('database'))

    # PHP has no try/catch around `new PDO(...)` here — an uncaught
    # PDOException is a PHP fatal error (exit 255). Left to propagate to
    # `run()`, which reproduces that exit code (see module docstring).
    db = Db.connect(db_config)
    try:
        return _run(db, dry_run, force, user_id, target_dir)
    finally:
        db.close()


def _run(db, dry_run: bool, force: bool, user_id: int | None, target_dir: str) -> int:
    sql = (
        "SELECT s.id, s.user_id, s.name, s.description, s.version, s.skill_content,\n"
        "               s.default_tools, s.tags, s.visibility, s.enabled,\n"
        "               c.name AS category_name\n"
        "        FROM skills s\n"
        "        LEFT JOIN skill_categories c ON c.id = s.category_id"
    )
    params = None
    if user_id is not None:
        sql += "\n        WHERE s.user_id = :uid"
        params = {'uid': user_id}
    sql += "\n        ORDER BY s.id ASC"

    rows = db.fetch_all(sql, params)

    if not rows:
        suffix = f" for user_id={user_id}" if user_id is not None else ''
        print(f"No skills found{suffix}. Nothing to migrate.")
        return 0

    prefix = '[DRY-RUN] ' if dry_run else ''
    print(f"{prefix}Found {len(rows)} skill(s) to migrate to {target_dir}")

    if not dry_run:
        try:
            Path(target_dir).mkdir(parents=True, exist_ok=True)
        except OSError:
            print(f"ERROR: failed to create target dir {target_dir}", file=sys.stderr)
            return 1

    ok = 0
    skipped = 0
    failed = 0

    for row in rows:
        slug = slugify(str(row['name']))
        if slug == '':
            slug = f"skill-{row['id']}"
        skill_dir = f"{target_dir}/{slug}"
        skill_md_path = f"{skill_dir}/SKILL.md"

        if Path(skill_dir).is_dir() and not force:
            print(f"  SKIP id={row['id']} '{row['name']}' — folder exists at {skill_dir} "
                  "(use --force to overwrite)")
            skipped += 1
            continue

        tools = json_or_null(row.get('default_tools'))
        tags = json_or_null(row.get('tags'))

        frontmatter = "---\n"
        # PHP `?:` (Elvis, falsy-check) here, `!empty()` below — NOT `??` —
        # so an explicit '0' or '' value is treated the same as absent;
        # php_empty() (not a Python truthy check) reproduces that.
        frontmatter += "name: " + yml_string(row['name'] if not php_empty(row['name']) else slug) + "\n"
        if not php_empty(row.get('description')):
            frontmatter += "description: " + yml_string(row['description']) + "\n"
        if not php_empty(row.get('version')):
            frontmatter += "version: " + yml_string(row['version']) + "\n"
        if is_php_array(tools) and tools != []:
            frontmatter += "default_tools: " + yml_array(tools) + "\n"
        if is_php_array(tags) and tags != []:
            frontmatter += "tags: " + yml_array(tags) + "\n"
        if not php_empty(row.get('visibility')):
            frontmatter += "visibility: " + yml_string(row['visibility']) + "\n"
        if not php_empty(row.get('category_name')):
            frontmatter += "category: " + yml_string(row['category_name']) + "\n"
        frontmatter += f"legacy_skill_id: {php_intval(row['id'])}\n"
        frontmatter += "---\n\n"

        body = php_strval(row.get('skill_content'))
        if _FRONTMATTER_RE.match(body):
            output = body
        else:
            output = frontmatter + body

        if dry_run:
            print(f"  WOULD WRITE id={row['id']} '{row['name']}' → {skill_md_path} "
                  f"({len(output.encode('utf-8'))} bytes)")
            ok += 1
            continue

        try:
            Path(skill_dir).mkdir(parents=True, exist_ok=True)
        except OSError:
            print(f"  FAIL id={row['id']} — could not create {skill_dir}", file=sys.stderr)
            failed += 1
            continue

        try:
            Path(skill_md_path).write_text(output, encoding='utf-8')
        except OSError:
            print(f"  FAIL id={row['id']} — could not write {skill_md_path}", file=sys.stderr)
            failed += 1
            continue

        print(f"  OK   id={row['id']} '{row['name']}' → {skill_md_path}")
        ok += 1

    prefix = '[DRY-RUN] ' if dry_run else ''
    print(f"\n{prefix}Done — {ok} migrated, {skipped} skipped, {failed} failed.")
    if not dry_run:
        print(f"Verify the folders under {target_dir} look right, refresh the app's Skills "
              "sidebar, then drop the legacy tables:")
        print("  DROP TABLE skills;")
        print("  DROP TABLE skill_categories;")

    return 0


def run(argv: list[str] | None = None) -> None:
    """Entry point used by `__main__`: reproduces PHP's uncaught-exception
    exit code (255) for the DB-connect failure this module deliberately
    does not catch (see module docstring)."""
    try:
        sys.exit(main(argv))
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — mirrors PHP CLI's fatal-error handler
        traceback.print_exc()
        sys.exit(255)


if __name__ == '__main__':
    run()
