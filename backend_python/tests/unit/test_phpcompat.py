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
