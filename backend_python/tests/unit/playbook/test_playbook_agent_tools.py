"""Port of backend/tests/Unit/Playbook/PlaybookAgentToolsTest.php (30 lines, 2 cases).

A playbook agent's `tools` = the MCP tools its #Actions bind to (as the
runtime names them, mcp_<tool>), so the agent form's checkboxes show what
the playbook needs. Native verbs and unbound actions contribute nothing.
"""
from __future__ import annotations

from app.agent_team.services.playbook_agent_tools import PlaybookAgentTools


def test_bound_mcp_tools_become_the_agent_tools():
    text = (
        "Title: T\n\nTrigger: x\n\nInstructions:\n1. #Custom Workday Get PTO Balance for the requester.\n"
        "2. #Lookup Users on the requester.\n3. #Custom Frobnicate Widgets.\n4. #Send Direct Message; #Resolve Request.\n\n"
        "Tools used: Workday\n\nActions used: #Custom Workday Get PTO Balance; #Lookup Users; #Custom Frobnicate Widgets; #Send Direct Message; #Resolve Request"
    )
    available = ['workday.get_pto_balance', 'workday.submit_time_off', 'okta.lookup_users']
    assert PlaybookAgentTools.fromPlaybookText(text, available) == ['mcp_get_pto_balance', 'mcp_lookup_users']


def test_unparseable_text_yields_no_tools():
    assert PlaybookAgentTools.fromPlaybookText('not a playbook', ['okta.lookup_users']) == []
