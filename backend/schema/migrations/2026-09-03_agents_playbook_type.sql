-- 2026-09-03_agents_playbook_type.sql — fifth agent type: playbook.
-- A playbook agent is a library card whose `instructions` hold a Console-style
-- playbook text; dropping it on the workflow canvas creates a Playbook node
-- (not an agent node) preloaded with that text and linked by agent_id.
ALTER TABLE agents
  MODIFY agent_type ENUM('standard','manager','worker','dispatcher','playbook')
  COLLATE utf8mb4_unicode_ci DEFAULT 'standard';
