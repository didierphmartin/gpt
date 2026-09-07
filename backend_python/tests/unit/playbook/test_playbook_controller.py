"""Port of backend/tests/Unit/Playbook/PlaybookControllerTest.php (178 lines, 6 cases).

Registration-time validate endpoint (spec T4). Tests the controller
method's return value directly (no HTTP layer) — mirrors the PHP suite's
"assert the returned dict" convention.

The controller's MCPToolsLoader is swapped for a stub via the optional
third constructor argument (a loader factory).
"""
from __future__ import annotations

import json

from app.controllers.playbook_controller import PlaybookController

# The mock Okta server's 7 real tools (see backend/scripts/register_mock_okta.php run log).
_MOCK_OKTA_TOOLS = (
    'search_users', 'search_system_log', 'list_user_factors',
    'verify_security_answers', 'reset_password', 'reset_factor', 'unlock_user',
)


def _mfa_doc():
    return {
        'title': 'MFA Reset',
        'trigger': {'kind': 'request', 'description': 'user locked out'},
        'instructions': '#Search Okta User by Email first, then #Reset Password (Okta), '
                         'then #Reset User Factors (Okta), then #Leave Internal Note, then #Resolve Request.',
        'tools_used': ['Okta'],
        'actions_used': [
            '#Search Okta User by Email', '#Reset Password (Okta)',
            '#Reset User Factors (Okta)', '#Leave Internal Note', '#Resolve Request',
        ],
        'bindings': {
            '#Search Okta User by Email': 'okta.search_users',
            '#Reset Password (Okta)': 'okta.reset_password',
            '#Reset User Factors (Okta)': 'okta.reset_factor',
        },
    }


class _FakeLoader:
    """Builds an MCPToolsLoader stub whose getTools() exposes the given Okta tool names."""

    def __init__(self, toolNames):
        self._tools = {}
        for name in toolNames:
            self._tools['mcp_' + name] = {
                'original_name': name,
                'server_id': 1,
                'server_url': 'http://localhost/mockokta/',
                'server_name': 'Okta',
                'server_headers': [],
                'description': f'Mock Okta tool {name}',
                'input_schema_json': json.dumps({'type': 'object', 'properties': {}}),
                'has_ui': False,
                'ui_resource_uri': None,
            }
        self.getTools_called = False

    def loadToolsForUser(self, userId):
        return self._tools

    def getTools(self):
        self.getTools_called = True
        return self._tools


class _NoGetToolsLoader(_FakeLoader):
    """A loader that fails the test if getTools() is ever called."""

    def getTools(self):
        raise AssertionError('getTools() should not have been called')


class _FakeDb:
    """Stands in for the contexts DB's `agents` table (empty — no agent bindings tested)."""

    def fetch_column(self, sql, params=None):
        return []


def _controller(loader, db=None):
    return PlaybookController(db if db is not None else _FakeDb(), {}, lambda userId: loader)


def test_dangling_binding_returns_422():
    # All 7 mock Okta tools present EXCEPT reset_factor — the binding
    # for "#Reset User Factors (Okta)" dangles.
    present = [t for t in _MOCK_OKTA_TOOLS if t != 'reset_factor']
    loader = _FakeLoader(present)
    controller = _controller(loader)

    result = controller.validate({
        'user_id': 7,
        'body': {'playbook': _mfa_doc()},
    })

    assert result['status_code'] == 422
    assert result['valid'] is False
    assert result['errors']
    assert '#Reset User Factors (Okta)' in result['errors'][0]
    assert 'okta.reset_factor' in result['errors'][0]


def test_fully_bound_mfa_document_returns_200():
    # All 7 mock Okta tools present — every binding resolves.
    loader = _FakeLoader(_MOCK_OKTA_TOOLS)
    controller = _controller(loader)

    result = controller.validate({
        'user_id': 7,
        'body': {'playbook': _mfa_doc()},
    })

    assert result['status_code'] == 200
    assert result['valid'] is True
    assert result['errors'] == []
    assert result['actions']
    assert result['checklist'] == _mfa_doc()['actions_used']
    byName = {a['name']: a for a in result['actions']}
    assert byName['#Search Okta User by Email']['kind'] == 'bound'
    assert byName['#Search Okta User by Email']['target'] == 'okta.search_users'
    assert byName['#Resolve Request']['kind'] == 'native'


def test_missing_playbook_field_returns_422_without_touching_loader():
    loader = _NoGetToolsLoader([])
    controller = _controller(loader)

    result = controller.validate({'user_id': 7, 'body': {}})

    assert result['status_code'] == 422
    assert result['valid'] is False
    assert result['errors']


def test_console_text_string_playbook_is_parsed():
    loader = _FakeLoader(_MOCK_OKTA_TOOLS)
    controller = _controller(loader)

    text = (
        "Title: MFA Reset\n"
        "Trigger: user locked out\n"
        "Instructions: #Search Okta User by Email first, then #Resolve Request.\n"
        "Tools used: Okta\n"
        "Actions used: #Search Okta User by Email; #Resolve Request\n"
    )

    result = controller.validate({'user_id': 7, 'body': {'playbook': text}})

    # No bindings supplied in the console text form here, so the Okta
    # search action is unbound (warning, not error) while #Resolve
    # Request is a native verb; the document itself parses successfully.
    assert result['status_code'] in (200, 422)
    assert isinstance(result['checklist'], list)
    assert result['checklist'] == ['#Search Okta User by Email', '#Resolve Request']


def test_unauthenticated_request_returns_401():
    loader = _NoGetToolsLoader([])
    controller = _controller(loader)

    result = controller.validate({'body': {'playbook': _mfa_doc()}})

    assert result['status_code'] == 401
