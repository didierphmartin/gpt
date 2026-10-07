<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Throwable;

/**
 * One usage row per decision-model call the vendor answered, written like an
 * LLM call (UsageLogger) under the decision row's key, so usage and cost
 * screens show it. A call never sent (not allowed, no key, bad menu) records nothing.
 */
final class DecisionUsage
{
    /** The vendor answered: adapters set ms only once a response came back. */
    public static function shouldRecord(array $out): bool
    {
        return ($out['ms'] ?? null) !== null;
    }

    public static function transaction(int $userId, string $providerKey, string $model, array $out): array
    {
        $isError = ($out['outcome'] ?? null) === 'error';
        return [
            'user_id' => $userId,
            'provider' => $providerKey,
            'model' => $model,
            'prompt_tokens' => (int) ($out['usage']['input_tokens'] ?? 0),
            'completion_tokens' => (int) ($out['usage']['output_tokens'] ?? 0),
            'response_time_ms' => (int) $out['ms'],
            'status' => $isError ? 'error' : 'success',
            'error_message' => $isError ? (string) ($out['reason'] ?? '') : null,
            'request_metadata' => ['decision_outcome' => (string) ($out['outcome'] ?? '')],
        ];
    }

    public static function record(UsageLogger $logger, ?int $userId, string $providerKey, string $model, array $out): void
    {
        if ($userId === null || $userId <= 0 || !self::shouldRecord($out)) {
            return;
        }
        try {
            $logger->logTransaction(self::transaction($userId, $providerKey, $model, $out));
        } catch (Throwable $e) {
            // Usage is bookkeeping: it must never turn a routed request into a failure.
            error_log('[DecisionUsage] could not record a decision call: ' . $e->getMessage());
        }
    }
}
