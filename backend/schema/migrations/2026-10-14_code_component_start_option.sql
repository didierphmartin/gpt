-- 2026-10-14_code_component_start_option.sql — code components as Start options
-- (spec 2026-10-13 start-trigger-options §2). Additive only: this database is shared with production.
-- Safe to re-run: each change checks information_schema first. MySQL 8.x syntax.

-- The option: {"label", "watch": {"server", "tool", "args"}, "work_exit"} (JSON text); NULL = not an option.
SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE code_components ADD COLUMN start_trigger TEXT DEFAULT NULL AFTER timeout_s', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'code_components' AND COLUMN_NAME = 'start_trigger');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The component whose option made this an event schedule; event_trigger keeps the watch itself.
SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE scheduled_workflows ADD COLUMN trigger_component_id INT UNSIGNED DEFAULT NULL AFTER event_trigger', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_workflows' AND COLUMN_NAME = 'trigger_component_id');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
