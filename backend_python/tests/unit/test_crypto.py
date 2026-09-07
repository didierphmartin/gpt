import base64
import hashlib, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from app.support.crypto import aes256cbc_decrypt, aes256cbc_encrypt

# openssl_encrypt('sk-abc', 'AES-256-CBC', hash('sha256','secret',true), OPENSSL_RAW_DATA,
#                 str_repeat("\x01", 16)) — base64 of the raw ciphertext, from the PHP CLI.
PHP_RAW_CT_B64 = 'puMIE7lxhwkQoWaQRQ1V/Q=='


def test_roundtrip_like_openssl_decrypt():
    key = hashlib.sha256(b'secret').digest(); iv = os.urandom(16)
    padder = padding.PKCS7(128).padder(); padded = padder.update(b'sk-abc') + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ct = enc.update(padded) + enc.finalize()
    assert aes256cbc_decrypt(ct, key, iv) == b'sk-abc'
    assert aes256cbc_decrypt(b'garbage-not-block-aligned', key, iv) is None


def test_encrypt_matches_php_openssl_encrypt():
    key = hashlib.sha256(b'secret').digest(); iv = b'\x01' * 16
    ct = aes256cbc_encrypt(b'sk-abc', key, iv)
    assert base64.b64encode(ct).decode() == PHP_RAW_CT_B64
    assert aes256cbc_decrypt(ct, key, iv) == b'sk-abc'
