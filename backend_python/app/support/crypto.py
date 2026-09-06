"""openssl_decrypt($data, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv) equivalent."""
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def aes256cbc_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> bytes | None:
    try:
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        padded = dec.update(ciphertext) + dec.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return unpadder.update(padded) + unpadder.finalize()
    except Exception:  # noqa: BLE001 — openssl_decrypt returns false on any failure
        return None
