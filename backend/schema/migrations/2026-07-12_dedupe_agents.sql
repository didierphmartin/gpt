-- ============================================================================
-- Dedupe agents by (user_id, name) and repoint workflows to the canonical row.
--
-- Context: the `agents` table had no uniqueness on name, and every time an
-- agent was configured/saved inside a workflow the app INSERTed a fresh row.
-- The same logical agent (e.g. "llms.txt agent") therefore exists many times.
-- We collapse each (user_id, name) group to ONE canonical row = the lowest id
-- (oldest), repoint every workflow node at the canonical id, delete the losers,
-- then add a UNIQUE(user_id, name) constraint so it can never recur.
--
-- RUN ORDER MATTERS. Run Step 0 first and eyeball the output. Only run
-- Steps 1-5 once you're happy. Steps 1-3 are wrapped in a transaction so you
-- can ROLLBACK if the row counts look wrong before COMMIT.
--
-- Recommended: take a backup first, e.g.
--   mysqldump chatbot agents workflow_nodes agent_executions agent_conversations > agents_backup.sql
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — AUDIT (read-only). Review this before running anything below.
-- Lists every (user_id, name) group that has more than one row, with the
-- canonical id we will KEEP and the loser ids we will DELETE.
-- ----------------------------------------------------------------------------
SELECT
    a.user_id,
    a.name,
    MIN(a.id)                                   AS canonical_id_kept,
    GROUP_CONCAT(a.id ORDER BY a.id)            AS all_ids,
    COUNT(*)                                    AS copies
FROM agents a
GROUP BY a.user_id, a.name
HAVING COUNT(*) > 1
ORDER BY copies DESC, a.name;

-- Optional sanity check: how many workflow nodes point at a NON-canonical
-- (loser) agent and will be repointed by Step 2.
SELECT COUNT(*) AS nodes_to_repoint
FROM workflow_nodes wn
JOIN agents a  ON wn.agent_id = a.id
JOIN (
    SELECT user_id, name, MIN(id) AS canonical_id
    FROM agents GROUP BY user_id, name
) c ON a.user_id = c.user_id AND a.name = c.name
WHERE wn.agent_id <> c.canonical_id;


-- ----------------------------------------------------------------------------
-- STEP 1-3 — the actual cleanup, in one transaction.
-- ----------------------------------------------------------------------------
START TRANSACTION;

-- STEP 1: build the loser -> canonical mapping in a temp table.
DROP TEMPORARY TABLE IF EXISTS agent_dedup_map;
CREATE TEMPORARY TABLE agent_dedup_map AS
SELECT
    a.id            AS loser_id,
    c.canonical_id  AS canonical_id
FROM agents a
JOIN (
    SELECT user_id, name, MIN(id) AS canonical_id
    FROM agents GROUP BY user_id, name
) c ON a.user_id = c.user_id AND a.name = c.name
WHERE a.id <> c.canonical_id;

-- STEP 2: repoint workflow nodes from the loser id to the canonical id.
-- (NULL agent_id rows — start/output nodes — are untouched by the join.)
UPDATE workflow_nodes wn
JOIN agent_dedup_map m ON wn.agent_id = m.loser_id
SET wn.agent_id = m.canonical_id;

-- STEP 3: delete the loser agent rows.
DELETE FROM agents
WHERE id IN (SELECT loser_id FROM agent_dedup_map);

-- Review the affected-row counts above. If they match the audit, COMMIT.
-- Otherwise ROLLBACK and investigate.
COMMIT;
-- ROLLBACK;   -- <- use this instead of COMMIT to abort.


-- ----------------------------------------------------------------------------
-- STEP 4 — add the uniqueness guard (run AFTER Steps 1-3 succeed).
-- This is what makes duplicates impossible going forward. It will fail if any
-- (user_id, name) duplicates still remain, which is a useful safety check.
-- ----------------------------------------------------------------------------
ALTER TABLE agents
    ADD UNIQUE KEY uq_agents_user_name (user_id, name);


-- ----------------------------------------------------------------------------
-- STEP 5 — verify no duplicates remain (read-only). Should return 0 rows.
-- ----------------------------------------------------------------------------
SELECT user_id, name, COUNT(*) AS copies
FROM agents
GROUP BY user_id, name
HAVING COUNT(*) > 1;


-- ============================================================================
-- OPTIONAL — historical / auxiliary tables that also carry agent_id.
-- These are past-run logs and hierarchy links, NOT workflow definitions, so
-- they are left alone by default. Uncomment and run ONLY if you want the
-- history to point at the canonical agents too. (agent_dedup_map is a TEMPORARY
-- table and is gone after your session ends — if you run these later, rebuild
-- it with the CREATE TEMPORARY TABLE statement from Step 1 first.)
-- ============================================================================
-- UPDATE agent_executions   ae JOIN agent_dedup_map m ON ae.agent_id       = m.loser_id SET ae.agent_id       = m.canonical_id;
-- UPDATE agent_conversations ac JOIN agent_dedup_map m ON ac.agent_id       = m.loser_id SET ac.agent_id       = m.canonical_id;
-- UPDATE agents              ap JOIN agent_dedup_map m ON ap.parent_agent_id = m.loser_id SET ap.parent_agent_id = m.canonical_id;
--
-- NOTE: `agents.can_delegate_to` is a JSON array of agent ids. If your
-- manager/worker agents were among the duplicates, those id lists may still
-- reference deleted ids. They are not touched here — review manually if you use
-- delegation.
