import json
import os
import shutil
import subprocess

import pytest

from app.support.phpjson import dumps, dumps_pretty, php_json_arrays, php_json_decode


def test_clean_json_and_key_order():
    assert dumps({'b': 1, 'a': 'é/x'}) == '{"b":1,"a":"é/x"}'
    assert dumps([1, 2.5, None, True]) == '[1,2.5,null,true]'


# ─── dumps_pretty ────────────────────────────────────────────────────────────
# json_encode($v, JSON_PRETTY_PRINT [| flags]) — PHP's 4-space-indented pretty
# print. `unescaped=True` mirrors JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
# `unescaped=False` mirrors plain JSON_PRETTY_PRINT (both escaped). The
# `unescape_slashes` override serves callers (WorkflowOutputStorage.php:85,
# GraphWorkflowRunner.php:1600) that set JSON_UNESCAPED_UNICODE WITHOUT
# JSON_UNESCAPED_SLASHES.

_NESTED = {
    'emptyArr': [],
    'emptyObj': {},
    'text': 'héllo/wörld',
    'num': 1.5,
    'nested': {'a': {'b': []}},
}


def test_dumps_pretty_unescaped_default():
    assert dumps_pretty(_NESTED) == (
        '{\n'
        '    "emptyArr": [],\n'
        '    "emptyObj": {},\n'
        '    "text": "héllo/wörld",\n'
        '    "num": 1.5,\n'
        '    "nested": {\n'
        '        "a": {\n'
        '            "b": []\n'
        '        }\n'
        '    }\n'
        '}'
    )


def test_dumps_pretty_escaped():
    assert dumps_pretty(_NESTED, unescaped=False) == (
        '{\n'
        '    "emptyArr": [],\n'
        '    "emptyObj": {},\n'
        '    "text": "h\\u00e9llo\\/w\\u00f6rld",\n'
        '    "num": 1.5,\n'
        '    "nested": {\n'
        '        "a": {\n'
        '            "b": []\n'
        '        }\n'
        '    }\n'
        '}'
    )


def test_dumps_pretty_unicode_unescaped_slashes_still_escaped():
    """WorkflowOutputStorage.php:85 / GraphWorkflowRunner.php:1600 shape:
    JSON_UNESCAPED_UNICODE without JSON_UNESCAPED_SLASHES."""
    out = dumps_pretty(_NESTED, unescape_slashes=False)
    assert '"text": "héllo\\/wörld"' in out


_PHP_BIN = shutil.which('php') or '/Applications/XAMPP/xamppfiles/bin/php'


@pytest.mark.skipif(not os.path.exists(_PHP_BIN), reason='php CLI not found')
def test_dumps_pretty_matches_real_php_byte_for_byte():
    php_script = (
        '$data = ["emptyArr" => [], "emptyObj" => new stdClass(), '
        '"text" => "héllo/wörld", "num" => 1.5, "nested" => ["a" => ["b" => []]]];'
        'echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);'
        'echo "\\x00";'
        'echo json_encode($data, JSON_PRETTY_PRINT);'
    )
    result = subprocess.run([_PHP_BIN, '-r', php_script], capture_output=True, text=True, check=True)
    php_unescaped, php_escaped = result.stdout.split('\x00')

    assert dumps_pretty(_NESTED) == php_unescaped
    assert dumps_pretty(_NESTED, unescaped=False) == php_escaped


# ─── dumps_pretty(float_formatter=...) ─────────────────────────────────────
# Phase 6 Task 1 fix round 1: PythonEmitHelpers.jsonToPython must render
# floats using PHP's json_encode()/serialize_precision=-1 rules, not
# Python's json.dumps/repr() rules -- see python_emit_helpers.py's
# _phpFloatToken. Since stdlib json.dumps gives no hook for float
# formatting, dumps_pretty grew an optional float_formatter callable that
# bypasses stdlib json.dumps for a small recursive encoder. Default None
# (all pre-existing call sites) is unaffected -- proven above (this whole
# file's other tests still pass unchanged) and by the identical-shape
# comparison below.

def test_dumps_pretty_float_formatter_default_none_is_unaffected():
    """No pre-existing caller passes float_formatter; confirm the parameter
    defaults to None and produces byte-identical output to before."""
    assert dumps_pretty(_NESTED) == dumps_pretty(_NESTED, float_formatter=None)


