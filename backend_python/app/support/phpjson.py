"""JSON output. PHP json_encode() defaults escape '/' and non-ASCII and print
full-precision floats; the TS port and this port emit clean JSON instead
(parity tracker B.18: cosmetic, every JSON consumer decodes identically)."""
import json


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
