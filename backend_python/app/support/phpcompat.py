"""Small PHP built-in equivalents used by the ported controllers."""
from __future__ import annotations

import base64
import calendar
import os
import random
import re
import time
import zlib
from datetime import datetime, timedelta
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


_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
           'August', 'September', 'October', 'November', 'December']


def _now(tz) -> datetime:
    """Seam for tests to freeze time (monkeypatch this module attribute);
    production always uses the real clock."""
    return datetime.now(tz)


def _php_date_char(ch: str, dt: datetime) -> str:
    """One PHP date() format character, English/locale-independent (PHP's
    date() is never locale-aware — that's date_format with an Intl formatter)."""
    if ch == 'd':
        return f'{dt.day:02d}'
    if ch == 'D':
        return _DAYS[dt.weekday()][:3]
    if ch == 'j':
        return str(dt.day)
    if ch == 'l':
        return _DAYS[dt.weekday()]
    if ch == 'N':
        return str(dt.isoweekday())
    if ch == 'S':
        day = dt.day
        if 11 <= day % 100 <= 13:
            return 'th'
        return {1: 'st', 2: 'nd', 3: 'rd'}.get(day % 10, 'th')
    if ch == 'w':
        return str(dt.isoweekday() % 7)
    if ch == 'z':
        return str(dt.timetuple().tm_yday - 1)
    if ch == 'W':
        return f'{dt.isocalendar()[1]:02d}'
    if ch == 'F':
        return _MONTHS[dt.month - 1]
    if ch == 'm':
        return f'{dt.month:02d}'
    if ch == 'M':
        return _MONTHS[dt.month - 1][:3]
    if ch == 'n':
        return str(dt.month)
    if ch == 't':
        return str(calendar.monthrange(dt.year, dt.month)[1])
    if ch == 'L':
        y = dt.year
        return '1' if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else '0'
    if ch == 'o':
        return str(dt.isocalendar()[0])
    if ch == 'Y':
        return str(dt.year)
    if ch == 'y':
        return f'{dt.year % 100:02d}'
    if ch == 'a':
        return 'am' if dt.hour < 12 else 'pm'
    if ch == 'A':
        return 'AM' if dt.hour < 12 else 'PM'
    if ch == 'g':
        h = dt.hour % 12
        return str(h if h != 0 else 12)
    if ch == 'G':
        return str(dt.hour)
    if ch == 'h':
        h = dt.hour % 12
        return f'{(h if h != 0 else 12):02d}'
    if ch == 'H':
        return f'{dt.hour:02d}'
    if ch == 'i':
        return f'{dt.minute:02d}'
    if ch == 's':
        return f'{dt.second:02d}'
    if ch == 'u':
        return f'{dt.microsecond:06d}'
    if ch == 'v':
        return f'{dt.microsecond // 1000:03d}'
    if ch == 'e':
        tz = dt.tzinfo
        return getattr(tz, 'key', str(tz))
    if ch == 'I':
        dst = dt.dst()
        return '1' if dst and dst.total_seconds() != 0 else '0'
    if ch == 'O':
        off = dt.utcoffset() or timedelta(0)
        total_minutes = int(off.total_seconds() // 60)
        sign = '+' if total_minutes >= 0 else '-'
        total_minutes = abs(total_minutes)
        return f'{sign}{total_minutes // 60:02d}{total_minutes % 60:02d}'
    if ch == 'P':
        o = _php_date_char('O', dt)
        return o[:3] + ':' + o[3:]
    if ch == 'T':
        return dt.strftime('%Z')
    if ch == 'Z':
        off = dt.utcoffset() or timedelta(0)
        return str(int(off.total_seconds()))
    if ch == 'c':
        return php_date('Y-m-d\\TH:i:sP', dt=dt)
    if ch == 'r':
        return php_date('D, d M Y H:i:s O', dt=dt)
    if ch == 'U':
        return str(int(dt.timestamp()))
    raise KeyError(ch)


def php_date(fmt: str, dt: datetime | None = None, tz: ZoneInfo | None = None) -> str:
    """PHP date(): every format character PHP's date() recognizes (English
    names/abbreviations always — PHP's date() is locale-independent). Only
    letters are ever reserved format characters in PHP's date(); any
    non-letter (punctuation, digits, spaces) always passes through literally,
    exactly like PHP. `\\` (backslash-escape) additionally forces the next
    character through literally, for a literal letter that would otherwise
    be read as a format code (e.g. 'Y-m-d\\TH:i:sP' for the 'c' shorthand).
    `dt` lets callers/tests pass an explicit moment (e.g. a frozen "now");
    otherwise this uses `_now(tz or php_tz())` so tests can monkeypatch
    `_now` instead of the real clock. A *letter* PHP reserves that this port
    hasn't implemented raises ValueError rather than silently emitting the
    wrong text (real PHP would still just echo an unrecognized letter back)."""
    if dt is None:
        dt = _now(tz or php_tz())
    elif tz is not None and dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    out = []
    i = 0
    n = len(fmt)
    while i < n:
        c = fmt[i]
        if c == '\\' and i + 1 < n:
            out.append(fmt[i + 1])
            i += 2
            continue
        if not c.isalpha():
            out.append(c)
            i += 1
            continue
        try:
            out.append(_php_date_char(c, dt))
        except KeyError:
            raise ValueError(f'unsupported php_date format: {fmt}')
        i += 1
    return ''.join(out)


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


def php_array(d):
    """PHP arrays are ordered maps: a string-keyed one json_encodes as an object,
    but an EMPTY one encodes as `[]`, not `{}`. Apply wherever PHP hands such a
    map straight to json_encode so the wire shape matches on both backends."""
    return d if d else []


def php_coalesce(*values):
    """PHP `??` chain: the first argument that `is not None`, else `None`
    (never a truthiness check — `0`/`''`/`[]`/`False` all pass through)."""
    for v in values:
        if v is not None:
            return v
    return None


def php_array_cast(v):
    """PHP `(array)$v` cast. PHP semantics (this port never receives PHP
    *objects* here — every input already came through json_decode(..., true)
    or plain Python values — so the object-to-property-array branch of the
    real cast doesn't apply):
      - already a PHP array (dict OR list, since json_decode(..., true)
        makes no list/assoc distinction) -> itself, unchanged
      - null -> [] (an empty array)
      - any scalar (str/int/float/bool) -> a single-element array [v] (PHP
        wraps a lone scalar at integer key 0)
    """
    if isinstance(v, (dict, list)):
        return v
    if v is None:
        return []
    return [v]


def is_php_array(v) -> bool:
    """PHP is_array(): true for anything that came out of json_decode(..., true)
    as an array — which covers BOTH a JSON list and a JSON object, since PHP's
    assoc-mode decode does not distinguish them. Only apply php_array() to a
    value that actually went through this decode step; a value you are
    DEFAULTING in (key absent/null) is not a decoded PHP array and must not
    be routed through php_array() — see tools_controller.classifyIntent's
    `args` default (`?? new \\stdClass()` -> `{}`, never `[]`)."""
    return isinstance(v, (list, dict))


def php_values(v) -> list:
    """`foreach ($v as $item)` over a JSON-decoded PHP array — iterates VALUES
    only (ignoring string/int keys), for both a JSON list and a JSON object."""
    if isinstance(v, dict):
        return list(v.values())
    if isinstance(v, list):
        return v
    return []


def php_items(v) -> list:
    """`foreach ($v as $k => $v)` over a JSON-decoded PHP array — a JSON
    object yields its (key, value) pairs, a JSON list yields (index, value)
    pairs, anything else yields nothing."""
    if isinstance(v, dict):
        return list(v.items())
    if isinstance(v, list):
        return list(enumerate(v))
    return []


_FLOAT_PREFIX = re.compile(r'\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?')


def php_floatval(v) -> float:
    """PHP (float) cast: numeric string -> float, leading-numeric prefix -> that prefix
    ("12abc" -> 12.0), anything else -> 0.0."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = _FLOAT_PREFIX.match(v)
        return float(m.group(0)) if m else 0.0
    return 0.0


PHP_TRIM_CHARS = ' \t\n\r\x00\x0b'


def php_trim(v, chars: str = PHP_TRIM_CHARS) -> str:
    """PHP trim(): coerces its argument like a string cast (None -> '', True -> '1',
    False -> '', numbers via php_strval) and strips ONLY PHP's default charlist
    " \\t\\n\\r\\0\\x0B" — never Python's much wider Unicode whitespace set, so
    e.g. a NBSP-padded value survives here exactly as it does in PHP.

    PHP 8 raises `TypeError: trim(): Argument #1 ($string) must be of type string,
    array given` for array arguments; so does this, and index.php's `catch (Throwable)`
    and main.py's `except Exception` both turn that into the same 500.
    """
    if isinstance(v, (list, dict, tuple, set)):
        raise TypeError('trim(): Argument #1 ($string) must be of type string, array given')
    return php_strval(v).strip(chars)


def php_loose_eq(a, b) -> bool:
    """PHP 8 `==` for the value shapes that reach WorkflowRunner::
    evaluateCondition (WorkflowRunner.php 278-291): JSON-decoded scalars/
    None/list/dict pulled from workflow variables, or a raw condition-string
    literal. Not a full PHP comparison-table implementation (object/resource
    comparisons don't apply here) but covers bool/null/numeric-string/array
    comparisons per the PHP 8 rules:
      - either operand bool -> compare bool(a) == bool(b)
      - either operand null -> convert null to the other operand's "zero
        value" (0, '', [], or bool false) and compare
      - both arrays -> same key set, each value loosely equal (recursive)
      - one array, one scalar -> never equal
      - both numeric (int/float/numeric-string) -> compare as numbers
      - otherwise -> string comparison

    C2 (Phase 5 final-review wave): moved here from
    `WorkflowRunner._php_loose_eq` (a private module function there) so
    other callers can share it.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return php_bool(a) == php_bool(b)
    if a is None or b is None:
        if a is None and b is None:
            return True
        other = b if a is None else a
        if isinstance(other, (int, float)):
            return php_floatval(other) == 0.0
        if isinstance(other, str):
            return other == ''
        if isinstance(other, (list, dict)):
            return php_loose_eq([], other)
        return False
    a_arr = isinstance(a, (list, dict))
    b_arr = isinstance(b, (list, dict))
    if a_arr or b_arr:
        if not (a_arr and b_arr):
            return False
        da = a if isinstance(a, dict) else dict(enumerate(a))
        db = b if isinstance(b, dict) else dict(enumerate(b))
        if len(da) != len(db):
            return False
        for k, v in da.items():
            if k not in db or not php_loose_eq(v, db[k]):
                return False
        return True
    if is_numeric(a) and is_numeric(b):
        return php_floatval(a) == php_floatval(b)
    return php_strval(a) == php_strval(b)


def php_loose_cmp(a, b) -> int:
    """PHP 8 loose comparison of `a` vs `b`, restricted to the types that
    reach the alert-price sites: None, int, float, Decimal-as-str, numeric
    strings, and plain strings (WatchlistFunctions.php ~24/28: `$a >= $b` /
    `$a <= $b` on DB-sourced DECIMAL/None values). Returns -1/0/1.

    Rules (PHP 8 comparison table): bool operand -> compare as bool; None ->
    treated as '' then falls through to the string rules; both operands
    numeric (int/float/numeric-string) -> compare as float; otherwise ->
    lexical string comparison (this reproduces PHP's `null <= '9.00'` =>
    true quirk, since '' sorts below any non-empty string).

    C2 (Phase 5 final-review wave): moved here from
    `watchlist_functions._php_loose_cmp` (a private module function there)
    so other callers can share it.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        ab, bb = bool(a), bool(b)
        return (ab > bb) - (ab < bb)
    if a is None:
        a = ''
    if b is None:
        b = ''
    a_numeric = isinstance(a, (int, float)) or (isinstance(a, str) and is_numeric(a))
    b_numeric = isinstance(b, (int, float)) or (isinstance(b, str) and is_numeric(b))
    if a_numeric and b_numeric:
        af, bf = float(a), float(b)
        return (af > bf) - (af < bf)
    astr, bstr = str(a), str(b)
    return (astr > bstr) - (astr < bstr)


_STR_WORD_COUNT_RE = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*")


def str_word_count(s: str) -> int:
    """Approximation of PHP's str_word_count() default mode (word count
    only). PHP's own implementation is a locale-dependent C routine; this
    is a documented approximation (ASCII letters, with an internal
    apostrophe/hyphen allowed), not an exact reproduction — good enough for
    diagnostic-only counts (e.g. AgentDelegationFunctions.php:354's
    `result_word_count` field), not for anything asserted byte-for-byte
    against PHP.

    C4 (Phase 5 final-review wave): moved here from
    `agent_delegation_functions._str_word_count` (a private module function
    there) so other callers can share it.
    """
    return len(_STR_WORD_COUNT_RE.findall(s))
