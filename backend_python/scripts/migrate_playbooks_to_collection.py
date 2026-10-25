"""Port of backend/scripts/migrate_playbooks_to_collection.php.

    cd backend_python && .venv/bin/python -m scripts.migrate_playbooks_to_collection [--write]

Moves playbook text from playbook agents and playbook nodes into the playbook collection (the CONTEXTS database).
Without --write it is a dry run: it prints the report and changes nothing.
"""
from __future__ import annotations

import json
import sys

from app.config import load_config
from app.db import Db
from app.playbook.playbook_migration import PlaybookMigration


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    config = load_config()
    db = Db.connect(config['contexts_database'])
    try:
        write = '--write' in argv
        report = PlaybookMigration(db).run(write)
        print('WRITTEN' if write else 'DRY RUN (nothing written; add --write)')
        print(json.dumps(report, indent=4, ensure_ascii=False))
    finally:
        db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
