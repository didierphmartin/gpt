-- 2026-10-29_active_workflows_per_workflow.sql -- the robot can be active on several workflows at once (spec 2026-10-29
-- workflow-robot-owner, task 6): active_workflows is keyed (user_id, workflow_id) instead of user_id alone. A person
-- still keeps one row (the service replaces it); the robot keeps one row per workflow. idx_active_workflows_workflow
-- and fk_active_workflows_workflow stay as they are.
--
-- Deploy order: apply this only AFTER synergyaichat.com (and every other install on this database) runs the code of
-- this change. An old event worker keys its slots by user: with two robot rows it would flip between them.
--
-- This database is shared with production. Safe to re-run after a partial failure (MySQL DDL commits implicitly): the
-- change checks information_schema first and runs through PREPARE/EXECUTE. MySQL 8.x syntax only. The user runs it;
-- nothing here runs automatically. Existing rows already satisfy the wider key (one per user).

SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE active_workflows DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, workflow_id)', 'DO 0')
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'active_workflows' AND INDEX_NAME = 'PRIMARY');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
