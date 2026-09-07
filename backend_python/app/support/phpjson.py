"""JSON I/O. PHP json_encode() defaults escape '/' and non-ASCII and print
full-precision floats; the TS port and this port emit clean JSON instead
(parity tracker B.18: cosmetic, every JSON consumer decodes identically)."""
from __future__ import annotations

import json
from typing import Callable

from app.support.phpcompat import php_array


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def php_json_encode(value) -> str:
    """json_encode() with PHP's actual defaults — escaped slashes and \\uXXXX for
    non-ASCII. Unlike dumps() above this is NOT cosmetic: use it for blobs written
    to the database, so the stored bytes are identical to PHP's."""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/')


def dumps_pretty(obj, unescaped: bool = True, unescape_slashes: bool | None = None,
                  float_formatter: Callable[[float], str] | None = None) -> str:
    """json_encode($v, JSON_PRETTY_PRINT [| flags]) — PHP's pretty-print
    (4-space indent; Python's `json.dumps(..., indent=4)` matches PHP's
    separator/newline placement byte-for-byte, verified against `php -r`
    2026-09-07 for nested arrays/objects, empty arrays/objects, unicode and
    slash-bearing strings, and floats).

    `unescaped=True` (default) mirrors `JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE
    | JSON_UNESCAPED_SLASHES` — literal non-ASCII, literal '/'.
    `unescaped=False` mirrors plain `JSON_PRETTY_PRINT` — `\\uXXXX`-escaped
    non-ASCII and `\\/`-escaped slashes.

    `unescape_slashes` overrides slash handling independently of `unescaped`,
    for PHP call sites that pass `JSON_UNESCAPED_UNICODE` WITHOUT
    `JSON_UNESCAPED_SLASHES` — e.g. `WorkflowOutputStorage.php:85` and
    `GraphWorkflowRunner.php:1600`, which both unescape unicode but still
    escape slashes. Without this override those two callers could not reuse
    this helper without changing their on-disk output bytes.

    `float_formatter`: optional `callable(float) -> str` used to render every
    float LEAF instead of Python's own `repr()`-based `json.dumps` float
    formatting (stdlib `json.dumps` gives no hook for this — floats are
    natively serializable so the `default=` callback is never invoked for
    them). When given, this bypasses stdlib `json.dumps` for a small
    recursive encoder (`_encode_pretty_with_float_formatter` below) that
    reproduces `json.dumps(obj, indent=4, ensure_ascii=...)`'s exact
    structural layout (4-space indent, `,`+newline item separator, `": "`
    key separator, `{}`/`[]` for empty containers, stdlib `json.dumps` used
    for every string leaf/key so escaping is unaffected) — verified
    byte-identical to stdlib output for every non-float shape the existing
    `dumps_pretty` tests exercise (see test_phpjson.py). Default `None`
    preserves the EXACT prior behaviour (plain stdlib `json.dumps`) for
    every pre-existing caller (`agent_mcp_controller.py`,
    `workflow_output_storage.py`, `graph_workflow_runner.py`) — added only
    for `PythonEmitHelpers.jsonToPython`, which must render floats using
    PHP's `json_encode()` (`serialize_precision=-1`) rules, not Python's
    `repr()`-based ones (they disagree on whole-number floats and on the
    decimal/exponential-notation threshold — see `_phpFloatToken` in
    `python_emit_helpers.py`).
    """
    slashesUnescaped = unescaped if unescape_slashes is None else unescape_slashes
    if float_formatter is not None:
        s = _encode_pretty_with_float_formatter(obj, ensure_ascii=not unescaped, float_formatter=float_formatter)
    else:
        s = json.dumps(obj, indent=4, ensure_ascii=not unescaped)
    return s if slashesUnescaped else s.replace('/', '\\/')


def _encode_pretty_with_float_formatter(obj, ensure_ascii: bool, float_formatter: Callable[[float], str],
                                         level: int = 0) -> str:
    """Recursive 4-space-indent JSON pretty-printer matching
    `json.dumps(obj, indent=4, ensure_ascii=ensure_ascii)`'s exact layout,
    except every `float` leaf is rendered via `float_formatter(v)` instead
    of `float.__repr__`. Only reached when `dumps_pretty(..., float_formatter=...)`
    is given a non-None formatter; see that function's docstring."""
    pad = ' ' * (4 * level)
    pad_in = ' ' * (4 * (level + 1))
    if obj is None:
        return 'null'
    if obj is True:
        return 'true'
    if obj is False:
        return 'false'
    if isinstance(obj, float):
        return float_formatter(obj)
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=ensure_ascii)
    if isinstance(obj, dict):
        if not obj:
            return '{}'
        items = []
        for k, v in obj.items():
            key_str = json.dumps(k if isinstance(k, str) else str(k), ensure_ascii=ensure_ascii)
            items.append(pad_in + key_str + ': '
                         + _encode_pretty_with_float_formatter(v, ensure_ascii, float_formatter, level + 1))
        return '{\n' + ',\n'.join(items) + '\n' + pad + '}'
    if isinstance(obj, (list, tuple)):
        if not obj:
            return '[]'
        items = [pad_in + _encode_pretty_with_float_formatter(x, ensure_ascii, float_formatter, level + 1)
                 for x in obj]
        return '[\n' + ',\n'.join(items) + '\n' + pad + ']'
    raise TypeError(f'dumps_pretty(float_formatter=...): not JSON serializable: {type(obj)!r}')


def php_json_arrays(value):
    """Apply php_array() to every map in an already-decoded JSON value.

    Mirrors `json_decode($s, true)`: PHP's assoc-mode decode makes an EMPTY
    JSON object indistinguishable from an empty JSON array — both come back
    as `[]` — so php_array() must be applied at every nesting depth or a
    round-tripped empty object silently becomes `[]` on the way back out.
    """
    if isinstance(value, dict):
        return php_array({k: php_json_arrays(v) for k, v in value.items()})
    if isinstance(value, list):
        return [php_json_arrays(v) for v in value]
    return value


def php_json_decode(s):
    """json_decode($s, true) — None on invalid JSON, PHP-array-shaped otherwise.

    `json.loads` + the `php_json_arrays` walk above, guarded so invalid JSON
    (or a non-JSON-string argument) returns None exactly like PHP's
    json_decode() returns null on failure, instead of raising.
    """
    try:
        return php_json_arrays(json.loads(s))
    except (ValueError, TypeError):
        return None
