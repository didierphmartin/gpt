-- 2026-10-28_code_component_args_provides.sql — code components declare their arguments and what they provide
-- (spec 2026-10-28 component-args-and-placeholders). Additive only: this database is shared with production.
-- Safe to re-run: each change checks information_schema first. MySQL 8.x syntax.

-- args: [{"name", "description"?, "default"?, "required"?}]; NULL reads as an empty list.
SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE code_components ADD COLUMN args JSON DEFAULT NULL AFTER start_trigger', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'code_components' AND COLUMN_NAME = 'args');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- provides: [{"name", "description"?}] — the meta names the component's output carries on; NULL reads as an empty list.
SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE code_components ADD COLUMN provides JSON DEFAULT NULL AFTER args', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'code_components' AND COLUMN_NAME = 'provides');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
