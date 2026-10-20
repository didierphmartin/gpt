-- 2026-10-20_automations.sql -- the automation record (spec 2026-10-20 servicenow-automation-author, item 6).
-- Additive only: this database is shared with production. Safe to re-run: tables use IF NOT EXISTS and each
-- column change checks information_schema first. MySQL 8.x syntax. The user runs it; nothing here runs automatically.

CREATE TABLE IF NOT EXISTS automations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  automation_key VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  spec_json MEDIUMTEXT NOT NULL,
  playbook_id INT DEFAULT NULL,
  workflow_id INT DEFAULT NULL,
  sn_scope VARCHAR(100) DEFAULT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_automation_user_key (user_id, automation_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (automation, ServiceNow MCP server). The environment is NOT a column: the connector profile is its only
-- source; the last check keeps what it reported inside `detail` (JSON) for display only.
CREATE TABLE IF NOT EXISTS automation_instances (
  automation_id INT UNSIGNED NOT NULL,
  mcp_server_id INT NOT NULL,
  installed_version INT DEFAULT NULL,
  sn_item_sys_id VARCHAR(64) DEFAULT NULL,
  last_check_at TIMESTAMP NULL DEFAULT NULL,
  status ENUM('not_installed','in_sync','out_of_sync') NOT NULL DEFAULT 'not_installed',
  detail TEXT,
  PRIMARY KEY (automation_id, mcp_server_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE playbooks ADD COLUMN automation_id INT NULL DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playbooks' AND COLUMN_NAME = 'automation_id');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE agent_workflows ADD COLUMN automation_id INT NULL DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'automation_id');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
