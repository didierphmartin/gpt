"""Port of backend/src/AgentTeam/Controllers/IngestionController.php (1231 lines).

Dedicated RAG ingestion endpoints — separate from the agent run/compile
controller (WorkflowController). Each chunk/script is compiled from the node
configs the FRONTEND sends, NOT from the saved graph. The real separation
lives in IngestionCompiler; this controller only auth-gates and relays.

Ported: `nodeCode`, `compile`, `saveScript`, `loaderText`, `splitterChunks`,
`storeChunks`, `storeFind`, `runStream`, `runStart`, `runWorker`, and every
private helper (`ingestionRunDir`/`runFilePath`/`runCursorPath`/
`claimNextFile`/`cleanupOldRuns`/`callMcpServer`/`mcpBaseHeaders`/
`openMcpSession`/`callMcpTool`/`mcpPost`/`normalizeMcpBody`/
`interpretToolResult`/`buildLoaderClosures`).

HTTP wiring (PHP wins over the brief — this is Task 6's own responsibility;
Task 5's report explicitly notes VectorMcpStore/IngestionLoader take injected
callables and do no HTTP of their own): every vector-DB MCP call
(`storeChunks`/`storeFind`/`runStream`/`runWorker`) goes through
`self._newHttpClient()` — a thin factory (Python-only; PHP's curl_init/
curl_close per call has no client object to share) so unit tests can swap in
an `httpx.MockTransport` after construction, mirroring
`tests/unit/test_mcp_tools_loader.py`'s `ld._http = httpx.Client(transport=
httpx.MockTransport(handler))` pattern — while every real call uses
`SHARED_SSL_CONTEXT` and PHP's own curl timeouts (`CURLOPT_TIMEOUT=60`,
`CURLOPT_CONNECTTIMEOUT=10`, PHP 1085-1086) uniformly, matching the literal
per-call cURL options PHP sets on every one of `mcpPost`'s callers (there is
no per-caller variation in PHP — `runStream`'s `set_time_limit(0)` only lifts
PHP's own execution ceiling, not curl's per-request timeout). langfs (storage
MCP) calls go through the already-ported `MCPToolsLoader` (its own
`httpx.Client`, `SHARED_SSL_CONTEXT`-backed, closed via `.close()` — see
`buildLoaderClosures`/`_buildLoaderClosures` below), exactly like
`AgentController.listTools`'s close-in-finally precedent
(agent_controller.py:370-386).

File-write permissions: PHP passes explicit, non-default mkdir modes here
(`saveScript`: `mkdir($dir, 0775, true)`, PHP 196; `ingestionRunDir`:
`mkdir($dir, 0700, true)`, PHP 930-933) — unlike the generic-umask cases
elsewhere in this port (chat_attachment_controller.py, skill_tool_bridge.py)
that motivate the "0o666 files / 0o777 dirs" Phase 2d convention the task
brief mentions. Per "PHP wins over the brief", `ingestionRunDir`'s run/cursor
files keep PHP's literal 0700 privacy mode verbatim (internal run-coordination
state, never meant to be read by another process/tool). `saveScript`'s and
`compile`'s script writes ARE meant to be read/run later by other tooling
(langchain_runner, a human, download+run), so — consistent with the
chat_attachment_controller.py/skill_tool_bridge.py precedent of widening
permissions past a masked mkdir/file-write for cross-process interop — this
port widens those specific writes to 0o777 (dir, only if freshly created) /
0o666 (file) best-effort, on top of PHP's own literal mkdir mode. This is a
Python-only addition (PHP has no matching chmod call for these two writes);
documented per-method below.
"""
from __future__ import annotations

import fcntl
import os
import re
import secrets
import tempfile
import time as _time

import httpx

from app.agent_team.services.ingestion_compiler import IngestionCompiler
from app.agent_team.services.ingestion_loader import IngestionLoader
from app.agent_team.services.ingestion_splitter import IngestionSplitter
from app.agent_team.services.vector_mcp_store import VectorMcpStore
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.config import PHP_BACKEND
from app.providers._http import SHARED_SSL_CONTEXT
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support import phpjson
from app.support.logger import error_log
from app.support.phpcompat import mb_substr, php_bool, php_empty, php_intval, php_strval, php_trim, php_values

_MCP_STORE_RE = re.compile(r'^mcp:(\d+)$', re.ASCII)
_RUN_ID_RE = re.compile(r'^[a-f0-9]{16}$')
_HEADER_NAME_SANITIZE_RE = re.compile(r'[\r\n:]')
_HEADER_VALUE_SANITIZE_RE = re.compile(r'[\r\n]')

#: PHP 1085-1086 (`CURLOPT_TIMEOUT => 60, CURLOPT_CONNECTTIMEOUT => 10`) — the
#: SAME per-call cURL options every one of mcpPost's callers gets; there is no
#: per-caller variation in PHP (runStream's `set_time_limit(0)` only lifts
#: PHP's own execution ceiling, not curl's per-request timeout).
_MCP_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def _nested_get(d, *keys):
    """`$arr[k1][k2] ?? null`-style chained lookup: None as soon as any
    intermediate value isn't itself a dict, exactly like PHP's array offset
    access returning null off a non-array (same helper as
    workflow_controller.py's own `_nested_get`, duplicated locally per this
    phase's "touch no other files" rule)."""
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _str_or(v, default: str) -> str:
    """`(string) ($v ?? $default) ?: $default` (PHP's own pattern, repeated
    verbatim at PHP 234, 293, 380, 509, 738 for the loader's `provider`):
    None/missing falls back to `default`, and so does any falsy cast result
    ('' or '0')."""
    s = php_strval(v) if v is not None else default
    return default if php_empty(s) else s


