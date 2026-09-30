-- 2026-09-29_jev_router_row.sql — the Jev router row.
-- Jev (TypeSafe) routes dispatcher nodes; it is NOT a chat provider. This row
-- only stores its global key (the admin sets it in gpt_admin LLM settings);
-- per-user keys live in user_api_keys with provider = 'jev'. api_format
-- 'router' is what keeps it out of every chat path (ProviderKinds.php).
-- Idempotent without relying on a UNIQUE index: an install that already has a
-- 'jev' row keeps it untouched. Plain INSERT (not INSERT IGNORE) so a bad
-- value or column type fails loudly instead of storing a broken row.
INSERT INTO system_llm_settings
  (provider_key, display_name, api_key, model, base_url, max_tokens, temperature,
   chat_endpoint, streaming, supports_tools, supported_models, api_format,
   system_prompt, enabled, sort_order, price_input_per_1m, price_output_per_1m)
SELECT
  'jev', 'Jev (dispatcher routing)', '', 'jev-latest', NULL, NULL, NULL,
  NULL, 0, 0, NULL, 'router', NULL, 1, 100, 0.042, 0
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM system_llm_settings WHERE provider_key = 'jev');

-- A row created before prices were known: fill them once, never overwrite an admin's edit.
-- Jev pricing (docs.typesafe.ai/models): $0.042 per 1M input tokens, output free.
UPDATE system_llm_settings
   SET price_input_per_1m = 0.042, price_output_per_1m = 0
 WHERE provider_key = 'jev' AND price_input_per_1m IS NULL AND price_output_per_1m IS NULL;

-- Verify: this must return exactly one row, with api_format 'router' and prices 0.042 / 0:
--   SELECT provider_key, api_format, enabled, price_input_per_1m, price_output_per_1m FROM system_llm_settings WHERE provider_key='jev';
