-- 2026-10-07_decision_protocol.sql — decision-model providers.
-- A router row (api_format 'router') names the protocol its adapter speaks
-- (DecisionProtocols.php). NULL = not usable until an admin sets it.
-- Additive: code that predates this column ignores it.
ALTER TABLE system_llm_settings ADD COLUMN protocol VARCHAR(64) NULL DEFAULT NULL AFTER api_format;

UPDATE system_llm_settings SET protocol = 'typesafe'
 WHERE provider_key = 'jev' AND api_format = 'router' AND protocol IS NULL;

-- Verify:
--   SELECT provider_key, api_format, protocol FROM system_llm_settings WHERE api_format = 'router';
