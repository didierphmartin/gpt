-- Provider catalog seed for a fresh install.
--
-- Source of truth: backend/src/Controllers/SystemSettingsController.php,
-- the $providerDefaults array inside getProvidersFromConfig() (~lines
-- 123-198), plus the field defaults applied in the loop that follows
-- (~lines 201-234). Each row's model is that provider's balanced current
-- model, and its prices are that model's entry in
-- backend/resources/model_catalog.json (docker/tests/seed-test.sh checks
-- both). That is what the app itself serves when the database
-- has no rows, so this seed agrees with the app by construction.
--
-- api_key is '' for every row, always. Keys are entered by the admin in
-- the app after install; this file is structurally incapable of carrying
-- one -- do not hand-add a value here.
--
-- Do not "fix" the kimi base_url below to match the controller's
-- 'https://api.moonshot.cn' fallback. That is a deliberate divergence
-- (ruling R7b): KimiProvider.php:38 is what the runtime actually calls,
-- and it uses 'https://api.moonshot.ai' ('.cn' is the China endpoint).
-- The controller's inconsistency is flagged for a later review, not fixed
-- here.
--
-- The last row, `jev`, is NOT a chat provider. It is a router row
-- (api_format 'router'): TypeSafe's Jev routes dispatcher nodes, and this row
-- only holds its global key. It has no base_url; its price is $0.042 per 1M
-- input tokens, output free. Every chat path skips it (see backend/src/Services/ProviderKinds.php).

INSERT INTO `system_llm_settings`
  (`provider_key`, `display_name`, `api_key`, `model`, `base_url`, `max_tokens`, `temperature`, `price_input_per_1m`, `price_output_per_1m`, `chat_endpoint`, `streaming`, `supports_tools`, `supported_models`, `api_format`, `system_prompt`, `enabled`, `sort_order`)
VALUES
('claude', 'Claude', '', 'claude-sonnet-5', 'https://api.anthropic.com', 64000, 0.70, 2.00, 10.00, '/v1/messages', 1, 1, NULL, 'anthropic', NULL, 1, 0),
('openai', 'OpenAI', '', 'gpt-5.6-terra', 'https://api.openai.com', 4096, 0.70, 2.00, 12.00, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 1),
('gemini', 'Gemini', '', 'gemini-3.6-flash', 'https://generativelanguage.googleapis.com', 8192, 0.70, 0.75, 3.75, '/v1beta/models', 1, 1, NULL, 'gemini', NULL, 1, 2),
('grok', 'Grok', '', 'grok-4.6', 'https://api.x.ai', 4096, 0.70, 2.00, 6.00, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 3),
('deepseek', 'DeepSeek', '', 'deepseek-v4-pro', 'https://api.deepseek.com', 4096, 0.70, 0.66, 1.98, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 4),
('kimi', 'Kimi', '', 'kimi-k2.6', 'https://api.moonshot.ai', 4096, 0.70, 0.95, 4.00, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 5),
('gamma4', 'Gamma4', '', 'Gemma-4-E4B-it', 'https://g4eb.yellowbrickroad.info', 4096, 0.70, 0.00, 0.00, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 6),
('glm', 'GLM 5.2', '', 'glm-5.2', 'https://api.z.ai/api/paas/v4', 4096, 0.70, 1.40, 4.40, '/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 7),
('jev', 'Jev (dispatcher routing)', '', 'jev-latest', NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'router', NULL, 1, 100);

-- Jev is not in the model catalog, so its row carries no catalog price; its
-- price is fixed by its vendor and set here ($0.042 per 1M input, output free).
UPDATE `system_llm_settings`
   SET `price_input_per_1m` = 0.042, `price_output_per_1m` = 0
 WHERE `provider_key` = 'jev' AND `price_input_per_1m` IS NULL AND `price_output_per_1m` IS NULL;
