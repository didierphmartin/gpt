<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * The Gemini key a user's voice sessions use, found like every other provider
 * key: the user's own key, else the package's default key, else the admin's
 * (system_llm_settings), else the server's GEMINI_VOICE_API_KEY -- and none
 * when the user's package does not allow Gemini. It stays on the server: the
 * browser only ever gets a single-use Live token minted with it.
 */
final class GeminiVoiceKey
{
    public static function resolve(PDO $db, array $config, ?int $userId): string
    {
        $package = DecisionKeyResolver::packageEntry($db, $userId, 'gemini');
        if ($package === false) {
            return '';
        }

        if ($userId !== null && $userId > 0) {
            [$userKey] = DecisionKeyResolver::userRow($db, ApiKeyCrypto::secret($config), $userId, 'gemini');
            if ($userKey !== '') {
                return $userKey;
            }
        }

        $packageKey = trim((string) ($package['default_api_key'] ?? ''));
        if ($packageKey !== '') {
            return $packageKey;
        }

        $adminKey = trim((string) (LLMProviderResolver::applyDbSettings($db, [])['providers']['gemini']['api_key'] ?? ''));
        if ($adminKey !== '') {
            return $adminKey;
        }

        return trim((string) ($config['gemini_voice']['api_key'] ?? ''));
    }
}
