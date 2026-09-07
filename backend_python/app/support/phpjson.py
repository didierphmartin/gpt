"""JSON output. PHP json_encode() defaults escape '/' and non-ASCII and print
full-precision floats; the TS port and this port emit clean JSON instead
(parity tracker B.18: cosmetic, every JSON consumer decodes identically)."""
import json


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def php_json_encode(value) -> str:
    """json_encode() with PHP's actual defaults — escaped slashes and \\uXXXX for
    non-ASCII. Unlike dumps() above this is NOT cosmetic: use it for blobs written
    to the database, so the stored bytes are identical to PHP's."""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/')
