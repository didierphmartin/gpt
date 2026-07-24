-- Migration: prompt_library.user_id  varchar(255) -> INT
-- Item #8 in docs/backend-parity-tracker.md
--
-- Why: user_id holds the integer user id (users.id is INT, JWT `sub` is int) but
-- the column is varchar(255). That forces implicit casts on every query (index
-- inefficiency at scale), allows inconsistent values ('5' vs '05'), and blocks a
-- proper foreign key to users(id).
--
-- Safety (verified against the live DB on 2026-06-30):
--   * 10 rows, 0 non-integer user_id values, max numeric user_id = 6 (INT max 2,147,483,647)
--   * indexes idx_user_parent (user_id, parent_id) and idx_user_type (user_id, type)
--     rebuild automatically as part of MODIFY COLUMN.
-- Run the pre-flight check below first; it MUST return 0 before applying.

-- ---------------------------------------------------------------------------
-- 1) Pre-flight: must return 0. If not, clean those rows before continuing.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS non_integer_user_ids
FROM prompt_library
WHERE user_id NOT REGEXP '^[0-9]+$';

-- ---------------------------------------------------------------------------
-- 2) The change.
-- ---------------------------------------------------------------------------
ALTER TABLE prompt_library
  MODIFY COLUMN user_id INT NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) OPTIONAL: add the foreign key to users(id).
--    Currently BLOCKED by 1 orphaned row (a user_id with no matching users.id).
--    Find the orphan(s) first:
--
--      SELECT p.id, p.user_id
--      FROM prompt_library p
--      LEFT JOIN users u ON p.user_id = u.id
--      WHERE u.id IS NULL;
--
--    After deleting/reassigning the orphan(s), you may add:
--
--      ALTER TABLE prompt_library
--        ADD CONSTRAINT fk_prompt_library_user
--        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Rollback (if ever needed):
--   ALTER TABLE prompt_library
--     MODIFY COLUMN user_id VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL;
-- ---------------------------------------------------------------------------
