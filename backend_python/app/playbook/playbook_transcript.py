"""Port of backend/src/Playbook/PlaybookTranscript.php (30 lines)."""
from __future__ import annotations

import json
import os

from app.support.phpcompat import php_date
from app.support.phpjson import dumps as _json_dumps


class PlaybookTranscript:
    def __init__(self, dir: str):
        self.dir = dir

    def append(self, runId: int, event: dict) -> None:
        event = dict(event)
        event['ts'] = php_date('c')
        line = _json_dumps(event) + "\n"
        path = self._path(runId)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line)

    def read(self, runId: int) -> list:
        path = self._path(runId)
        if not os.path.isfile(path):
            return []
        events = []
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\n')
                if line == '':
                    continue
                try:
                    events.append(json.loads(line))
                except ValueError:
                    events.append(None)
        return events

    def _path(self, runId: int) -> str:
        return self.dir.rstrip('/') + '/playbook-' + str(runId) + '.jsonl'
