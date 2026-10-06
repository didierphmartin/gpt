-- 2026-10-06_roles_robot_publishing.sql — custom roles, the robot service account, published playbooks.
-- Roles reuse `packages`: the role key becomes free text, plus a display name and a built-in flag.
--
-- Safe to re-run after a partial failure (MySQL DDL commits implicitly): every change checks
-- information_schema first and runs through PREPARE/EXECUTE, or is an INSERT ... WHERE NOT EXISTS.
-- MySQL 8.x syntax only (no ADD COLUMN IF NOT EXISTS). Dry run: docker/tests/migration-2026-10-06-dry-run.sh

-- packages.role: ENUM -> VARCHAR(64) (keeps the values and the primary key).
SET @s = (SELECT IF(COUNT(*) > 0,
  'ALTER TABLE packages MODIFY role VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'packages' AND COLUMN_NAME = 'role' AND DATA_TYPE = 'enum');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE packages ADD COLUMN name VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER role', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'packages' AND COLUMN_NAME = 'name');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE packages ADD COLUMN builtin TINYINT(1) NOT NULL DEFAULT 0 AFTER name', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'packages' AND COLUMN_NAME = 'builtin');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- A name an admin has since given a built-in role is kept on a re-run.
UPDATE packages SET builtin = 1, name = COALESCE(name, CONCAT(UPPER(LEFT(role, 1)), SUBSTRING(role, 2)))
 WHERE role IN ('guest', 'prospect', 'user', 'admin');

-- users.role: ENUM -> VARCHAR(64), same default; users.kind: person | service.
SET @s = (SELECT IF(COUNT(*) > 0,
  'ALTER TABLE users MODIFY role VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT ''prospect''', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role' AND DATA_TYPE = 'enum');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE users ADD COLUMN kind ENUM(''person'', ''service'') NOT NULL DEFAULT ''person'' AFTER role', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'kind');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- playbooks: who published the robot copy, when, and from which source playbook.
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE playbooks ADD COLUMN published_by INT DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playbooks' AND COLUMN_NAME = 'published_by');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE playbooks ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playbooks' AND COLUMN_NAME = 'published_at');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE playbooks ADD COLUMN source_id INT DEFAULT NULL', 'DO 0')
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playbooks' AND COLUMN_NAME = 'source_id');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The robot's package (a copy of user) and the robot service account, once each.
INSERT INTO packages (role, name, builtin, capabilities)
SELECT 'robot', 'Robot', 1, COALESCE((SELECT capabilities FROM packages p WHERE p.role = 'user'), JSON_OBJECT())
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM packages WHERE role = 'robot');
INSERT INTO users (email, first_name, last_name, password, provider, role, kind, email_verified)
SELECT 'robot@synergyai.invalid', 'SynergyAI', 'Operations', NULL, 'email', 'robot', 'service', 1
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE kind = 'service');
-- Verify: SELECT id, email, role, kind FROM users WHERE kind = 'service';
