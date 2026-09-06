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
