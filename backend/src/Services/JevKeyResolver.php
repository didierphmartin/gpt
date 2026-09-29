<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Throwable;

/**
 * Where the Jev key for a run comes from: the user's own key, else the admin's
 * global key, else none.
 *
 * Stored like LLM keys (per-user row in user_api_keys, global router row in
 * system_llm_settings) but resolved here rather than through the chat config,
 * because Jev is not a chat provider and must never enter $config['providers'].
 * The backend .env TYPESAFE_API_KEY is not read.
 */
final class JevKeyResolver
{
    /**
     * @return array{key: string, source: 'user'|'global'|'none'}
     */
    public static function resolve(PDO $db, array $config, ?int $userId): array
    {
        if ($userId !== null && $userId > 0) {
            $userKey = self::userKey($db, ApiKeyCrypto::secret($config), $userId);
            if ($userKey !== '') {
                return ['key' => $userKey, 'source' => 'user'];
            }
        }

        $globalKey = self::globalKey($db);
        if ($globalKey !== '') {
            return ['key' => $globalKey, 'source' => 'global'];
        }

        return ['key' => '', 'source' => 'none'];
    }

    private static function userKey(PDO $db, string $secret, int $userId): string
    {
        try {
            $stmt = $db->prepare(
                "SELECT api_key FROM user_api_keys WHERE user_id = :u AND provider = :p AND enabled = 1 LIMIT 1"
            );
            $stmt->execute([':u' => $userId, ':p' => ProviderKinds::JEV_KEY]);
            $stored = trim((string) ($stmt->fetchColumn() ?: ''));
        } catch (Throwable $e) {
            error_log('[JevKeyResolver] user key lookup failed: ' . $e->getMessage());
            return '';
        }
        if ($stored === '') {
            return '';
        }

        $plain = ApiKeyCrypto::decrypt($stored, $secret);
        if ($plain !== null && trim($plain) !== '') {
            return trim($plain);
        }
        // AdminController::saveApiKeys stores per-user keys in the clear. A
        // value that is not even shaped like an encrypted blob is such a key;
        // one that IS shaped like a blob but will not open (rotated secret) is
        // unusable, and the global key takes over.
        return ApiKeyCrypto::looksEncrypted($stored) ? '' : $stored;
    }

    private static function globalKey(PDO $db): string
    {
        try {
            $stmt = $db->prepare(
                "SELECT api_key FROM system_llm_settings WHERE provider_key = :p AND enabled = 1 LIMIT 1"
            );
            $stmt->execute([':p' => ProviderKinds::JEV_KEY]);
            return trim((string) ($stmt->fetchColumn() ?: ''));
        } catch (Throwable $e) {
            error_log('[JevKeyResolver] global key lookup failed: ' . $e->getMessage());
            return '';
        }
    }
}
