<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Pure helpers for affiliate keys and link construction. No DB access.
 */
final class AffiliateSupport
{
    private const KEY_LENGTH = 16;
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    /** Generate a URL-safe random affiliate key. Uniqueness vs. the DB is the caller's job. */
    public static function generateKey(): string
    {
        $max = strlen(self::ALPHABET) - 1;
        $out = '';
        for ($i = 0; $i < self::KEY_LENGTH; $i++) {
            $out .= self::ALPHABET[random_int(0, $max)];
        }
        return $out;
    }

    /** Append ?ref=KEY (or &ref=KEY) to a sales-page URL. */
    public static function buildLink(string $salesPageUrl, string $key): string
    {
        $url = trim($salesPageUrl);
        $sep = str_contains($url, '?') ? '&' : '?';
        return $url . $sep . 'ref=' . rawurlencode($key);
    }
}