def test_dumps_pretty_float_formatter_replaces_float_leaves_only():
    out = dumps_pretty({'x': 1.0, 'y': [2.0, 'z'], 'w': True, 'n': None},
                        float_formatter=lambda v: f'<{v!r}>')
    assert out == (
        '{\n'
        '    "x": <1.0>,\n'
        '    "y": [\n'
        '        <2.0>,\n'
        '        "z"\n'
        '    ],\n'
        '    "w": true,\n'
        '    "n": null\n'
        '}'
    )


def test_dumps_pretty_float_formatter_matches_stdlib_layout_when_no_floats():
    """The custom recursive encoder used only when float_formatter is given
    must reproduce stdlib json.dumps(indent=4)'s exact structural layout
    (indent, separators, empty-container rendering, string escaping) for
    every shape carrying no floats -- proven by direct comparison against
    the float_formatter=None (stdlib) path on the same nested fixture."""
    assert dumps_pretty(_NESTED, float_formatter=lambda v: json.dumps(v)) == dumps_pretty(_NESTED)
    assert dumps_pretty(_NESTED, unescaped=False, float_formatter=lambda v: json.dumps(v)) == \
        dumps_pretty(_NESTED, unescaped=False)


@pytest.mark.skipif(not os.path.exists(_PHP_BIN), reason='php CLI not found')
def test_dumps_pretty_float_formatter_matches_real_php_json_encode_floats():
    """The reviewer's critical-bug cases plus threshold-boundary values,
    diffed against live `php -r` with serialize_precision=-1 (the effective
    runtime precision PythonEmitHelpers' callers set -- see
    python_emit_helpers.py's _phpFloatToken docstring)."""
    from app.agent_team.services.python_emit_helpers import _phpFloatToken

    data = {
        'wholeSmall': 1.0, 'wholeHundred': 100.0, 'zero': 0.0, 'negZero': -0.0,
        'frac': 0.1, 'bigExp': 1.0e16, 'smallExp': 1.0e-5, 'hugeExp': 1.0e25,
        'manyDigits': 123456789.123, 'half': 1.5,
        'decptBoundaryDecimal': 1.0e-4, 'decptBoundaryExp': 1.0e17,
    }
    # Build a PHP array literal whose float values are Python's own repr()
    # of the same doubles -- valid PHP float-literal syntax too (PHP parses
    # "1e+16"/"1e-05"/"-0.0" exponent/sign forms the same as Python emits).
    php_pairs = ', '.join(f'"{k}" => {repr(v)}' for k, v in data.items())
    result = subprocess.run(
        [_PHP_BIN, '-r', f'ini_set("serialize_precision","-1"); echo json_encode([{php_pairs}], JSON_PRETTY_PRINT);'],
        capture_output=True, text=True, check=True,
    )
    php_out = result.stdout

    py_out = dumps_pretty(data, unescaped=False, float_formatter=_phpFloatToken)
    assert py_out == php_out


# ─── php_json_arrays / php_json_decode ─────────────────────────────────────
# PHP json_decode($s, true) collapses an empty JSON object into an array
# indistinguishable from an empty JSON list — both come back `[]` — and that
# corruption applies at every nesting depth. php_json_arrays() reproduces it
# on an already-decoded value; php_json_decode() combines json.loads() with
# that walk, and returns None on invalid JSON just like PHP's json_decode().

def test_php_json_arrays_collapses_nested_empty_objects():
    assert php_json_arrays({'a': {}, 'b': {'c': {}}}) == {'a': [], 'b': {'c': []}}


def test_php_json_arrays_walks_lists_and_leaves_scalars_alone():
    assert php_json_arrays([{}, {'x': 1}, [1, {}], 'y', 3, None, True]) == \
        [[], {'x': 1}, [1, []], 'y', 3, None, True]


def test_php_json_arrays_top_level_empty_object_becomes_list():
    assert php_json_arrays({}) == []


def test_php_json_decode_parses_and_walks_nested_empty_objects():
    assert php_json_decode('{"a": {}, "b": [{}, {"c": {}}]}') == {'a': [], 'b': [[], {'c': []}]}


def test_php_json_decode_returns_none_on_invalid_json():
    assert php_json_decode('{not json') is None
    assert php_json_decode('') is None


def test_php_json_decode_scalars_pass_through():
    assert php_json_decode('42') == 42
    assert php_json_decode('"x"') == 'x'
    assert php_json_decode('null') is None
    assert php_json_decode('true') is True
