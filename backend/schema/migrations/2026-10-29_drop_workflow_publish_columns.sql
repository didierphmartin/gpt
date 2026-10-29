-- 2026-10-29_drop_workflow_publish_columns.sql -- publish-to-robot copies of workflows are gone (spec 2026-10-29
-- workflow-robot-owner, task 9): a workflow now has an owner (a person or the robot) instead of a robot copy, so
-- agent_workflows.published_by / published_at / source_id and the index on (user_id, source_id) are dropped.
-- The playbooks table keeps its own published_by / published_at / source_id.
--
-- Deploy order: apply this only AFTER synergyaichat.com (and every other install on this database) runs the code of
-- this change -- the old code reads these columns -- and AFTER wf 76 (the robot's copy of wf 75) is deleted.
--
-- This database is shared with production. Safe to re-run after a partial failure (MySQL DDL commits implicitly): each
-- change checks information_schema first and runs through PREPARE/EXECUTE. MySQL 8.x syntax only. The index goes
-- before the column it covers. The user runs it; nothing here runs automatically.

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE agent_workflows DROP INDEX idx_agent_workflows_user_source', 'DO 0')
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND INDEX_NAME = 'idx_agent_workflows_user_source');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE agent_workflows DROP COLUMN source_id', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'source_id');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE agent_workflows DROP COLUMN published_at', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'published_at');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE agent_workflows DROP COLUMN published_by', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_workflows' AND COLUMN_NAME = 'published_by');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
