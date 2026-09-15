-- Swarm v1(a): how a workflow's graph is interpreted.
-- "workflow" (default) = the DAG compiler and interpreter as today.
-- "swarm"              = the dispatcher dissolves and its children hand off
--                        to one another (see SwarmRewriter).
-- Runs against the CONTEXTS database (netfo587_chatbot), where workflows live.
ALTER TABLE agent_workflows
  ADD COLUMN orchestration VARCHAR(16) NOT NULL DEFAULT 'workflow'
  AFTER output_folder;
