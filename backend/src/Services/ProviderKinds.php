<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Which system_llm_settings rows are chat providers, and which are not.
 *
 * The table holds every model key the admin manages, and almost every row is a
 * chat provider: text in, text out. A ROUTER row is not. Jev (TypeSafe's
 * dispatcher router) answers a closed question with a choice and cannot write
 * a single sentence, so it must never be offered, registered, or fallen back
 * to as a chat provider -- it only borrows the table for key storage.
 *
 * `api_format = 'router'` is the one marker. Every reader that treats rows as
 * "providers that can answer a prompt" skips rows for which isRouterRow() is
 * true; keyed lookups (provider -> model) need not, since no chat node can
 * name a router.
 */
final class ProviderKinds
{
    public const ROUTER_FORMAT = 'router';

    /** The one router known today. Router rows are allowed for these keys only. */
    public const JEV_KEY = 'jev';

    /** @var list<string> */
    public const ROUTER_KEYS = [self::JEV_KEY];

    /** A system_llm_settings row (or a provider block built from one) that is a router. */
    public static function isRouterRow(array $row): bool
    {
        return ($row['api_format'] ?? null) === self::ROUTER_FORMAT;
    }
}
