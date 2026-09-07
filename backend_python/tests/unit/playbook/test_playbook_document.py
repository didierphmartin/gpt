"""Port of backend/tests/Unit/Playbook/PlaybookDocumentTest.php (90 lines, 6 cases)."""
from __future__ import annotations

import pytest

from app.playbook.playbook_document import PlaybookDocument


def test_from_array_defaults_policy():
    d = PlaybookDocument.fromArray({
        'title': 'T', 'trigger': {'kind': 'request', 'description': 'x'},
        'instructions': 'Do #Foo.', 'tools_used': ['Okta'],
        'actions_used': ['#Foo'], 'bindings': {'#Foo': 'okta.foo'},
    })
    assert d.title == 'T'
    assert d.policy['writes_enabled'] is False
    assert d.policy['on_unbound'] == 'handoff'
    assert d.policy['on_failure'] == 'continue_then_handoff'
    assert d.bindings == {'#Foo': 'okta.foo'}


def test_from_console_text_parses_sections():
    text = (
        "Title: Okta Password / MFA Reset\n\n"
        "Trigger: Requester reports being locked out.\n\n"
        "Instructions: #Search Okta User by Email for the requester. #Resolve Request.\n\n"
        "Tools used: Okta\n\n"
        "Actions used: #Search Okta User by Email; #Resolve Request"
    )
    d = PlaybookDocument.fromConsoleText(text)
    assert d.title == 'Okta Password / MFA Reset'
    assert d.trigger['kind'] == 'request'
    assert 'locked out' in d.trigger['description']
    assert '#Search Okta User by Email' in d.instructions
    assert d.toolsUsed == ['Okta']
    assert d.actionsUsed == ['#Search Okta User by Email', '#Resolve Request']
    assert d.bindings == {}


def test_section_headers_tolerate_list_markers_and_markdown():
    """Playbook 4 (wf 42) wrote "1. Instructions: …" and markdown headers;
    the keyword must still be detected and step 1's number kept."""
    text = (
        "## Title: Time Off\n\n**Trigger:** Requester asks for PTO.\n\n"
        "1. Instructions: Parse start date.\n2. #Lookup Users on the requester.\n"
        "- Tools used: Slack; Workday\n\nActions used: #Lookup Users"
    )
    d = PlaybookDocument.fromConsoleText(text)
    assert d.title == 'Time Off'
    assert d.trigger['description'] == 'Requester asks for PTO.'
    assert d.instructions.startswith("1. Parse start date.\n2. #Lookup Users")
    assert d.toolsUsed == ['Slack', 'Workday']
    assert d.actionsUsed == ['#Lookup Users']


def test_domain_field():
    d = PlaybookDocument.fromArray({
        'title': 'T', 'trigger': {'kind': 'request', 'description': 'x'},
        'instructions': '#Resolve Request.', 'domain': 'an HR benefits desk',
    })
    assert d.domain == 'an HR benefits desk'

    text = "Title: T\n\nDomain: a finance operations team\n\nTrigger: y\n\nInstructions: #Resolve Request."
    t = PlaybookDocument.fromConsoleText(text)
    assert t.domain == 'a finance operations team'

    # Default: empty (interpreter substitutes a neutral phrase).
    none = PlaybookDocument.fromArray({
        'title': 'T', 'trigger': {'kind': 'request', 'description': 'x'},
        'instructions': '#Resolve Request.'})
    assert none.domain == ''


def test_missing_section_message_names_it_and_what_was_found():
    with pytest.raises(ValueError) as exc:
        PlaybookDocument.fromConsoleText("Title: T\n\nTrigger: y\n\nSteps: do things\n\nActions used: #Resolve Request")
    msg = str(exc.value)
    assert 'Missing "Instructions:" section' in msg
    assert 'Recognized sections: Title, Trigger, Actions used' in msg


def test_missing_title_throws():
    with pytest.raises(ValueError):
        PlaybookDocument.fromArray({'instructions': 'x'})
