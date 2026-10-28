"""PHP built-ins as the compilers use them, for byte-identical generated code.

The compile targets (LangGraph and the shared Compiled* emitters) build Python
source text from PHP arrays. Their ports keep PHP's data model:

- a Python ``dict`` is a PHP array with keys; an EMPTY one encodes as JSON ``[]``
  and one keyed "0", "1", ... "n-1" encodes as a JSON list, exactly as PHP's
  json_encode() sees such an array;
- ``PhpObj`` (a dict) is a stdClass or an ``(object)`` cast: always a JSON object;
- a ``list`` is a PHP list.

Floats encode under serialize_precision=-1 (the compilers set it), i.e. the
shortest round-trip digits with PHP's notation rules (``1.0`` -> ``1``).
"""
from __future__ import annotations

import json
import re
import unicodedata

from app.agent_team.services.python_emit_helpers import _phpFloatToken

PHP_TRIM = ' \t\n\r\x00\x0b'


class PhpObj(dict):
    """A stdClass / ``(object)`` cast: json_encode() always writes a JSON object."""


def obj(value) -> PhpObj:
    """PHP ``(object) $array``: a list becomes an object keyed "0", "1", ..."""
    if isinstance(value, PhpObj):
        return value
    if isinstance(value, list):
        return PhpObj((str(i), v) for i, v in enumerate(value))
    if isinstance(value, dict):
        return PhpObj(value)
    return PhpObj() if value is None else PhpObj({'scalar': value})


def array_values(value) -> list:
    """PHP ``array_values($value ?? [])``: a list as is, a keyed array's values in order."""
    if value is None:
        return []
    return list(value.values()) if isinstance(value, dict) else list(value)


def is_list_like(d: dict) -> bool:
    """A PHP array json_encode() writes as a list: keys 0..n-1 in order."""
    for i, k in enumerate(d):
        if str(k) != str(i) or (isinstance(k, str) and not re.fullmatch(r'0|[1-9][0-9]*', k)):
            return False
    return True


def _str(s: str, slashes: bool, unicode: bool) -> str:
    out = json.dumps(s, ensure_ascii=not unicode)
    if unicode:
        out = out.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    if not slashes:
        out = out.replace('/', '\\/')
    return out


