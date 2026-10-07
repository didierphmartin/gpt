<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Throwable;

/**
 * Where the Jev key for a run comes from: the user's own key, else the
 * package's default key, else the admin's global key -- and only when the
 * user's package allows Jev.
 *
 * Stored like LLM keys (per-user row in user_api_keys, global router row in
 * system_llm_settings) but resolved here rather than through the chat config,
 * because Jev is not a chat provider and must never enter $config['providers'].
 * The backend .env TYPESAFE_API_KEY is not read.
 */
final class JevKeyResolver
{
    /**
     * @return array{key: string, source: 'user'|'package'|'global'|'none'|'not_allowed'}
     */
    public static function resolve(PDO $db, array $config, ?int $userId): array
    {
        $package = self::jevPackageEntry($db, $userId);
        if ($package === false) {
            return ['key' => '', 'source' => 'not_allowed'];
        }

        if ($userId !== null && $userId > 0) {
            $userKey = self::userKey($db, ApiKeyCrypto::secret($config), $userId);
            if ($userKey !== '') {
                return ['key' => $userKey, 'source' => 'user'];
            }
        }

        $packageKey = trim((string) ($package['default_api_key'] ?? ''));
        if ($packageKey !== '') {
            return ['key' => $packageKey, 'source' => 'package'];
        }

        $globalKey = self::globalKey($db);
        if ($globalKey !== '') {
            return ['key' => $globalKey, 'source' => 'global'];
        }

        return ['key' => '', 'source' => 'none'];
    }

    /**
     * The Jev URL that goes with a resolved key, '' = the vendor default
     * (JevRouter::URL). Same rule as the LLM providers: a user's own entry
     * point (a gateway) is used only with the user's own key; the package and
     * global keys use the global row's URL, so an admin/package key is never
     * sent to an address a user picked.
     *
     * @param array{key: string, source: string} $resolved from resolve()
     */
    public static function url(PDO $db, array $resolved, ?int $userId): string
    {
        if ($resolved['key'] === '') {
            return '';
        }
        if ($resolved['source'] === 'user' && $userId !== null && $userId > 0) {
            $own = self::column($db,
                "SELECT * FROM user_api_keys WHERE user_id = :u AND provider = :p AND enabled = 1 LIMIT 1",
                [':u' => $userId, ':p' => ProviderKinds::JEV_KEY], 'base_url');
            if ($own !== '') {
                return $own;
            }
        }
        return self::column($db,
            "SELECT * FROM system_llm_settings WHERE provider_key = :p AND enabled = 1 LIMIT 1",
            [':p' => ProviderKinds::JEV_KEY], 'base_url');
    }

    /** One trimmed column of the first matching row; '' when absent (SELECT * tolerates an install without it). */
    private static function column(PDO $db, string $sql, array $params, string $name): string
    {
        try {
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return is_array($row) ? trim((string) ($row[$name] ?? '')) : '';
        } catch (Throwable $e) {
            error_log('[JevKeyResolver] ' . $name . ' lookup failed: ' . $e->getMessage());
            return '';
        }
    }

    /** Why a resolved-empty key cannot route, in the words the user sees. */
    public static function unavailableReason(string $source): string
    {
        return $source === 'not_allowed' ? 'Jev is not enabled for your plan' : 'no Jev key';
    }

    /**
     * The package's Jev entry, [] when the package sets no provider allowlist,
     * or false when the role may not use Jev. Same rule as the LLM provider list
     * (ProviderController::resolvePackageAllowedProviders): a providers map is an
     * allowlist, and a provider missing from it or switched off is not allowed.
     *
     * @return array|false
     */
    private static function jevPackageEntry(PDO $db, ?int $userId): array|false
    {
        try {
            $providers = (new PackageResolver($db))->resolveForUser($userId)['capabilities']['providers'] ?? null;
        } catch (Throwable $e) {
            // Same as the LLM list: a package that cannot be read imposes no allowlist.
            error_log('[JevKeyResolver] package lookup failed: ' . $e->getMessage());
            return [];
        }
        if (!is_array($providers)) {
            return [];
        }
        $jev = $providers[ProviderKinds::JEV_KEY] ?? null;
        if (!is_array($jev) || empty($jev['enabled'])) {
            return false;
        }
        return $jev;
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

        return ApiKeyCrypto::reveal($stored, $secret);
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
