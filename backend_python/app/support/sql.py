"""PDO placeholder syntax → PyMySQL. The PHP code is ported with its SQL verbatim
(`?` and `:name`); this shim keeps the queries diffable against the PHP source."""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

# `:name` not preceded by a word char or another colon, and not inside quotes.
_NAMED = re.compile(r"(?<![\w:]):([A-Za-z_]\w*)")
_SPLIT_QUOTES = re.compile(r"('(?:[^']|'')*')")


def _outside_quotes(sql: str, fn) -> str:
    parts = _SPLIT_QUOTES.split(sql)
    return ''.join(p if i % 2 else fn(p) for i, p in enumerate(parts))


def translate(sql: str, params=None):
    if params is None:
        return sql, None
    sql = sql.replace('%', '%%')
    if isinstance(params, Mapping):
        clean = {k.lstrip(':'): v for k, v in params.items()}
        return _outside_quotes(sql, lambda s: _NAMED.sub(r'%(\1)s', s)), clean
    if isinstance(params, Sequence) and not isinstance(params, (str, bytes)):
        return _outside_quotes(sql, lambda s: s.replace('?', '%s')), list(params)
    raise TypeError(f'unsupported params type: {type(params)!r}')
