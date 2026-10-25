"""Port of backend/src/AgentTeam/Services/PlaybookSource.php.

Playbook node "from input": the parent's output (JSON) names the playbook key;
it resolves to the robot's published copy, never the owner's draft.
"""
from __future__ import annotations

import json
import re

from app.playbook.playbook_store import PlaybookStore
from app.services.robot_account import RobotAccount
from app.support.phpcompat import php_strval, php_trim

_HEADER_RE = re.compile(r'\A## [^\n]*\n')
_LTRIM = ' \t\n\r\0\x0b'


def _json_object_or_none(text: str):
    """json_decode($text) when it is a JSON object (stdClass), else None. Python's
    json also reads NaN/Infinity, which PHP refuses: refused here too."""
    def _no_constant(c):
        raise ValueError(c)
    try:
        data = json.loads(text, parse_constant=_no_constant)
    except (ValueError, TypeError):
        return None
    return data


class PlaybookSource:
    @staticmethod
    def isFromInput(nodeConfig: dict) -> bool:
        v = nodeConfig.get('playbook_source')
        return (v if v is not None else 'fixed') == 'input'

    @staticmethod
    def _stripHeader(parentText: str) -> str:
        """The parent's text without its leading "## <name>" header line, trimmed."""
        return php_trim(_HEADER_RE.sub('', parentText.lstrip(_LTRIM), count=1))

    @staticmethod
    def jobLine(parentText: str) -> str | None:
        """"Job: <compact JSON>" when the parent's text (header stripped) is a JSON object, else None.
        Downstream complete/hand-back nodes read the last line starting with "Job: "."""
        data = _json_object_or_none(PlaybookSource._stripHeader(parentText))
        if not isinstance(data, dict):
            return None
        return 'Job: ' + json.dumps(data, ensure_ascii=False, separators=(',', ':'))

    @staticmethod
    def fromInput(db, ownerId: int, nodeConfig: dict, parentText: str) -> dict:
        """{'ok': True, 'key', 'text'} or {'ok': False, 'reason'}."""
        field = nodeConfig.get('playbook_input_field')
        field = field if field is not None else 'playbook'
        field = field if isinstance(field, str) and field != '' else 'playbook'
        data = _json_object_or_none(PlaybookSource._stripHeader(parentText))
        key = data.get(field) if isinstance(data, dict) else None
        if not isinstance(key, str) or not PlaybookStore.isValidKey(key):
            return {'ok': False, 'reason': 'bad_input'}
        store = PlaybookStore(db)
        robotId = RobotAccount.id(db)
        row = None if robotId is None else store.getByKey(robotId, key)
        if row is not None:
            return {'ok': True, 'key': key, 'text': php_strval(row.get('text'))}
        why = 'playbook_not_published:' if store.getByKey(ownerId, key) is not None else 'playbook_not_found:'
        return {'ok': False, 'reason': why + key}
