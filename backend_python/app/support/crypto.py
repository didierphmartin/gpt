"""openssl_encrypt/openssl_decrypt($data, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv) equivalents."""
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def aes256cbc_encrypt(plaintext: bytes, key: bytes, iv: bytes) -> bytes:
    """Symmetric twin of aes256cbc_decrypt — OPENSSL_RAW_DATA output (no base64),
    PKCS#7 padding, which is what openssl_encrypt() produces for AES-256-CBC."""
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return enc.update(padded) + enc.finalize()


def aes256cbc_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> bytes | None:
    try:
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        padded = dec.update(ciphertext) + dec.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return unpadder.update(padded) + unpadder.finalize()
    except Exception:  # noqa: BLE001 — openssl_decrypt returns false on any failure
        return None
