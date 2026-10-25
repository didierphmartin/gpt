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
from app.agent_team.services.start_document_store import StartDocumentStore
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

    def __init__(self, db, workflowRepo, graphRepo, agentRepo, skillsRoot=None, startDocuments=None):
        self.ctor_args = (db, workflowRepo, graphRepo, agentRepo)
        self.extra_args = (skillsRoot, startDocuments)
        self.generate_calls = []
        self.result = {'filename': 'wf.py', 'code': 'print("hi")\n'}
        self.raise_ = None
        FakeGenerator.last_instance = self

    def generate(self, workflowId, userId=None, options=None):
        self.generate_calls.append((workflowId, userId, options))
        if self.raise_:
            raise self.raise_
        return dict(self.result)

    # ADK / MAF / NOOA: the modular package and the A2A folder (WorkflowController::compiledTargetResponse).
    def generatePackage(self, workflowId, userId=None):
        self.generate_calls.append(('package', workflowId, userId))
        return dict(self.result)

    def generateA2A(self, workflowId, userId=None):
        self.generate_calls.append(('a2a', workflowId, userId))
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
        assert gen.generate_calls == [(42, '3', {'a2a': False, 'modular': False})]
    else:
        assert gen.generate_calls == [(42, '3', None)]
    # Every target: no skills root (the default), and the requesting user's Start document store.
    assert gen.extra_args[0] is None
    assert isinstance(gen.extra_args[1], StartDocumentStore)
    assert gen.extra_args[1].userFolder == 'user_3'


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

    def init_with_a2a_result(self, *args):
        orig_init(self, *args)
        self.result = {'root': 'wf_42', 'files': [{'path': 'agent.py', 'code': 'x'}]}

    monkeypatch.setattr(FakeGenerator, '__init__', init_with_a2a_result)
    r = c.generatePython(ctx(query={'a2a': '1'}), id=42)
    assert r == {
        'success': True,
        'data': {'root': 'wf_42', 'files': [{'path': 'agent.py', 'code': 'x'}]},
        'status_code': 200,
    }
    assert FakeGenerator.last_instance.generate_calls == [(42, '3', {'a2a': True, 'modular': False})]


def test_generate_python_a2a_ignores_download(monkeypatch):
    """PHP 267-270: the a2a branch returns before the download check is
    ever reached -- ?a2a=1&download=1 still yields the JSON {root, files}
    shape, never raw_body."""
    monkeypatch.setattr('app.agent_team.controllers.workflow_controller.LangGraphGenerator', FakeGenerator)
    c = controller()
    orig_init = FakeGenerator.__init__

    def init_with_a2a_result(self, *args):
        orig_init(self, *args)
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
        def __init__(self, *args):
            super().__init__(*args)
            self.raise_ = RuntimeError('boom')

    monkeypatch.setattr(f'app.agent_team.controllers.workflow_controller.{cls_name}', RaisingGenerator)
    c = controller()
    r = getattr(c, method)(ctx(), id=42)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ============================================================================
# generatePython-only: ?modular=1 (a package manifest) and ?format=zip (Export)
# ============================================================================

def _with_result(monkeypatch, result):
    monkeypatch.setattr('app.agent_team.controllers.workflow_controller.LangGraphGenerator', FakeGenerator)
    orig_init = FakeGenerator.__init__

    def init(self, *args):
        orig_init(self, *args)
        self.result = result

    monkeypatch.setattr(FakeGenerator, '__init__', init)


def test_generate_python_modular_mode_returns_the_package_manifest(monkeypatch):
    package = {'root': 'wf_modular', 'files': [{'path': 'workflow.py', 'code': 'x'}], 'architecture': '# doc\n'}
    _with_result(monkeypatch, package)
    r = controller().generatePython(ctx(query={'modular': '1', 'download': '1'}), id=42)
    assert r == {'success': True, 'data': package, 'status_code': 200}
    assert FakeGenerator.last_instance.generate_calls == [(42, '3', {'a2a': False, 'modular': True})]


