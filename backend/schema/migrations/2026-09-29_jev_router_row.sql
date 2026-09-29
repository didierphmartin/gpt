-- 2026-09-29_jev_router_row.sql — the Jev router row.
-- Jev (TypeSafe) routes dispatcher nodes; it is NOT a chat provider. This row
-- only stores its global key (the admin sets it in gpt_admin LLM settings);
-- per-user keys live in user_api_keys with provider = 'jev'. api_format
-- 'router' is what keeps it out of every chat path (ProviderKinds.php).
-- INSERT IGNORE: an install that already has a 'jev' row keeps it untouched.
INSERT IGNORE INTO system_llm_settings
  (provider_key, display_name, api_key, model, base_url, max_tokens, temperature,
   chat_endpoint, streaming, supports_tools, supported_models, api_format,
   system_prompt, enabled, sort_order)
VALUES
  ('jev', 'Jev (dispatcher routing)', '', 'jev-latest', NULL, NULL, NULL,
   NULL, 0, 0, NULL, 'router', NULL, 1, 100);
