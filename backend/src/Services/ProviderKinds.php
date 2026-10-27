<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Which system_llm_settings rows are chat providers, and which are not.
 *
 * The table holds every model key the admin manages, and almost every row is a
 * chat provider: text in, text out. A ROUTER row is a decision
 * provider (DecisionProviders): it answers a closed question with a choice and
 * cannot write a sentence, so it must never be offered, registered, or fallen
 * back to as a chat provider -- it only borrows the table for key storage.
 *
 * A VOICE row (`api_format = 'voice'`, e.g. hume) is the admin's key for a
 * voice provider that is not a chat provider; it too only borrows the table.
 *
 * Every reader that treats rows as "providers that can answer a prompt" keeps
 * only rows for which isChatRow() is true; keyed lookups (provider -> model)
 * need not, since no chat node can name a router or a voice key.
 */
final class ProviderKinds
{
    public const ROUTER_FORMAT = 'router';
    public const VOICE_FORMAT = 'voice';

    /** The api_format values of rows that are not chat providers. */
    public const NON_CHAT_FORMATS = [self::ROUTER_FORMAT, self::VOICE_FORMAT];

    /** A system_llm_settings row (or a provider block built from one) that is a router. */
    public static function isRouterRow(array $row): bool
    {
        return ($row['api_format'] ?? null) === self::ROUTER_FORMAT;
    }

    /** A row (or a provider block built from one) holding a voice provider's key. */
    public static function isVoiceRow(array $row): bool
    {
        return ($row['api_format'] ?? null) === self::VOICE_FORMAT;
    }

    /** A row that can answer a prompt: neither a router nor a voice key. */
    public static function isChatRow(array $row): bool
    {
        return !in_array($row['api_format'] ?? null, self::NON_CHAT_FORMATS, true);
    }
}
