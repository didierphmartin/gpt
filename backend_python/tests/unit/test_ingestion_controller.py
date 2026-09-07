"""Unit tests for IngestionController (Phase 6, Task 6).

Port of backend/src/AgentTeam/Controllers/IngestionController.php (1231
lines). Every validation string/status code is copied verbatim from the PHP
source and pinned here. Success paths use fakes for the loader wiring
(`_buildLoaderClosures` — MCPToolsLoader/langfs dispatch is exercised in
Phase 5's own `test_vector_mcp_store.py`/`test_ingestion_loader.py`, not
re-tested here) and `httpx.MockTransport` for the vector-store MCP dispatch
(`storeChunks`/`storeFind`), asserting the exact JSON-RPC request bytes per
the task brief.
"""
from __future__ import annotations

import json

import httpx

from app.agent_team.controllers.ingestion_controller import IngestionController
import app.agent_team.controllers.ingestion_controller as ingestion_controller_module


class FakeDb:
    """Queue-based fake: fetch_one pops from a per-call queue in call order."""

    def __init__(self, one=None):
        self.one_queue = list(one) if one else []
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one_queue.pop(0) if self.one_queue else None


WORKFLOW_ROW = {
    'id': 1, 'user_id': 3, 'workspace_id': None, 'name': 'WF A', 'description': 'd',
    'steps': '[]', 'triggers': '[]', 'variables': '[]', 'enabled': 1,
    'created_at': 'c', 'updated_at': 'u', 'output_storage_enabled': 0, 'output_folder': None,
}


def ctx(body=None, user_id=3, sse=None):
    c = {'user_id': user_id, 'body': body if body is not None else {}}
    if sse is not None:
        c['sse'] = sse
    return c


def ic(db=None, config=None):
    return IngestionController(db if db is not None else FakeDb(), config or {})


class FakeMcpLoader:
    """Stand-in for the (listFiles, readFile, mcpLoader) tuple `_buildLoaderClosures`
    returns -- isolates controller-logic tests from MCPToolsLoader/langfs wiring
    (covered by Phase 5's own service tests)."""

    def __init__(self, files=None, texts=None, list_error=None, read_error=None):
        self.files = files if files is not None else {}   # folder -> {"files": [...]}
        self.texts = texts if texts is not None else {}    # file_id -> text
        self.list_error = list_error
        self.read_error = read_error
        self.closed = False

    def close(self):
        self.closed = True

    def closures(self):
        def listFiles(provider, folder):
            if self.list_error:
                raise RuntimeError(self.list_error)
            return self.files.get(folder, {'files': []})

        def readFile(provider, fileId):
            if self.read_error:
                raise RuntimeError(self.read_error)
            return {'is_text': True, 'data': self.texts[fileId]}

        return listFiles, readFile, self


def patch_loader(monkeypatch, controller, fake: FakeMcpLoader):
    monkeypatch.setattr(controller, '_buildLoaderClosures', lambda userId, storageMcpId=None: fake.closures())


class FakeSse:
    """Captures every send_data() call; .aborted mirrors app/support/sse.py's
    SseStream.aborted (proactive-check semantics, not exception-based, unless
    `abort_after` is set)."""

    def __init__(self, abort_after: int | None = None):
        self.frames: list = []
        self.aborted = False
        self._abort_after = abort_after

    def send_data(self, data):
        if self.aborted:
            raise RuntimeError('CLIENT_ABORTED')
        self.frames.append(data)
        if self._abort_after is not None and len(self.frames) >= self._abort_after:
            self.aborted = True


# ============================================================================
# nodeCode — PHP 44-81
# ============================================================================

