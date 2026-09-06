import datetime as dt
import time
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from app.services import firebase_tokens as ft

PROJECT = 'transledgersite'


def _keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'securetoken.system.gserviceaccount.com')])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(dt.datetime.now(dt.UTC) - dt.timedelta(days=1))
            .not_valid_after(dt.datetime.now(dt.UTC) + dt.timedelta(days=1)).sign(key, hashes.SHA256()))
    return key, cert.public_bytes(serialization.Encoding.PEM).decode()


def _token(key, kid, **over):
    now = int(time.time())
    claims = {'iss': f'https://securetoken.google.com/{PROJECT}', 'aud': PROJECT, 'sub': 'uid-1',
              'iat': now, 'exp': now + 600, 'email': 'U@Example.com', **over}
    return jwt.encode(claims, key, algorithm='RS256', headers={'kid': kid})


def test_valid_token_returns_claims(tmp_path, monkeypatch):
    key, pem = _keypair()
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs.json')
    claims = ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=lambda: {'k1': pem})
    assert claims['sub'] == 'uid-1' and claims['email'] == 'U@Example.com'
    assert (tmp_path / 'certs.json').is_file()          # cached


def test_cache_is_used_within_an_hour(tmp_path, monkeypatch):
    key, pem = _keypair()
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs.json')
    calls = []
    fetch = lambda: (calls.append(1), {'k1': pem})[1]
    assert ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=fetch)
    assert ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=fetch)
    assert len(calls) == 1


def test_rejections(tmp_path, monkeypatch):
    key, pem = _keypair()
    other, _ = _keypair()
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs.json')
    certs = lambda: {'k1': pem}
    assert ft.verify_firebase_id_token(_token(other, 'k1'), PROJECT, fetch_certs=certs) is None      # bad signature
    assert ft.verify_firebase_id_token(_token(key, 'k9'), PROJECT, fetch_certs=certs) is None         # unknown kid
    assert ft.verify_firebase_id_token(_token(key, 'k1', aud='x'), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1', iss='https://evil'), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1', sub=''), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1', exp=int(time.time()) - 5), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token('garbage', PROJECT, fetch_certs=certs) is None
    # Fresh (never-populated) cache path so this actually exercises the fetch failure
    # instead of silently hitting the cache written by the assertions above.
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs-uncached.json')
    assert ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=lambda: (_ for _ in ()).throw(OSError())) is None
