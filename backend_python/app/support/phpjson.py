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
