import re
from datetime import datetime
from zoneinfo import ZoneInfo

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
    # 'B' (Swatch Internet Time) is a real PHP date() character this port has
    # not implemented; php_date() raises rather than silently emitting the
    # wrong text (unlike PHP itself, which would just echo 'B' back).
    with pytest.raises(ValueError, match='unsupported php_date format'):
        pc.php_date('B')


def test_php_date_general_format_chars_match_php():
    # php -r 'date_default_timezone_set("America/New_York");
    #   $d = new DateTime("2026-04-07 15:45:30", new DateTimeZone("America/New_York"));
    #   foreach (["F j, Y","g:i A","F j, Y g:i A","Y","F","n","j","l","Y-m-d","c"] as $f) echo $d->format($f)."\n";'
    dt = datetime(2026, 4, 7, 15, 45, 30, tzinfo=ZoneInfo('America/New_York'))
    assert pc.php_date('F j, Y', dt=dt) == 'April 7, 2026'
    assert pc.php_date('g:i A', dt=dt) == '3:45 PM'
    assert pc.php_date('F j, Y g:i A', dt=dt) == 'April 7, 2026 3:45 PM'
    assert pc.php_date('Y', dt=dt) == '2026'
    assert pc.php_date('F', dt=dt) == 'April'
    assert pc.php_date('n', dt=dt) == '4'
    assert pc.php_date('j', dt=dt) == '7'
    assert pc.php_date('l', dt=dt) == 'Tuesday'
    assert pc.php_date('Y-m-d', dt=dt) == '2026-04-07'
    assert pc.php_date('c', dt=dt) == '2026-04-07T15:45:30-04:00'


def test_php_date_dt_and_tz_seams():
    # dt with a naive datetime + tz attaches the tz.
    naive = datetime(2026, 4, 7, 15, 45, 30)
    assert pc.php_date('c', dt=naive, tz=ZoneInfo('UTC')) == '2026-04-07T15:45:30+00:00'
    # tz alone (no dt) drives the frozen-clock seam.
    fixed = datetime(2026, 1, 1, 0, 0, 0, tzinfo=ZoneInfo('UTC'))
    import app.support.phpcompat as pc_mod
    orig = pc_mod._now
    try:
        pc_mod._now = lambda tz: fixed.astimezone(tz)
        assert pc.php_date('Y-m-d', tz=ZoneInfo('America/New_York')) == '2025-12-31'
    finally:
        pc_mod._now = orig


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


def test_php_coalesce():
    # C1 (Phase 5 final-review wave) -- consolidates the `_coalesce`
    # duplicated in parallel_agent_executor.py/graph_workflow_runner.py/
    # playbook_node_runner.py.
    assert pc.php_coalesce(None, None, 3) == 3
    assert pc.php_coalesce(1, 2) == 1
    assert pc.php_coalesce(None, None) is None
    assert pc.php_coalesce() is None
    # Never a truthiness check -- 0/''/[]/False all pass straight through.
    assert pc.php_coalesce(0, 5) == 0
    assert pc.php_coalesce('', 'x') == ''
    assert pc.php_coalesce([], [1]) == []
    assert pc.php_coalesce(False, True) is False


def test_php_loose_eq():
    # C2 (Phase 5 final-review wave) -- moved here from
    # WorkflowRunner._php_loose_eq (WorkflowRunner.php 278-291's rules,
    # verified against `php -r` — see test_workflow_runner.py's
    # test_evaluate_condition_* for the original indirect coverage, still
    # exercised through the moved-and-aliased `_php_loose_eq` there).
    assert pc.php_loose_eq(True, '1') is True
    assert pc.php_loose_eq(True, '0') is False
    assert pc.php_loose_eq(None, None) is True
    assert pc.php_loose_eq(None, 0) is True
    assert pc.php_loose_eq(None, '') is True
    assert pc.php_loose_eq(None, 'x') is False
    assert pc.php_loose_eq(None, []) is True
    assert pc.php_loose_eq([], {}) is True
    assert pc.php_loose_eq({'a': 1}, {'a': 1}) is True
    assert pc.php_loose_eq({'a': 1}, {'a': 2}) is False
    assert pc.php_loose_eq([1, 2], 'x') is False
    assert pc.php_loose_eq('5', 5) is True
    assert pc.php_loose_eq('abc', 'abc') is True
    assert pc.php_loose_eq('abc', 'xyz') is False


def test_php_loose_cmp():
    # C2 (Phase 5 final-review wave) -- moved here from
    # watchlist_functions._php_loose_cmp (WatchlistFunctions.php ~24/28's
    # rules; original indirect coverage stays in
    # test_portfolio_watchlist_functions.py via the moved-and-aliased
    # `_php_loose_cmp` there).
    assert pc.php_loose_cmp('10.50', '9.00') > 0
    assert pc.php_loose_cmp('9.00', '10.50') < 0
    assert pc.php_loose_cmp('10.50', '10.50') == 0
    assert pc.php_loose_cmp(None, '9.00') < 0        # '' < '9.00' lexically
    assert pc.php_loose_cmp('abc', '9.00') > 0        # neither numeric -> lexical
    assert pc.php_loose_cmp(True, False) > 0


