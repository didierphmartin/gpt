"""Port of AgentTeam/Functions/AgentDelegationFunctions.php.

Provides tools for manager agents to delegate tasks to worker agents.
These functions are registered with ToolsManager and can be called by LLMs.

Tools provided:
- delegate_to_agent: Delegate a task to a specific agent
- list_available_agents: List agents that can be delegated to
- run_agents_parallel: Run multiple agents in parallel

Phase 2c: only the static `getToolNames()` is ported (Task 4 consumes it to
list the delegation tool names for ProviderController). The constructor
(`AgentRepository`, `AgentRunner`) and instance handlers (`delegateToAgent`,
`listAvailableAgents`, `runAgentsParallel`, `completeTask`) are ported in
Phase 5, once `AgentRunner`/`AgentRepository` exist.
"""
from __future__ import annotations


class AgentDelegationFunctions:
    """Agent Delegation Functions (2c: static tool-name listing only)."""

    @staticmethod
    def getToolNames() -> list:
        """Get the names of all delegation tools (static method for use
        without instantiation)."""
        return [
            'delegate_to_agent',
            'list_available_agents',
            'run_agents_parallel',
        ]
