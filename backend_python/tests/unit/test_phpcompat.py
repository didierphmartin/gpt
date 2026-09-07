import re
from app.support import phpcompat as pc


def test_php_now_format_and_timezone(monkeypatch):
    monkeypatch.setenv('PHP_TIMEZONE', 'Europe/Berlin')
    s = pc.php_now()
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', s)


def test_ucfirst():
    assert pc.ucfirst('prompt') == 'Prompt'
    assert pc.ucfirst('') == ''


def test_is_numeric():
    assert pc.is_numeric(3) and pc.is_numeric('3') and pc.is_numeric('3.5') and pc.is_numeric(' 3')
    assert not pc.is_numeric(None) and not pc.is_numeric('') and not pc.is_numeric('abc') and not pc.is_numeric(True)


def test_validate_email():
    assert pc.validate_email('a.b@example.com')
    assert not pc.validate_email('nope') and not pc.validate_email('a@b') and not pc.validate_email('a b@c.com')


def test_b64url_roundtrip():
    raw = bytes(range(32))
    enc = pc.b64url_encode(raw)
    assert '=' not in enc and '+' not in enc and '/' not in enc
    assert pc.b64url_decode(enc) == raw


def test_mb_substr():
    assert pc.mb_substr('héllo wörld', 0, 5) == 'héllo'


def test_php_intval():
    assert pc.php_intval('12.5') == 12
    assert pc.php_intval('1e3') == 1000
    assert pc.php_intval(' 7') == 7
    assert pc.php_intval('abc') == 0
    assert pc.php_intval(3.9) == 3


def test_php_empty():
    assert pc.php_empty('0') and pc.php_empty(0) and pc.php_empty('') and pc.php_empty(None)
    assert pc.php_empty(False) and pc.php_empty([]) and pc.php_empty({})
    assert not pc.php_empty('a') and not pc.php_empty(1) and not pc.php_empty('00') and not pc.php_empty(True)


def test_php_date_formats(monkeypatch):
    import re
    monkeypatch.setenv('PHP_TIMEZONE', 'Europe/Berlin')
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}', pc.php_date('Y-m-d'))
    assert pc.php_date('l') in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
    assert re.fullmatch(r'\d{4}-\d{2}', pc.php_date('Y-m'))


def test_php_uniqid_shapes():
    import re
    assert re.fullmatch(r'chat_[0-9a-f]{13}', pc.php_uniqid('chat_'))
    assert re.fullmatch(r'chat_[0-9a-f]{13}\.\d{8}', pc.php_uniqid('chat_', True))


def test_php_crc32_matches_php():
    assert pc.php_crc32('demo-user') == 4190640275   # php -r 'echo abs(crc32("demo-user"));' (verified against live PHP CLI)


def test_php_date_unsupported_format_raises():
    import pytest
    with pytest.raises(ValueError, match='unsupported php_date format'):
        pc.php_date('D M j')


def test_php_strval_matches_php_string_cast():
    # php -r 'var_dump(strval(true), strval(false), strval(null), strval(1.0), strval(1/3), strval("x"), strval(7));'
    assert pc.php_strval(True) == '1'
    assert pc.php_strval(False) == ''
    assert pc.php_strval(None) == ''
    assert pc.php_strval(1.0) == '1'
    assert pc.php_strval(1 / 3) == '0.33333333333333'
    assert pc.php_strval(0.1) == '0.1'
    assert pc.php_strval('x') == 'x'
    assert pc.php_strval(7) == '7'
    assert pc.php_strval([1, 2]) == 'Array'


def test_php_trim_coerces_like_php_and_uses_phps_charlist():
    # php -r 'var_dump(trim(null), trim(true), trim(false), trim(7), trim(3.5),
    #                  trim("  x  "), trim("\xc2\xa0x\xc2\xa0"), trim("\0\x0Bx\t\n\r "));'
    assert pc.php_trim(None) == ''            # deprecated in PHP 8 but still ''
    assert pc.php_trim(True) == '1'
    assert pc.php_trim(False) == ''
    assert pc.php_trim(7) == '7'
    assert pc.php_trim(3.5) == '3.5'
    assert pc.php_trim('  x  ') == 'x'
    assert pc.php_trim('\0\x0bx\t\n\r ') == 'x'
    # PHP strips its own byte charlist only — NBSP and the other Unicode spaces
    # Python's str.strip() would eat are left alone.
    assert pc.php_trim(' x ') == ' x '
    assert pc.php_trim(' x') == ' x'
    assert pc.php_trim('--x--', '-') == 'x'


def test_php_trim_rejects_arrays_like_php8():
    import pytest
    with pytest.raises(TypeError, match='must be of type string, array given'):
        pc.php_trim(['a'])
    with pytest.raises(TypeError):
        pc.php_trim({'a': 1})


def test_php_floatval_matches_php_float_cast():
    # php -r 'var_dump((float)"7.5", (float)"12abc", (float)"abc", (float)null, (float)true, (float)"1e3");'
    assert pc.php_floatval('7.5') == 7.5
    assert pc.php_floatval('12abc') == 12.0
    assert pc.php_floatval('abc') == 0.0
    assert pc.php_floatval(None) == 0.0
    assert pc.php_floatval(True) == 1.0
    assert pc.php_floatval('1e3') == 1000.0
    assert pc.php_floatval('  4.25  ') == 4.25


def test_is_php_array():
    # PHP is_array(): true for anything json_decode(..., true) can produce as
    # an array — a JSON list AND a JSON object both decode to a PHP array.
    assert pc.is_php_array([])
    assert pc.is_php_array([1, 2, 3])
    assert pc.is_php_array({})
    assert pc.is_php_array({'a': 1})
    assert not pc.is_php_array(None)
    assert not pc.is_php_array('array')
    assert not pc.is_php_array(0)
    assert not pc.is_php_array(False)


def test_php_values():
    # foreach ($v as $item) — values only, insertion order, for both shapes.
    assert pc.php_values([1, 2, 3]) == [1, 2, 3]
    assert pc.php_values({'a': 1, 'b': 2}) == [1, 2]
    assert pc.php_values({}) == []
    assert pc.php_values([]) == []
    assert pc.php_values(None) == []
    assert pc.php_values('not an array') == []


def test_php_items_foreach_k_v_over_dict_or_list():
    # foreach ($arr as $k => $v) for a JSON-decoded PHP array (object or list).
    assert pc.php_items({'a': 1, 'b': 2}) == [('a', 1), ('b', 2)]
    assert pc.php_items(['x', 'y']) == [(0, 'x'), (1, 'y')]
    assert pc.php_items({}) == []
    assert pc.php_items([]) == []
    assert pc.php_items(None) == []
    assert pc.php_items('not an array') == []