def test_generate_python_a2a_wins_over_modular(monkeypatch):
    _with_result(monkeypatch, {'root': 'wf_a2a', 'files': []})
    controller().generatePython(ctx(query={'modular': '1', 'a2a': '1'}), id=42)
    assert FakeGenerator.last_instance.generate_calls == [(42, '3', {'a2a': True, 'modular': False})]


def _zip_entries(body: bytes) -> dict:
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


def test_generate_python_zip_of_a_single_file_holds_the_script_and_its_architecture(monkeypatch):
    _with_result(monkeypatch, {'filename': 'dispatcher_demo_langgraph.py', 'code': 'print(1)\n', 'architecture': '# A\n'})
    r = controller().generatePython(ctx(query={'format': 'zip', 'download': '1'}), id=42)
    assert r['status_code'] == 200 and r['success'] is True
    assert r['headers']['Content-Type'] == 'application/zip'
    assert r['headers']['Content-Disposition'] == 'attachment; filename="dispatcher_demo_single.zip"'
    assert r['headers']['Content-Length'] == str(len(r['raw_body']))
    assert _zip_entries(r['raw_body']) == {
        'dispatcher_demo_langgraph/dispatcher_demo_langgraph.py': b'print(1)\n',
        'dispatcher_demo_langgraph/ARCHITECTURE.md': b'# A\n',
    }


def test_generate_python_zip_of_a_package_decodes_binary_files(monkeypatch):
    import base64
    _with_result(monkeypatch, {'root': 'support_swarm_modular_swarm', 'files': [
        {'path': 'workflow.py', 'code': 'w'},
        {'path': 'skills/x/icon.png', 'code': base64.b64encode(b'\x89PNG\x00').decode(), 'encoding': 'base64'},
    ]})
    r = controller().generatePython(ctx(query={'format': 'zip', 'modular': '1'}), id=42)
    assert r['headers']['Content-Disposition'] == 'attachment; filename="support_swarm_modular.zip"'
    assert _zip_entries(r['raw_body']) == {
        'support_swarm_modular_swarm/workflow.py': b'w',
        'support_swarm_modular_swarm/skills/x/icon.png': b'\x89PNG\x00',
    }


def test_generate_python_zip_without_architecture_holds_the_script_only(monkeypatch):
    _with_result(monkeypatch, {'filename': 'ingest_langgraph.py', 'code': 'x', 'architecture': None})
    r = controller().generatePython(ctx(query={'format': 'zip', 'a2a': '1'}), id=42)
    assert r['headers']['Content-Disposition'] == 'attachment; filename="ingest_a2a.zip"'
    assert list(_zip_entries(r['raw_body'])) == ['ingest_langgraph/ingest_langgraph.py']


# ============================================================================
# generate-adk / -maf / -nooa: the code structure (WorkflowController::compiledTargetResponse)
# ============================================================================

COMPILED = [g for g in GENERATORS if not g[2]]


def _with_target_result(monkeypatch, cls_name, result):
    monkeypatch.setattr(f'app.agent_team.controllers.workflow_controller.{cls_name}', FakeGenerator)
    orig_init = FakeGenerator.__init__

    def init(self, *args):
        orig_init(self, *args)
        self.result = result

    monkeypatch.setattr(FakeGenerator, '__init__', init)


@pytest.mark.parametrize('query,call', [
    ({'modular': '1'}, ('package', 42, '3')),
    ({'package': '1'}, ('package', 42, '3')),
    ({'package': 'yes'}, ('package', 42, '3')),     # !empty($q['package'])
    ({'package': '0'}, (42, '3', None)),            # '0' is empty() in PHP
    ({'a2a': '1'}, ('a2a', 42, '3')),
    ({'a2a': '1', 'modular': '1'}, ('a2a', 42, '3')),   # A2A wins
    ({'a2a': 'true'}, (42, '3', None)),             # only '1' switches a mode on
])
@pytest.mark.parametrize('method,cls_name,has_a2a', COMPILED)
def test_compiled_target_mode_picks_the_generator_call(monkeypatch, method, cls_name, has_a2a, query, call):
    _with_target_result(monkeypatch, cls_name, {'root': 'wf', 'files': []})
    r = getattr(controller(), method)(ctx(query=query), id=42)
    assert r == {'success': True, 'data': {'root': 'wf', 'files': []}, 'status_code': 200}
    assert FakeGenerator.last_instance.generate_calls == [call]


