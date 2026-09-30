<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * The one encryption used for per-user keys in user_api_keys.
 *
 * base64(iv16 . AES-256-CBC(plaintext)) with key = sha256(secret), where the
 * secret is `auth.jwt_secret`. Extracted verbatim from SettingsController and
 * ChatController so a third reader (JevKeyResolver) cannot drift from them.
 */
final class ApiKeyCrypto
{
    /** What the controllers have always used when auth.jwt_secret is unset. */
    public const FALLBACK_SECRET = 'default-encryption-key-change-this';

    public static function secret(array $config): string
    {
        return $config['auth']['jwt_secret'] ?? self::FALLBACK_SECRET;
    }

    public static function encrypt(string $apiKey, string $secret): string
    {
        $key = hash('sha256', $secret, true);
        $iv = openssl_random_pseudo_bytes(16);
        $encrypted = openssl_encrypt($apiKey, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
        return base64_encode($iv . $encrypted);
    }

    /** The plaintext, or null when the blob is malformed or was encrypted under another secret. */
    public static function decrypt(string $blob, string $secret): ?string
    {
        try {
            $data = base64_decode($blob);
            if ($data === false || strlen($data) < 17) {
                return null;
            }

            $key = hash('sha256', $secret, true);
            $iv = substr($data, 0, 16);
            $encrypted = substr($data, 16);

            $decrypted = openssl_decrypt($encrypted, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
            return $decrypted !== false ? $decrypted : null;
        } catch (\Exception $e) {
            return null;
        }
    }

    /**
     * Whether $value has the exact shape encrypt() produces: canonical base64
     * of a 16-byte IV followed by whole AES blocks. Used to tell an encrypted
     * key we cannot open (wrong secret) from a key that was stored in the clear.
     */
    public static function looksEncrypted(string $value): bool
    {
        $data = base64_decode($value, true);
        if ($data === false || base64_encode($data) !== $value) {
            return false;
        }
        $len = strlen($data);
        return $len >= 32 && ($len - 16) % 16 === 0;
    }
}