def test_str_word_count():
    # C4 (Phase 5 final-review wave) -- moved here from
    # agent_delegation_functions._str_word_count (documented as an
    # approximation of PHP's locale-dependent str_word_count(), used only
    # for the diagnostic `result_word_count` field, AgentDelegationFunctions.
    # php:354). Indirect coverage stays in test_agent_delegation_functions.py.
    assert pc.str_word_count('hello world') == 2
    assert pc.str_word_count("it's a well-known fact") == 4
    assert pc.str_word_count('') == 0
    assert pc.str_word_count('123 456') == 0
    assert pc.str_word_count('one, two; three!') == 3


def test_php_array_cast():
    # PHP `(array)$v` -- B3 (Phase 5 final-review wave). Already-array
    # (dict or list, per json_decode(..., true)'s no list/assoc distinction)
    # passes through unchanged; null -> []; any scalar -> a single-element
    # array (PHP wraps a lone scalar at integer key 0).
    d = {'a': 1}
    assert pc.php_array_cast(d) is d
    li = [1, 2]
    assert pc.php_array_cast(li) is li
    assert pc.php_array_cast(None) == []
    assert pc.php_array_cast('x') == ['x']
    assert pc.php_array_cast(5) == [5]
    assert pc.php_array_cast(5.5) == [5.5]
    assert pc.php_array_cast(True) == [True]
    assert pc.php_array_cast(False) == [False]


def test_php_basename():
    # PHP basename(): strips trailing slashes FIRST, then returns the final
    # path segment -- unlike posixpath.basename(), which returns '' for any
    # path ending in '/'. Pinned via `php -r`, 2026-09-07 (moved from
    # test_ingestion_loader.py in the Phase 6 final wave, C2).
    assert pc.php_basename('/a/b/') == 'b'
    assert pc.php_basename('/a/b') == 'b'
    assert pc.php_basename('a/b/') == 'b'
    assert pc.php_basename('b') == 'b'
    assert pc.php_basename('') == ''
    assert pc.php_basename('/') == ''
    assert pc.php_basename('//') == ''
    assert pc.php_basename('a/') == 'a'
    assert pc.php_basename('///a///') == 'a'
    assert pc.php_basename('a//b') == 'b'
    assert pc.php_basename('noslash') == 'noslash'


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


def test_php_round():
    # Phase 7 final-review wave (B1): PHP 8 round() — half away from zero,
    # pre-rounded off the shortest decimal string that reproduces the double.
    # Every value below verified against the real PHP 8 build:
    #   php -r 'echo round(0.32685, 2);'   -> 0.33
    #   php -r 'echo round(2.5, 0);'       -> 3
    #   php -r 'echo round(-2.5, 0);'      -> -3
    #   php -r 'echo round(1.005, 2);'     -> 1.01
    #   php -r 'echo round(21790*15/1000000, 2);' -> 0.33
    #   php -r 'echo round(21790*15/1000000, 4);' -> 0.3269
    assert pc.php_round(0.32685, 2) == 0.33
    assert pc.php_round(2.5, 0) == 3.0
    assert pc.php_round(-2.5, 0) == -3.0
    assert pc.php_round(1.005, 2) == 1.01
    assert pc.php_round(21790 * 15 / 1_000_000, 2) == 0.33
    assert pc.php_round(21790 * 15 / 1_000_000, 4) == 0.3269
    # Python round-half-to-even would give 2.67/1.0/0.0/0.123456 for these —
    # PHP (and php_round) round away from zero instead:
    #   php -r 'echo round(2.675, 2);'      -> 2.68
    #   php -r 'echo round(0.0000005, 6);'  -> 1.0E-6
    #   php -r 'echo round(0.1234565, 6);'  -> 0.123457
    assert pc.php_round(2.675, 2) == 2.68
    assert pc.php_round(0.0000005, 6) == 1e-6
    assert pc.php_round(0.1234565, 6) == 0.123457
    assert pc.php_round(None) is None
    assert pc.php_round(4) == 4.0  # precision=0 default


def test_filter_validate_url():
    # Phase 7 final-review wave (B2): filter_var($v, FILTER_VALIDATE_URL) —
    # verified against the real PHP 8 build:
    #   php -r 'var_dump(filter_var("https://example.com/path", FILTER_VALIDATE_URL));' -> string (truthy)
    #   php -r 'var_dump(filter_var("http://ex_ample.com", FILTER_VALIDATE_URL));'       -> false ('_' not allowed in host)
    #   php -r 'var_dump(filter_var("mailto:foo@bar.com", FILTER_VALIDATE_URL));'        -> string (truthy, hostless scheme)
    #   php -r 'var_dump(filter_var("not a url", FILTER_VALIDATE_URL));'                 -> false
    assert pc.filter_validate_url('https://example.com/path') is True
    assert pc.filter_validate_url('http://ex_ample.com') is False
    assert pc.filter_validate_url('mailto:foo@bar.com') is True
    assert pc.filter_validate_url('not a url') is False