def json_encode(value, slashes: bool = False, unicode: bool = False, pretty: bool = False,
                _level: int = 0) -> str:
    """PHP json_encode($value, flags): slashes = JSON_UNESCAPED_SLASHES, unicode =
    JSON_UNESCAPED_UNICODE, pretty = JSON_PRETTY_PRINT."""
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, float):
        return _phpFloatToken(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _str(value, slashes, unicode)
    if isinstance(value, tuple):
        value = list(value)
    nl = '\n' + '    ' * (_level + 1) if pretty else ''
    end = '\n' + '    ' * _level if pretty else ''
    if isinstance(value, dict):
        if not isinstance(value, PhpObj) and is_list_like(value):
            value = list(value.values())
        else:
            if not value:
                return '{}'
            sep = ': ' if pretty else ':'
            parts = [_str(str(k), slashes, unicode) + sep + json_encode(v, slashes, unicode, pretty, _level + 1)
                     for k, v in value.items()]
            return '{' + nl + (',' + nl).join(parts) + end + '}'
    if isinstance(value, list):
        if not value:
            return '[]'
        parts = [json_encode(v, slashes, unicode, pretty, _level + 1) for v in value]
        return '[' + nl + (',' + nl).join(parts) + end + ']'
    raise TypeError(f'json_encode: unsupported type {type(value)!r}')


def j(value) -> str:
    """json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)."""
    return json_encode(value, slashes=True, unicode=True)


def json_decode_obj(raw):
    """json_decode($raw) (objects as stdClass): dicts become PhpObj; None when invalid."""
    def conv(v):
        if isinstance(v, dict):
            return PhpObj((k, conv(x)) for k, x in v.items())
        if isinstance(v, list):
            return [conv(x) for x in v]
        return v
    try:
        return conv(json.loads(raw))
    except (ValueError, TypeError):
        return None


def json_decode_assoc(raw):
    """json_decode($raw, true): None when invalid (objects are dicts)."""
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def strval(v) -> str:
    """(string) $v for the scalars the compilers cast."""
    if v is None or v is False:
        return ''
    if v is True:
        return '1'
    if isinstance(v, float):
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return repr(v)
    return str(v)


def var_export_float(v: float) -> str:
    """var_export((float) $v, true): shortest digits, always with a decimal point."""
    s = repr(float(v))
    if 'e' in s or 'E' in s:
        mant, exp = s.split('e')
        if '.' not in mant:
            mant += '.0'
        return mant + 'E' + (exp if exp.startswith('-') else '+' + exp.lstrip('+'))
    return s


def ucfirst(s: str) -> str:
    return s[:1].upper() + s[1:] if s and 'a' <= s[0] <= 'z' else s


def ucwords(s: str) -> str:
    """ucwords(): uppercase the first ASCII letter after each space/tab/newline (and at the start)."""
    out = []
    prev = ' '
    for ch in s:
        out.append(ch.upper() if prev in ' \t\r\n\f\v' and 'a' <= ch <= 'z' else ch)
        prev = ch
    return ''.join(out)


def sprintf_pad(s: str, width: int, left: bool = True) -> str:
    """sprintf('%-Ns' / '%Ns', $s): PHP pads by BYTES, not characters."""
    n = len(s.encode('utf-8'))
    pad = ' ' * max(0, width - n)
    return s + pad if left else pad + s


def strlen(s: str) -> int:
    """strlen(): bytes."""
    return len(s.encode('utf-8'))


def str_pad_bytes(s: str, width: int) -> str:
    return sprintf_pad(s, width)


# iconv('UTF-8', 'ASCII//TRANSLIT') spellings that Unicode decomposition does not give.
_TRANSLIT = {
    '\u2014': '-', '\u2013': '-', '\u2012': '-', '\u2010': '-', '\u2011': '-', '\u2212': '-',
    '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201c': '"', '\u201d': '"', '\u201e': '"',
    '\u2026': '...', '\u00a0': ' ', '\u00df': 'ss', '\u00e6': 'ae', '\u00c6': 'AE', '\u0153': 'oe',
    '\u0152': 'OE', '\u00f8': 'o', '\u00d8': 'O', '\u0142': 'l', '\u0141': 'L', '\u0111': 'd',
    '\u0110': 'D', '\u00f0': 'd', '\u00fe': 'th', '\u00de': 'TH', '\u20ac': 'EUR', '\u00a9': '(C)',
    '\u00ae': '(R)', '\u2122': '(TM)', '\u00ab': '<<', '\u00bb': '>>', '\u2022': 'o', '\u00b7': '.',
}


def ascii_translit(s: str) -> str:
    """iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) for the names the compilers slug.

    macOS/glibc iconv spells an accented letter as the letter plus a mark ("'e"); the
    callers strip those marks right after, so the base letter is what counts here.
    """
    out = []
    for ch in s:
        if ord(ch) < 128:
            out.append(ch)
        elif ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        else:
            base = unicodedata.normalize('NFKD', ch).encode('ascii', 'ignore').decode('ascii')
            out.append(base if base else '?')
    return ''.join(out)


def wordwrap(text: str, width: int, brk: str = '\n', cut: bool = False) -> str:
    """wordwrap($text, $width, $break, $cut), byte-oriented like PHP's (ext/standard/string.c)."""
    if text == '':
        return text
    b = text.encode('utf-8')
    brk_b = brk.encode('utf-8')
    n = len(b)
    if len(brk_b) == 1 and not cut:
        out = bytearray(b)
        laststart = lastspace = 0
        bc = brk_b[0]
        for current in range(n):
            if b[current] == bc:
                laststart = lastspace = current + 1
            elif b[current] == 0x20:
                if current - laststart >= width:
                    out[current] = bc
                    laststart = current + 1
                lastspace = current
            elif current - laststart >= width and laststart != lastspace:
                out[lastspace] = bc
                laststart = lastspace + 1
        return bytes(out).decode('utf-8', errors='replace')
    chunks = []
    laststart = lastspace = 0
    current = 0
    while current < n:
        ch = b[current:current + 1]
        if ch == brk_b[:1] and b[current:current + len(brk_b)] == brk_b and current + len(brk_b) < n:
            chunks.append(b[laststart:current + len(brk_b)])
            current += len(brk_b) - 1
            laststart = lastspace = current + 1
        elif ch == b' ':
            if current - laststart >= width:
                chunks.append(b[laststart:current])
                chunks.append(brk_b)
                laststart = current + 1
            lastspace = current
        elif current - laststart >= width and cut and laststart >= lastspace:
            chunks.append(b[laststart:current])
            chunks.append(brk_b)
            laststart = lastspace = current
        elif current - laststart >= width and laststart < lastspace:
            chunks.append(b[laststart:lastspace])
            chunks.append(brk_b)
            laststart = lastspace = lastspace + 1
        current += 1
    if laststart != current:
        chunks.append(b[laststart:current])
    return b''.join(chunks).decode('utf-8', errors='replace')


def preg_quote(s: str) -> str:
    return re.sub(r'([.\\+*?\[^\]$(){}=!<>|:\-#/])', r'\\\1', s)


def str_replace_count(search: list, replace: list, subject: str) -> tuple[str, int]:
    """str_replace(array, array, $subject, $count): each pair applied in turn, total count."""
    total = 0
    for s, r in zip(search, replace):
        total += subject.count(s)
        subject = subject.replace(s, r)
    return subject, total


def implode_lines(lines: list) -> str:
    return '\n'.join(lines)


def json_to_python(value, force_object: bool = False) -> str:
    """PythonEmitHelpers::jsonToPython() with PHP's array semantics (see the module docstring):
    pretty JSON, unescaped unicode and slashes, ': true/false/null' spelled the Python way."""
    if force_object and isinstance(value, (list, dict)):
        value = obj(value)
    raw = json_encode(value, slashes=True, unicode=True, pretty=True)
    return raw.replace(': true', ': True').replace(': false', ': False').replace(': null', ': None')


def py_str(s: str) -> str:
    """PythonEmitHelpers::pyStr(): a Python double-quoted literal."""
    s = s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
    return '"' + s + '"'
