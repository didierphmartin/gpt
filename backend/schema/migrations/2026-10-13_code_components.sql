-- Code components: reusable code-node bodies. A workflow's code node links by
-- config.code_component_id and keeps no copy of the code (WorkflowGraphRepository fills it on read).
CREATE TABLE IF NOT EXISTS code_components (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  description TEXT COLLATE utf8mb4_unicode_ci NULL,
  code MEDIUMTEXT COLLATE utf8mb4_unicode_ci NOT NULL,
  exits JSON NOT NULL,
  mcp_servers JSON NOT NULL,
  timeout_s SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_code_components_user_name (user_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
