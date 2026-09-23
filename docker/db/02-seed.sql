-- Provider catalog seed for a fresh install.
--
-- Source of truth: backend/src/Controllers/SystemSettingsController.php,
-- the $providerDefaults array inside getProvidersFromConfig() (~lines
-- 150-217), plus the field defaults applied in the loop that follows
-- (~lines 219-246). That is what the app itself serves when the database
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

INSERT INTO `system_llm_settings`
  (`provider_key`, `display_name`, `api_key`, `model`, `base_url`, `max_tokens`, `temperature`, `chat_endpoint`, `streaming`, `supports_tools`, `supported_models`, `api_format`, `system_prompt`, `enabled`, `sort_order`)
VALUES
('claude', 'Claude', '', 'claude-sonnet-4-5', 'https://api.anthropic.com', 64000, 0.70, '/v1/messages', 1, 1, NULL, 'anthropic', NULL, 1, 0),
('openai', 'OpenAI', '', 'gpt-4o', 'https://api.openai.com', 4096, 0.70, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 1),
('gemini', 'Gemini', '', 'gemini-2.0-flash', 'https://generativelanguage.googleapis.com', 8192, 0.70, '/v1beta/models', 1, 1, NULL, 'gemini', NULL, 1, 2),
('grok', 'Grok', '', 'grok-2-latest', 'https://api.x.ai', 4096, 0.70, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 3),
('deepseek', 'DeepSeek', '', 'deepseek-chat', 'https://api.deepseek.com', 4096, 0.70, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 4),
('kimi', 'Kimi', '', 'moonshot-v1-auto', 'https://api.moonshot.ai', 4096, 0.70, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 5),
('gamma4', 'Gamma4', '', 'Gemma-4-E4B-it', 'https://g4eb.yellowbrickroad.info', 4096, 0.70, '/v1/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 6),
('glm', 'GLM 5.2', '', 'glm-5.2', 'https://api.z.ai/api/paas/v4', 4096, 0.70, '/chat/completions', 1, 1, NULL, 'openai', NULL, 1, 7);
