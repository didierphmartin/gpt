"""JSON I/O. PHP json_encode() defaults escape '/' and non-ASCII and print
full-precision floats; the TS port and this port emit clean JSON instead
(parity tracker B.18: cosmetic, every JSON consumer decodes identically)."""
import json

from app.support.phpcompat import php_array


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def php_json_encode(value) -> str:
    """json_encode() with PHP's actual defaults — escaped slashes and \\uXXXX for
    non-ASCII. Unlike dumps() above this is NOT cosmetic: use it for blobs written
    to the database, so the stored bytes are identical to PHP's."""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/')


def dumps_pretty(obj, unescaped: bool = True, unescape_slashes: bool | None = None) -> str:
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
    """
    slashesUnescaped = unescaped if unescape_slashes is None else unescape_slashes
    s = json.dumps(obj, indent=4, ensure_ascii=not unescaped)
    return s if slashesUnescaped else s.replace('/', '\\/')


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
