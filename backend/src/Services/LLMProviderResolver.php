<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Exception;

/**
 * LLM provider config resolver.
 *
 * Loads enabled provider rows from `system_llm_settings` and overlays them on
 * the runtime config. As of the 2026-05 cutover, this is the *source* of LLM
 * provider config (the ai_config.php blocks were removed); per-user
 * overrides still apply on top in `ChatController::applyUserApiKeys`.
 *
 * Placement of each provider matches what
 * `AIPortfolioAssistant::initializeDefaultProvider` reads:
 *   - `claude`, `openai`           → at config root
 *   - everything else (`kimi`, `grok`, `gemini`, `deepseek`, …) → nested
 *     under `config['providers'][<key>]`
 */
class LLMProviderResolver
{
    private const ROOT_PROVIDERS = ['claude', 'openai'];

    /**
     * Return $config with provider blocks built from `system_llm_settings`.
     * Failures (table missing, permission denied) log and return the input
     * unchanged so the caller doesn't crash on an environment that hasn't
     * been seeded yet.
     */
    public static function applyDbSettings(PDO $db, array $config): array
    {
        try {
            $stmt = $db->query("SHOW TABLES LIKE 'system_llm_settings'");
            if ($stmt->rowCount() === 0) {
                return $config;
            }

            $rows = $db
                ->query("SELECT * FROM system_llm_settings WHERE enabled = 1")
                ->fetchAll(PDO::FETCH_ASSOC);

            if (!isset($config['providers']) || !is_array($config['providers'])) {
                $config['providers'] = [];
            }

            foreach ($rows as $row) {
                $key = $row['provider_key'];
                $built = self::buildProviderFromDb($row);

                if (in_array($key, self::ROOT_PROVIDERS, true)) {
                    $existing = $config[$key] ?? [];
                    $config[$key] = array_merge($existing, $built);
                } else {
                    $existing = $config['providers'][$key] ?? [];
                    $config['providers'][$key] = array_merge($existing, $built);
                }
            }
        } catch (Exception $e) {
            error_log("[LLMProviderResolver] applyDbSettings failed: " . $e->getMessage());
        }

        return $config;
    }

    /**
     * Build a provider config block from one `system_llm_settings` row.
     * Skips empty/null fields so a sparsely populated row doesn't clobber
     * sensible defaults that downstream code may rely on.
     */
    public static function buildProviderFromDb(array $row): array
    {
        $cfg = [];
        if (!empty($row['display_name']))   $cfg['display_name']   = $row['display_name'];
        if (!empty($row['model']))          $cfg['model']          = $row['model'];
        if (!empty($row['api_key']))        $cfg['api_key']        = $row['api_key'];
        if (!empty($row['base_url']))       $cfg['base_url']       = $row['base_url'];
        if (!empty($row['chat_endpoint']))  $cfg['chat_endpoint']  = $row['chat_endpoint'];
        if (!empty($row['api_format']))     $cfg['api_format']     = $row['api_format'];
        if (isset($row['max_tokens']) && $row['max_tokens'] !== null && $row['max_tokens'] !== '') {
            $cfg['max_tokens'] = (int)$row['max_tokens'];
        }
        if (isset($row['temperature']) && $row['temperature'] !== null && $row['temperature'] !== '') {
            $cfg['temperature'] = (float)$row['temperature'];
        }
        if (!empty($row['system_prompt']))  $cfg['system_prompt']  = $row['system_prompt'];
        if (isset($row['streaming']))       $cfg['streaming']      = (bool)$row['streaming'];
        if (isset($row['supports_tools']))  $cfg['supports_tools'] = (bool)$row['supports_tools'];
        if (!empty($row['supported_models'])) {
            $decoded = json_decode($row['supported_models'], true);
            if (is_array($decoded)) {
                $cfg['supported_models'] = $decoded;
            }
        }
        return $cfg;
    }
}
