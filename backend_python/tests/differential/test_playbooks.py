"""Differential: POST /api/v1/playbooks/validate — PHP vs Python (Phase 5, Task 4).

Uses a native-verb-only playbook (only #Resolve Request, no MCP tool
binding) so the result is deterministic regardless of user 3's actual live
MCP tool registry — the same fixture PlaybookControllerTest.php's simplest
case exercises (a fully-resolvable document with no dangling bindings).
"""
import pytest

from .conftest import same

pytestmark = pytest.mark.differential


def test_playbooks_validate_parity(both):
    # Auth / validation edge cases — exact compare.
    same(*both('POST', '/api/v1/playbooks/validate', json={'playbook': {}}, auth=False))
    same(*both('POST', '/api/v1/playbooks/validate', json={}))

    # Native-verb-only object playbook: no MCP dependency, deterministic on both backends.
    doc = {
        'title': 'T',
        'trigger': {'kind': 'request', 'description': 'd'},
        'instructions': '#Resolve Request.',
    }
    same(*both('POST', '/api/v1/playbooks/validate', json={'playbook': doc}))

    # Console-text form of the same document.
    text = "Title: T\n\nTrigger: d\n\nInstructions: #Resolve Request.\n\nActions used: #Resolve Request"
    same(*both('POST', '/api/v1/playbooks/validate', json={'playbook': text}))

    # Missing "playbook" field entirely -> 422 with the exact error text.
    same(*both('POST', '/api/v1/playbooks/validate', json={'not_playbook': True}))
