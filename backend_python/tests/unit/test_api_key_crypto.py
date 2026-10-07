"""ApiKeyCrypto unit tests — PHP source: backend/src/Services/ApiKeyCrypto.php."""
import base64

from app.services.api_key_crypto import ApiKeyCrypto

# openssl_encrypt('sk-differential-1234', 'AES-256-CBC', hash('sha256','test-jwt-secret',true),
# OPENSSL_RAW_DATA, str_repeat("\x01", 16)) prefixed by the IV, base64'd (live PHP output;
# same fixture as test_settings_controller).
PHP_CIPHERTEXT = 'AQEBAQEBAQEBAQEBAQEBAS6d1m13WSupDdCkNQG1HaiD6z7+lv4ZqQir1rWyurev'
SECRET = 'test-jwt-secret'


def test_decrypt_php_ciphertext_and_rejects_garbage():
    assert ApiKeyCrypto.decrypt(PHP_CIPHERTEXT, SECRET) == 'sk-differential-1234'
    assert ApiKeyCrypto.decrypt('', SECRET) is None
    assert ApiKeyCrypto.decrypt(base64.b64encode(b'x' * 16).decode(), SECRET) is None


def test_looks_encrypted_is_the_exact_encrypt_shape():
    assert ApiKeyCrypto.looksEncrypted(PHP_CIPHERTEXT)
    assert not ApiKeyCrypto.looksEncrypted('sk-ant-api03-plain')
    assert not ApiKeyCrypto.looksEncrypted(base64.b64encode(b'x' * 16).decode())   # IV only, no block
    assert not ApiKeyCrypto.looksEncrypted(base64.b64encode(b'x' * 40).decode())   # not whole blocks
    assert not ApiKeyCrypto.looksEncrypted(PHP_CIPHERTEXT.rstrip('v') + '!')       # not canonical base64


def test_reveal():
    # Encrypted (user Settings) -> plaintext.
    assert ApiKeyCrypto.reveal(PHP_CIPHERTEXT, SECRET) == 'sk-differential-1234'
    assert ApiKeyCrypto.reveal('  ' + PHP_CIPHERTEXT + '\n', SECRET) == 'sk-differential-1234'
    # Nothing stored -> ''.
    assert ApiKeyCrypto.reveal('', SECRET) == ''
    assert ApiKeyCrypto.reveal(' \t ', SECRET) == ''
    # Stored in the clear (gpt_admin) -> the trimmed value itself.
    assert ApiKeyCrypto.reveal(' sk-clear-key ', SECRET) == 'sk-clear-key'
    # Shaped like a blob but will not open (rotated secret) -> unusable.
    assert ApiKeyCrypto.reveal(PHP_CIPHERTEXT, 'rotated-secret') == ''
    # PHP trim() semantics: NBSP is not whitespace to PHP.
    assert ApiKeyCrypto.reveal(' sk ', SECRET) == ' sk '