def test_node_code_unauthenticated_returns_401():
    r = ic().nodeCode(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_node_code_missing_workflow_id_returns_400():
    r = ic().nodeCode(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_node_code_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).nodeCode(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_node_code_single_node_happy_path():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).nodeCode(ctx(body={'node_type': 'loader', 'config': {'provider': 'local', 'path': 'a.pdf'}}), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['data']['node'] == 'loader'
    assert list(r['data'].keys()) == ['node', 'input', 'generated', 'output']
    assert 'LOADER' in r['data']['generated']


def test_node_code_stages_happy_path_uses_last_stage_type():
    db = FakeDb(one=[WORKFLOW_ROW])
    stages = [
        {'node_type': 'start'},
        {'node_type': 'loader', 'config': {'provider': 'local', 'path': 'a.pdf'}},
    ]
    r = ic(db).nodeCode(ctx(body={'stages': stages}), 1)
    assert r['success'] is True
    assert r['data']['node'] == 'loader'
    assert r['data']['input'] != ''


def test_node_code_unknown_kind_returns_400_with_message():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).nodeCode(ctx(body={'node_type': 'bogus', 'config': {}}), 1)
    assert r['success'] is False
    assert r['status_code'] == 400
    assert 'unknown node kind' in r['error']


# ============================================================================
# compile — PHP 89-143
# ============================================================================

def test_compile_unauthenticated_returns_401():
    r = ic().compile(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_compile_missing_workflow_id_returns_400():
    r = ic().compile(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_compile_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).compile(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_compile_happy_path_writes_script(tmp_path, monkeypatch):
    monkeypatch.setattr(ingestion_controller_module, 'PHP_BACKEND', tmp_path / 'backend')
    (tmp_path / 'langchain_runner').mkdir()
    db = FakeDb(one=[WORKFLOW_ROW])
    body = {
        'loader': {'provider': 'local', 'path': 'a.pdf'},
        'splitter': {'chunk_size': 500, 'overlap': 50},
        'vectorstore': {'provider': 'qdrant', 'collection': 'docs'},
    }
    r = ic(db).compile(ctx(body=body), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['data']['written'] is True
    assert r['data']['filename'] == 'ingestion_docs.py'
    written = tmp_path / 'langchain_runner' / 'ingestion_docs.py'
    assert written.read_text(encoding='utf-8') == r['data']['code']
    # Phase-2d widening (Python-only; see module docstring): the written
    # script is meant to be read/run by other tooling.
    assert (written.stat().st_mode & 0o777) == 0o666


def test_compile_resolves_mcpqrant_url_from_store_id(tmp_path, monkeypatch):
    monkeypatch.setattr(ingestion_controller_module, 'PHP_BACKEND', tmp_path / 'backend')
    (tmp_path / 'langchain_runner').mkdir()
    db = FakeDb(one=[WORKFLOW_ROW, {'url': 'https://vec.example/mcp'}])
    body = {
        'loader': {'provider': 'local', 'path': 'a.pdf'},
        'vectorstore': {'store': 'mcp:9', 'collection': 'docs'},
    }
    r = ic(db).compile(ctx(body=body), 1)
    assert r['success'] is True
    assert 'https://vec.example/mcp' in r['data']['code']


# ============================================================================
# saveScript — PHP 153-204
# ============================================================================

def test_save_script_unauthenticated_returns_401():
    r = ic().saveScript(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_save_script_missing_workflow_id_returns_404_not_400():
    # PHP 160: `!$workflowId || !canUserAccess(...)` -- both collapse to 404,
    # unlike the other nine methods' separate 400 "Workflow ID is required".
    r = ic().saveScript(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_save_script_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).saveScript(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_save_script_empty_code_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).saveScript(ctx(body={'code': ''}), 1)
    assert r == {'success': False, 'error': 'Nothing to save (empty script).', 'status_code': 400}


def test_save_script_default_dir_and_filename(tmp_path, monkeypatch):
    monkeypatch.setattr(ingestion_controller_module, 'PHP_BACKEND', tmp_path / 'backend')
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).saveScript(ctx(body={'code': 'print(1)'}), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    expected_dir = str(tmp_path / 'langchain_runner')
    assert r['data']['default_dir'] == expected_dir
    assert r['data']['path'] == expected_dir + '/ingestion_pipeline.py'
    written = tmp_path / 'langchain_runner' / 'ingestion_pipeline.py'
    assert written.read_text(encoding='utf-8') == 'print(1)'
    assert (written.stat().st_mode & 0o777) == 0o666
    assert ((tmp_path / 'langchain_runner').stat().st_mode & 0o777) == 0o777


def test_save_script_explicit_py_dest(tmp_path, monkeypatch):
    monkeypatch.setattr(ingestion_controller_module, 'PHP_BACKEND', tmp_path / 'backend')
    db = FakeDb(one=[WORKFLOW_ROW])
    dest = str(tmp_path / 'custom' / 'my_pipeline.py')
    (tmp_path / 'custom').mkdir()
    r = ic(db).saveScript(ctx(body={'code': 'x = 1', 'dest': dest}), 1)
    assert r['success'] is True
    assert r['data']['path'] == dest
    assert (tmp_path / 'custom' / 'my_pipeline.py').read_text(encoding='utf-8') == 'x = 1'


# ============================================================================
# loaderText — PHP 216-262
# ============================================================================

def test_loader_text_unauthenticated_returns_401():
    r = ic().loaderText(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_loader_text_missing_workflow_id_returns_400():
    r = ic().loaderText(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_loader_text_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).loaderText(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_loader_text_empty_path_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).loaderText(ctx(body={'config': {'path': ''}}), 1)
    assert r == {'success': False, 'error': 'Choose a file or folder in the loader first.', 'status_code': 400}


def test_loader_text_happy_path_single_file(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW])
    controller = ic(db)
    fake = FakeMcpLoader(texts={'a.pdf': 'hello world'})
    patch_loader(monkeypatch, controller, fake)
    r = controller.loaderText(ctx(body={'config': {'provider': 'local', 'path': 'a.pdf'}}), 1)
    assert r['success'] is True
    assert r['data']['count'] == 1
    assert r['data']['current']['text'] == 'hello world'
    assert 'file 1/1' in r['data']['logs'][0]
    assert fake.closed is True


def test_loader_text_no_matching_files_logs_message(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW])
    controller = ic(db)
    fake = FakeMcpLoader()
    patch_loader(monkeypatch, controller, fake)
    r = controller.loaderText(ctx(body={'config': {'provider': 'local', 'path': 'unmatched.exe'}}), 1)
    assert r['success'] is True
    assert r['data']['current'] is None
    assert 'no matching files' in r['data']['logs'][0]
    assert fake.closed is True


# ============================================================================
# splitterChunks — PHP 273-349
# ============================================================================

def test_splitter_chunks_unauthenticated_returns_401():
    r = ic().splitterChunks(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_splitter_chunks_missing_workflow_id_returns_400():
    r = ic().splitterChunks(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_splitter_chunks_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).splitterChunks(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_splitter_chunks_empty_path_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).splitterChunks(ctx(body={'loader': {'path': ''}}), 1)
    assert r == {
        'success': False,
        'error': 'The upstream loader has no Source set — pick a file or folder first.',
        'status_code': 400,
    }


def test_splitter_chunks_happy_path(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW])
    controller = ic(db)
    text = 'word ' * 400   # long enough to force >1 chunk at a small chunk_size
    fake = FakeMcpLoader(texts={'a.pdf': text})
    patch_loader(monkeypatch, controller, fake)
    body = {'loader': {'provider': 'local', 'path': 'a.pdf'}, 'splitter': {'chunk_size': 100, 'overlap': 10}}
    r = controller.splitterChunks(ctx(body=body), 1)
    assert r['success'] is True
    cur = r['data']['current']
    assert cur['source'] == 'a.pdf'
    assert cur['chunk_count'] > 1
    assert cur['chunk_count'] == len(cur['chunks'])
    assert fake.closed is True


# ============================================================================
# storeChunks — PHP 359-460
# ============================================================================

def test_store_chunks_unauthenticated_returns_401():
    r = ic().storeChunks(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_store_chunks_missing_workflow_id_returns_400():
    r = ic().storeChunks(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_store_chunks_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).storeChunks(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_store_chunks_empty_path_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).storeChunks(ctx(body={'loader': {'path': ''}}), 1)
    assert r == {'success': False, 'error': 'The upstream loader has no Source set.', 'status_code': 400}


def test_store_chunks_no_store_selected_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).storeChunks(ctx(body={'loader': {'path': 'a.pdf'}, 'vectorstore': {}}), 1)
    assert r == {'success': False, 'error': 'Pick a vector-DB MCP server in the store node.', 'status_code': 400}


def test_store_chunks_server_not_found_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW, None])
    body = {'loader': {'path': 'a.pdf'}, 'vectorstore': {'store': 'mcp:9', 'collection': 'docs'}}
    r = ic(db).storeChunks(ctx(body=body), 1)
    assert r == {'success': False, 'error': 'Vector MCP server #9 not found or disabled.', 'status_code': 400}


def test_store_chunks_missing_collection_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW, {'url': 'https://vec.example/mcp', 'headers': None}])
    body = {'loader': {'path': 'a.pdf'}, 'vectorstore': {'store': 'mcp:9', 'collection': ''}}
    r = ic(db).storeChunks(ctx(body=body), 1)
    assert r == {'success': False, 'error': 'Set a collection name in the store node.', 'status_code': 400}


