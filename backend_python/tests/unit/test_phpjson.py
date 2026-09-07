from app.support.phpjson import dumps, php_json_arrays, php_json_decode


def test_clean_json_and_key_order():
    assert dumps({'b': 1, 'a': 'é/x'}) == '{"b":1,"a":"é/x"}'
    assert dumps([1, 2.5, None, True]) == '[1,2.5,null,true]'


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
