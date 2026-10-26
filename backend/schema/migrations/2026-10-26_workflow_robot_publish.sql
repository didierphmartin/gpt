-- 2026-10-26_workflow_robot_publish.sql -- a workflow published to the robot (spec 2026-10-26 vip-mailboxes, task B2):
-- the robot's frozen copy records who published it, when, and from which source workflow.
--
-- Additive only: this database is shared with production. Safe to re-run after a partial failure (MySQL DDL commits
-- implicitly): every change checks information_schema first and runs through PREPARE/EXECUTE. MySQL 8.x syntax only
-- (no ADD COLUMN IF NOT EXISTS). The user runs it; nothing here runs automatically.

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE agent_workflows ADD COLUMN published_by INT NULL DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'published_by');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE agent_workflows ADD COLUMN published_at DATETIME NULL DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'published_at');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE agent_workflows ADD COLUMN source_id INT NULL DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'source_id');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The robot's copy of a workflow is looked up by (robot user, source workflow).
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE agent_workflows ADD KEY idx_agent_workflows_user_source (user_id, source_id)', 'DO 0')
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND INDEX_NAME = 'idx_agent_workflows_user_source');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