def test_store_chunks_happy_path_mock_transport(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW, {'url': 'https://vec.example/mcp', 'headers': '{"X-Api-Key":"secret"}'}])
    controller = ic(db)
    fake = FakeMcpLoader(texts={'a.pdf': 'hello world, this gets stored'})
    patch_loader(monkeypatch, controller, fake)

    requests_seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests_seen.append({'method': body.get('method'), 'body': body, 'headers': dict(request.headers)})
        if body['method'] == 'initialize':
            return httpx.Response(200, headers={'Mcp-Session-Id': 'sess-1'},
                                   json={'jsonrpc': '2.0', 'id': 1, 'result': {'protocolVersion': '2024-11-05'}})
        if body['method'] == 'notifications/initialized':
            return httpx.Response(202, content=b'')
        if body['method'] == 'tools/call' and body['params']['name'] == 'store':
            payload = json.dumps({'stored': 3, 'errors': 0})
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2,
                                              'result': {'content': [{'type': 'text', 'text': payload}]}})
        raise AssertionError(f"unexpected method {body['method']}")

    monkeypatch.setattr(controller, '_newHttpClient', lambda: httpx.Client(transport=httpx.MockTransport(handler)))

    body = {'loader': {'provider': 'local', 'path': 'a.pdf'},
            'vectorstore': {'store': 'mcp:9', 'collection': 'docs', 'provider': 'qdrant'}}
    r = controller.storeChunks(ctx(body=body), 1)
    assert r['success'] is True, r
    assert r['data']['current']['stored'] == 3
    assert fake.closed is True

    methods = [c['method'] for c in requests_seen]
    assert methods == ['initialize', 'notifications/initialized', 'tools/call']
    assert requests_seen[0]['body'] == {
        'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
        'params': {'protocolVersion': '2024-11-05', 'capabilities': {},
                   'clientInfo': {'name': 'gpt-ingestion', 'version': '1'}},
    }
    # Session id + the server's stored auth header both ride on the SECOND
    # and THIRD calls, never the first (captured before the handshake).
    assert 'mcp-session-id' not in requests_seen[0]['headers']
    assert requests_seen[1]['headers']['mcp-session-id'] == 'sess-1'
    assert requests_seen[2]['headers']['mcp-session-id'] == 'sess-1'
    assert requests_seen[2]['headers']['x-api-key'] == 'secret'
    call_args = requests_seen[2]['body']['params']['arguments']
    assert call_args['provider'] == 'qdrant'
    assert call_args['collection'] == 'docs'
    assert [it['text'] for it in call_args['items']] == ['hello world, this gets stored']


