import hashlib, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from app.support.crypto import aes256cbc_decrypt


def test_roundtrip_like_openssl_decrypt():
    key = hashlib.sha256(b'secret').digest(); iv = os.urandom(16)
    padder = padding.PKCS7(128).padder(); padded = padder.update(b'sk-abc') + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ct = enc.update(padded) + enc.finalize()
    assert aes256cbc_decrypt(ct, key, iv) == b'sk-abc'
    assert aes256cbc_decrypt(b'garbage-not-block-aligned', key, iv) is None