@pytest.mark.parametrize('method,cls_name,has_a2a', COMPILED)
def test_compiled_target_package_ignores_download(monkeypatch, method, cls_name, has_a2a):
    _with_target_result(monkeypatch, cls_name, {'root': 'wf', 'files': []})
    r = getattr(controller(), method)(ctx(query={'modular': '1', 'download': '1'}), id=42)
    assert r == {'success': True, 'data': {'root': 'wf', 'files': []}, 'status_code': 200}


@pytest.mark.parametrize('mode_query,mode', [({}, 'single'), ({'modular': '1'}, 'modular'), ({'a2a': '1'}, 'a2a')])
@pytest.mark.parametrize('method,cls_name,has_a2a', COMPILED)
def test_compiled_target_zip_is_named_after_target_and_mode(monkeypatch, method, cls_name, has_a2a, mode_query, mode):
    target = method[len('generate'):].lower()
    result = ({'filename': f'demo_{target}.py', 'code': 'x', 'architecture': '# A\n'} if mode == 'single'
              else {'root': f'demo_{target}' + ('_a2a' if mode == 'a2a' else ''), 'files': [{'path': 'workflow.py', 'code': 'w'}]})
    _with_target_result(monkeypatch, cls_name, result)
    r = getattr(controller(), method)(ctx(query={**mode_query, 'format': 'zip', 'download': '1'}), id=42)
    assert r['headers']['Content-Type'] == 'application/zip'
    assert r['headers']['Content-Disposition'] == f'attachment; filename="demo_{target}_{mode}.zip"'


@pytest.mark.parametrize('method,cls_name,has_a2a', COMPILED)
def test_compiled_target_exception_names_the_mode_and_returns_500(monkeypatch, method, cls_name, has_a2a):
    class Raising(FakeGenerator):
        def generatePackage(self, workflowId, userId=None):
            raise RuntimeError('no package')

    monkeypatch.setattr(f'app.agent_team.controllers.workflow_controller.{cls_name}', Raising)
    r = getattr(controller(), method)(ctx(query={'modular': '1'}), id=42)
    assert r == {'success': False, 'error': 'no package', 'status_code': 500}


# ============================================================================
# Port of backend/tests/Unit/Controllers/CompiledTargetZipExportTest.php: ADK, MAF and NOOA exported as a
# zip in the chosen code structure, on the real generators (the dispatcher_demo compiler fixture).
# ============================================================================

def _demo_generator(target):
    from tests.unit import compiler_fixtures as cf
    fx = cf.load(cf.WORKFLOWS / 'dispatcher_demo.json')
    return cf.generator(fx, target), int(fx['workflow']['id']), str(fx.get('user_id') or '3')


@pytest.mark.parametrize('target', ['adk', 'maf', 'nooa'])
def test_single_file_zip(target):
    gen, wf, user = _demo_generator(target)
    r = WorkflowController.langGraphZipResponse(gen.generate(wf, user), f'{target}_single')
    assert r['headers']['Content-Disposition'] == f'attachment; filename="dispatcher_demo_{target}_single.zip"'
    # the script and its ARCHITECTURE.md, as LangGraph's single-file zip
    assert list(_zip_entries(r['raw_body'])) == [f'dispatcher_demo_{target}/dispatcher_demo_{target}.py',
                                                 f'dispatcher_demo_{target}/ARCHITECTURE.md']


@pytest.mark.parametrize('target', ['adk', 'maf', 'nooa'])
def test_modular_zip_holds_the_package(target):
    gen, wf, user = _demo_generator(target)
    pkg = gen.generatePackage(wf, user)
    r = WorkflowController.langGraphZipResponse(pkg, f'{target}_modular')
    assert r['headers']['Content-Disposition'] == f'attachment; filename="dispatcher_demo_{target}_modular.zip"'
    assert list(_zip_entries(r['raw_body'])) == [f"dispatcher_demo_{target}/{f['path']}" for f in pkg['files']]