def test_store_chunks_session_error_returns_400(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW, {'url': 'https://vec.example/mcp', 'headers': None}])
    controller = ic(db)
    fake = FakeMcpLoader(texts={'a.pdf': 'hello'})
    patch_loader(monkeypatch, controller, fake)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text='boom')

    monkeypatch.setattr(controller, '_newHttpClient', lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    body = {'loader': {'path': 'a.pdf'}, 'vectorstore': {'store': 'mcp:9', 'collection': 'docs'}}
    r = controller.storeChunks(ctx(body=body), 1)
    assert r['success'] is False
    assert r['status_code'] == 400
    assert 'Vector store connection failed' in r['error']
    assert fake.closed is True


# ============================================================================
# storeFind — PHP 642-708
# ============================================================================

def test_store_find_unauthenticated_returns_401():
    r = ic().storeFind(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_store_find_missing_workflow_id_returns_400():
    r = ic().storeFind(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_store_find_access_denied_returns_404():
    db = FakeDb(one=[None])
    r = ic(db).storeFind(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_store_find_empty_query_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).storeFind(ctx(body={'query': '  '}), 1)
    assert r == {'success': False, 'error': 'Enter a search query.', 'status_code': 400}


def test_store_find_happy_path_mock_transport(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW, {'url': 'https://vec.example/mcp', 'headers': None}])
    controller = ic(db)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body['method'] == 'initialize':
            return httpx.Response(200, headers={'Mcp-Session-Id': 'sess-2'},
                                   json={'jsonrpc': '2.0', 'id': 1, 'result': {}})
        if body['method'] == 'notifications/initialized':
            return httpx.Response(202, content=b'')
        if body['method'] == 'tools/call' and body['params']['name'] == 'find':
            assert body['params']['arguments']['query'] == 'hello'
            payload = json.dumps({'results': [{'text': 'chunk one', 'metadata': {'source': 'a.pdf'}, 'score': 0.9}]})
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2,
                                              'result': {'content': [{'type': 'text', 'text': payload}]}})
        raise AssertionError(body['method'])

    monkeypatch.setattr(controller, '_newHttpClient', lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    body = {'query': 'hello', 'vectorstore': {'store': 'mcp:9', 'collection': 'docs'}}
    r = controller.storeFind(ctx(body=body), 1)
    assert r == {
        'success': True,
        'data': {'query': 'hello', 'results': [{'content': 'chunk one', 'source': 'a.pdf', 'score': 0.9}]},
        'status_code': 200,
    }


def test_store_find_tool_error_returns_400(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW, {'url': 'https://vec.example/mcp', 'headers': None}])
    controller = ic(db)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body['method'] == 'initialize':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {}})
        if body['method'] == 'tools/call':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2, 'error': {'message': 'collection missing'}})
        raise AssertionError(body['method'])

    monkeypatch.setattr(controller, '_newHttpClient', lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    body = {'query': 'hello', 'vectorstore': {'store': 'mcp:9', 'collection': 'docs'}}
    r = controller.storeFind(ctx(body=body), 1)
    assert r == {'success': False, 'error': 'collection missing', 'status_code': 400}


# ============================================================================
# runStream (SSE) — PHP 472-633
# ============================================================================

def test_run_stream_unauthenticated_sends_error_and_done():
    sse = FakeSse()
    ic().runStream(ctx(user_id=0, sse=sse), 1)
    assert sse.frames == [{'type': 'error', 'error': 'Authentication required'}, '[DONE]']


def test_run_stream_access_denied_sends_error_and_done():
    db = FakeDb(one=[None])
    sse = FakeSse()
    ic(db).runStream(ctx(sse=sse), 1)
    assert sse.frames == [{'type': 'error', 'error': 'Workflow not found or access denied'}, '[DONE]']


def test_run_stream_empty_path_sends_error_and_done():
    db = FakeDb(one=[WORKFLOW_ROW])
    sse = FakeSse()
    ic(db).runStream(ctx(body={'loader': {'path': ''}}, sse=sse), 1)
    assert sse.frames == [{'type': 'error', 'error': 'The loader has no Source set.'}, '[DONE]']


def test_run_stream_loader_only_happy_path_frame_sequence(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW])
    controller = ic(db)
    fake = FakeMcpLoader(
        files={'docs': {'files': [{'id': 'a.pdf', 'name': 'a.pdf', 'type': 'file'}]}},
        texts={'a.pdf': 'hello world'},
    )
    patch_loader(monkeypatch, controller, fake)
    sse = FakeSse()
    body = {'loader': {'provider': 'local', 'path': 'docs', 'is_dir': True, 'types': ['pdf']}}
    controller.runStream(ctx(body=body, sse=sse), 1)

    types = [f.get('type') if isinstance(f, dict) else f for f in sse.frames]
    assert types == ['start', 'node', 'log', 'node', 'node', 'node', 'progress', 'done', '[DONE]']
    assert sse.frames[0] == {'type': 'start', 'count': 1, 'sources': ['a.pdf']}
    done = sse.frames[-2]
    assert done == {'type': 'done', 'count': 1, 'files': 1, 'chunks': 1, 'stored': 0, 'errors': 0, 'wrote': False}
    assert fake.closed is True