class IngestionController:
    def __init__(self, db, config):
        """PHP 32-37."""
        self.db = db
        self.config = config
        self.workflowRepository = WorkflowRepository(db)

    def _newHttpClient(self) -> httpx.Client:
        """Python-only factory (see module docstring) — every real call uses
        SHARED_SSL_CONTEXT + PHP's own per-call cURL timeouts; unit tests
        monkeypatch this to return an `httpx.Client(transport=
        httpx.MockTransport(handler))`."""
        return httpx.Client(timeout=_MCP_TIMEOUT, verify=SHARED_SSL_CONTEXT)

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/node-code — PHP 44-81
    # ========================================================================

    def nodeCode(self, request, id: int = 0) -> dict:
        """PHP 44-81. Compile the Python chunk for a SINGLE node (or, when
        `stages` is a non-empty ordered array, the cumulative view through
        the target/last stage) from the config the frontend sends."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}
        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        stages = body.get('stages')
        stagesList = php_values(stages) if isinstance(stages, (list, dict)) else None

        try:
            if stagesList:
                view = IngestionCompiler.compileView(stagesList)
                last = stagesList[-1] if isinstance(stagesList[-1], dict) else {}
                nodeType = php_strval(
                    last.get('node_type') if last.get('node_type') is not None
                    else (last.get('type') if last.get('type') is not None else 'loader'))
            else:
                nodeType = php_strval(body.get('node_type') if body.get('node_type') is not None else 'loader')
                cfg = body.get('config') if isinstance(body.get('config'), dict) else {}
                view = IngestionCompiler.compileNodeView(nodeType, cfg)

            data = {'node': nodeType}
            data.update(view)
            return {'success': True, 'data': data, 'status_code': 200}
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            return {'success': False, 'error': str(e), 'status_code': 400}

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/compile — PHP 89-143
    # ========================================================================

    def compile(self, request, id: int = 0) -> dict:
        """PHP 89-143. Compile the full runnable standalone script and
        best-effort write it under langchain_runner/."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}
        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        loader = body.get('loader') if isinstance(body.get('loader'), dict) else {}
        splitter = body.get('splitter') if isinstance(body.get('splitter'), dict) else {}
        store = body.get('vectorstore') if isinstance(body.get('vectorstore'), dict) else {}

        ctx: dict = {}
        if not php_empty(loader.get('storage_mcp_url')):
            ctx['langfs_url'] = php_strval(loader['storage_mcp_url'])
        m = _MCP_STORE_RE.match(php_strval(store.get('store') if store.get('store') is not None else ''))
        if m:
            row = self.db.fetch_one("SELECT url FROM mcp_servers WHERE id = ? AND enabled = 1", [php_intval(m.group(1))])
            if row:
                ctx['mcpqrant_url'] = php_strval(row['url'])

        try:
            r = IngestionCompiler.compileScript(loader, splitter, store, ctx)

            path = str(PHP_BACKEND.parent / 'langchain_runner' / os.path.basename(r['filename']))
            written = False
            try:
                with open(path, 'w', encoding='utf-8') as fh:
                    fh.write(r['code'])
                written = True
            except OSError:
                written = False
            if written:
                # Python-only widening (see module docstring) — PHP's own
                # `@file_put_contents` has no matching chmod call.
                try:
                    os.chmod(path, 0o666)
                except OSError:
                    pass

            return {
                'success': True,
                'data': {
                    'filename': r['filename'],
                    'path': path if written else None,
                    'written': written,
                    'code': r['code'],
                },
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 400}

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/save-script — PHP 153-204
    # ========================================================================

    def saveScript(self, request, id: int = 0) -> dict:
        """PHP 153-204. Store an already-compiled ingestion script to a
        chosen location; default target is langchain_runner/."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId or not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        code = php_strval(body.get('code') if body.get('code') is not None else '')
        dest = php_trim(php_strval(body.get('dest') if body.get('dest') is not None else ''))
        filename = os.path.basename(php_trim(php_strval(body.get('filename') if body.get('filename') is not None else '')))
        if code == '':
            return {'success': False, 'error': 'Nothing to save (empty script).', 'status_code': 400}
        if filename == '':
            filename = 'ingestion_pipeline.py'
        if not filename.endswith('.py'):
            filename += '.py'

        repoRoot = PHP_BACKEND.parent            # …/gpt
        defaultDir = str(repoRoot / 'langchain_runner')

        # Resolve the destination: blank -> default env; a path ending in
        # .py is a full file path; an absolute dir is used as-is; a relative
        # dir resolves against the gpt repo root.
        if dest == '':
            dir_ = defaultDir
        elif dest.endswith('.py'):
            dir_ = os.path.dirname(dest)
            filename = os.path.basename(dest)
        elif dest[0] in ('/', '~'):
            dir_ = (os.environ.get('HOME', '') + dest[1:]) if dest.startswith('~') else dest
        else:
            dir_ = str(repoRoot) + '/' + dest
        dir_ = dir_.rstrip('/')

        dirJustCreated = not os.path.isdir(dir_)
        if dirJustCreated:
            try:
                os.makedirs(dir_, mode=0o775, exist_ok=True)
            except OSError:
                pass
            if not os.path.isdir(dir_):
                return {'success': False, 'error': f'Could not create directory: {dir_}', 'status_code': 400}
            # Python-only widening (see module docstring) — mkdir's mode is
            # masked by umask; PHP has no matching chmod call.
            try:
                os.chmod(dir_, 0o777)
            except OSError:
                pass

        path = dir_ + '/' + filename
        try:
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(code)
        except OSError:
            return {'success': False, 'error': f'Could not write to: {path}', 'status_code': 400}
        try:
            os.chmod(path, 0o666)
        except OSError:
            pass

        return {'success': True, 'data': {'path': path, 'default_dir': defaultDir}, 'status_code': 200}

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/loader-text — PHP 216-262
    # ========================================================================

    def loaderText(self, request, id: int = 0) -> dict:
        """PHP 216-262. `@set_time_limit(120)` is a no-op here (uvicorn has
        no per-request PHP-style time limit — see WorkflowController.run's
        docstring)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}
        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        cfg = body.get('config') if isinstance(body.get('config'), dict) else {}
        cursor = max(0, php_intval(body.get('cursor') if body.get('cursor') is not None else 0))
        provider = _str_or(cfg.get('provider'), 'local')
        path = php_trim(php_strval(cfg.get('path') if cfg.get('path') is not None else ''))
        isDir = php_bool(cfg.get('is_dir'))
        types = [v for v in php_values(cfg.get('types') if cfg.get('types') is not None else []) if isinstance(v, str)]

        if path == '':
            return {'success': False, 'error': 'Choose a file or folder in the loader first.', 'status_code': 400}

        listFiles, readFile, mcpLoader = self._buildLoaderClosures(
            userId, php_strval(cfg.get('storage_mcp_id') if cfg.get('storage_mcp_id') is not None else ''))
        try:
            try:
                round_ = IngestionLoader.readRound(listFiles, readFile, provider, path, types, isDir, cursor)
                cur = round_['current']
                if cur is None:
                    round_['logs'] = ['[loader] ' + (
                        'no matching files (check Source + File types)' if round_['count'] == 0
                        else f"done — {round_['count']} file(s)")]
                elif 'error' in cur:
                    round_['logs'] = [f"[loader] {cur['source']}: ERROR — {cur['error']}"]
                else:
                    round_['logs'] = [f"[loader] file {round_['cursor'] + 1}/{round_['count']}: "
                                       f"{cur['source']} → {cur['type']}, {cur['chars']} chars"]
                return {'success': True, 'data': round_, 'status_code': 200}
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 400}
        finally:
            self._closeMcpLoader(mcpLoader)

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/splitter-chunks — PHP 273-349
    # ========================================================================

    def splitterChunks(self, request, id: int = 0) -> dict:
        """PHP 273-349. `@set_time_limit(120)` is a no-op (see loaderText)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}
        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        loaderCfg = body.get('loader') if isinstance(body.get('loader'), dict) else {}
        splitterCfg = body.get('splitter') if isinstance(body.get('splitter'), dict) else {}
        cursor = max(0, php_intval(body.get('cursor') if body.get('cursor') is not None else 0))

        provider = _str_or(loaderCfg.get('provider'), 'local')
        path = php_trim(php_strval(loaderCfg.get('path') if loaderCfg.get('path') is not None else ''))
        isDir = php_bool(loaderCfg.get('is_dir'))
        types = [v for v in php_values(loaderCfg.get('types') if loaderCfg.get('types') is not None else []) if isinstance(v, str)]
        chunkSize = max(1, php_intval(splitterCfg.get('chunk_size') if splitterCfg.get('chunk_size') is not None else 1000))
        overlap = max(0, php_intval(splitterCfg.get('overlap') if splitterCfg.get('overlap') is not None else 150))

        if path == '':
            return {'success': False, 'error': 'The upstream loader has no Source set — pick a file or folder first.', 'status_code': 400}

        listFiles, readFile, mcpLoader = self._buildLoaderClosures(
            userId, php_strval(loaderCfg.get('storage_mcp_id') if loaderCfg.get('storage_mcp_id') is not None else ''))
        try:
            try:
                round_ = IngestionLoader.readRound(listFiles, readFile, provider, path, types, isDir, cursor, 5_000_000)
                cur = round_['current']
                out = {'count': round_['count'], 'cursor': round_['cursor'], 'sources': round_['sources'], 'current': None}
                logs = []
                if cur is None:
                    logs.append('[splitter] ' + ('no files to chunk' if round_['count'] == 0 else 'done'))
                elif 'error' in cur:
                    out['current'] = {'source': cur['source'], 'type': cur.get('type'), 'error': cur['error']}
                    logs.append(f"[loader] {cur['source']}: ERROR — {cur['error']}")
                else:
                    logs.append(f"[loader] file {round_['cursor'] + 1}/{round_['count']}: "
                                 f"{cur['source']} → {cur['type']}, {len(cur['text'])} chars")
                    chunks = IngestionSplitter.recursiveSplit(cur['text'], chunkSize, overlap)
                    maxChunks = 200
                    maxLen = 2000
                    shown = []
                    for c in chunks[:maxChunks]:
                        ln = len(c)
                        shown.append({'chars': ln, 'text': mb_substr(c, 0, maxLen) if ln > maxLen else c, 'clipped': ln > maxLen})
                    out['current'] = {
                        'source': cur['source'],
                        'type': cur['type'],
                        'chunk_count': len(chunks),
                        'chunks': shown,
                        'truncated': len(chunks) > maxChunks,
                    }
                    logs.append(f"[splitter] {cur['source']}: {len(chunks)} chunk(s) (size={chunkSize}, overlap={overlap})")
                out['logs'] = logs
                return {'success': True, 'data': out, 'status_code': 200}
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 400}
        finally:
            self._closeMcpLoader(mcpLoader)

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/store-chunks — PHP 359-460
    # ========================================================================

    def storeChunks(self, request, id: int = 0) -> dict:
        """PHP 359-460. `@set_time_limit(180)` is a no-op (see loaderText)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}
        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        loaderCfg = body.get('loader') if isinstance(body.get('loader'), dict) else {}
        splitterCfg = body.get('splitter') if isinstance(body.get('splitter'), dict) else {}
        storeCfg = body.get('vectorstore') if isinstance(body.get('vectorstore'), dict) else {}
        cursor = max(0, php_intval(body.get('cursor') if body.get('cursor') is not None else 0))

        provider = _str_or(loaderCfg.get('provider'), 'local')
        path = php_trim(php_strval(loaderCfg.get('path') if loaderCfg.get('path') is not None else ''))
        isDir = php_bool(loaderCfg.get('is_dir'))
        types = [v for v in php_values(loaderCfg.get('types') if loaderCfg.get('types') is not None else []) if isinstance(v, str)]
        chunkSize = max(1, php_intval(splitterCfg.get('chunk_size') if splitterCfg.get('chunk_size') is not None else 1000))
        overlap = max(0, php_intval(splitterCfg.get('overlap') if splitterCfg.get('overlap') is not None else 150))
        collection = php_trim(php_strval(storeCfg.get('collection') if storeCfg.get('collection') is not None else ''))
        vsProvider = php_trim(php_strval(storeCfg.get('provider') if storeCfg.get('provider') is not None else ''))
        connection = storeCfg.get('connection')
        embedding = php_trim(php_strval(storeCfg.get('embedding') if storeCfg.get('embedding') is not None else ''))

        if path == '':
            return {'success': False, 'error': 'The upstream loader has no Source set.', 'status_code': 400}
        m = _MCP_STORE_RE.match(php_strval(storeCfg.get('store') if storeCfg.get('store') is not None else ''))
        if not m:
            return {'success': False, 'error': 'Pick a vector-DB MCP server in the store node.', 'status_code': 400}
        serverId = php_intval(m.group(1))
        srv = self.db.fetch_one("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1", [serverId])
        if not srv:
            return {'success': False, 'error': f"Vector MCP server #{serverId} not found or disabled.", 'status_code': 400}
        if collection == '':
            return {'success': False, 'error': 'Set a collection name in the store node.', 'status_code': 400}

        listFiles, readFile, mcpLoader = self._buildLoaderClosures(
            userId, php_strval(loaderCfg.get('storage_mcp_id') if loaderCfg.get('storage_mcp_id') is not None else ''))
        try:
            try:
                round_ = IngestionLoader.readRound(listFiles, readFile, provider, path, types, isDir, cursor, 5_000_000)
                out = {'count': round_['count'], 'cursor': round_['cursor'], 'sources': round_['sources'], 'current': None}
                cur = round_['current']
                logs = []
                if cur is None:
                    logs.append('[store] ' + ('no files to store' if round_['count'] == 0 else 'done'))
                elif 'error' in cur:
                    out['current'] = {'source': cur['source'], 'type': cur.get('type'), 'error': cur['error']}
                    logs.append(f"[loader] {cur['source']}: ERROR — {cur['error']}")
                else:
                    logs.append(f"[loader] file {round_['cursor'] + 1}/{round_['count']}: "
                                 f"{cur['source']} → {cur['type']}, {len(cur['text'])} chars")
                    chunks = IngestionSplitter.recursiveSplit(cur['text'], chunkSize, overlap)
                    logs.append(f"[splitter] {cur['source']}: {len(chunks)} chunk(s) (size={chunkSize}, overlap={overlap})")

                    with self._newHttpClient() as httpClient:
                        sess = self._openMcpSession(httpClient, php_strval(srv['url']), self._mcpBaseHeaders(srv.get('headers')))
                        if sess.get('error'):
                            raise RuntimeError('Vector store connection failed: '
                                                + php_strval(sess.get('message') if sess.get('message') is not None else 'session error'))
                        sessHeaders = sess['headers']
                        vs = VectorMcpStore(
                            lambda sid, tool, args, _c=httpClient, _h=sessHeaders: self._callMcpTool(_c, php_strval(srv['url']), _h, tool, args))
                        r = vs.store(serverId, chunks, {
                            'provider': vsProvider,
                            'connection': connection,
                            'collection': collection if collection != '' else None,
                            'embedding': embedding if embedding != '' else None,
                            'metadata': {'source': cur['source']},
                        })

                    out['current'] = {
                        'source': cur['source'],
                        'type': cur['type'],
                        'chunk_count': len(chunks),
                        'stored': r['stored'],
                        'collection': r['collection'],
                    }
                    coll = r['collection'] if r.get('collection') is not None else '(server default)'
                    errSuffix = f" ({r['errors']} failed)" if r.get('errors') else ''
                    logs.append(f"[store] {cur['source']}: wrote {r['stored']} chunk(s){errSuffix} → collection \"{coll}\" on mcp:{serverId}")
                out['logs'] = logs
                return {'success': True, 'data': out, 'status_code': 200}
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 400}
        finally:
            self._closeMcpLoader(mcpLoader)

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/store-find — PHP 642-708
    # ========================================================================

    def storeFind(self, request, id: int = 0) -> dict:
        """PHP 642-708. `@set_time_limit(60)` is a no-op (see loaderText)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}
        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        storeCfg = body.get('vectorstore') if isinstance(body.get('vectorstore'), dict) else {}
        query = php_trim(php_strval(body.get('query') if body.get('query') is not None else ''))
        collection = php_trim(php_strval(storeCfg.get('collection') if storeCfg.get('collection') is not None else ''))
        provider = php_trim(php_strval(storeCfg.get('provider') if storeCfg.get('provider') is not None else ''))
        connection = storeCfg.get('connection')
        embedding = php_trim(php_strval(storeCfg.get('embedding') if storeCfg.get('embedding') is not None else ''))

        if query == '':
            return {'success': False, 'error': 'Enter a search query.', 'status_code': 400}
        m = _MCP_STORE_RE.match(php_strval(storeCfg.get('store') if storeCfg.get('store') is not None else ''))
        if not m:
            return {'success': False, 'error': 'Pick a vector-DB MCP server in the store node.', 'status_code': 400}
        serverId = php_intval(m.group(1))
        srv = self.db.fetch_one("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1", [serverId])
        if not srv:
            return {'success': False, 'error': f"Vector MCP server #{serverId} not found or disabled.", 'status_code': 400}
        if collection == '':
            return {'success': False, 'error': 'Set a collection name in the store node.', 'status_code': 400}

        with self._newHttpClient() as httpClient:
            vs = VectorMcpStore(
                lambda sid, tool, args, _c=httpClient: self._callMcpServer(_c, php_strval(srv['url']), srv.get('headers'), tool, args))
            try:
                find = vs.find(serverId, query, {
                    'provider': provider,
                    'connection': connection,
                    'collection': collection,
                    'embedding': embedding if embedding != '' else None,
                    'limit': 5,
                })
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 400}

        # Map the MCP's {text,metadata,score} to the Search panel's {content,source,score}.
        results = []
        for r in find['results']:
            meta = r.get('metadata')
            results.append({
                'content': r['text'],
                'source': meta.get('source') if isinstance(meta, dict) else None,
                'score': r['score'],
            })
        return {'success': True, 'data': {'query': query, 'results': results}, 'status_code': 200}

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/run-stream (SSE) — PHP 472-633
    # ========================================================================

    def runStream(self, request, id: int = 0) -> None:
        """PHP 472-633. SSE headers/output-buffering/flush are handled by
        the shared bridge (`request['sse']` — see app/support/sse.py); every
        PHP `$sse(...)` call below becomes `sse.send_data(event)` (bare
        `data:` frame, no `event:` line — PHP 481-484), matching
        WorkflowController.runStream's own pattern.

        Python-only CLIENT_ABORTED handling: PHP's own `$sse` closure here
        does NOT itself check `connection_aborted()` (unlike ChatController's
        `$sendEvent`) — only the per-file loop does, proactively, before each
        iteration (PHP 578-580, mirrored below via `sse.aborted`). But this
        port's `sse.send_data()` (app/support/sse.py) always raises
        `RuntimeError('CLIENT_ABORTED')` once the bridge is aborted (there is
        no fire-into-the-void `echo`+`flush()` no-op like PHP's SAPI has), so
        the trailing unconditional `done` event PHP sends after the loop can
        raise even when the loop's own proactive check already caught the
        abort. Caught once at the outer level and swallowed quietly — same
        idiom as ChatController.verify's own CLIENT_ABORTED handling
        (chat_controller.py:1413-1415)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        sse = request['sse']

        def sseEvent(event: dict) -> None:
            sse.send_data(event)

        def sseDone() -> None:
            sse.send_data('[DONE]')

        try:
            self._runStreamInner(userId, workflowId, request, sse, sseEvent, sseDone)
        except RuntimeError as e:
            if str(e) == 'CLIENT_ABORTED':
                error_log('[IngestionController] runStream: client aborted')
                return None
            raise
        return None

    def _runStreamInner(self, userId, workflowId, request, sse, sseEvent, sseDone) -> None:
        if not userId:
            sseEvent({'type': 'error', 'error': 'Authentication required'})
            sseDone()
            return
        if not workflowId or not self.workflowRepository.canUserAccess(userId, workflowId):
            sseEvent({'type': 'error', 'error': 'Workflow not found or access denied'})
            sseDone()
            return

        body = request['body'] if request.get('body') is not None else {}
        loaderCfg = body.get('loader') if isinstance(body.get('loader'), dict) else {}
        hasSplitter = body.get('splitter') is not None
        hasStore = body.get('vectorstore') is not None
        splitterCfg = body.get('splitter') if isinstance(body.get('splitter'), dict) else {}
        storeCfg = body.get('vectorstore') if isinstance(body.get('vectorstore'), dict) else {}

        provider = _str_or(loaderCfg.get('provider'), 'local')
        path = php_trim(php_strval(loaderCfg.get('path') if loaderCfg.get('path') is not None else ''))
        isDir = php_bool(loaderCfg.get('is_dir'))
        types = [v for v in php_values(loaderCfg.get('types') if loaderCfg.get('types') is not None else []) if isinstance(v, str)]
        chunkSize = max(1, php_intval(splitterCfg.get('chunk_size') if splitterCfg.get('chunk_size') is not None else 1000))
        overlap = max(0, php_intval(splitterCfg.get('overlap') if splitterCfg.get('overlap') is not None else 150))
        collection = php_trim(php_strval(storeCfg.get('collection') if storeCfg.get('collection') is not None else ''))
        vsProvider = php_trim(php_strval(storeCfg.get('provider') if storeCfg.get('provider') is not None else ''))
        connection = storeCfg.get('connection')
        embedding = php_trim(php_strval(storeCfg.get('embedding') if storeCfg.get('embedding') is not None else ''))

        if path == '':
            sseEvent({'type': 'error', 'error': 'The loader has no Source set.'})
            sseDone()
            return

        srv = None
        serverId = 0
        if hasStore:
            m = _MCP_STORE_RE.match(php_strval(storeCfg.get('store') if storeCfg.get('store') is not None else ''))
            if not m:
                sseEvent({'type': 'error', 'error': 'The store node needs a vector-DB MCP server selected.'})
                sseDone()
                return
            serverId = php_intval(m.group(1))
            srv = self.db.fetch_one("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1", [serverId])
            if not srv:
                sseEvent({'type': 'error', 'error': f"Vector MCP server #{serverId} not found or disabled."})
                sseDone()
                return
            if collection == '':
                sseEvent({'type': 'error', 'error': 'Set a collection name in the store node.'})
                sseDone()
                return

        listFiles, readFile, mcpLoader = self._buildLoaderClosures(
            userId, php_strval(loaderCfg.get('storage_mcp_id') if loaderCfg.get('storage_mcp_id') is not None else ''))
        httpClient = self._newHttpClient()
        try:
            try:
                descs = IngestionLoader.enumerateFiles(listFiles, provider, path, types, isDir)
            except Exception as e:  # noqa: BLE001
                sseEvent({'type': 'error', 'error': 'Loader enumeration failed: ' + str(e)})
                sseDone()
                return
            count = len(descs)
            sseEvent({'type': 'start', 'count': count, 'sources': [d['source'] for d in descs]})

            vs = None
            if hasStore:
                sess = self._openMcpSession(httpClient, php_strval(srv['url']), self._mcpBaseHeaders(srv.get('headers')))
                if sess.get('error'):
                    sseEvent({'type': 'error', 'error': 'Vector store connection failed: '
                              + php_strval(sess.get('message') if sess.get('message') is not None else 'session error')})
                    sseDone()
                    return
                sessHeaders = sess['headers']
                vs = VectorMcpStore(
                    lambda sid, tool, args: self._callMcpTool(httpClient, php_strval(srv['url']), sessHeaders, tool, args))

            files = chunks = stored = errors = 0
            for i, desc in enumerate(descs):
                if sse.aborted:
                    break
                sseEvent({'type': 'node', 'node': 'loader', 'state': 'active'})
                try:
                    text = IngestionLoader.loadFile(readFile, desc)
                except Exception as e:  # noqa: BLE001
                    errors += 1
                    sseEvent({'type': 'log', 'lines': [f"[loader] {desc['source']}: ERROR — {e}"]})
                    sseEvent({'type': 'node', 'node': 'loader', 'state': 'error'})
                    continue
                sseEvent({'type': 'log', 'lines': [f"[loader] file {i + 1}/{count}: {desc['source']} → {desc['doc_type']}, {len(text)} chars"]})
                sseEvent({'type': 'node', 'node': 'loader', 'state': 'done'})

                sseEvent({'type': 'node', 'node': 'splitter', 'state': 'active'})
                ch = IngestionSplitter.recursiveSplit(text, chunkSize, overlap)
                chunks += len(ch)
                if hasSplitter:
                    sseEvent({'type': 'log', 'lines': [f"[splitter] {desc['source']}: {len(ch)} chunk(s) (size={chunkSize}, overlap={overlap})"]})
                sseEvent({'type': 'node', 'node': 'splitter', 'state': 'done'})

                if hasStore and vs is not None:
                    sseEvent({'type': 'node', 'node': 'vectorstore', 'state': 'active'})
                    try:
                        r = vs.store(serverId, ch, {
                            'provider': vsProvider,
                            'connection': connection,
                            'collection': collection if collection != '' else None,
                            'embedding': embedding if embedding != '' else None,
                            'metadata': {'source': desc['source']},
                        })
                        stored += r['stored']
                        errors += r['errors']
                        errSuffix = f" ({r['errors']} failed)" if r.get('errors') else ''
                        collSuffix = f' → "{collection}"' if collection != '' else ''
                        sseEvent({'type': 'log', 'lines': [f"[store] {desc['source']}: wrote {r['stored']} chunk(s){errSuffix}{collSuffix} on mcp:{serverId}"]})
                        sseEvent({'type': 'node', 'node': 'vectorstore', 'state': 'done'})
                    except Exception as e:  # noqa: BLE001
                        errors += 1
                        sseEvent({'type': 'log', 'lines': [f"[store] {desc['source']}: ERROR — {e}"]})
                        sseEvent({'type': 'node', 'node': 'vectorstore', 'state': 'error'})
                        continue

                files += 1
                sseEvent({'type': 'progress', 'cursor': i + 1, 'count': count, 'source': desc['source'],
                          'files': files, 'chunks': chunks, 'stored': stored})

            # Silence = done (the loader is exhausted -> the loop ends).
            sseEvent({'type': 'done', 'count': count, 'files': files, 'chunks': chunks, 'stored': stored, 'errors': errors, 'wrote': hasStore})
            sseDone()
        finally:
            try:
                httpClient.close()
            except Exception:  # noqa: BLE001
                pass
            self._closeMcpLoader(mcpLoader)

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/run-start — PHP 720-797
    # ========================================================================

    def runStart(self, request, id: int = 0) -> dict:
        """PHP 720-797. `@set_time_limit(120)` is a no-op (see loaderText)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId or not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        body = request['body'] if request.get('body') is not None else {}
        loaderCfg = body.get('loader') if isinstance(body.get('loader'), dict) else {}
        hasSplitter = body.get('splitter') is not None
        hasStore = body.get('vectorstore') is not None
        splitterCfg = body.get('splitter') if isinstance(body.get('splitter'), dict) else {}
        storeCfg = body.get('vectorstore') if isinstance(body.get('vectorstore'), dict) else {}

        provider = _str_or(loaderCfg.get('provider'), 'local')
        path = php_trim(php_strval(loaderCfg.get('path') if loaderCfg.get('path') is not None else ''))
        isDir = php_bool(loaderCfg.get('is_dir'))
        types = [v for v in php_values(loaderCfg.get('types') if loaderCfg.get('types') is not None else []) if isinstance(v, str)]

        if path == '':
            return {'success': False, 'error': 'The loader has no Source set.', 'status_code': 400}

        serverId = 0
        srv = None
        if hasStore:
            m = _MCP_STORE_RE.match(php_strval(storeCfg.get('store') if storeCfg.get('store') is not None else ''))
            if not m:
                return {'success': False, 'error': 'The store node needs a vector-DB MCP server selected.', 'status_code': 400}
            serverId = php_intval(m.group(1))
            srv = self.db.fetch_one("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1", [serverId])
            if not srv:
                return {'success': False, 'error': f"Vector MCP server #{serverId} not found or disabled.", 'status_code': 400}
            if php_trim(php_strval(storeCfg.get('collection') if storeCfg.get('collection') is not None else '')) == '':
                return {'success': False, 'error': 'Set a collection name in the store node.', 'status_code': 400}

        listFiles, readFile, mcpLoader = self._buildLoaderClosures(
            userId, php_strval(loaderCfg.get('storage_mcp_id') if loaderCfg.get('storage_mcp_id') is not None else ''))
        try:
            try:
                descriptors = IngestionLoader.enumerateFiles(listFiles, provider, path, types, isDir)
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': 'Loader enumeration failed: ' + str(e), 'status_code': 400}
            count = len(descriptors)
            if count == 0:
                return {'success': True, 'data': {'run_id': None, 'count': 0}, 'status_code': 200}

            runId = secrets.token_hex(8)
            runConfig = {
                'user_id': php_intval(userId),
                'has_splitter': hasSplitter,
                'has_store': hasStore,
                'chunk_size': max(1, php_intval(splitterCfg.get('chunk_size') if splitterCfg.get('chunk_size') is not None else 1000)),
                'overlap': max(0, php_intval(splitterCfg.get('overlap') if splitterCfg.get('overlap') is not None else 150)),
                'collection': php_trim(php_strval(storeCfg.get('collection') if storeCfg.get('collection') is not None else '')),
                'provider': php_trim(php_strval(storeCfg.get('provider') if storeCfg.get('provider') is not None else '')),
                'connection': storeCfg.get('connection') if storeCfg.get('connection') is not None else {},
                'embedding': php_trim(php_strval(storeCfg.get('embedding') if storeCfg.get('embedding') is not None else '')),
                'server_id': serverId,
                'server_url': srv.get('url') if srv else None,
                'server_headers': srv.get('headers') if srv else None,
            }
            with open(self._runFilePath(runId), 'w', encoding='utf-8') as fh:
                fh.write(phpjson.php_json_encode({'config': runConfig, 'descriptors': descriptors}))
            with open(self._runCursorPath(runId), 'w', encoding='utf-8') as fh:
                fh.write('0')
            self._cleanupOldRuns()

            return {'success': True, 'data': {'run_id': runId, 'count': count}, 'status_code': 200}
        finally:
            self._closeMcpLoader(mcpLoader)

    # ========================================================================
    # POST /api/v1/workflows/{id}/ingestion/run-worker (SSE) — PHP 807-925
    # ========================================================================

    def runWorker(self, request, id: int = 0) -> None:
        """PHP 807-925. `id` (the route's {id:\\d+} workflow id) is accepted
        for positional-arg parity with the route table but is UNUSED — PHP's
        own runWorker() never reads `$request['params']['id']` either (it
        only uses userId + `run_id` from the body). `@set_time_limit(0)` is a
        no-op (see loaderText). Same CLIENT_ABORTED handling as runStream —
        see that method's docstring."""
        sse = request['sse']

        def sseEvent(event: dict) -> None:
            sse.send_data(event)

        def sseDone() -> None:
            sse.send_data('[DONE]')

        try:
            self._runWorkerInner(request, sse, sseEvent, sseDone)
        except RuntimeError as e:
            if str(e) == 'CLIENT_ABORTED':
                error_log('[IngestionController] runWorker: client aborted')
                return None
            raise
        return None

    def _runWorkerInner(self, request, sse, sseEvent, sseDone) -> None:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if not userId:
            sseEvent({'type': 'error', 'error': 'Authentication required'})
            sseDone()
            return

        body = request['body'] if request.get('body') is not None else {}
        runId = php_strval(body.get('run_id') if body.get('run_id') is not None else '')
        if not _RUN_ID_RE.match(runId):
            sseEvent({'type': 'error', 'error': 'Invalid run id'})
            sseDone()
            return

        runPath = self._runFilePath(runId)
        if not os.path.isfile(runPath):
            sseEvent({'type': 'error', 'error': 'Run not found (it may have expired).'})
            sseDone()
            return

        try:
            with open(runPath, 'r', encoding='utf-8') as fh:
                raw = fh.read()
        except OSError:
            raw = ''
        run = phpjson.php_json_decode(raw)
        run = run if isinstance(run, dict) else {}
        config = run.get('config') if isinstance(run.get('config'), dict) else {}
        descriptors = run.get('descriptors') if isinstance(run.get('descriptors'), list) else []
        if php_intval(config.get('user_id') if config.get('user_id') is not None else -1) != php_intval(userId):
            sseEvent({'type': 'error', 'error': 'Access denied'})
            sseDone()
            return

        count = len(descriptors)
        cursorPath = self._runCursorPath(runId)

        # PHP 850: `(string) (($config['loader']['storage_mcp_id']) ?? '')` —
        # `runStart`'s persisted $config (PHP 778-791) never nests a `loader`
        # key, so this is always '' in practice. Replicated verbatim (a real
        # PHP quirk, not a Python bug) per "PHP wins over the brief" —  never
        # patch PHP behavior.
        _storageMcpId = _nested_get(config, 'loader', 'storage_mcp_id')
        listFiles, readFile, mcpLoader = self._buildLoaderClosures(
            userId, php_strval(_storageMcpId if _storageMcpId is not None else ''))

        httpClient = self._newHttpClient()
        try:
            vs = None
            serverId = php_intval(config.get('server_id') if config.get('server_id') is not None else 0)
            if php_bool(config.get('has_store')):
                url = php_strval(config.get('server_url') if config.get('server_url') is not None else '')
                sess = self._openMcpSession(httpClient, url, self._mcpBaseHeaders(config.get('server_headers')))
                if sess.get('error'):
                    sseEvent({'type': 'error', 'error': 'Vector store connection failed: '
                              + php_strval(sess.get('message') if sess.get('message') is not None else 'session error')})
                    sseDone()
                    return
                sessHeaders = sess['headers']
                vs = VectorMcpStore(lambda sid, tool, args: self._callMcpTool(httpClient, url, sessHeaders, tool, args))

            chunkSize = php_intval(config.get('chunk_size'))
            overlap = php_intval(config.get('overlap'))
            collection = php_strval(config.get('collection') if config.get('collection') is not None else '')
            provider = php_strval(config.get('provider') if config.get('provider') is not None else '')
            connection = config.get('connection') if config.get('connection') is not None else {}
            embedding = php_strval(config.get('embedding') if config.get('embedding') is not None else '')
            hasSplitter = php_bool(config.get('has_splitter'))
            hasStoreFlag = php_bool(config.get('has_store'))

            files = chunks = stored = errors = 0
            while True:
                if sse.aborted:
                    break
                i = self._claimNextFile(cursorPath, count)
                if i is None:
                    break
                desc = descriptors[i] if isinstance(descriptors[i], dict) else {}
                src = php_strval(desc.get('source') if desc.get('source') is not None else '?')
                try:
                    text = IngestionLoader.loadFile(readFile, desc)
                except Exception as e:  # noqa: BLE001
                    errors += 1
                    sseEvent({'type': 'log', 'lines': [f"[loader] {src}: ERROR — {e}"]})
                    continue
                docType = desc.get('doc_type') if desc.get('doc_type') is not None else '?'
                sseEvent({'type': 'log', 'lines': [f"[loader] {i + 1}/{count}: {src} → {docType}, {len(text)} chars"]})
                ch = IngestionSplitter.recursiveSplit(text, chunkSize, overlap)
                chunks += len(ch)
                if hasSplitter:
                    sseEvent({'type': 'log', 'lines': [f"[splitter] {src}: {len(ch)} chunk(s) (size={chunkSize}, overlap={overlap})"]})
                if vs is not None:
                    try:
                        r = vs.store(serverId, ch, {
                            'provider': provider,
                            'connection': connection,
                            'collection': collection if collection != '' else None,
                            'embedding': embedding if embedding != '' else None,
                            'metadata': {'source': src},
                        })
                        stored += r['stored']
                        errors += r['errors']
                        errSuffix = f" ({r['errors']} failed)" if r.get('errors') else ''
                        sseEvent({'type': 'log', 'lines': [f"[store] {src}: wrote {r['stored']} chunk(s){errSuffix} on mcp:{serverId}"]})
                    except Exception as e:  # noqa: BLE001
                        errors += 1
                        sseEvent({'type': 'log', 'lines': [f"[store] {src}: ERROR — {e}"]})
                        continue
                files += 1
                sseEvent({'type': 'progress', 'index': i, 'count': count, 'files': files, 'chunks': chunks, 'stored': stored})

            sseEvent({'type': 'done', 'files': files, 'chunks': chunks, 'stored': stored, 'errors': errors, 'wrote': hasStoreFlag})
            sseDone()
        finally:
            try:
                httpClient.close()
            except Exception:  # noqa: BLE001
                pass
            self._closeMcpLoader(mcpLoader)

    # ========================================================================
    # PRIVATE HELPERS — PHP 927-1231
    # ========================================================================

    def _ingestionRunDir(self) -> str:
        """PHP 928-935. Shared run-state dir (file-based; no DB schema
        needed). PHP's own literal `mkdir($dir, 0700, true)` is kept
        verbatim — see module docstring (this is deliberately private
        run-coordination state, not a Phase-2d-widened artefact)."""
        d = os.path.join(tempfile.gettempdir(), 'gpt_ingestion_runs')
        if not os.path.isdir(d):
            try:
                os.makedirs(d, mode=0o700, exist_ok=True)
            except OSError:
                pass
        return d

    def _runFilePath(self, runId: str) -> str:
        """PHP 937-940."""
        return self._ingestionRunDir() + '/' + runId + '.json'

    def _runCursorPath(self, runId: str) -> str:
        """PHP 942-945."""
        return self._ingestionRunDir() + '/' + runId + '.cur'

    def _claimNextFile(self, cursorPath: str, count: int) -> int | None:
        """PHP 952-973. Atomically claim the next file index from the shared
        cursor (flock so two worker requests never grab the same file)."""
        try:
            fd = os.open(cursorPath, os.O_RDWR | os.O_CREAT, 0o644)
        except OSError:
            return None
        fp = os.fdopen(fd, 'r+', encoding='utf-8')
        claimed = None
        try:
            fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
        except OSError:
            fp.close()
            return None
        try:
            fp.seek(0)
            cur = php_intval(php_trim(fp.read()))
            if cur < count:
                claimed = cur
                fp.seek(0)
                fp.truncate(0)
                fp.write(str(cur + 1))
                fp.flush()
        finally:
            try:
                fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            fp.close()
        return claimed

    def _cleanupOldRuns(self) -> None:
        """PHP 976-984. Delete run files older than 2h (best-effort housekeeping)."""
        cutoff = _time.time() - 7200
        d = self._ingestionRunDir()
        try:
            entries = os.listdir(d)
        except OSError:
            entries = []
        for name in entries:
            f = os.path.join(d, name)
            try:
                mtime = os.path.getmtime(f)
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    os.unlink(f)
                except OSError:
                    pass

    def _callMcpServer(self, client: httpx.Client, url: str, headersJson, tool: str, args: dict) -> dict:
        """PHP 996-1003. Call ONE specific MCP server (fresh session handshake
        every call — used by storeFind, where each request is a single find())."""
        sess = self._openMcpSession(client, url, self._mcpBaseHeaders(headersJson))
        if sess.get('error'):
            return sess
        return self._callMcpTool(client, url, sess['headers'], tool, args)

    def _mcpBaseHeaders(self, headersJson) -> dict:
        """PHP 1006-1020. Base headers (content/accept + the server's stored
        auth headers)."""
        base = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        if headersJson:
            h = phpjson.php_json_decode(headersJson) if isinstance(headersJson, str) else headersJson
            if isinstance(h, dict):
                for k, v in h.items():
                    if isinstance(k, str) and k != '' and isinstance(v, (str, int, float, bool)):
                        name = _HEADER_NAME_SANITIZE_RE.sub('', k)
                        base[name] = _HEADER_VALUE_SANITIZE_RE.sub('', php_strval(v))
        return base

    def _openMcpSession(self, client: httpx.Client, url: str, base: dict) -> dict:
        """PHP 1031-1048. Open a Streamable-HTTP session ONCE: initialize
        (capture the Mcp-Session-Id response header) -> notifications/
        initialized. Returns {'headers': callHeaders} to reuse for every
        subsequent tools/call."""
        result, session = self._mcpPost(client, url, base, {
            'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
            'params': {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'gpt-ingestion', 'version': '1'}},
        })
        if result.get('error'):
            return result
        callHeaders = dict(base)
        if session:
            callHeaders['Mcp-Session-Id'] = session
            self._mcpPost(client, url, callHeaders, {'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}})
        return {'headers': callHeaders}

    def _callMcpTool(self, client: httpx.Client, url: str, callHeaders: dict, tool: str, args: dict) -> dict:
        """PHP 1058-1066. One tools/call on an already-opened session."""
        res, _session = self._mcpPost(client, url, callHeaders, {
            'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
            'params': {'name': tool, 'arguments': args},
        })
        return self._interpretToolResult(res)

    def _mcpPost(self, client: httpx.Client, url: str, headers: dict, payload: dict):
        """PHP 1077-1119. One JSON-RPC POST to an MCP server. Returns
        (parsed_result, session_id_or_None): captures the Mcp-Session-Id
        response header, parses a JSON or SSE body, and normalizes a
        JSON-RPC error to {'error': True, 'message': ...}. A bodyless
        notification ack (202) returns {'ok': True}.

        PHP 1105-1117 decodes `$resp` into an unused `$parsed` local before
        calling `normalizeMcpBody($resp)` (which re-parses the same `$resp`
        from scratch) — dead code with no observable effect (json_decode has
        no side effects); not replicated, since skipping it produces
        byte-identical behavior (see task report)."""
        try:
            resp = client.post(url, json=payload, headers=headers)
        except httpx.RequestError as e:
            return {'error': True, 'message': f"MCP connection failed: {e}"}, None
        if resp.status_code >= 400:
            return {'error': True, 'message': f"MCP server returned HTTP {resp.status_code}"}, None
        session = resp.headers.get('mcp-session-id')
        return self._normalizeMcpBody(resp.text), session

    def _normalizeMcpBody(self, respText):
        """PHP 1122-1144. Decode a JSON or SSE MCP body into a JSON-RPC
        array, normalizing errors."""
        parsed = phpjson.php_json_decode(respText) if respText else None
        if parsed is None:
            for line in (respText or '').split('\n'):
                line = line.strip()
                if line.startswith('data:'):
                    d = line[5:].strip()
                    if d:
                        p = phpjson.php_json_decode(d)
                        if p is not None:
                            parsed = p
                            break
        if not isinstance(parsed, (dict, list)):
            return {'ok': True}   # e.g. 202 Accepted for a notification
        if isinstance(parsed, dict) and parsed.get('error') is not None:
            errField = parsed['error']
            message = (errField.get('message') if isinstance(errField, dict) and errField.get('message') is not None
                       else 'MCP error')
            return {'error': True, 'message': php_strval(message)}
        return parsed

    def _interpretToolResult(self, res: dict) -> dict:
        """PHP 1146-1163. From a parsed JSON-RPC response, return the tool
        result or an error (handles result.isError)."""
        if isinstance(res, dict) and res.get('error'):
            return res
        result = res.get('result') if isinstance(res, dict) and res.get('result') is not None else res
        if isinstance(result, dict) and result.get('isError'):
            msg = ''
            content = result.get('content') if isinstance(result.get('content'), list) else []
            for c in content:
                if isinstance(c, dict) and c.get('text') is not None:
                    msg += php_strval(c['text'])
            return {'error': True, 'message': msg if msg != '' else 'MCP tool error'}
        return result if isinstance(result, dict) else {'ok': True}

    def _closeMcpLoader(self, mcpLoader: MCPToolsLoader) -> None:
        """Python-only cleanup helper — see module docstring (PHP's Guzzle
        clients die with the request; MCPToolsLoader's httpx.Client does
        not). Same close()-in-finally precedent as
        AgentController.listTools (agent_controller.py:381-386)."""
        try:
            mcpLoader.close()
        except Exception as closeErr:  # noqa: BLE001
            error_log(f"[IngestionController] mcpLoader.close() failed: {closeErr}")

    def _buildLoaderClosures(self, userId, storageMcpId: str | None = None):
        """PHP 1165-1230. Build the two injected MCP callables the loader
        needs (list_files / read_file against the registered UniversalFS/
        langfs storage), scoped to the chosen storage server so dispatch
        resolves to the right one. Returns (listFiles, readFile, mcpLoader)
        — the MCPToolsLoader instance is returned too (Python-only) so
        callers can `.close()` it in `finally` (see `_closeMcpLoader`)."""
        mcp = MCPToolsLoader(self.db)
        allowed = None
        if storageMcpId is not None and storageMcpId != '':
            row = self.db.fetch_one("SELECT name FROM mcp_servers WHERE id = ?", [storageMcpId])
            if row is not None:
                allowed = [php_strval(row.get('name'))]
        mcp.loadToolsForUser(php_strval(userId), allowed)

        def listFiles(provider: str, folder: str) -> dict:
            args = {'provider': provider}
            if folder != '':
                args['path'] = folder
            res = mcp.executeTool('list_files', args)
            if res.get('error'):
                raise RuntimeError(php_strval(res.get('message') if res.get('message') is not None else 'list_files failed'))
            decoded = phpjson.php_json_decode(php_strval(res.get('result') if res.get('result') is not None else ''))
            return decoded if isinstance(decoded, (dict, list)) else {'files': []}

        # Read one file via langfs, which extracts text server-side:
        #  - langfs: {"content":"<text>"} -> {'is_text': True}.
        #  - langfs error: {"error":true,"message":...} -> raise that message.
        # The legacy UniversalFS base64 raw-bytes path (is_text=false + local
        # decode) was removed -- langfs is the only storage backend now, so a
        # response without `content` is an error.
        def readFile(provider: str, fileId: str) -> dict:
            res = mcp.executeTool('read_file', {'provider': provider, 'file_id': fileId, 'format': 'text'})
            if res.get('error'):
                raise RuntimeError(php_strval(res.get('message') if res.get('message') is not None else 'read_file failed'))
            raw = php_strval(res.get('result') if res.get('result') is not None else '')
            decoded = phpjson.php_json_decode(raw)
            if isinstance(decoded, dict):
                if decoded.get('error'):
                    raise RuntimeError(php_strval(decoded.get('message') if decoded.get('message') is not None else 'read_file error'))
                if 'content' in decoded:
                    return {'is_text': True, 'data': php_strval(decoded['content'])}
            raise RuntimeError('read_file did not return {content} extracted text (langfs required).')

        return listFiles, readFile, mcp
