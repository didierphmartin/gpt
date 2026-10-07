-- 2026-10-07_scheduled_workflows_cron.sql — cron schedules + stale-run reclaim for scheduled_workflows.
-- Additive only: this database is shared with production. Safe to re-run: each change checks
-- information_schema first. MySQL 8.x syntax.

-- repeat_type gains 'cron' (existing values kept, same order).
SET @s = (SELECT IF(COLUMN_TYPE NOT LIKE '%''cron''%',
  'ALTER TABLE scheduled_workflows MODIFY repeat_type ENUM(''none'',''hourly'',''daily'',''weekly'',''monthly'',''cron'') DEFAULT ''none''', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_workflows' AND COLUMN_NAME = 'repeat_type');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE scheduled_workflows ADD COLUMN cron VARCHAR(100) DEFAULT NULL AFTER repeat_interval', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_workflows' AND COLUMN_NAME = 'cron');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE scheduled_workflows ADD COLUMN running_since DATETIME DEFAULT NULL AFTER next_run', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_workflows' AND COLUMN_NAME = 'running_since');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
