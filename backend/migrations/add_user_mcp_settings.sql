-- Per-user master switch for MCP tools. Absent row = enabled (default on).
-- Applies to the shared chatbot DB used by the backend. Idempotent.
CREATE TABLE IF NOT EXISTS `user_mcp_settings` (
  `user_id` BIGINT NOT NULL,
  `mcp_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Per-user MCP master on/off switch';
