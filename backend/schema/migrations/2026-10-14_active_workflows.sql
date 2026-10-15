-- 2026-10-14_active_workflows.sql — the workflow each user activated with ▶ on Start (spec 2026-10-14
-- event-worker): the event worker runs it on its schedule or on its Start option's event. One row per user.
-- MySQL 8.x. Safe to re-run.
CREATE TABLE IF NOT EXISTS active_workflows (
    user_id INT NOT NULL PRIMARY KEY,
    workflow_id INT NOT NULL,
    mode VARCHAR(16) NOT NULL,                 -- 'schedule' | 'option'
    trigger_component_id INT NULL,             -- the option's component when mode = 'option'
    activated_at DATETIME NOT NULL,
    watch_state VARCHAR(16) NOT NULL DEFAULT 'starting',
    watch_message VARCHAR(255) NULL,
    watch_checked_at DATETIME NULL,
    KEY idx_active_workflows_workflow (workflow_id),
    CONSTRAINT fk_active_workflows_workflow FOREIGN KEY (workflow_id) REFERENCES agent_workflows (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
