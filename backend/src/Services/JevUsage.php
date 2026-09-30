<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Throwable;

/**
 * One usage row per Jev call that TypeSafe answered, written like an LLM call
 * (UsageLogger -> llm_usage_transactions + llm_usage_balance) so both apps'
 * usage and cost screens show it. A call that was never sent (not allowed, no
 * key, an unusable menu) costs nothing and records nothing.
 */
final class JevUsage
{
    public const MODEL = 'jev-latest';

    /** TypeSafe answered: JevRouter sets ms only once a response came back. */
    public static function shouldRecord(array $jevOut): bool
    {
        return ($jevOut['ms'] ?? null) !== null;
    }

    public static function transaction(int $userId, array $jevOut): array
    {
        $isError = ($jevOut['outcome'] ?? null) === 'error';
        return [
            'user_id' => $userId,
            'provider' => ProviderKinds::JEV_KEY,
            'model' => self::MODEL,
            'prompt_tokens' => (int) ($jevOut['usage']['input_tokens'] ?? 0),
            'completion_tokens' => (int) ($jevOut['usage']['output_tokens'] ?? 0),
            'response_time_ms' => (int) $jevOut['ms'],
            'status' => $isError ? 'error' : 'success',
            'error_message' => $isError ? (string) ($jevOut['reason'] ?? '') : null,
            'request_metadata' => ['jev_outcome' => (string) ($jevOut['outcome'] ?? '')],
        ];
    }

    public static function record(UsageLogger $logger, ?int $userId, array $jevOut): void
    {
        if ($userId === null || $userId <= 0 || !self::shouldRecord($jevOut)) {
            return;
        }
        try {
            $logger->logTransaction(self::transaction($userId, $jevOut));
        } catch (Throwable $e) {
            // Usage is bookkeeping: it must never turn a routed request into a failure.
            error_log('[JevUsage] could not record a Jev call: ' . $e->getMessage());
        }
    }
}
