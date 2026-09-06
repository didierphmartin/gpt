from app.support.phpjson import dumps


def test_clean_json_and_key_order():
    assert dumps({'b': 1, 'a': 'é/x'}) == '{"b":1,"a":"é/x"}'
    assert dumps([1, 2.5, None, True]) == '[1,2.5,null,true]'
