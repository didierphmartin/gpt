<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Throwable;

/**
 * The decision providers an admin configured: system_llm_settings rows with
 * api_format 'router'. Read with SELECT * so an install without the
 * `protocol` column (migration not applied) reads protocol null = unusable.
 */
final class DecisionProviders
{
    /** @return list<array<string, mixed>> */
    public static function rows(PDO $db, bool $enabledOnly = true): array
    {
        try {
            $stmt = $db->prepare("SELECT * FROM system_llm_settings WHERE api_format = :f ORDER BY sort_order ASC, provider_key ASC");
            $stmt->execute([':f' => ProviderKinds::ROUTER_FORMAT]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        } catch (Throwable $e) {
            error_log('[DecisionProviders] rows lookup failed: ' . $e->getMessage());
            return [];
        }
        return array_values(array_filter($rows, fn(array $r) => !$enabledOnly || !empty($r['enabled'])));
    }

    /** The enabled decision row for a key, null when there is none. */
    public static function row(PDO $db, string $key): ?array
    {
        foreach (self::rows($db) as $r) {
            if ((string) $r['provider_key'] === $key) {
                return $r;
            }
        }
        return null;
    }

    /** @return list<string> every decision key, enabled or not (quota, key screens). */
    public static function keys(PDO $db): array
    {
        return array_map('strval', array_column(self::rows($db, false), 'provider_key'));
    }

    public static function protocolOf(array $row): ?array
    {
        return DecisionProtocols::get(isset($row['protocol']) ? (string) $row['protocol'] : null);
    }

    /** Env var stem for a row key: upper case, every char outside A-Z0-9 -> '_'. */
    public static function envStem(string $key): string
    {
        return (string) preg_replace('/[^A-Z0-9]/', '_', strtoupper($key));
    }
}
