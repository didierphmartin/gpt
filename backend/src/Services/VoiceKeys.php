<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Throwable;

/**
 * The key a voice provider uses for one user, found in the DB like every other
 * key: the user's own voice key (Settings -> voice), then -- for a voice
 * provider that is also a chat provider (gemini, grok) -- the user's own chat
 * key, the package's default key and the admin's chat row; for the others
 * (hume) the admin's voice row (system_llm_settings, api_format 'voice'). The
 * server's .env key is only the last default. Gemini and Grok get none when
 * the user's package does not allow them. Keys stay on the server: the
 * browser only ever gets a short-lived token minted with them.
 */
final class VoiceKeys
{
    /** Voice providers that are also chat providers, so their chat keys serve. */
    private const CHAT_BACKED = ['gemini', 'grok'];

    /** The ai_config.php block holding each provider's .env default. */
    private const SERVER_DEFAULTS = ['gemini' => 'gemini_voice', 'grok' => 'grok_voice', 'hume' => 'hume_evi'];

    public static function resolve(PDO $db, array $config, ?int $userId, string $provider): string
    {
        $chatBacked = in_array($provider, self::CHAT_BACKED, true);
        $package = $chatBacked ? DecisionKeyResolver::packageEntry($db, $userId, $provider) : [];
        if ($package === false) {
            return '';
        }

        $secret = ApiKeyCrypto::secret($config);
        if ($userId !== null && $userId > 0) {
            $voiceKey = self::userVoiceKey($db, $secret, $userId, $provider);
            if ($voiceKey !== '') {
                return $voiceKey;
            }
        }

        $admin = LLMProviderResolver::applyDbSettings($db, []);
        if ($chatBacked) {
            if ($userId !== null && $userId > 0) {
                [$userKey] = DecisionKeyResolver::userRow($db, $secret, $userId, $provider);
                if ($userKey !== '') {
                    return $userKey;
                }
            }
            $packageKey = trim((string) ($package['default_api_key'] ?? ''));
            if ($packageKey !== '') {
                return $packageKey;
            }
            $adminKey = trim((string) ($admin['providers'][$provider]['api_key'] ?? ''));
        } else {
            $adminKey = trim((string) ($admin['voice_providers'][$provider]['api_key'] ?? ''));
        }
        if ($adminKey !== '') {
            return $adminKey;
        }

        $block = self::SERVER_DEFAULTS[$provider] ?? null;
        return $block !== null ? trim((string) ($config[$block]['api_key'] ?? '')) : '';
    }

    /** The user's own key from Settings -> voice ('' when none or switched off). */
    private static function userVoiceKey(PDO $db, string $secret, int $userId, string $provider): string
    {
        try {
            $stmt = $db->prepare("SELECT api_key FROM user_provider_settings
                WHERE user_id = :u AND category = 'voice' AND provider = :p AND enabled = 1 LIMIT 1");
            $stmt->execute([':u' => $userId, ':p' => $provider]);
            $stored = $stmt->fetchColumn();
        } catch (Throwable $e) {
            return ''; // table not created yet on this install
        }
        return is_string($stored) ? ApiKeyCrypto::reveal($stored, $secret) : '';
    }
}
