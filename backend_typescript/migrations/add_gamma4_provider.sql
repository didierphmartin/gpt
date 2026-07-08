-- Register the Gamma4 LLM provider (OpenAI-compatible, function/tool-calling capable).
--
-- Applies to the shared `chatbot` database used by BOTH backends (PHP `backend/` and
-- `backend_typescript/`): they resolve providers from the same `system_llm_settings` table,
-- so this one migration registers Gamma4 everywhere. Mirrors how heal_spend.sql is a
-- standalone, manually-applied migration.
--
-- Idempotent: re-running is a no-op (guarded by NOT EXISTS on provider_key).
--
-- The API key is intentionally left NULL. Like every other provider, the secret is entered via
-- the admin UI (Global Settings > LLM providers) or a direct UPDATE — never committed to git
-- (only .env is gitignored here). Until a key is set the row is registered but isAvailable()
-- returns false, so Gamma4 stays safely inert rather than erroring.
--
-- Endpoint (from the OpenAI SDK snippet): base_url https://g4eb.yellowbrickroad.info/v1 ,
-- model Gemma-4-E4B-it. Stored split per this table's convention: base_url = origin root,
-- chat_endpoint = /v1/chat/completions (base_url + chat_endpoint == the SDK base_url + path).
-- Pricing is 0 because the Gamma4 model is free.
INSERT INTO `system_llm_settings`
    (`provider_key`, `display_name`, `api_key`, `model`, `base_url`, `max_tokens`, `temperature`,
     `price_input_per_1m`, `price_output_per_1m`, `chat_endpoint`, `streaming`, `supports_tools`,
     `supported_models`, `api_format`, `enabled`, `sort_order`)
SELECT
    'gamma4', 'Gamma4', NULL, 'Gemma-4-E4B-it', 'https://g4eb.yellowbrickroad.info', 4096, 0.70,
    0.0000, 0.0000, '/v1/chat/completions', 1, 1,
    '["Gemma-4-E4B-it"]', 'openai', 1, 7
WHERE NOT EXISTS (
    SELECT 1 FROM `system_llm_settings` WHERE `provider_key` = 'gamma4'
);

-- To activate, set the key (kept out of version control):
--   UPDATE `system_llm_settings` SET `api_key` = '<GAMMA4_API_KEY>' WHERE `provider_key` = 'gamma4';
-- or paste it in the admin dashboard under Global Settings > LLM providers > Gamma4.
