-- 2026-09-02_agents_dispatcher_type.sql — fourth agent type: dispatcher.
-- A dispatcher agent's outgoing workflow edges are a MENU of branches the
-- model picks from by name (route_to), never a parallel fan-out. Batch twin
-- of the voice runner's handoff_to. See AgentTeam\Services\DispatchRouting.
ALTER TABLE agents
  MODIFY agent_type ENUM('standard','manager','worker','dispatcher')
  COLLATE utf8mb4_unicode_ci DEFAULT 'standard';
