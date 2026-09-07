"""Unit tests for WorkflowController's code-generator endpoints (Phase 6,
Task 4) -- `generatePython`, `generateAdk`, `generateMaf`, `generateNooa`.
Port of backend/src/AgentTeam/Controllers/WorkflowController.php:240-467.

Every validation/ownership/not-found string below is copied verbatim from
the PHP source. The four generator classes (`LangGraphGenerator`,
`ADKGenerator`, `MAFGenerator`, `NOOAGenerator`) are swapped for fakes via
`monkeypatch.setattr` on the module (same style as
tests/unit/test_workflow_run_routes.py's `PlaybookNodeRunner` patching) --
each has its own dedicated emit/compile/parity unit tests (Tasks 2-3); this
file only pins WorkflowController's own branching and response shaping.

PHP-truth strings pinned here:
  - "Authentication required"                              (247, 310, 368, 426)
  - "Workflow ID is required"                               (250, 313, 371, 429)
  - "Workflow not found or access denied"                   (255, 318, 376, 434)
"""
from __future__ import annotations

import pytest
from starlette.datastructures import Headers

from app.agent_team.controllers.workflow_controller import WorkflowController
from app.support.http import Ctx

CFG = {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}}


class FakeDb:
    """Constructor-time-only stand-in -- see test_workflow_run_routes.py's
    FakeDb docstring for why the `system_llm_settings` probe is answered
    directly here rather than through a call queue."""

    def fetch_all(self, sql, params=None):
        return []

    def fetch_one(self, sql, params=None):
        return None

    def fetch_column(self, sql, params=None):
        return []

    def execute(self, sql, params=None):
        return 0

    def insert(self, sql, params=None):
        return 1

    def begin(self) -> None:
        pass

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass


