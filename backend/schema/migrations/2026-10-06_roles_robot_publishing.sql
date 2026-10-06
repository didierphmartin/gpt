-- 2026-10-06_roles_robot_publishing.sql — custom roles, the robot service account, published playbooks.
-- Roles reuse `packages`: the role key becomes free text, plus a display name and a built-in flag.
ALTER TABLE packages
  MODIFY role VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  ADD COLUMN name VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER role,
  ADD COLUMN builtin TINYINT(1) NOT NULL DEFAULT 0 AFTER name;
UPDATE packages SET builtin = 1, name = CONCAT(UPPER(LEFT(role, 1)), SUBSTRING(role, 2))
 WHERE role IN ('guest', 'prospect', 'user', 'admin');

ALTER TABLE users
  MODIFY role VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT 'prospect',
  ADD COLUMN kind ENUM('person', 'service') NOT NULL DEFAULT 'person' AFTER role;

ALTER TABLE playbooks
  ADD COLUMN published_by INT DEFAULT NULL,
  ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN source_id INT DEFAULT NULL;

INSERT INTO packages (role, name, builtin, capabilities)
SELECT 'robot', 'Robot', 1, COALESCE((SELECT capabilities FROM packages p WHERE p.role = 'user'), JSON_OBJECT())
 WHERE NOT EXISTS (SELECT 1 FROM packages WHERE role = 'robot');
INSERT INTO users (email, first_name, last_name, password, provider, role, kind, email_verified)
SELECT 'robot@synergyai.invalid', 'SynergyAI', 'Operations', NULL, 'email', 'robot', 'service', 1
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE kind = 'service');
-- Verify: SELECT id, email, role, kind FROM users WHERE kind = 'service';
