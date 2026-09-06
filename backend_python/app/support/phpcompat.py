"""Small PHP built-in equivalents used by the ported controllers."""
from __future__ import annotations

import base64
import os
import random
import re
import time
import zlib
from datetime import datetime
from zoneinfo import ZoneInfo

_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$"
)


def php_tz() -> ZoneInfo:
    return ZoneInfo(os.environ.get('PHP_TIMEZONE', 'Europe/Berlin'))


def php_now() -> str:
    """date('Y-m-d H:i:s') in PHP's configured timezone."""
    return datetime.now(php_tz()).strftime('%Y-%m-%d %H:%M:%S')


def ucfirst(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def is_numeric(v) -> bool:
    """PHP is_numeric(): ints/floats (not bool), or numeric strings (leading whitespace allowed)."""
    if isinstance(v, bool) or v is None:
        return False
    if isinstance(v, (int, float)):
        return True
    if isinstance(v, str):
        return re.fullmatch(r'\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', v) is not None
    return False


def validate_email(s: str) -> bool:
    """Approximation of filter_var($s, FILTER_VALIDATE_EMAIL) (see parity tracker)."""
    return bool(s) and len(s) <= 254 and _EMAIL_RE.match(s) is not None


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4))


def mb_substr(s: str, start: int, length: int | None = None) -> str:
    return s[start:] if length is None else s[start:start + length]


def php_intval(v) -> int:
    """PHP (int) cast: numeric string -> truncated int (e.g. "12.5" -> 12, "1e3" -> 1000),
    non-numeric string -> 0, int/float/bool -> int(v)."""
    if isinstance(v, str):
        return int(float(v)) if is_numeric(v) else 0
    if isinstance(v, (int, float)):
        return int(v)
    return 0


def php_empty(v) -> bool:
    """PHP empty(): None, '', '0', 0, 0.0, False, and empty list/dict are empty."""
    if v is None or v is False:
        return True
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v == 0
    if isinstance(v, str):
        return v == '' or v == '0'
    if isinstance(v, (list, dict, tuple, set)):
        return len(v) == 0
    return False


def php_date(fmt: str) -> str:
    """Subset of PHP date(): Y-m-d, l, Y-m, Y-m-d H:i:s, in PHP's timezone."""
    now = datetime.now(php_tz())
    table = {'Y-m-d': '%Y-%m-%d', 'l': '%A', 'Y-m': '%Y-%m', 'Y-m-d H:i:s': '%Y-%m-%d %H:%M:%S'}
    if fmt not in table:
        raise ValueError(f'unsupported php_date format: {fmt}')
    return now.strftime(table[fmt])


def php_uniqid(prefix: str = '', more_entropy: bool = False) -> str:
    t = time.time()
    sec, usec = int(t), int((t - int(t)) * 1_000_000)
    out = f'{prefix}{sec:08x}{usec:05x}'
    if more_entropy:
        out += f'.{random.randint(0, 99999999):08d}'
    return out


def php_crc32(s: str) -> int:
    return zlib.crc32(s.encode('utf-8')) & 0xFFFFFFFF


def php_strval(v) -> str:
    """PHP strval() / (string) cast: None -> '', True -> '1', False -> '',
    floats through the default precision=14 formatting (1.0 -> '1',
    1/3 -> '0.33333333333333'), arrays -> 'Array'.

    Bare str() differs on exactly the cases that matter for a JSON-decoded
    payload (booleans and integral floats), which is why the ported
    array_map('strval', ...) calls go through here.
    """
    if v is None:
        return ''
    if isinstance(v, bool):
        return '1' if v else ''
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return 'NAN'
        if v == float('inf'):
            return 'INF'
        if v == float('-inf'):
            return '-INF'
        return '%.14G' % v
    if isinstance(v, str):
        return v
    if isinstance(v, (list, dict, tuple, set)):
        return 'Array'
    return str(v)


def php_bool(v) -> bool:
    """PHP (bool) cast: '' , '0', 0, 0.0, None, False, and empty list/dict/tuple/set are falsy;
    everything else (including non-'0' strings like "0.0") is truthy."""
    return not php_empty(v)