def ctx(query=None, params=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body={}, raw_body='',
               params=params or {}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


def controller(access=True) -> WorkflowController:
    c = WorkflowController(FakeDb(), CFG)
    c.workflowRepository.canUserAccess = lambda uid, wid: access
    return c


class FakeGenerator:
    """Stand-in for LangGraphGenerator/ADKGenerator/MAFGenerator/NOOAGenerator.
    Records constructor args and the args `generate()` was called with, so
    tests can assert the controller wires (db, workflowRepository,
    graphRepository, agentRepo) and (workflowId, str(userId)[, options])
    exactly like PHP's `new \\AgentTeam\\Services\\XGenerator(...)` /
    `$gen->generate($workflowId, (string) $userId, [...])`."""

    last_instance = None

    def __init__(self, db, workflowRepo, graphRepo, agentRepo):
        self.ctor_args = (db, workflowRepo, graphRepo, agentRepo)
        self.generate_calls = []
        self.result = {'filename': 'wf.py', 'code': 'print("hi")\n'}
        self.raise_ = None
        FakeGenerator.last_instance = self

    def generate(self, workflowId, userId=None, options=None):
        self.generate_calls.append((workflowId, userId, options))
        if self.raise_:
            raise self.raise_
        return dict(self.result)


GENERATORS = [
    ('generatePython', 'LangGraphGenerator', True),
    ('generateAdk', 'ADKGenerator', False),
    ('generateMaf', 'MAFGenerator', False),
    ('generateNooa', 'NOOAGenerator', False),
]


# ============================================================================
# Validation / ownership -- identical across all four methods
# ============================================================================

@pytest.mark.parametrize('method,cls_name,has_a2a', GENERATORS)
def test_unauthenticated_returns_401(method, cls_name, has_a2a):
    c = controller()
    r = getattr(c, method)(ctx(user_id=0), id=1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


@pytest.mark.parametrize('method,cls_name,has_a2a', GENERATORS)
def test_missing_workflow_id_returns_400(method, cls_name, has_a2a):
    c = controller()
    r = getattr(c, method)(ctx(), id=0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


@pytest.mark.parametrize('method,cls_name,has_a2a', GENERATORS)
def test_access_denied_returns_404(method, cls_name, has_a2a):
    c = controller(access=False)
    r = getattr(c, method)(ctx(), id=1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


# ============================================================================
# Success shapes -- default JSON {filename, code}
# ============================================================================

@pytest.mark.parametrize('method,cls_name,has_a2a', GENERATORS)
def test_default_mode_returns_json_data(monkeypatch, method, cls_name, has_a2a):
    monkeypatch.setattr(f'app.agent_team.controllers.workflow_controller.{cls_name}', FakeGenerator)
    c = controller()
    r = getattr(c, method)(ctx(), id=42)
    assert r == {
        'success': True,
        'data': {'filename': 'wf.py', 'code': 'print("hi")\n'},
        'status_code': 200,
    }
    gen = FakeGenerator.last_instance
    assert gen.ctor_args == (c.db, c.workflowRepository, c.graphRepository, gen.ctor_args[3])
    if has_a2a:
        assert gen.generate_calls == [(42, '3', {'a2a': False})]
    else:
        assert gen.generate_calls == [(42, '3', None)]


# ============================================================================
# ?download=1 -- raw text/x-python body + Content-Disposition, all four
# ============================================================================

@pytest.mark.parametrize('method,cls_name,has_a2a', GENERATORS)
def test_download_mode_returns_raw_body_with_headers(monkeypatch, method, cls_name, has_a2a):
    monkeypatch.setattr(f'app.agent_team.controllers.workflow_controller.{cls_name}', FakeGenerator)
    c = controller()
    r = getattr(c, method)(ctx(query={'download': '1'}), id=42)
    assert r == {
        'success': True,
        'raw_body': 'print("hi")\n',
        'headers': {
            'Content-Type': 'text/x-python; charset=utf-8',
            'Content-Disposition': 'attachment; filename="wf.py"',
        },
        'status_code': 200,
    }


# ============================================================================
# generatePython-only: ?a2a=1 multi-file mode (always JSON, ignores download)
# ============================================================================

def test_generate_python_a2a_mode_returns_root_and_files(monkeypatch):
    monkeypatch.setattr('app.agent_team.controllers.workflow_controller.LangGraphGenerator', FakeGenerator)
    c = controller()
    FakeGenerator.last_instance = None
    # Pre-seed the result the fake will return for this call.
    orig_init = FakeGenerator.__init__

    def init_with_a2a_result(self, db, wr, gr, ar):
        orig_init(self, db, wr, gr, ar)
        self.result = {'root': 'wf_42', 'files': [{'path': 'agent.py', 'code': 'x'}]}

    monkeypatch.setattr(FakeGenerator, '__init__', init_with_a2a_result)
    r = c.generatePython(ctx(query={'a2a': '1'}), id=42)
    assert r == {
        'success': True,
        'data': {'root': 'wf_42', 'files': [{'path': 'agent.py', 'code': 'x'}]},
        'status_code': 200,
    }
    assert FakeGenerator.last_instance.generate_calls == [(42, '3', {'a2a': True})]


def test_generate_python_a2a_ignores_download(monkeypatch):
    """PHP 267-270: the a2a branch returns before the download check is
    ever reached -- ?a2a=1&download=1 still yields the JSON {root, files}
    shape, never raw_body."""
    monkeypatch.setattr('app.agent_team.controllers.workflow_controller.LangGraphGenerator', FakeGenerator)
    c = controller()
    orig_init = FakeGenerator.__init__

    def init_with_a2a_result(self, db, wr, gr, ar):
        orig_init(self, db, wr, gr, ar)
        self.result = {'root': 'wf_42', 'files': []}

    monkeypatch.setattr(FakeGenerator, '__init__', init_with_a2a_result)
    r = c.generatePython(ctx(query={'a2a': '1', 'download': '1'}), id=42)
    assert r == {'success': True, 'data': {'root': 'wf_42', 'files': []}, 'status_code': 200}
    assert 'raw_body' not in r


# ============================================================================
# Exceptions -- caught, logged, 500
# ============================================================================

@pytest.mark.parametrize('method,cls_name,has_a2a', GENERATORS)
def test_generator_exception_returns_500(monkeypatch, method, cls_name, has_a2a):
    class RaisingGenerator(FakeGenerator):
        def __init__(self, db, workflowRepo, graphRepo, agentRepo):
            super().__init__(db, workflowRepo, graphRepo, agentRepo)
            self.raise_ = RuntimeError('boom')

    monkeypatch.setattr(f'app.agent_team.controllers.workflow_controller.{cls_name}', RaisingGenerator)
    c = controller()
    r = getattr(c, method)(ctx(), id=42)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}
