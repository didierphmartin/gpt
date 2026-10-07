<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Throwable;

/**
 * Which key and URL a decision provider uses for one user: the user's own key,
 * else the package's default key, else the row's (admin) key -- and only when
 * the user's package allows that provider. The user's own URL goes with the
 * user's own key only, so an admin/package key is never sent to an address a
 * user picked. A key that names no enabled row with a registered protocol is
 * 'unknown': it cannot route, and nothing guesses another provider.
 */
final class DecisionKeyResolver
{
    /**
     * @return array{key: string, source: 'user'|'package'|'global'|'none'|'not_allowed'|'unknown',
     *               url: string, row: ?array, protocol: ?array}
     */
    public static function resolve(PDO $db, array $config, ?int $userId, string $providerKey): array
    {
        $row = DecisionProviders::row($db, $providerKey);
        $protocol = $row !== null ? DecisionProviders::protocolOf($row) : null;
        $base = ['key' => '', 'url' => '', 'row' => $row, 'protocol' => $protocol];
        if ($row === null || $protocol === null) {
            return ['source' => 'unknown'] + $base;
        }
        $rowUrl = trim((string) ($row['base_url'] ?? '')) ?: $protocol['url'];

        $package = self::packageEntry($db, $userId, $providerKey);
        if ($package === false) {
            return ['source' => 'not_allowed', 'url' => $rowUrl] + $base;
        }

        if ($userId !== null && $userId > 0) {
            [$userKey, $userUrl] = self::userRow($db, ApiKeyCrypto::secret($config), $userId, $providerKey);
            if ($userKey !== '') {
                return ['key' => $userKey, 'source' => 'user', 'url' => $userUrl !== '' ? $userUrl : $rowUrl] + $base;
            }
        }

        $packageKey = trim((string) ($package['default_api_key'] ?? ''));
        if ($packageKey !== '') {
            return ['key' => $packageKey, 'source' => 'package', 'url' => $rowUrl] + $base;
        }

        $globalKey = trim((string) ($row['api_key'] ?? ''));
        if ($globalKey !== '') {
            return ['key' => $globalKey, 'source' => 'global', 'url' => $rowUrl] + $base;
        }

        return ['source' => 'none', 'url' => $rowUrl] + $base;
    }

    /** The provider an unset dispatcher uses: first usable row (admin order) the plan allows. */
    public static function defaultProvider(PDO $db, ?int $userId): ?string
    {
        foreach (DecisionProviders::rows($db) as $row) {
            $key = (string) $row['provider_key'];
            if (DecisionProviders::protocolOf($row) !== null && self::packageEntry($db, $userId, $key) !== false) {
                return $key;
            }
        }
        return null;
    }

    public static function allowed(PDO $db, ?int $userId, string $providerKey): bool
    {
        return self::packageEntry($db, $userId, $providerKey) !== false;
    }

    /** Why a resolved-empty key cannot route, in the words the user sees. */
    public static function unavailableReason(array $resolved, string $providerKey): string
    {
        $label = trim((string) ($resolved['row']['display_name'] ?? '')) ?: $providerKey;
        return match ($resolved['source']) {
            'unknown' => "'{$providerKey}' is not an available decision provider",
            'not_allowed' => "{$label} is not enabled for your plan",
            default => "no {$label} key",
        };
    }

    /**
     * The package's entry for this provider, [] when the package sets no
     * provider allowlist, false when the role may not use it. Same rule as the
     * LLM provider list (ProviderController::resolvePackageAllowedProviders).
     *
     * @return array|false
     */
    private static function packageEntry(PDO $db, ?int $userId, string $providerKey): array|false
    {
        try {
            $providers = (new PackageResolver($db))->resolveForUser($userId)['capabilities']['providers'] ?? null;
        } catch (Throwable $e) {
            error_log('[DecisionKeyResolver] package lookup failed: ' . $e->getMessage());
            return [];
        }
        if (!is_array($providers)) {
            return [];
        }
        $entry = $providers[$providerKey] ?? null;
        if (!is_array($entry) || empty($entry['enabled'])) {
            return false;
        }
        return $entry;
    }

    /** @return array{0: string, 1: string} the user's own [key, url]; ['', ''] when none. */
    private static function userRow(PDO $db, string $secret, int $userId, string $providerKey): array
    {
        try {
            $stmt = $db->prepare("SELECT * FROM user_api_keys WHERE user_id = :u AND provider = :p AND enabled = 1 LIMIT 1");
            $stmt->execute([':u' => $userId, ':p' => $providerKey]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            error_log('[DecisionKeyResolver] user key lookup failed: ' . $e->getMessage());
            return ['', ''];
        }
        if (!is_array($row)) {
            return ['', ''];
        }
        return [ApiKeyCrypto::reveal((string) ($row['api_key'] ?? ''), $secret), trim((string) ($row['base_url'] ?? ''))];
    }
}
