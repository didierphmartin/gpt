"""Port of backend/tests/Unit/PythonEmitHelpersTest.php (Phase 6, Task 1)."""
from __future__ import annotations

from app.agent_team.services.compiler_php import json_to_python
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers


def test_py_str_escapes():
    """PHP testPyStrEscapes (lines 8-13)."""
    out = PythonEmitHelpers.pyStr('line1\nquote"x')
    assert '\\n' in out
    assert '\\"' in out


def test_json_to_python_null_true_false():
    """PHP testJsonToPythonNullTrueFalse (lines 14-20)."""
    out = json_to_python({'a': None, 'b': True, 'c': False})
    assert 'None' in out
    assert 'True' in out
    assert 'False' in out


def test_json_to_python_empty_dict_without_force_object_renders_list():
    """Phase 6, Task 4 fix (differential wf=27/38/40/41/42 generate-adk):
    PHP's own json_encode() has no way to distinguish an empty associative
    array from an empty list -- without an explicit `(object)` cast (i.e.
    forceObject=False, the default), ANY empty PHP array -- even one built
    with string keys when non-empty, like ADKGenerator.php:892-893's
    `$nodeNames[(string) $nid] = ...; jsonToPython($nodeNames)` -- encodes
    as JSON `[]`, never `{}`. Verified against a live PHP generate-adk
    response for workflow 27 ("test ingestion workflow", no agent nodes):
    PHP emits `NODE_NAMES = []`, not `{}`. A caller here that built the
    natural Python port -- an empty `dict` -- must match that."""
    assert json_to_python({}) == '[]'
    # forceObject=True still takes the (object) cast path -- unaffected.
    assert json_to_python({}, True) == '{}'
    # A non-empty dict is unaffected either way.
    assert json_to_python({'1': 'a'}) == '{\n    "1": "a"\n}'


# ─── jsonToPython float tokens (Fix round 1) ───────────────────────────────
# Critical bug found in review: jsonToPython delegated to phpjson.dumps_pretty,
# which used Python's json.dumps/repr() float formatting -- disagreeing with
# PHP's json_encode()/serialize_precision=-1 rules on whole-number floats
# ("1.0" vs PHP's "1") and on the decimal/exponential notation threshold
# (Python: 1e16 -> "1e+16"; PHP: "10000000000000000"). jsonToPython now
# passes float_formatter=_phpFloatToken into dumps_pretty (see
# python_emit_helpers.py and phpjson.dumps_pretty's new optional parameter).
#
# Every expected literal below was captured verbatim from live PHP:
#   php -r '
#     require "backend/vendor/autoload.php";
#     use AgentTeam\Services\PythonEmitHelpers;
#     ini_set("serialize_precision", "-1");
#     $dict = ["a"=>1.0,"b"=>100.0,"c"=>0.0,"d"=>-0.0,"e"=>0.1,
#              "f"=>1e16,"g"=>1e-5,"h"=>1e25,"i"=>123456789.123,"j"=>1.5];
#     echo PythonEmitHelpers::jsonToPython($dict);
#     $list = [1.0,100.0,0.0,-0.0,0.1,1e16,1e-5,1e25,123456789.123,1.5];
#     echo PythonEmitHelpers::jsonToPython($list);
#   '
# (serialize_precision=-1 matches the effective runtime precision every real
# caller runs under -- LangGraphGenerator::analyzeForEmit sets it before
# reaching this code; see _phpFloatToken's docstring).

_FLOAT_DICT = {
    'a': 1.0, 'b': 100.0, 'c': 0.0, 'd': -0.0, 'e': 0.1,
    'f': 1e16, 'g': 1e-5, 'h': 1e25, 'i': 123456789.123, 'j': 1.5,
}
_FLOAT_LIST = [1.0, 100.0, 0.0, -0.0, 0.1, 1e16, 1e-5, 1e25, 123456789.123, 1.5]


def test_json_to_python_float_tokens_nested_in_dict():
    out = json_to_python(_FLOAT_DICT)
    assert out == (
        '{\n'
        '    "a": 1,\n'
        '    "b": 100,\n'
        '    "c": 0,\n'
        '    "d": -0,\n'
        '    "e": 0.1,\n'
        '    "f": 10000000000000000,\n'
        '    "g": 1.0e-5,\n'
        '    "h": 1.0e+25,\n'
        '    "i": 123456789.123,\n'
        '    "j": 1.5\n'
        '}'
    )


def test_json_to_python_float_tokens_nested_in_list():
    out = json_to_python(_FLOAT_LIST)
    assert out == (
        '[\n'
        '    1,\n'
        '    100,\n'
        '    0,\n'
        '    -0,\n'
        '    0.1,\n'
        '    10000000000000000,\n'
        '    1.0e-5,\n'
        '    1.0e+25,\n'
        '    123456789.123,\n'
        '    1.5\n'
        ']'
    )


def test_node_summary_compact_float_path_still_correct():
    """The compact (non-pretty-print) float path -- _nodeSummary's
    `json_encode((float) $n['temperature'])`, via _jsonEncodeUnescapedUnicode
    -- must keep working after the pretty-print float fix. Regression guard
    for python_emit_helpers.py's PythonEmitHelpersPinTest-adjacent doc
    generators, verified against live PHP in task-1-report.md's original
    _nodeSummary differential (EDGE1: temperature=0 -> 'temp 0', not
    'temp 0.0')."""
    node = dict(id='2', type='agent', name='A', provider='claude', model='m',
                temperature=0.7, max_tokens=None, thinking=None, tools=[], skills=[],
                dispatch=[], playbook=None, supported=True, parents=[], children=[], prompt='')
    assert PythonEmitHelpers._nodeSummary(node) == 'claude/m, temp 0.7, 0 tool(s)'
    node['temperature'] = 0
    assert PythonEmitHelpers._nodeSummary(node) == 'claude/m, temp 0, 0 tool(s)'


def test_py_literal_long_and_escaped_strings():
    """pyLiteral on 200000-char and escape-heavy strings evaluates back to the value."""
    import subprocess
    import json
    from app.agent_team.services.compiler_php import py_literal
    for v in ({'k': 'x' * 200000, 'b': True, 'n': None}, {'k': 'a"b\\c true null ' * 20000, 'f': False}):
        out = subprocess.run(['python3', '-c', 'import sys,json; print(json.dumps(eval(sys.stdin.read())))'],
                             input=py_literal(v), capture_output=True, text=True, check=True).stdout
        assert json.loads(out) == v
    assert py_literal({'a': True, 'b': 'true', 'c': None}) == '{"a":True,"b":"true","c":None}'
