import crypto from 'crypto';

/**
 * Mirrors backend/src/Services/ApiKeyCrypto.php — the one encryption used for per-user keys in
 * user_api_keys: base64(iv16 . AES-256-CBC(plaintext)) with key = sha256(secret), where the secret
 * is `auth.jwt_secret`.
 */
export class ApiKeyCrypto {
  static encrypt(apiKey: string, secret: string): string {
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, enc]).toString('base64');
  }

  /** The plaintext, or null when the blob is malformed or was encrypted under another secret. */
  static decrypt(blob: string, secret: string): string | null {
    try {
      const data = Buffer.from(blob, 'base64');
      if (data.length < 17) return null;
      const key = crypto.createHash('sha256').update(secret).digest();
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
      return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * The usable key in a user_api_keys.api_key value, or '' when there is none. SettingsController
   * stores keys encrypted; AdminController stores per-user keys in the clear. A value not even
   * shaped like an encrypted blob is such a clear key; one that IS shaped like a blob but will not
   * open (rotated secret) is unusable.
   */
  static reveal(stored: string, secret: string): string {
    stored = stored.trim();
    if (stored === '') return '';
    const plain = ApiKeyCrypto.decrypt(stored, secret);
    if (plain !== null && plain.trim() !== '') return plain.trim();
    return ApiKeyCrypto.looksEncrypted(stored) ? '' : stored;
  }

  /**
   * Whether value has the exact shape encrypt() produces: canonical base64 of a 16-byte IV
   * followed by whole AES blocks. Tells an encrypted key we cannot open (wrong secret) from a key
   * that was stored in the clear.
   */
  static looksEncrypted(value: string): boolean {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
    const data = Buffer.from(value, 'base64');
    if (data.toString('base64') !== value) return false;
    return data.length >= 32 && (data.length - 16) % 16 === 0;
  }
}
