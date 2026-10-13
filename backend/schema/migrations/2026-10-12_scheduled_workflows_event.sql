-- 2026-10-12_scheduled_workflows_event.sql — event-triggered schedules (spec 2026-10-12 mail/drive events §8).
-- Additive only: this database is shared with production. Safe to re-run: each change checks
-- information_schema first. MySQL 8.x syntax.
--
-- An 'event' schedule has no next_run (NULL), so no scheduler tick -- PHP, TypeScript, Python, or an
-- older deployed version -- ever claims it: they all select next_run <= NOW(). Its trigger is used by a
-- compiled script's --watch.

-- repeat_type gains 'event' (existing values kept, same order).
SET @s = (SELECT IF(COLUMN_TYPE NOT LIKE '%''event''%',
  'ALTER TABLE scheduled_workflows MODIFY repeat_type ENUM(''none'',''hourly'',''daily'',''weekly'',''monthly'',''cron'',''event'') DEFAULT ''none''', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_workflows' AND COLUMN_NAME = 'repeat_type');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The trigger: {"server": <MCP server name>, "tool": ..., "args": {...}} (JSON text).
SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE scheduled_workflows ADD COLUMN event_trigger TEXT DEFAULT NULL AFTER cron', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_workflows' AND COLUMN_NAME = 'event_trigger');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