def test_run_stream_client_aborted_swallowed_quietly():
    db = FakeDb(one=[WORKFLOW_ROW])
    sse = FakeSse()
    sse.aborted = True   # abort before the very first send
    result = ic(db).runStream(ctx(sse=sse), 1)
    assert result is None
    assert sse.frames == []


# ============================================================================
# runStart — PHP 720-797
# ============================================================================

def test_run_start_unauthenticated_returns_401():
    r = ic().runStart(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_run_start_missing_workflow_id_returns_404_not_400():
    # PHP 727: `!$workflowId || !canUserAccess(...)` -- combined, like saveScript.
    r = ic().runStart(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_run_start_empty_path_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = ic(db).runStart(ctx(body={'loader': {'path': ''}}), 1)
    assert r == {'success': False, 'error': 'The loader has no Source set.', 'status_code': 400}


def test_run_start_no_files_returns_null_run_id(monkeypatch):
    db = FakeDb(one=[WORKFLOW_ROW])
    controller = ic(db)
    fake = FakeMcpLoader()
    patch_loader(monkeypatch, controller, fake)
    r = controller.runStart(ctx(body={'loader': {'path': 'nomatch.exe'}}), 1)
    assert r == {'success': True, 'data': {'run_id': None, 'count': 0}, 'status_code': 200}
    assert fake.closed is True


def test_run_start_happy_path_persists_run_file(monkeypatch, tmp_path):
    db = FakeDb(one=[WORKFLOW_ROW])
    controller = ic(db)
    fake = FakeMcpLoader(texts={'a.pdf': 'hi'})
    monkeypatch.setattr(controller, '_ingestionRunDir', lambda: str(tmp_path))
    patch_loader(monkeypatch, controller, fake)
    body = {'loader': {'provider': 'local', 'path': 'a.pdf'}, 'splitter': {'chunk_size': 200}}
    r = controller.runStart(ctx(body=body), 1)
    assert r['success'] is True
    runId = r['data']['run_id']
    assert r['data']['count'] == 1
    import re as _re
    assert _re.match(r'^[a-f0-9]{16}$', runId)
    run_file = tmp_path / f'{runId}.json'
    cursor_file = tmp_path / f'{runId}.cur'
    assert run_file.is_file()
    assert cursor_file.read_text(encoding='utf-8') == '0'
    persisted = json.loads(run_file.read_text(encoding='utf-8'))
    assert persisted['config']['user_id'] == 3
    assert persisted['config']['chunk_size'] == 200
    assert persisted['config']['has_store'] is False
    assert len(persisted['descriptors']) == 1
    assert fake.closed is True


# ============================================================================
# runWorker (SSE) — PHP 807-925
# ============================================================================

def test_run_worker_unauthenticated_sends_error_and_done():
    sse = FakeSse()
    ic().runWorker(ctx(user_id=0, sse=sse), 1)
    assert sse.frames == [{'type': 'error', 'error': 'Authentication required'}, '[DONE]']


def test_run_worker_invalid_run_id_sends_error_and_done():
    sse = FakeSse()
    ic().runWorker(ctx(body={'run_id': 'not-hex'}, sse=sse), 1)
    assert sse.frames == [{'type': 'error', 'error': 'Invalid run id'}, '[DONE]']


def test_run_worker_run_not_found_sends_error_and_done(monkeypatch, tmp_path):
    controller = ic()
    monkeypatch.setattr(controller, '_ingestionRunDir', lambda: str(tmp_path))
    sse = FakeSse()
    controller.runWorker(ctx(body={'run_id': 'a' * 16}, sse=sse), 1)
    assert sse.frames == [{'type': 'error', 'error': 'Run not found (it may have expired).'}, '[DONE]']


def test_run_worker_access_denied_when_user_mismatch(monkeypatch, tmp_path):
    controller = ic()
    monkeypatch.setattr(controller, '_ingestionRunDir', lambda: str(tmp_path))
    runId = 'a' * 16
    (tmp_path / f'{runId}.json').write_text(json.dumps({'config': {'user_id': 999}, 'descriptors': []}), encoding='utf-8')
    sse = FakeSse()
    controller.runWorker(ctx(body={'run_id': runId}, sse=sse, user_id=3), 1)
    assert sse.frames == [{'type': 'error', 'error': 'Access denied'}, '[DONE]']


def test_run_worker_happy_path_no_store(monkeypatch, tmp_path):
    controller = ic()
    monkeypatch.setattr(controller, '_ingestionRunDir', lambda: str(tmp_path))
    fake = FakeMcpLoader(texts={'a.pdf': 'hello worker'})
    patch_loader(monkeypatch, controller, fake)
    runId = 'b' * 16
    run = {
        'config': {'user_id': 3, 'has_splitter': True, 'has_store': False, 'chunk_size': 1000, 'overlap': 150,
                   'collection': '', 'provider': '', 'connection': {}, 'embedding': '', 'server_id': 0,
                   'server_url': None, 'server_headers': None},
        'descriptors': [{'provider': 'local', 'file_id': 'a.pdf', 'name': 'a.pdf', 'source': 'a.pdf', 'doc_type': 'pdf'}],
    }
    (tmp_path / f'{runId}.json').write_text(json.dumps(run), encoding='utf-8')
    (tmp_path / f'{runId}.cur').write_text('0', encoding='utf-8')

    sse = FakeSse()
    controller.runWorker(ctx(body={'run_id': runId}, sse=sse, user_id=3), 1)

    types = [f.get('type') if isinstance(f, dict) else f for f in sse.frames]
    assert types == ['log', 'log', 'progress', 'done', '[DONE]']
    done = sse.frames[-2]
    assert done == {'type': 'done', 'files': 1, 'chunks': 1, 'stored': 0, 'errors': 0, 'wrote': False}
    assert (tmp_path / f'{runId}.cur').read_text(encoding='utf-8') == '1'
    assert fake.closed is True


def test_run_worker_exhausted_run_produces_no_file_activity(monkeypatch, tmp_path):
    controller = ic()
    monkeypatch.setattr(controller, '_ingestionRunDir', lambda: str(tmp_path))
    fake = FakeMcpLoader()
    patch_loader(monkeypatch, controller, fake)
    runId = 'c' * 16
    run = {'config': {'user_id': 3, 'has_store': False}, 'descriptors': []}
    (tmp_path / f'{runId}.json').write_text(json.dumps(run), encoding='utf-8')
    (tmp_path / f'{runId}.cur').write_text('0', encoding='utf-8')

    sse = FakeSse()
    controller.runWorker(ctx(body={'run_id': runId}, sse=sse, user_id=3), 1)
    assert sse.frames == [
        {'type': 'done', 'files': 0, 'chunks': 0, 'stored': 0, 'errors': 0, 'wrote': False},
        '[DONE]',
    ]
