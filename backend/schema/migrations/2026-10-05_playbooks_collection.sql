-- 2026-10-05_playbooks_collection.sql — the playbook collection.
-- A playbook is content: its Console text, stored verbatim, and a key that
-- names it (unique per user). Playbook agents link to one by playbook_id;
-- playbook workflow nodes keep playbook_id in their config JSON.
CREATE TABLE IF NOT EXISTS playbooks (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  pkey VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  title VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  text MEDIUMTEXT COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_playbooks_user_pkey (user_id, pkey),
  KEY idx_playbooks_user (user_id),
  CONSTRAINT playbooks_ibfk_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE agents
  ADD COLUMN playbook_id INT DEFAULT NULL AFTER instructions,
  ADD KEY idx_agents_playbook (playbook_id);
