-- 2026-09-01_playbook_runs.sql — playbook interpreter run record (spec §Data model)
-- VARCHAR statuses (not enum): unit tests recreate these tables in SQLite.
-- `sensitive` is backtick-escaped below because it's a reserved word as of
-- MySQL 8.4 (closes an old deferral to actually quote it, not just note it).
CREATE TABLE IF NOT EXISTS playbook_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  playbook_title VARCHAR(255) NOT NULL,
  document JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  requester JSON NULL,
  variables JSON NULL,
  pending_gate JSON NULL,
  current_leg INT NOT NULL DEFAULT 0,
  coverage JSON NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_messages (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  direction VARCHAR(32) NOT NULL,          -- to_requester|from_requester|to_channel|to_email
  audience VARCHAR(255) NULL,
  text TEXT NOT NULL,
  `sensitive` TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pbm_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_notes (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  author VARCHAR(32) NOT NULL DEFAULT 'agent',
  text TEXT NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pbn_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_ledger (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  leg INT NOT NULL DEFAULT 0,
  seq INT NOT NULL,
  action_name VARCHAR(255) NOT NULL,       -- the #Action or native verb name
  tool VARCHAR(255) NOT NULL,              -- resolved tool id (okta.search_users / native)
  args JSON NULL,                          -- redacted
  outcome VARCHAR(32) NOT NULL,            -- ok|failed|skipped|replayed
  result_summary TEXT NULL,
  returned_ids JSON NULL,
  `sensitive` TINYINT(1) NOT NULL DEFAULT 0,
  duration_ms INT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pbl_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playbook_run_gates (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  leg INT NOT NULL DEFAULT 0,
  kind VARCHAR(32) NOT NULL,               -- form|await_message|approval|handoff|wait
  args JSON NULL,
  asked_of VARCHAR(32) NOT NULL,           -- requester|approver|operator|clock
  opened_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL DEFAULT NULL,
  decision JSON NULL,
  actor VARCHAR(255) NULL,
  INDEX idx_pbg_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Widen, don't narrow: node_type also stores 'agent-template', 'loader',
-- 'splitter', 'vectorstore', and 'realtime-*' values (see
-- WorkflowGraphRepository.php, IngestionCompiler.php) that an ENUM listing
-- only the values this migration cares about would silently truncate to ''
-- under non-strict SQL modes, or reject outright under strict mode.
ALTER TABLE workflow_nodes MODIFY node_type VARCHAR(32) NOT NULL;
