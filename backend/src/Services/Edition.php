<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Which edition this backend runs as: 'individual', 'corporate', or '' (hosted).
 * Set by the container entrypoint from GPT_EDITION, which the compose files choose.
 */
final class Edition
{
    public static function current(array $config): string
    {
        return (string) ($config['edition'] ?? '');
    }

    public static function isCorporate(array $config): bool
    {
        return self::current($config) === 'corporate';
    }

    /**
     * On a corporate install every session comes from the login service via
     * sso_exchange; gpt's own credential paths must not issue one.
     */
    public static function refuseLocalSignIn(array $config): ?array
    {
        if (!self::isCorporate($config)) {
            return null;
        }
        return [
            'success' => false,
            'message' => 'This installation signs in through its login service.',
            'status_code' => 403,
        ];
    }
}
