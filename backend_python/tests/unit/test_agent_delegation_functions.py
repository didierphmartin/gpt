"""Tests for app.agent_team.functions.agent_delegation_functions.AgentDelegationFunctions
(port of AgentTeam/Functions/AgentDelegationFunctions.php, 2c: static getToolNames only)."""
from app.agent_team.functions.agent_delegation_functions import AgentDelegationFunctions


def test_tool_names_match_php():
    assert AgentDelegationFunctions.getToolNames() == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']
