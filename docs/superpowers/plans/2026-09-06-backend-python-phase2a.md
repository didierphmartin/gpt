# Backend Python Port — Phase 2a (Streaming bridge, Claude chat path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/v1/chat` work on the Python backend for the Claude provider, streaming and non-streaming, with the tool loop, MCP tools, built-in search tools, session search, user memory and usage logging — byte-faithful to the PHP SSE contract — and ship the SSE differential comparator.

**Architecture:** Thread-to-queue streaming bridge (spec §3): controllers stay synchronous and PHP-shaped; `ctx['sse']` is an `SseStream` whose `send()` pushes frames onto an asyncio queue through `loop.call_soon_threadsafe`; `main.py` races "controller returned" against "stream started" and returns a `StreamingResponse` in the second case. Every service is a one-to-one port of its PHP class (same class name, same camelCase method names, same SQL, same response dict key order). Provider HTTP goes through `httpx`.

**Tech Stack:** Python 3.13, FastAPI/Starlette, httpx, PyMySQL, cryptography (AES-256-CBC for stored user keys), pytest.

**Spec:** `docs/superpowers/specs/2026-09-06-backend-python-phase2-chat-design.md` (sections 3–7) under the umbrella `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§3 conventions bind).

## Global Constraints

- Everything from the Phase 1 plan's Global Constraints still applies (Python 3.13, venv, port 3002, `.env` resolution, PHP timezone `Europe/Berlin` via `PHP_TIMEZONE`, clean JSON, no runtime DDL, commit trailer, controllers return dicts).
- **PHP-semantics helpers are mandatory:** `php_empty()` for `empty()`, `v if v is not None else d` for `??`, `php_intval()` for `(int)`, `is_numeric()` for `is_numeric()`, dict-or-list for `is_array()`. New helpers added here: `php_date(fmt)` (formats `Y-m-d`, `l`, `Y-m`, `Y-m-d H:i:s` in PHP's tz), `php_uniqid(prefix, more_entropy)`, `php_crc32(s)`, `mb_substr`.
- **SSE framing is byte-identical to PHP's `$sendEvent`/`SSEHubClient::sendDirect`:** `event: <name>\n`, then for string data one `data: <line>\n` per `\n`-split segment (raw, not JSON), for non-string data one `data: <json>\n`, then `\n`. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Client abort → the next `send` raises `RuntimeError('CLIENT_ABORTED')`.
- **Progress strings verbatim** from the PHP providers (e.g. `"Claude: Preparing Claude streaming request..."`, `"Claude: Executing function: {name}"`, `"Claude: Response ready."`).
- Provider `chat()`/`streamChat()` return dicts with exactly the PHP keys and order (`text, usage{input_tokens,output_tokens,total_tokens,function_calls}, model, provider, functions_called, mcp_tools_called, mcp_calls_count[, pending_client_tool_call, pending_tool_calls, stop_reason]`).
- Exceptions: `ProviderException.apiError/rateLimited/authenticationFailed` produce the exact PHP messages; `FunctionExecutionException.notFound/executionFailed/invalidParameters` likewise; `PricingUnavailableException` messages verbatim.
- Tables on this path exist in `backend/schema/chatbot.sql` (`llm_usage_transactions`, `llm_usage_balance`, `system_llm_settings`, `user_api_keys`, `user_model_selections`, `user_memories`, `user_memory_events`, `user_memory_settings`, `mcp_servers`, `mcp_server_tools`, `user_mcp_overrides`, `conversation_contexts`) except `user_mcp_settings` (migration `backend/migrations/add_user_mcp_settings.sql`; PHP tolerates its absence — mirror that) and `llm_function_usage_stats` (only used by `UsageTracker::trackFunctionCall`, which nothing calls — port the method, never create the table). The PHP memory repos' `CREATE TABLE IF NOT EXISTS` is NOT ported (tables exist).
- Differential tests: PHP at `http://localhost/gpt/backend`, Python in-process, user 3. Live-LLM cases use the prompt `Reply with exactly: hello world`, `provider: 'claude'`, `tools: []`, `memory: false`, and skip when no Claude key is configured in `system_llm_settings`.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```
- Work from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python` with `source .venv/bin/activate`; commit from the repo root with `git add backend_python`.

## Porting rules for the big classes (read before any "port verbatim" step)

Each "port" step names the PHP file and line range. Translate line by line:

| PHP | Python |
|---|---|
| `$x['k'] ?? d` | `x.get('k') if x.get('k') is not None else d` (or `_nn(x, 'k', d)` helper) |
| `isset($x['k'])` | `x.get('k') is not None` |
| `empty($v)` | `php_empty(v)` |
| `!empty($v)` | `not php_empty(v)` |
| `(int) $v` / `(float) $v` | `php_intval(v)` / `float(v)` guarded by `is_numeric` |
| `is_array($v)` | `isinstance(v, (dict, list))` |
| `is_string($v)` | `isinstance(v, str)` |
| `json_encode($v)` | `phpjson.dumps(v)` (`json_encode($v, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)` too — same output) |
| `json_decode($s, true)` | `json.loads(s)` in `try/except ValueError → None` |
| `new \stdClass()` / `(object)[]` | `{}` |
| `array_merge($a, $b)` (assoc) | `{**a, **b}`; (list) `a + b` |
| `array_values(array_filter(...))` | list comprehension |
| `array_column($rows, 'k')` | `[r['k'] for r in rows]` |
| `str_starts_with/contains/ends_with` | `startswith/in/endswith` |
| `mb_substr/mb_strlen` | slicing / `len` |
| `microtime(true)` | `time.time()` |
| `date('Y-m-d')`, `date('l')`, `date('Y-m')` | `php_date('Y-m-d')`, `php_date('l')`, `php_date('Y-m')` |
| `uniqid('chat_', true)` | `php_uniqid('chat_', True)` |
| `abs(crc32($s))` | `php_crc32(s)` |
| `error_log(...)` | `error_log(...)` from `app.support.logger` (keep the message text) |
| `$this->sseClient?->x()` | `if self.sseClient: self.sseClient.x()` |
| `throw ProviderException::apiError(...)` | `raise ProviderException.apiError(...)` |
| `catch (\Throwable $e)` | `except Exception as e` |
| Guzzle `$client->post(path, ['json'=>..])` | `httpx.Client.post(path, json=...)`; Guzzle raises on 4xx/5xx → call `r.raise_for_status()`; map `httpx.HTTPStatusError` → `e.response.status_code`, `httpx.RequestError` → code 0 |
| references `&$var` (accumulators) | pass a small mutable holder (dict) or return tuples — keep method names; document in a comment |

Keep PHP method names (camelCase) and private helpers as `_name` only when PHP marks them `private`; static methods become `@staticmethod`/`@classmethod`.

## File Structure

```
backend_python/
  main.py                                   MODIFY: executor, streaming race, multipart → ctx['files'], sse in ctx
  app/config.py                             MODIFY: add 'py_workers'
  app/db.py                                 MODIFY: reconnect-once on 2006/2013; begin/commit/rollback
  app/support/phpcompat.py                  MODIFY: php_date, php_uniqid, php_crc32
  app/support/crypto.py                     NEW: aes256cbc_decrypt (openssl_decrypt AES-256-CBC, PKCS7)
  app/support/sse.py                        NEW: SseStream, format_sse_frame
  app/contracts/__init__.py + {ai_provider,function_executor,streaming_client,usage_tracker,http_request_builder}.py
  app/exceptions/__init__.py + {ai_assistant,configuration,function_execution,pricing_unavailable,provider,streaming}_exception.py
  app/config_/configuration.py              NEW (package name avoids clashing with app/config.py): Configuration
  app/models/{conversation,message}.py      NEW
  app/services/debug_logger.py, sse_hub_client.py, llm_provider_resolver.py, pricing_resolver.py,
               usage_tracker.py, usage_logger.py, tools_manager.py, combined_tools_executor.py,
               filtered_tools_executor.py, mcp_tools_loader.py, llm_manager.py
  app/functions/search_functions.py          NEW
  app/agent_team/services/session_search_service.py, user_memory_repository.py,
               user_memory_events_repository.py, user_memory_settings_repository.py,
               memory_extractor.py, memory_auto_updater.py
  app/providers/traits/{provider_request_builder,client_side_tools}.py   NEW mixins
  app/providers/claude_provider.py           NEW
  app/ai_portfolio_assistant.py              NEW
  app/controllers/chat_controller.py         NEW
  app/routes.py                              MODIFY: ChatController + POST /api/v1/chat
  resources/prompts/*.txt                    COPY from ../backend/resources/prompts
  tests/unit/...                             one module per new module
  tests/differential/sse.py                  NEW comparator helpers
  tests/differential/test_chat.py            NEW
```

---

### Task 1: Streaming bridge, multipart, worker pool, Db reconnect/transactions, PHP helpers

**Files:**
- Create: `app/support/sse.py`, `app/support/crypto.py`
- Modify: `main.py`, `app/config.py`, `app/db.py`, `app/support/phpcompat.py`, `requirements.txt` (add `cryptography>=42` explicitly)
- Test: `tests/unit/test_sse.py`, `tests/unit/test_streaming_pipeline.py`, `tests/unit/test_db_reconnect.py`, `tests/unit/test_phpcompat.py` (extend), `tests/unit/test_crypto.py`

**Interfaces:**
- Produces `app.support.sse.SseStream(loop: asyncio.AbstractEventLoop)`: `start()`, `send(event: str, data)`, `end()`, `mark_aborted()`, properties `started`, `ended`, `aborted`, `started_future` (asyncio.Future), `queue` (asyncio.Queue of `bytes | None`); `format_sse_frame(event, data) -> bytes`. `send` raises `RuntimeError('CLIENT_ABORTED')` when aborted (checked before and after queuing, as PHP checks `connection_aborted()` after `flush()`).
- Produces `main.create_app(config=None, *, controllers=None, routes=None)`; `ctx['sse']` (SseStream), `ctx['files']` (dict like `$_FILES`: `{field: {'name','type','tmp_name','size','error'}}`), `ctx['body']` also holds non-file multipart fields.
- Produces `Db.begin()/commit()/rollback()` and transparent reconnect-once on MySQL 2006/2013; `Db.connect(cfg, timeout=10)` keeps kwargs for reconnect.
- Produces `phpcompat.php_date(fmt)`, `php_uniqid(prefix='', more_entropy=False)`, `php_crc32(s) -> int`; `crypto.aes256cbc_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> bytes | None`.
- Produces `config['py_workers']` (env `PY_WORKERS`, default 100).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_sse.py`:
```python
import asyncio
import pytest
from app.support.sse import SseStream, format_sse_frame


def test_frame_string_splits_lines_raw():
    assert format_sse_frame('chunk', 'a\nb') == b'event: chunk\ndata: a\ndata: b\n\n'
    assert format_sse_frame('progress', 'Claude: Thinking...') == b'event: progress\ndata: Claude: Thinking...\n\n'


def test_frame_object_is_single_json_line_clean():
    assert format_sse_frame('response', {'success': True, 'text': 'é/x'}) == \
        b'event: response\ndata: {"success":true,"text":"\xc3\xa9/x"}\n\n'
    assert format_sse_frame('complete', {'status': 'done'}) == b'event: complete\ndata: {"status":"done"}\n\n'


def test_send_starts_queues_and_end_sentinel():
    async def run():
        loop = asyncio.get_running_loop()
        s = SseStream(loop)
        assert not s.started
        await loop.run_in_executor(None, s.send, 'progress', 'hi')
        assert s.started and s.started_future.done()
        await loop.run_in_executor(None, s.end)
        assert await s.queue.get() == b'event: progress\ndata: hi\n\n'
        assert await s.queue.get() is None
        assert s.ended
    asyncio.run(run())


def test_send_after_abort_raises_client_aborted():
    async def run():
        loop = asyncio.get_running_loop()
        s = SseStream(loop)
        s.mark_aborted()
        with pytest.raises(RuntimeError, match='CLIENT_ABORTED'):
            await loop.run_in_executor(None, s.send, 'chunk', 'x')
    asyncio.run(run())
```

`tests/unit/test_streaming_pipeline.py` (uses `create_app` with injected test controllers):
```python
import json
import time
import jwt
import pytest
from fastapi.testclient import TestClient


class StreamCtl:
    def __init__(self, db, config): pass
    def go(self, request):
        sse = request['sse']
        sse.send('progress', 'Claude: Thinking...')
        sse.send('chunk', 'hel\nlo')
        sse.send('response', {'success': True, 'text': 'hello'})
        sse.send('complete', {'status': 'done'})
        sse.end()
        request['_after'] = 'ran'          # post-stream work still runs
        return {'streaming_handled': True, 'status_code': 200}
    def boom(self, request):
        request['sse'].send('progress', 'x')
        raise RuntimeError('provider exploded')
    def upload(self, request):
        f = request['files'].get('file')
        return {'success': True, 'name': f['name'], 'size': f['size'], 'type': f['type'],
                'has_tmp': __import__('os').path.isfile(f['tmp_name']), 'note': request['body'].get('note')}


ROUTES = [('POST', '/t/stream', ('StreamCtl', 'go')), ('POST', '/t/boom', ('StreamCtl', 'boom')),
          ('POST', '/t/upload', ('StreamCtl', 'upload'))]


@pytest.fixture(scope='module')
def app_client(config):
    from main import create_app
    return TestClient(create_app(config, controllers={'StreamCtl': StreamCtl}, routes=ROUTES))


def _auth(config):
    now = int(time.time())
    return {'Authorization': 'Bearer ' + jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 600, 'sub': 3, 'type': 'access'},
                                                    config['auth']['jwt_secret'], 'HS256')}


def test_streaming_response_frames_and_headers(app_client, config):
    with app_client.stream('POST', '/t/stream', json={}, headers=_auth(config)) as r:
        assert r.status_code == 200
        assert r.headers['content-type'].startswith('text/event-stream')
        assert r.headers['cache-control'] == 'no-cache' and r.headers['x-accel-buffering'] == 'no'
        assert r.headers['access-control-allow-origin'] == '*'
        body = b''.join(r.iter_bytes())
    assert body == (b'event: progress\ndata: Claude: Thinking...\n\n'
                    b'event: chunk\ndata: hel\ndata: lo\n\n'
                    b'event: response\ndata: {"success":true,"text":"hello"}\n\n'
                    b'event: complete\ndata: {"status":"done"}\n\n')


def test_exception_after_stream_start_ends_stream_cleanly(app_client, config):
    with app_client.stream('POST', '/t/boom', json={}, headers=_auth(config)) as r:
        assert r.status_code == 200
        body = b''.join(r.iter_bytes())
    assert body == b'event: progress\ndata: x\n\n'      # stream closed; error logged, not rendered as JSON


def test_multipart_files_shape_like_php(app_client, config):
    r = app_client.post('/t/upload', files={'file': ('a.txt', b'hello', 'text/plain')}, data={'note': 'n1'},
                        headers=_auth(config))
    assert r.status_code == 200
    j = r.json()
    assert j['name'] == 'a.txt' and j['size'] == 5 and j['type'] == 'text/plain' and j['has_tmp'] is True and j['note'] == 'n1'


def test_non_stream_route_unaffected(client):
    assert client.get('/').status_code == 200
```

`tests/unit/test_db_reconnect.py`:
```python
import pymysql
from app.db import Db


class FlakyConn:
    """First execute raises 'server has gone away'; a fresh connection succeeds."""
    instances = 0
    def __init__(self): FlakyConn.instances += 1; self.calls = 0; self.closed = False
    def cursor(self): return FlakyCursor(self)
    def close(self): self.closed = True
    def begin(self): self.began = True
    def commit(self): self.committed = True
    def rollback(self): self.rolled = True


class FlakyCursor:
    def __init__(self, conn): self.conn = conn; self.rowcount = 1; self.lastrowid = 7
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def execute(self, sql, params=None):
        self.conn.calls += 1
        if FlakyConn.instances == 1 and self.conn.calls == 1:
            raise pymysql.err.OperationalError(2006, 'MySQL server has gone away')
    def fetchone(self): return {'n': 1}
    def fetchall(self): return [{'n': 1}]
    def close(self): pass


def test_reconnects_once_on_gone_away(monkeypatch):
    FlakyConn.instances = 0
    monkeypatch.setattr('app.db.pymysql.connect', lambda **kw: FlakyConn())
    db = Db.connect({'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'})
    assert db.fetch_one('SELECT 1 AS n') == {'n': 1}
    assert FlakyConn.instances == 2


def test_transaction_methods_delegate(monkeypatch):
    FlakyConn.instances = 5
    monkeypatch.setattr('app.db.pymysql.connect', lambda **kw: FlakyConn())
    db = Db.connect({'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'})
    db.begin(); db.commit(); db.rollback()
    assert db._conn.began and db._conn.committed and db._conn.rolled
```

Append to `tests/unit/test_phpcompat.py`:
```python
def test_php_date_formats(monkeypatch):
    import re
    monkeypatch.setenv('PHP_TIMEZONE', 'Europe/Berlin')
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}', pc.php_date('Y-m-d'))
    assert pc.php_date('l') in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
    assert re.fullmatch(r'\d{4}-\d{2}', pc.php_date('Y-m'))


def test_php_uniqid_shapes():
    import re
    assert re.fullmatch(r'chat_[0-9a-f]{13}', pc.php_uniqid('chat_'))
    assert re.fullmatch(r'chat_[0-9a-f]{13}\.\d{8}', pc.php_uniqid('chat_', True))


def test_php_crc32_matches_php():
    assert pc.php_crc32('demo-user') == 2432255693   # php -r 'echo abs(crc32("demo-user"));'
```

`tests/unit/test_crypto.py`:
```python
import hashlib, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from app.support.crypto import aes256cbc_decrypt


def test_roundtrip_like_openssl_decrypt():
    key = hashlib.sha256(b'secret').digest(); iv = os.urandom(16)
    padder = padding.PKCS7(128).padder(); padded = padder.update(b'sk-abc') + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ct = enc.update(padded) + enc.finalize()
    assert aes256cbc_decrypt(ct, key, iv) == b'sk-abc'
    assert aes256cbc_decrypt(b'garbage-not-block-aligned', key, iv) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_sse.py tests/unit/test_streaming_pipeline.py tests/unit/test_db_reconnect.py tests/unit/test_crypto.py tests/unit/test_phpcompat.py -q`
Expected: ImportError / TypeError (`create_app` has no `controllers` kwarg)

- [ ] **Step 3: Implement `app/support/sse.py`**

```python
"""Thread-to-queue SSE bridge (spec §3). The controller thread calls send(); the async
StreamingResponse generator in main.py drains `queue`. Framing mirrors PHP's $sendEvent."""
from __future__ import annotations

import asyncio

from app.support.phpjson import dumps


def format_sse_frame(event: str, data) -> bytes:
    out = f'event: {event}\n'
    if isinstance(data, str):
        for line in data.split('\n'):
            out += f'data: {line}\n'
    else:
        out += 'data: ' + dumps(data) + '\n'
    out += '\n'
    return out.encode('utf-8')


class SseStream:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self.queue: asyncio.Queue = asyncio.Queue()
        self.started_future: asyncio.Future = loop.create_future()
        self.started = False
        self.ended = False
        self.aborted = False

    def start(self) -> None:
        if self.started:
            return
        self.started = True
        self._loop.call_soon_threadsafe(self._set_started)

    def _set_started(self) -> None:
        if not self.started_future.done():
            self.started_future.set_result(True)

    def send(self, event: str, data) -> None:
        if self.aborted:
            raise RuntimeError('CLIENT_ABORTED')
        if not self.started:
            self.start()
        frame = format_sse_frame(event, data)
        self._loop.call_soon_threadsafe(self.queue.put_nowait, frame)
        if self.aborted:                      # PHP: connection_aborted() checked after flush()
            raise RuntimeError('CLIENT_ABORTED')

    def end(self) -> None:
        if self.ended:
            return
        self.ended = True
        self._loop.call_soon_threadsafe(self.queue.put_nowait, None)

    def mark_aborted(self) -> None:
        self.aborted = True
```

- [ ] **Step 4: Implement `app/support/crypto.py` and the phpcompat additions**

`app/support/crypto.py`:
```python
"""openssl_decrypt($data, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv) equivalent."""
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def aes256cbc_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> bytes | None:
    try:
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        padded = dec.update(ciphertext) + dec.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return unpadder.update(padded) + unpadder.finalize()
    except Exception:  # noqa: BLE001 — openssl_decrypt returns false on any failure
        return None
```

Append to `app/support/phpcompat.py`:
```python
import random
import time
import zlib


def php_date(fmt: str) -> str:
    """Subset of PHP date(): Y-m-d, l, Y-m, Y-m-d H:i:s, in PHP's timezone."""
    now = datetime.now(php_tz())
    table = {'Y-m-d': '%Y-%m-%d', 'l': '%A', 'Y-m': '%Y-%m', 'Y-m-d H:i:s': '%Y-%m-%d %H:%M:%S'}
    return now.strftime(table[fmt])


def php_uniqid(prefix: str = '', more_entropy: bool = False) -> str:
    t = time.time()
    sec, usec = int(t), int((t - int(t)) * 1_000_000)
    out = f'{prefix}{sec:08x}{usec:05x}'
    if more_entropy:
        out += f'.{random.randint(0, 99999999):08d}'
    return out


def php_crc32(s: str) -> int:
    return zlib.crc32(s.encode('utf-8')) & 0xFFFFFFFF
```

- [ ] **Step 5: `app/db.py` reconnect + transactions**

In `Db.connect`, keep `kwargs` on the instance (`self._connect_kwargs`). Replace `_run`:
```python
    _GONE = (2006, 2013)

    def _run(self, sql, params):
        sql, params = translate(sql, params)
        for attempt in (1, 2):
            cur = self._conn.cursor()
            try:
                cur.execute(sql, params)
                return cur
            except pymysql.err.OperationalError as e:
                cur.close()
                if attempt == 1 and e.args and e.args[0] in self._GONE:
                    self.close()
                    self._conn = pymysql.connect(**self._connect_kwargs)
                    continue
                raise
            except Exception:
                cur.close()
                raise

    def begin(self): self._conn.begin()
    def commit(self): self._conn.commit()
    def rollback(self): self._conn.rollback()
```

- [ ] **Step 6: `app/config.py`** — add `'py_workers': int(_e('PY_WORKERS', '100'))` next to `port`.

- [ ] **Step 7: `main.py`**

Replace the request handling with the streaming-aware version. Full new `create_app`:
```python
"""Entry point — the Python twin of backend/index.php, plus the streaming bridge (spec §3)."""
from __future__ import annotations

import asyncio
import os
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, Request
from starlette.responses import Response, StreamingResponse

from app.config import load_config
from app.db import open_primary
from app.middleware.processor import MiddlewareProcessor
from app.routes import CONTROLLERS, ROUTES
from app.support.http import build_ctx, json_response, render
from app.support.logger import error_log, get_logger
from app.support.phpcompat import is_numeric, php_intval
from app.support.router import Dispatcher
from app.support.sse import SseStream

METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']
SSE_HEADERS = {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'}


def create_app(config: dict | None = None, *, controllers: dict | None = None, routes: list | None = None) -> FastAPI:
    config = config or load_config()
    get_logger()
    registry = controllers if controllers is not None else CONTROLLERS
    dispatcher = Dispatcher(routes if routes is not None else ROUTES)
    processor = MiddlewareProcessor(config, lambda: open_primary(config))
    executor = ThreadPoolExecutor(max_workers=int(config.get('py_workers', 100)), thread_name_prefix='req')
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.executor = executor

    def handle_sync(request: Request, raw_body: bytes, sse: SseStream, files: dict, form_fields: dict) -> Response | None:
        ctx = build_ctx(request, raw_body)
        ctx['sse'] = sse
        ctx['files'] = files
        if form_fields:
            ctx['body'] = dict(form_fields)
        cors_headers = processor.cors.headers(request.headers.get('origin', ''))

        def with_cors(resp):
            if resp is not None:
                for k, v in cors_headers.items():
                    resp.headers[k] = v
            return resp

        try:
            mw = processor.process(ctx)
        except Exception as e:  # noqa: BLE001
            error_log(f'[Backend] Middleware error: {e}\n{traceback.format_exc()}')
            return with_cors(json_response(500, {'success': False, 'error': str(e)}))
        if mw['handled']:
            r = mw['response']
            body = r.get('body')
            if body:
                return with_cors(json_response(r.get('status_code', 200), body, r.get('headers') or {}))
            return with_cors(Response(status_code=r.get('status_code', 200), headers=r.get('headers') or {}))
        ctx = mw['request']

        try:
            db = open_primary(config)
        except Exception as e:  # noqa: BLE001
            error_log(f'[Backend] Database connection failed: {e}')
            return with_cors(json_response(500, {'success': False, 'error': 'Database connection failed'}))

        try:
            route = dispatcher.dispatch(ctx['method'], ctx['uri'])
            if route.status == 'NOT_FOUND':
                return with_cors(json_response(404, {'success': False, 'error': 'Endpoint not found', 'uri': ctx['uri']}))
            if route.status == 'METHOD_NOT_ALLOWED':
                return with_cors(json_response(405, {'success': False, 'error': 'Method not allowed', 'allowed_methods': route.allowed}))
            controller_name, method_name = route.handler
            cls = registry.get(controller_name)
            if cls is None:
                return with_cors(json_response(500, {'success': False, 'error': f'Controller not found: {controller_name}'}))
            try:
                controller = cls(db, config)
                fn = getattr(controller, method_name, None)
                if fn is None:
                    return with_cors(json_response(500, {'success': False, 'error': f'Method not found: {method_name}'}))
                if route.params:
                    params = [php_intval(v) if is_numeric(v) else v for v in route.params.values()]
                    ctx['params'] = dict(route.params)
                    result = fn(ctx, *params)
                else:
                    result = fn(ctx)
                if sse.started:
                    return None                     # streaming path: response already produced
                return with_cors(render(result))
            except Exception as e:  # noqa: BLE001
                error_log(f'[Backend] Controller error: {e}\n{traceback.format_exc()}')
                if sse.started:
                    return None
                return with_cors(json_response(500, {'success': False, 'error': str(e)}))
        finally:
            if sse.started and not sse.ended:
                sse.end()
            db.close()

    @app.api_route('/{path:path}', methods=METHODS, include_in_schema=False)
    @app.api_route('/', methods=METHODS, include_in_schema=False)
    async def catch_all(request: Request):
        loop = asyncio.get_running_loop()
        sse = SseStream(loop)
        files: dict = {}
        form_fields: dict = {}
        raw = b''
        ctype = request.headers.get('content-type', '')
        if ctype.startswith('multipart/form-data'):
            form = await request.form()
            for key, value in form.multi_items():
                if hasattr(value, 'filename'):
                    data = await value.read()
                    tmp = tempfile.NamedTemporaryFile(delete=False, prefix='php_upload_')
                    tmp.write(data); tmp.close()
                    files[key] = {'name': value.filename or '', 'type': value.content_type or '',
                                  'tmp_name': tmp.name, 'size': len(data), 'error': 0}
                else:
                    form_fields[key] = value
        else:
            raw = await request.body()

        work = loop.run_in_executor(executor, handle_sync, request, raw, sse, files, form_fields)

        def _cleanup(_):
            for f in files.values():
                try:
                    os.unlink(f['tmp_name'])
                except OSError:
                    pass
            if work.exception():
                error_log(f'[Backend] request thread error: {work.exception()}')
        work.add_done_callback(_cleanup)

        done, _ = await asyncio.wait({work, sse.started_future}, return_when=asyncio.FIRST_COMPLETED)
        if work in done and not sse.started:
            return work.result()

        cors_headers = processor.cors.headers(request.headers.get('origin', ''))

        async def gen():
            try:
                while True:
                    frame = await sse.queue.get()
                    if frame is None:
                        return
                    yield frame
            except asyncio.CancelledError:
                sse.mark_aborted()
                raise

        return StreamingResponse(gen(), status_code=200, media_type='text/event-stream',
                                 headers={**SSE_HEADERS, **cors_headers})

    return app


app = create_app()
```

Note: `work.result()` when the thread returned `None` (stream started then finished before the race resolved) cannot happen because `sse.started` is checked; if a controller raises before any output the thread returns a 500 Response as before. The done-callback runs `work.exception()` only after completion; guard with `if not work.cancelled()`.

- [ ] **Step 8: `resources/prompts`** — `cp -r ../backend/resources/prompts resources/`.

- [ ] **Step 9: Run tests**

Run: `pytest tests/unit -q` → all passed, 0 warnings. Then `pytest tests/differential -q` (PHP up) → all passed (nothing changed for Phase 1 routes).

- [ ] **Step 10: Commit**

```bash
git add backend_python && git commit -m "feat(py): SSE thread-to-queue streaming bridge, multipart files, worker pool, Db reconnect + transactions"
```

### Task 2: Contracts, exceptions, `Configuration`, `DebugLogger`, models

**Files:**
- Create: `app/contracts/__init__.py`, `app/contracts/ai_provider.py`, `app/contracts/function_executor.py`, `app/contracts/streaming_client.py`, `app/contracts/usage_tracker.py`, `app/contracts/http_request_builder.py`
- Create: `app/exceptions/__init__.py` (re-exports all six), `app/exceptions/ai_assistant_exception.py`, `configuration_exception.py`, `function_execution_exception.py`, `pricing_unavailable_exception.py`, `provider_exception.py`, `streaming_exception.py`
- Create: `app/config_/__init__.py`, `app/config_/configuration.py`; `app/models/__init__.py`, `app/models/message.py`, `app/models/conversation.py`; `app/services/debug_logger.py`
- Test: `tests/unit/test_exceptions.py`, `tests/unit/test_configuration.py`, `tests/unit/test_models.py`

**Interfaces (all mirror the PHP signatures; camelCase kept):**
- `AIProviderInterface(ABC)`: `getName() -> str`, `isAvailable() -> bool`, `chat(message, conversationHistory=[], options={}) -> dict`, `streamChat(message, onChunk, conversationHistory=[], options={}) -> dict`, `getModel()`, `setModel(model) -> self`, `getSupportedModels() -> list`.
- `FunctionExecutorInterface(ABC)`: `execute(functionName, parameters, context=None) -> dict`, `hasFunction(name) -> bool`, `getRegisteredFunctions() -> list`, `getToolDefinitions() -> list`, `registerFunction(name, handler, schema) -> self`, `isMCPTool(name) -> bool`.
- `StreamingClientInterface(ABC)`: `sendProgress(message)`, `sendResponse(data: dict)`, `sendError(message, code=500)`, `sendChunk(text)`, `complete()`, `sendCustomEvent(eventName, data: dict)`, `getSessionId() -> str`, `isConnected() -> bool`, `markHeadersInitialized()`.
- `UsageTrackerInterface(ABC)`: `trackRequest(data: dict)`, `trackFunctionCall(functionName, provider, executionTimeMs, success, userId=None)`, `getUserStats(userId, period='day') -> dict`, `getStats(period='day') -> dict`, `calculateCost(provider, model, inputTokens, outputTokens) -> float`.
- `HttpRequestBuilderInterface(ABC)`: static `buildHttpRequest(model, messages, tools, config, maxTokens, temperature) -> dict`, static `parseHttpResponse(decoded) -> dict`, static `getApiFamily() -> str`.
- Exceptions: `AIAssistantException(Exception)` with `.code`, `.context`, `getContext()`, classmethod `withContext(message, context={}, code=0)`; `ConfigurationException`; `FunctionExecutionException` with `setFunctionName/getFunctionName` and static `notFound(name)`, `executionFailed(name, reason)`, `invalidParameters(name, details)`; `PricingUnavailableException(RuntimeError)`; `ProviderException` with `setProvider/getProvider/setHttpStatusCode/getHttpStatusCode` and static `rateLimited(provider, retryAfter=0)`, `authenticationFailed(provider)`, `apiError(provider, message, statusCode=500)`; `StreamingException` with `connectionFailed(reason)`, `writeFailed(reason)`. `str(exc)` is the PHP `getMessage()`.
- `Configuration(config: dict = {})` with `DEFAULTS` verbatim from `backend/src/Config/Configuration.php`, `get('a.b', default)`, `set('a.b', v)`, `has`, `getClaude`, `getOpenAI`, `getSearch`, `getFinancial`, `isProviderConfigured(p)` (`not php_empty(get(f'{p}.api_key'))`), `getDefaultProvider`, `isDebugEnabled`, `toArray`, `validateProvider`, classmethod `fromEnvironment()` (env names exactly as PHP: `CLAUDE_API_KEY, CLAUDE_MODEL, OPENAI_API_KEY, SERPAPI_API_KEY, SCRAPINGDOG_API_KEY, BRAVE_API_KEY, FMP_API_KEY, STORAGE_PROVIDER, AI_DEBUG`), recursive merge where dict-into-dict merges and anything else overrides (PHP `arrayMergeRecursive`: a list override REPLACES).
- `Message`, `Conversation` as in PHP (`uniqid('msg_')`/`uniqid('conv_')` via `php_uniqid`; `toArray` ISO-8601 `format('c')` → `isoformat(timespec='seconds')` with tz offset).
- `DebugLogger(enabled=False, log_file=None, include_timestamp=True)` with the PSR-3 level methods, `log(level, message, context)`, `logApiRequest`, `logApiResponse`; writes via `error_log` or appends to `log_file`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_exceptions.py`:
```python
import pytest
from app.exceptions import (AIAssistantException, ProviderException, FunctionExecutionException,
                            PricingUnavailableException, StreamingException, ConfigurationException)


def test_provider_exception_factories_match_php_messages():
    e = ProviderException.apiError('claude', 'boom | Response: {}', 502)
    assert str(e) == 'claude API error: boom | Response: {}' and e.getHttpStatusCode() == 502 and e.getProvider() == 'claude'
    assert str(ProviderException.rateLimited('kimi')) == 'Rate limited by kimi. '
    assert str(ProviderException.rateLimited('kimi', 30)) == 'Rate limited by kimi. Retry after 30 seconds.'
    a = ProviderException.authenticationFailed('openai')
    assert str(a) == 'Authentication failed for openai. Please check your API key.' and a.getHttpStatusCode() == 401
    assert isinstance(a, AIAssistantException) and isinstance(a, Exception)


def test_function_execution_factories():
    assert str(FunctionExecutionException.notFound('x')) == "Function 'x' is not registered."
    e = FunctionExecutionException.executionFailed('x', 'bad')
    assert str(e) == "Function 'x' execution failed: bad" and e.getFunctionName() == 'x' and e.code == 500
    assert str(FunctionExecutionException.invalidParameters('x', 'd')) == "Invalid parameters for function 'x': d"


def test_streaming_and_context():
    assert str(StreamingException.connectionFailed('r')) == 'SSE connection failed: r'
    e = AIAssistantException.withContext('m', {'k': 1}, 3)
    assert e.getContext() == {'k': 1} and e.code == 3
    assert issubclass(PricingUnavailableException, RuntimeError) and issubclass(ConfigurationException, AIAssistantException)
```

`tests/unit/test_configuration.py`:
```python
from app.config_.configuration import Configuration


def test_defaults_and_dot_get():
    c = Configuration({})
    assert c.get('claude.model') == 'claude-sonnet-4-5-20250929'
    assert c.get('claude.max_tokens') == 4000 and c.get('default_provider') == 'claude'
    assert c.get('missing.key', 'd') == 'd' and c.has('sse.enabled') and not c.has('nope')
    assert c.isProviderConfigured('claude') is False


def test_merge_is_recursive_for_dicts_and_overrides_scalars():
    c = Configuration({'claude': {'api_key': 'k'}, 'providers': {'kimi': {'base_url': 'u'}}, 'default_provider': 'kimi'})
    assert c.get('claude.api_key') == 'k' and c.get('claude.model') == 'claude-sonnet-4-5-20250929'
    assert c.get('providers.kimi.base_url') == 'u' and c.getDefaultProvider() == 'kimi'
    assert c.isProviderConfigured('claude') is True
    c.set('a.b.c', 1)
    assert c.get('a.b') == {'c': 1}
    assert c.toArray()['claude']['api_key'] == 'k'


def test_validate_provider_raises_php_message():
    import pytest
    from app.exceptions import ConfigurationException
    with pytest.raises(ConfigurationException, match="Provider 'openai' is not configured. Please set the API key."):
        Configuration({}).validateProvider('openai')
```

`tests/unit/test_models.py`:
```python
from app.models.conversation import Conversation
from app.models.message import Message


def test_conversation_history_and_array():
    c = Conversation(None, '3', {'m': 1})
    c.addUserMessage('hi').addAssistantMessage('yo', {'provider': 'claude'})
    assert c.getHistory() == [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'yo'}]
    assert c.getMessageCount() == 2 and c.getId().startswith('conv_') and c.getLastMessage().isAssistant()
    d = c.toArray()
    assert d['user_id'] == '3' and d['message_count'] == 2 and d['metadata'] == {'m': 1} and d['updated_at']
    assert Message.fromArray({'role': 'system', 'content': 's'}).toClaudeFormat() == {'role': 'system', 'content': [{'type': 'text', 'text': 's'}]}
    assert len(Conversation.fromHistory([{'role': 'user', 'content': 'a'}]).getMessages()) == 1
```

- [ ] **Step 2: Run tests to verify they fail** — `pytest tests/unit/test_exceptions.py tests/unit/test_configuration.py tests/unit/test_models.py -q` → ImportError.

- [ ] **Step 3: Implement** — port `backend/src/Contracts/*.php`, `backend/src/Exceptions/*.php`, `backend/src/Config/Configuration.php` (lines 1–268), `backend/src/Models/{Message,Conversation}.php`, `backend/src/Services/DebugLogger.php` with the porting rules. `Configuration.fromFile` raises `ConfigurationException('Configuration file must return an array')` (PHP-file configs do not exist here). Exceptions example:

```python
class AIAssistantException(Exception):
    def __init__(self, message: str = '', code: int = 0, previous: BaseException | None = None, context: dict | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.previous = previous
        self.context = dict(context or {})
    def getMessage(self) -> str: return self.message
    def getContext(self) -> dict: return self.context
    @classmethod
    def withContext(cls, message: str, context: dict | None = None, code: int = 0):
        return cls(message, code, None, context)
```
`ProviderException` keeps `_provider`/`_httpStatusCode` and the three factories building the exact strings shown in the tests (note the trailing space in `rateLimited` without retry).

- [ ] **Step 4: Run tests** — the three modules pass; `pytest tests/unit -q` all green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): contracts, exceptions, Configuration, DebugLogger, Conversation/Message models"`

### Task 3: `LLMProviderResolver`, `PricingResolver`, `UsageTracker`, `UsageLogger`, `SSEHubClient`

**Files:**
- Create: `app/services/llm_provider_resolver.py`, `app/services/pricing_resolver.py`, `app/services/usage_tracker.py`, `app/services/usage_logger.py`, `app/services/sse_hub_client.py`
- Test: `tests/unit/test_llm_provider_resolver.py`, `tests/unit/test_pricing_resolver.py`, `tests/unit/test_usage_tracker.py`, `tests/unit/test_usage_logger.py`, `tests/unit/test_sse_hub_client.py`

**Interfaces:**
- `LLMProviderResolver.applyDbSettings(db, config: dict) -> dict` (static; `SHOW TABLES LIKE 'system_llm_settings'` via `db.fetch_all`, rows `WHERE enabled = 1`; ROOT_PROVIDERS `claude, openai` merge into `config[key]`, others into `config['providers'][key]`; swallow exceptions with the PHP log line) and `buildProviderFromDb(row) -> dict` (static, exact key set and casts as PHP: `max_tokens` int when not None/''; `temperature` float; `streaming`/`supports_tools` bool when key present; `supported_models` decoded JSON list).
- `PricingResolver(db)`: `resolve(provider) -> tuple[float, float]` with ALIASES `anthropic→claude, google→gemini`, per-instance cache, wraps DB errors in `PricingUnavailableException("Pricing lookup failed for provider '{key}' in system_llm_settings: {e}")`; static `classifyRow(row, key)` with the two exact messages.
- `UsageTracker(db=None, enabled=True)`: `trackRequest(data)` (INSERT exactly as PHP incl. `request_metadata = dumps({'request_type': ...})`, `error_message` pricing suffix), `trackFunctionCall(...)` (UPDATE then INSERT on rowcount 0), `getUserStats`, `getStats`, `calculateCost` (`round(x, 6)`), `_getDateCondition`.
- `UsageLogger(db=None, enabled=True, connectionConfig=None)`: `logTransaction(data) -> int | None`, `updateBalance(userId, provider, data)`, `_checkMonthReset`, `calculateCost`, `calculateVoiceCost` (VOICE_PRICING table verbatim), `getBalance`, `getTransactions`, `getStats`, `_getDateCondition`; `_ensureConnection()` runs `SELECT 1` and on failure reconnects with `Db.connect(connectionConfig)` when given, else re-raises. `logTransaction` returns None when `user_id` is falsy (log line `⚠️ [UsageLogger] Missing user_id, skipping transaction log`). All PDOException catches → `except Exception` returning the PHP fallback.
- `SSEHubClient(sessionId, hubUrl=None, debug=False, stream: SseStream | None = None)` implements `StreamingClientInterface`: `sendProgress` → `_sendEvent('progress', message)`, `sendResponse(data)` → `_sendEvent('response', dumps(data))`, `sendError(message, code=500)` → `_sendEvent('error', dumps({'error': True, 'message': message, 'code': code}))`, `sendChunk(text)` → logs `📤 SENDING TO FRONTEND (len=N): <json>` then `_sendEvent('chunk', text)`, `complete()` → `_sendEvent('complete', dumps({'status': 'done'}))` and `connected=False`, `sendCustomEvent(name, data)` → `_sendEvent(name, dumps(data))`, `getSessionId`, `isConnected` (`connected and not stream.aborted`), `markHeadersInitialized`, classmethod `create(...)`. `_sendEvent(event, data: str)` → `stream.send(event, data)` (string path, so framing is identical to PHP's `sendDirect`); when `hubUrl` is set POST `{'session_id','event','data'}` with httpx (timeout 5) instead. The stream is obtained from `stream` or `SSEHubClient.current_stream` (a `contextvars.ContextVar` set by `ChatController` before calling the assistant — thread-local because the whole request runs in one thread).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_pricing_resolver.py` (port of `PricingResolverTest.php`):
```python
import pytest
from app.services.pricing_resolver import PricingResolver
from app.exceptions import PricingUnavailableException


def test_classify_returns_rates_for_valid_row():
    assert PricingResolver.classifyRow({'price_input_per_1m': '2.5000', 'price_output_per_1m': '10.0000'}, 'openai') == (2.5, 10.0)


def test_classify_treats_zero_as_valid():
    assert PricingResolver.classifyRow({'price_input_per_1m': '0.0000', 'price_output_per_1m': '0.0000'}, 'gamma4') == (0.0, 0.0)


def test_classify_throws_on_missing_row():
    with pytest.raises(PricingUnavailableException, match="provider 'gemini'"):
        PricingResolver.classifyRow(None, 'gemini')


def test_classify_throws_on_null_price():
    with pytest.raises(PricingUnavailableException):
        PricingResolver.classifyRow({'price_input_per_1m': None, 'price_output_per_1m': '4.0000'}, 'kimi')


def test_resolve_uses_alias_cache_and_wraps_db_errors():
    class Db:
        def __init__(self): self.calls = 0
        def fetch_one(self, sql, p=None):
            self.calls += 1; assert p == {':k': 'claude'}
            return {'price_input_per_1m': '3', 'price_output_per_1m': '15'}
    db = Db(); r = PricingResolver(db)
    assert r.resolve('anthropic') == (3.0, 15.0) and r.resolve('claude') == (3.0, 15.0) and db.calls == 1
    class Bad:
        def fetch_one(self, sql, p=None): raise RuntimeError('down')
    with pytest.raises(PricingUnavailableException, match="Pricing lookup failed for provider 'kimi' in system_llm_settings: down"):
        PricingResolver(Bad()).resolve('kimi')
```

`tests/unit/test_usage_logger.py` (port of `UsageLoggerCostTest.php` + INSERT/balance behavior):
```python
import json
import pytest
from app.services.usage_logger import UsageLogger
from app.exceptions import PricingUnavailableException


class Db:
    def __init__(self, price=None):
        self.price = price; self.calls = []; self.next_id = 41
    def fetch_one(self, sql, p=None):
        self.calls.append((sql, p))
        if 'price_input_per_1m' in sql: return self.price
        if 'current_month' in sql: return None
        return {'1': 1}
    def fetch_all(self, sql, p=None): self.calls.append((sql, p)); return []
    def execute(self, sql, p=None): self.calls.append((sql, p)); return 1
    def insert(self, sql, p=None): self.calls.append((sql, p)); return self.next_id


def test_calculate_cost_uses_db_price():
    assert UsageLogger(Db({'price_input_per_1m': '2.5000', 'price_output_per_1m': '10.0000'}), True).calculateCost('openai', 'gpt-4o', 1_000_000, 1_000_000) == 12.5


def test_calculate_cost_throws_when_unconfigured():
    with pytest.raises(PricingUnavailableException):
        UsageLogger(Db(None), True).calculateCost('gemini', 'gemini-3-flash-preview', 1000, 1000)


def test_log_transaction_inserts_and_updates_balance():
    db = Db({'price_input_per_1m': '1', 'price_output_per_1m': '2'})
    tid = UsageLogger(db, True).logTransaction({'user_id': 3, 'session_id': 's', 'provider': 'claude', 'model': 'm',
                                               'prompt_tokens': 1000, 'completion_tokens': 500, 'response_time_ms': 12,
                                               'status': 'success', 'function_calls_count': 1, 'functions_called': ['a'],
                                               'mcp_calls_count': 0, 'mcp_tools_called': None})
    assert tid == 41
    ins = next(p for s, p in db.calls if s.strip().startswith('INSERT INTO llm_usage_transactions'))
    assert ins[':total_tokens'] == 1500 and ins[':cost_usd'] == 0.002 and ins[':functions_called'] == '["a"]' and ins[':mcp_tools_called'] is None
    assert ins[':is_voice_request'] == 0 and ins[':error_message'] is None
    bal = next(p for s, p in db.calls if 'INSERT INTO llm_usage_balance' in s)
    assert bal[':tokens'] == 1500 and bal[':success'] == 1 and bal[':failure'] == 0 and bal[':cost'] == 0.002


def test_log_transaction_pricing_error_records_null_cost_and_suffix():
    db = Db(None)
    UsageLogger(db, True).logTransaction({'user_id': 3, 'provider': 'gemini', 'model': 'x', 'prompt_tokens': 1, 'completion_tokens': 1, 'error_message': 'orig'})
    ins = next(p for s, p in db.calls if s.strip().startswith('INSERT INTO llm_usage_transactions'))
    assert ins[':cost_usd'] is None and ins[':error_message'].startswith('orig | PRICING_ERROR: No price configured')


def test_log_transaction_without_user_returns_none():
    db = Db()
    assert UsageLogger(db, True).logTransaction({'provider': 'claude'}) is None and not any('INSERT' in s for s, _ in db.calls)


def test_voice_cost_table():
    assert UsageLogger(Db(), True).calculateVoiceCost('grok', 10, 10) == 0.012
    assert UsageLogger(Db(), True).calculateVoiceCost('unknown', 10, 10) == 0.0075
```

`tests/unit/test_usage_tracker.py` (port of `UsageTrackerCostTest.php`):
```python
import pytest
from app.services.usage_tracker import UsageTracker
from app.exceptions import PricingUnavailableException


class Db:
    def __init__(self, price): self.price = price; self.calls = []
    def fetch_one(self, sql, p=None): self.calls.append((sql, p)); return self.price if 'price_' in sql else {'1': 1}
    def execute(self, sql, p=None): self.calls.append((sql, p)); return 1


def test_calculate_cost_uses_db_price():
    assert UsageTracker(Db({'price_input_per_1m': '0.2000', 'price_output_per_1m': '0.5000'}), True).calculateCost('grok', 'grok-4-fast', 1_000_000, 1_000_000) == 0.7


def test_calculate_cost_throws_when_unconfigured():
    with pytest.raises(PricingUnavailableException):
        UsageTracker(Db(None), True).calculateCost('gemini', 'x', 1000, 1000)


def test_track_request_inserts_with_request_metadata():
    db = Db({'price_input_per_1m': '1', 'price_output_per_1m': '1'})
    UsageTracker(db, True).trackRequest({'user_id': 3, 'provider': 'claude', 'model': 'm', 'input_tokens': 10, 'output_tokens': 5, 'request_type': 'chat'})
    ins = next(p for s, p in db.calls if s.strip().startswith('INSERT INTO llm_usage_transactions'))
    assert ins[':total_tokens'] == 15 and ins[':request_metadata'] == '{"request_type":"chat"}'


def test_disabled_without_db():
    UsageTracker(None, True).trackRequest({'user_id': 3})   # no error, no-op
```

`tests/unit/test_llm_provider_resolver.py`:
```python
from app.services.llm_provider_resolver import LLMProviderResolver


def test_build_provider_from_db_casts_and_skips_empties():
    row = {'display_name': 'Kimi', 'model': 'kimi-k2.6', 'api_key': '', 'base_url': 'https://api.moonshot.ai', 'chat_endpoint': None,
           'api_format': 'openai', 'max_tokens': '32768', 'temperature': '0.60', 'system_prompt': '', 'streaming': 1,
           'supports_tools': '0', 'supported_models': '["a","b"]'}
    assert LLMProviderResolver.buildProviderFromDb(row) == {
        'display_name': 'Kimi', 'model': 'kimi-k2.6', 'base_url': 'https://api.moonshot.ai', 'api_format': 'openai',
        'max_tokens': 32768, 'temperature': 0.6, 'streaming': True, 'supports_tools': False, 'supported_models': ['a', 'b']}


def test_apply_db_settings_merges_root_and_custom_providers():
    class Db:
        def fetch_all(self, sql, p=None):
            if 'SHOW TABLES' in sql: return [{'Tables_in_x': 'system_llm_settings'}]
            return [{'provider_key': 'claude', 'model': 'c-1', 'api_key': 'K'}, {'provider_key': 'kimi', 'base_url': 'u', 'model': 'k'}]
    cfg = LLMProviderResolver.applyDbSettings(Db(), {'claude': {'api_key': '', 'model': 'old'}})
    assert cfg['claude'] == {'api_key': 'K', 'model': 'c-1'} and cfg['providers']['kimi'] == {'model': 'k', 'base_url': 'u'}


def test_apply_db_settings_returns_config_when_table_missing_or_error():
    class NoTable:
        def fetch_all(self, sql, p=None): return []
    assert LLMProviderResolver.applyDbSettings(NoTable(), {'a': 1}) == {'a': 1}
    class Boom:
        def fetch_all(self, sql, p=None): raise RuntimeError('x')
    assert LLMProviderResolver.applyDbSettings(Boom(), {'a': 1}) == {'a': 1}
```

`tests/unit/test_sse_hub_client.py`:
```python
import asyncio
from app.services.sse_hub_client import SSEHubClient
from app.support.sse import SseStream


def test_events_use_php_string_framing():
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        c = SSEHubClient.create('sess', None, False, stream=s)
        await loop.run_in_executor(None, lambda: (c.sendProgress('Claude: Thinking...'), c.sendChunk('a\nb'),
                                                  c.sendResponse({'text': 'x'}), c.sendCustomEvent('mcp_ui', {'k': 1}),
                                                  c.sendError('bad', 500), c.complete()))
        frames = []
        while not s.queue.empty():
            frames.append(await s.queue.get())
        return frames, c.isConnected(), c.getSessionId()
    frames, connected, sid = asyncio.run(run())
    assert frames == [b'event: progress\ndata: Claude: Thinking...\n\n', b'event: chunk\ndata: a\ndata: b\n\n',
                      b'event: response\ndata: {"text":"x"}\n\n', b'event: mcp_ui\ndata: {"k":1}\n\n',
                      b'event: error\ndata: {"error":true,"message":"bad","code":500}\n\n',
                      b'event: complete\ndata: {"status":"done"}\n\n']
    assert connected is False and sid == 'sess'
```

- [ ] **Step 2: Run tests to verify they fail** → ImportError.

- [ ] **Step 3: Implement** — port `backend/src/Services/LLMProviderResolver.php` (1–100), `PricingResolver.php` (1–75), `UsageTracker.php` (1–236), `UsageLogger.php` (1–585), `SSEHubClient.php` (1–231). Notes:
  - `SHOW TABLES LIKE '...'` → `db.fetch_all("SHOW TABLES LIKE 'system_llm_settings'")` and test `len(rows) == 0`.
  - PHP `date('Y-m')` → `php_date('Y-m')`; `number_format($costUsd, 6)` in the log line → `f'{cost:.6f}'`.
  - `UsageLogger.getTransactions` binds `LIMIT :limit OFFSET :offset` as ints: build the SQL with `LIMIT %d OFFSET %d` after `int()` casting (PyMySQL cannot bind LIMIT safely).
  - Key order of the `logTransaction` params dict is irrelevant to MySQL but keep the PHP order for diffability.
  - `SSEHubClient.current_stream: ContextVar[SseStream | None]` — `ChatController` sets it in the request thread before `assistant.streamChat(...)`.

- [ ] **Step 4: Run tests** — the five modules pass; `pytest tests/unit -q` green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): LLMProviderResolver, PricingResolver, UsageTracker, UsageLogger, SSEHubClient"`

### Task 4: `ToolsManager`, provider mixins, `SearchFunctions`, `SessionSearchService`, executors, `MCPToolsLoader`

**Files:**
- Create: `app/services/tools_manager.py`, `app/services/combined_tools_executor.py`, `app/services/filtered_tools_executor.py`, `app/services/mcp_tools_loader.py`, `app/functions/__init__.py`, `app/functions/search_functions.py`, `app/agent_team/services/session_search_service.py`, `app/providers/__init__.py`, `app/providers/traits/__init__.py`, `app/providers/traits/provider_request_builder.py`, `app/providers/traits/client_side_tools.py`
- Test: `tests/unit/test_tools_manager.py`, `tests/unit/test_executors.py`, `tests/unit/test_mcp_tools_loader.py`, `tests/unit/test_search_functions.py`, `tests/unit/test_session_search_service.py`, `tests/unit/test_provider_mixins.py`

**Interfaces:**
- `ToolsManager(toolsJsonPath=None)` implements `FunctionExecutorInterface`: `registerFunction(name, handler, schema)`, `registerFunctions({name: {'handler','schema'}})`, `execute(name, params, context=None)` (non-dict result → `{'result': r}`; unknown → `FunctionExecutionException.notFound`; handler error → `executionFailed(name, str(e))`), `hasFunction`, `getRegisteredFunctions() -> list` (insertion order), `getToolDefinitions()` (cached; `{'name','description' (default f'Execute {name}'),'input_schema' (default {'type':'object','properties':{},'required':[]})}`), `loadFromJson(path)`, `getSchema`, `removeFunction`, `clear`, `isMCPTool → False`.
- `ProviderRequestBuilderMixin` (from `ProviderRequestBuilderTrait.php`): `getContextWindow() -> 0`, `emitUsageWarningIfTruncated(finishReason, outputTokens)`, `emitContextWarningIfHigh(inputTokens)` (both `sendCustomEvent('usage_warning', {...})` with the exact PHP keys), `buildSystemPrompt(options) -> str` (`"Current date: {php_date('Y-m-d')} ({php_date('l')})."` + `"\n\n"` + `lstrip(system)`, then memory_context / skill_content appended with `rstrip + "\n\n"`), static `convertEmptyArraysToObjects(data)` (empty list or dict → `{}`; recurse), static `convertEmptyArraysToObjectsForClaude(data, currentKey='')` (same but a value under key `'required'` is returned unchanged), static `normalizeUsage(usage, provider)`, static `convertToolsToOpenAIFormat(tools)`, static `convertToolsToGeminiFormat(tools)`, static `fixSchemaForGemini(schema)`. Instances must expose `sseClient`, `model`, `maxTokens`, `getName()`.
- `ClientSideToolsMixin`: static `getClientSideToolNames() -> ['run_skill_script', 'discover_skill', 'Task', 'route_to']`, `setPerRequestClientSideToolNames(names)`, `isClientSideTool(name)`, `emitClientToolCallEvent(toolCalls, assistantText='', extra={}) -> dict` (payload `{**extra, 'assistant_text', 'tool_calls'}` sent as `client_tool_call`; returns the four `_pending_*` keys).
- `SearchFunctions(config: Configuration)`: `getAllFunctions()` returning the eight entries with schemas verbatim; handlers `serpApiSearch, braveSearch, searchAssets, getTrendingAssets, getTopGainers, getTopLosers, getSecFilings, getSecFilingDocument` (httpx, timeout 30, `User-Agent: GPT Chatbot admin@company.com` for SEC); `_resolveToCik`.
- `SessionSearchService(contextsDb, config={})`: static `connectFromConfig(config) -> Db` (raises `RuntimeError('contexts_database config missing')`), static `registerAsTool(tools: ToolsManager, userId: int, config) -> bool` (registers `session_search` with the exact schema; the handler opens the connection lazily per call and closes it after — see ruling below), `search(userId, query, limit=5) -> list` (FULLTEXT `MATCH ... AGAINST (:q IN NATURAL LANGUAGE MODE)`, `LIMIT {limit}` interpolated after clamping), static `_extractPlainText`, `_queryTerms`, `_buildSnippet` (`…` ellipsis char).
- `CombinedToolsExecutor(baseExecutor, mcpLoader=None)`, `FilteredToolsExecutor(baseExecutor)` with `setAllowedTools/getAllowedTools/isFiltering` — exact PHP behavior.
- `MCPToolsLoader(db)`: `loadToolsForUser(userId=None, allowedServerNames=None) -> dict`, `getToolDefinitions()` (description `f"[MCP:{server_name}] " + (description or original_name)`, `input_schema` = `json.loads(input_schema_json)` or `{'type': 'object', 'properties': {}}`), `isMCPTool`, `executeTool(name, arguments)`, `_callMCPServer(serverUrl, toolName, arguments, extraHeaders=[], transport='http')` (httpx POST, `timeout=httpx.Timeout(180, connect=15)`, headers `Content-Type: application/json`, `Accept: application/json, text/event-stream, */*` plus `extraHeaders` given as `"Name: value"` strings → split on first `: `), `_parseResponse` (JSON, else first `data:` line that parses), `_formatToolResult`, `getTools`, `hasTools`, `_parseServerHeaders`. `user_mcp_settings` lookup and every DB error swallowed like PHP.

**Ruling (controller):** PHP's `SessionSearchService::registerAsTool` opens a dedicated PDO at registration time and never closes it (request-scoped process). In Python the handler closure opens `Db.connect(config['contexts_database'])` when the tool is actually called and closes it in `finally`; if the connect config is missing/invalid at registration time the function returns False exactly as PHP does. Record in the parity tracker.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_tools_manager.py`:
```python
import pytest
from app.services.tools_manager import ToolsManager
from app.exceptions import FunctionExecutionException


def test_register_execute_and_definitions():
    tm = ToolsManager()
    tm.registerFunction('echo', lambda p, ctx=None: {'got': p, 'ctx': ctx}, {'description': 'Echo', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}})
    tm.registerFunction('scalar', lambda p, ctx=None: 42, {})
    assert tm.execute('echo', {'x': 1}, 'u3') == {'got': {'x': 1}, 'ctx': 'u3'}
    assert tm.execute('scalar', {}) == {'result': 42}
    assert tm.getRegisteredFunctions() == ['echo', 'scalar'] and tm.hasFunction('echo') and not tm.isMCPTool('echo')
    defs = tm.getToolDefinitions()
    assert defs[0] == {'name': 'echo', 'description': 'Echo', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}}
    assert defs[1] == {'name': 'scalar', 'description': 'Execute scalar', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}}
    assert tm.getToolDefinitions() is defs                       # cached until registration changes
    tm.removeFunction('scalar')
    assert [d['name'] for d in tm.getToolDefinitions()] == ['echo']


def test_execute_errors_map_to_php_exceptions():
    tm = ToolsManager()
    with pytest.raises(FunctionExecutionException, match="Function 'nope' is not registered."):
        tm.execute('nope', {})
    tm.registerFunction('bad', lambda p, c=None: 1 / 0, {})
    with pytest.raises(FunctionExecutionException, match="Function 'bad' execution failed: division by zero"):
        tm.execute('bad', {})


def test_register_functions_bulk_and_load_json(tmp_path):
    tm = ToolsManager()
    tm.registerFunctions({'a': {'handler': lambda p, c=None: {}, 'schema': {'description': 'A'}}})
    assert tm.getSchema('a') == {'description': 'A'}
    p = tmp_path / 't.json'; p.write_text('[{"name":"j","description":"J"}]')
    tm.loadFromJson(str(p))
    assert tm.getSchema('j') == {'description': 'J', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}}
```

`tests/unit/test_executors.py`:
```python
from app.services.tools_manager import ToolsManager
from app.services.combined_tools_executor import CombinedToolsExecutor
from app.services.filtered_tools_executor import FilteredToolsExecutor


class FakeLoader:
    def __init__(self): self.tools = {'mcp_x': {}}; self.calls = []
    def isMCPTool(self, n): return n in self.tools or ('mcp_' + n) in self.tools
    def executeTool(self, n, a): self.calls.append((n, a)); return {'result': 'ok'}
    def getTools(self): return self.tools
    def getToolDefinitions(self): return [{'name': 'mcp_x', 'description': '[MCP:s] x', 'input_schema': {'type': 'object', 'properties': {}}}]


def test_combined_routes_mcp_and_base():
    tm = ToolsManager(); tm.registerFunction('base', lambda p, c=None: {'b': 1}, {})
    ld = FakeLoader(); c = CombinedToolsExecutor(tm, ld)
    assert c.execute('mcp_x', {'q': 1}) == {'result': 'ok'} and ld.calls == [('mcp_x', {'q': 1})]
    assert c.execute('base', {}) == {'b': 1}
    assert c.hasFunction('mcp_x') and c.hasFunction('base') and c.isMCPTool('x') and not c.isMCPTool('base')
    assert c.getRegisteredFunctions() == ['base', 'mcp_x'] and [d['name'] for d in c.getToolDefinitions()] == ['base', 'mcp_x']
    assert c.getBaseExecutor() is tm and c.getMCPLoader() is ld


def test_filtered_only_filters_definitions():
    tm = ToolsManager()
    for n in ('a', 'b'): tm.registerFunction(n, lambda p, c=None: {}, {})
    f = FilteredToolsExecutor(tm)
    assert not f.isFiltering() and [d['name'] for d in f.getToolDefinitions()] == ['a', 'b']
    f.setAllowedTools(['b', 'zz'])
    assert f.isFiltering() and [d['name'] for d in f.getToolDefinitions()] == ['b'] and f.hasFunction('a')
    f.setAllowedTools([]); assert f.getToolDefinitions() == []
```

`tests/unit/test_mcp_tools_loader.py` (DB fake + `httpx.MockTransport`):
```python
import json
import httpx
from app.services.mcp_tools_loader import MCPToolsLoader

ROW = {'id': 9, 'server_id': 2, 'tool_name': 'lookup', 'tool_description': 'Find', 'input_schema': '{"type":"object","properties":{"q":{"type":"string"}}}',
       'has_ui': 0, 'ui_resource_uri': None, 'cached_at': None, 'server_id_col': 2, 'server_url': 'http://mcp.local/mcp',
       'server_name': 'srv', 'server_user_id': None, 'server_headers': '{"X-Key":"v"}', 'server_transport': 'http'}


class Db:
    def __init__(self, rows, overrides=(), settings=None): self.rows = rows; self.overrides = list(overrides); self.settings = settings; self.calls = []
    def fetch_one(self, sql, p=None):
        self.calls.append(sql); return self.settings if 'user_mcp_settings' in sql else None
    def fetch_all(self, sql, p=None):
        self.calls.append(sql)
        if 'user_mcp_overrides' in sql: return self.overrides
        return self.rows


def test_load_prefixes_and_definitions():
    ld = MCPToolsLoader(Db([ROW]))
    tools = ld.loadToolsForUser('3')
    assert list(tools) == ['mcp_lookup'] and tools['mcp_lookup']['server_headers'] == ['X-Key: v'] and tools['mcp_lookup']['has_ui'] is False
    assert ld.getToolDefinitions() == [{'name': 'mcp_lookup', 'description': '[MCP:srv] Find', 'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}}}]
    assert ld.isMCPTool('lookup') and ld.isMCPTool('mcp_lookup') and ld.hasTools()


def test_master_switch_off_yields_no_tools():
    assert MCPToolsLoader(Db([ROW], settings={'mcp_enabled': 0})).loadToolsForUser('3') == {}


def test_allowlist_and_overrides():
    private = {**ROW, 'server_user_id': 3, 'server_name': 'mine'}
    assert list(MCPToolsLoader(Db([ROW])).loadToolsForUser('3', ['other'])) == []                        # global gated by allowlist
    assert list(MCPToolsLoader(Db([private])).loadToolsForUser('3', [])) == ['mcp_lookup']                  # private always allowed
    assert list(MCPToolsLoader(Db([ROW], overrides=[{'server_id': 2, 'allowed': 0}])).loadToolsForUser('3')) == []
    assert list(MCPToolsLoader(Db([ROW], overrides=[{'server_id': 2, 'allowed': 1}])).loadToolsForUser('3', [])) == ['mcp_lookup']


def _loader_with_transport(handler, row=ROW):
    ld = MCPToolsLoader(Db([row])); ld.loadToolsForUser('3')
    ld._http = httpx.Client(transport=httpx.MockTransport(handler))
    return ld


def test_execute_tool_jsonrpc_and_text_result():
    seen = {}
    def handler(req):
        seen['headers'] = dict(req.headers); seen['body'] = json.loads(req.content)
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {'content': [{'type': 'text', 'text': 'A'}, {'text': 'B'}], '_meta': None}})
    ld = _loader_with_transport(handler)
    out = ld.executeTool('lookup', {'q': 'x'})
    assert out == {'result': 'A\nB', '_meta': None}
    assert seen['body']['method'] == 'tools/call' and seen['body']['params'] == {'name': 'lookup', 'arguments': {'q': 'x'}}
    assert seen['headers']['x-key'] == 'v' and seen['headers']['accept'] == 'application/json, text/event-stream, */*'


def test_execute_tool_sse_body_http_error_and_rpc_error():
    ld = _loader_with_transport(lambda r: httpx.Response(200, text='event: message\ndata: {"result":{"content":[{"type":"text","text":"S"}]}}\n\n'))
    assert ld.executeTool('mcp_lookup', {}) == {'result': 'S', '_meta': None}
    ld2 = _loader_with_transport(lambda r: httpx.Response(500, text='x'))
    assert ld2.executeTool('lookup', {}) == {'error': True, 'message': 'MCP server returned HTTP 500'}
    ld3 = _loader_with_transport(lambda r: httpx.Response(200, json={'error': {'message': 'nope'}}))
    assert ld3.executeTool('lookup', {}) == {'error': True, 'message': 'nope'}
    assert MCPToolsLoader(Db([])).executeTool('zzz', {}) == {'error': True, 'message': "MCP tool 'zzz' not found"}


def test_execute_tool_ui_metadata():
    row = {**ROW, 'has_ui': 1, 'ui_resource_uri': 'ui://x'}
    ld = _loader_with_transport(lambda r: httpx.Response(200, json={'result': {'content': [{'type': 'text', 'text': 'T'}]}}), row)
    out = ld.executeTool('lookup', {'a': 1})
    ui = out['_mcp_ui']
    assert ui['has_ui'] is True and ui['tool_name'] == 'lookup' and ui['resource_uri'] == 'ui://x' and ui['arguments'] == {'a': 1}
    assert ui['tool_result'] == {'content': [{'type': 'text', 'text': 'T'}]} and ui['has_error'] is False
```

`tests/unit/test_search_functions.py`:
```python
import httpx
from app.config_.configuration import Configuration
from app.functions.search_functions import SearchFunctions


def test_schema_names_and_unconfigured_keys():
    sf = SearchFunctions(Configuration({}))
    fns = sf.getAllFunctions()
    assert list(fns) == ['serpapi_search', 'brave_search', 'search_assets', 'get_trending_assets', 'get_top_gainers', 'get_top_losers', 'get_sec_filings', 'get_sec_filing_document']
    assert fns['serpapi_search']['schema']['input_schema']['required'] == ['query']
    assert sf.serpApiSearch({'query': 'x'}, None) == {'error': 'SerpAPI key not configured'}
    assert sf.braveSearch({'query': 'x'}, None) == {'error': 'Brave Search API key not configured'}
    assert sf.searchAssets({'query': 'q'}, None) == {'success': True, 'message': 'Asset search requires database connection', 'query': 'q'}
    assert sf.getSecFilings({}, None) == {'error': 'symbol_or_cik is required'}


def test_serpapi_and_sec_via_mock_transport():
    sf = SearchFunctions(Configuration({'search': {'serpapi': {'api_key': 'K'}}}))
    def handler(req):
        if 'serpapi.com' in str(req.url):
            assert req.url.params['api_key'] == 'K' and req.url.params['num'] == '3'
            return httpx.Response(200, json={'organic_results': [{'title': 't', 'link': 'l', 'snippet': 's', 'position': 1}]})
        if 'company_tickers' in str(req.url):
            return httpx.Response(200, json={'0': {'ticker': 'AAPL', 'cik_str': 320193}})
        assert req.headers['user-agent'] == 'GPT Chatbot admin@company.com'
        return httpx.Response(200, json={'facts': 1})
    sf.httpClient = httpx.Client(transport=httpx.MockTransport(handler))
    assert sf.serpApiSearch({'query': 'q', 'count': 3}, None) == {'success': True, 'query': 'q', 'results': [{'title': 't', 'link': 'l', 'snippet': 's', 'position': 1}], 'count': 1}
    out = sf.getSecFilings({'symbol_or_cik': 'aapl'}, None)
    assert out == {'success': True, 'data_type': 'facts', 'cik': '0000320193', 'data': {'facts': 1}}
```

`tests/unit/test_session_search_service.py`:
```python
from app.agent_team.services.session_search_service import SessionSearchService
from app.services.tools_manager import ToolsManager


def test_snippet_terms_and_plain_text():
    text = 'role: ' + 'a' * 700 + ' redis ' + 'b' * 700
    snip = SessionSearchService._buildSnippet(text, ['redis'], 600)
    assert 'redis' in snip and snip.startswith('…') and snip.endswith('…') and len(snip) <= 602
    assert SessionSearchService._queryTerms('Auth Microservice, Redis!') == ['auth', 'microservice', 'redis']
    js = '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"text":"yo"}]}]}'
    assert SessionSearchService._extractPlainText(js) == 'user: hi\nassistant: yo'


def test_register_as_tool_schema_and_guard():
    tm = ToolsManager()
    assert SessionSearchService.registerAsTool(tm, 0, {}) is False
    assert SessionSearchService.registerAsTool(tm, 3, {}) is False               # no contexts_database config
    ok = SessionSearchService.registerAsTool(tm, 3, {'contexts_database': {'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'}})
    assert ok is True and tm.hasFunction('session_search')
    d = tm.getToolDefinitions()[0]
    assert d['name'] == 'session_search' and d['input_schema']['required'] == ['query'] and d['input_schema']['properties']['limit']['maximum'] == 15
    assert tm.execute('session_search', {'query': ''}) == {'error': 'query is required'}
```

`tests/unit/test_provider_mixins.py`:
```python
from app.providers.traits.provider_request_builder import ProviderRequestBuilderMixin
from app.providers.traits.client_side_tools import ClientSideToolsMixin


class Rec:
    def __init__(self): self.events = []
    def sendCustomEvent(self, n, d): self.events.append((n, d))


class P(ProviderRequestBuilderMixin, ClientSideToolsMixin):
    def __init__(self): self.sseClient = Rec(); self.model = 'm'; self.maxTokens = 10; self._init_client_side_tools()
    def getName(self): return 'claude'
    def getContextWindow(self): return 100
    def getDefaultSystemPrompt(self): return '  default'


def test_build_system_prompt_and_warnings():
    p = P()
    s = p.buildSystemPrompt({'memory_context': 'M', 'skill_content': 'S'})
    assert s.startswith('Current date: ') and s.endswith('default\n\nM\n\nS') and '(' in s.split('\n')[0]
    assert p.buildSystemPrompt({'system_prompt': ' X '}).endswith('\n\nX ')
    p.emitUsageWarningIfTruncated('max_tokens', 5); p.emitUsageWarningIfTruncated('stop', 5); p.emitUsageWarningIfTruncated('length', 0)
    p.emitContextWarningIfHigh(80); p.emitContextWarningIfHigh(10)
    assert p.sseClient.events == [('usage_warning', {'reason': 'output_truncated', 'provider': 'claude', 'model': 'm', 'max_tokens': 10, 'output_tokens': 5}),
                                  ('usage_warning', {'reason': 'context_high', 'provider': 'claude', 'model': 'm', 'input_tokens': 80, 'context_window': 100, 'percent': 80})]


def test_static_converters():
    M = ProviderRequestBuilderMixin
    assert M.convertEmptyArraysToObjects({'a': [], 'b': {'c': []}}) == {'a': {}, 'b': {'c': {}}}
    assert M.convertEmptyArraysToObjectsForClaude({'properties': [], 'required': []}) == {'properties': {}, 'required': []}
    assert M.normalizeUsage({'input_tokens': 1, 'output_tokens': 2}, 'claude') == {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
    assert M.normalizeUsage({'promptTokenCount': 1, 'candidatesTokenCount': 2, 'totalTokenCount': 3}, 'gemini') == {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
    assert M.normalizeUsage({'prompt_tokens': 1, 'completion_tokens': 2}, 'kimi') == {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
    assert M.normalizeUsage(None, 'x') is None
    assert M.convertToolsToOpenAIFormat([{'name': 'a', 'input_schema': {'type': 'object'}}]) == [{'type': 'function', 'function': {'name': 'a', 'description': '', 'parameters': {'type': 'object'}}}]
    g = M.fixSchemaForGemini({'type': 'object', 'properties': {'x': {'type': 'string', 'enum': ['a', 'b'], 'format': 'x'}}, 'required': [], 'additionalProperties': False})
    assert g == {'type': 'object', 'properties': {'x': {'type': 'string', 'description': 'Allowed values: a, b'}}}
    assert M.fixSchemaForGemini({}) == {'type': 'string'} and M.fixSchemaForGemini({'type': 'array'}) == {'type': 'array', 'items': {'type': 'string'}}
    assert M.convertToolsToGeminiFormat([{'name': 'a', 'input_schema': {}}]) == [{'functionDeclarations': [{'name': 'a', 'description': '', 'parameters': {'type': 'string'}}]}]


def test_client_side_tools():
    p = P()
    assert p.isClientSideTool('Task') and not p.isClientSideTool('webmcp_x')
    p.setPerRequestClientSideToolNames(['webmcp_x', '', 3])
    assert p.isClientSideTool('webmcp_x')
    marker = p.emitClientToolCallEvent([{'id': '1', 'name': 'Task', 'input': {}}], 'txt', {'assistant_reasoning': 'r'})
    assert p.sseClient.events[-1] == ('client_tool_call', {'assistant_reasoning': 'r', 'assistant_text': 'txt', 'tool_calls': [{'id': '1', 'name': 'Task', 'input': {}}]})
    assert marker == {'_pending_client_tool_call': True, '_pending_tool_calls': [{'id': '1', 'name': 'Task', 'input': {}}], '_pending_assistant_text': 'txt', '_pending_assistant_reasoning': 'r'}
```

- [ ] **Step 2: Run tests to verify they fail** → ImportError.

- [ ] **Step 3: Implement** — port `backend/src/Services/ToolsManager.php` (1–222), `Providers/Traits/ProviderRequestBuilderTrait.php` (1–331) and `ClientSideToolsTrait.php` (1–82) as mixins (`ClientSideToolsMixin` keeps `perRequestClientSideToolNames` in `_init_client_side_tools()` called from provider constructors), `Functions/SearchFunctions.php` (1–430; `self.httpClient = httpx.Client(timeout=30)` and per-call `timeout=` overrides where PHP passes them), `AgentTeam/Services/SessionSearchService.php` (1–251; ruling above), `Services/CombinedToolsExecutor.php`, `FilteredToolsExecutor.php`, `MCPToolsLoader.php` (1–444; `self._http = httpx.Client(timeout=httpx.Timeout(180.0, connect=15.0))`; `'id': int(time.time())`; an empty `arguments` dict serializes as `{}` already).
  - `fixSchemaForGemini`'s "properties present but empty → `{}`" and "`type == 'object'` without properties → `properties: {}`" must both hold (the test relies on the enum→description rewrite and field stripping).
  - `getToolDefinitions()` caching in `ToolsManager`: return the same list object until `registerFunction/removeFunction/clear/loadFromJson` invalidates it.

- [ ] **Step 4: Run tests** — the six modules pass; `pytest tests/unit -q` green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): ToolsManager, provider mixins, SearchFunctions, SessionSearchService, executors, MCPToolsLoader"`

### Task 5: User memory — repositories, `MemoryExtractor`, `MemoryAutoUpdater`

**Files:**
- Create: `app/agent_team/services/user_memory_repository.py`, `user_memory_events_repository.py`, `user_memory_settings_repository.py`, `memory_extractor.py`, `memory_auto_updater.py`
- Test: `tests/unit/test_user_memory.py`, `tests/unit/test_memory_extractor.py`, `tests/unit/test_memory_auto_updater.py`

**Interfaces:** exactly the PHP classes minus `ensureTablesExist` bodies (keep the methods as no-ops that set `tablesChecked`, since the tables exist — the Phase 1 tracker rule). `UserMemoryRepository`: constants `SCOPE_MEMORY='memory'`, `SCOPE_USER='user'`, `BUDGET_MEMORY=2200`, `BUDGET_USER=1375`; `get`, `getBoth`, `set` (raises `ValueError(f'Invalid scope: {scope}')`, truncates to budget), `budgetFor`, `buildMerged(current, additions)`, static `buildMemoryBlock(db, userId) -> str` (`"## Memory\n..."` / `"## User\n..."` joined by `"\n\n"`). `UserMemoryEventsRepository`: constants, `log(...) -> int` (0 when before == after), `list`, `get`, `delete`, `lastSource`. `UserMemorySettingsRepository`: `DEFAULT_MODEL='claude-haiku-4-5-20251001'`, `ALLOWED_MODELS`, `get(userId) -> {'enabled','model'}`, `set`. `MemoryExtractor(apiKey)`: `extract(model, currentMemory, currentUser, lastUserMsg, lastAssistantMsg) -> dict | None`, `filterDuplicates(model, currentContent, additions) -> list`, `compact(model, content, budget, mustKeep=[]) -> str | None`, `_buildSystemPrompt()` and `_buildUserContent()` with the prompt text verbatim, `_parseJson`; HTTP via `self.http = httpx.Client(timeout=30)` to `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`. `MemoryAutoUpdater(db, apiKey)`: `MIN_USER_MSG_CHARS=20`, `run(userId, sessionId, lastUserMsg, lastAssistantMsg) -> dict | None`, `_applyScope(...)`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_user_memory.py`:
```python
from app.agent_team.services.user_memory_repository import UserMemoryRepository
from app.agent_team.services.user_memory_events_repository import UserMemoryEventsRepository
from app.agent_team.services.user_memory_settings_repository import UserMemorySettingsRepository


class Db:
    def __init__(self, rows=None, one=None): self.rows = rows or []; self.one = one; self.calls = []
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return self.rows
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one
    def execute(self, s, p=None): self.calls.append((s, p)); return 1
    def insert(self, s, p=None): self.calls.append((s, p)); return 5


def test_memory_block_and_merge():
    db = Db(rows=[{'scope': 'memory', 'content': ' repo uses pytest '}, {'scope': 'user', 'content': 'likes tea'}])
    assert UserMemoryRepository.buildMemoryBlock(db, 3) == '## Memory\nrepo uses pytest\n\n## User\nlikes tea'
    assert UserMemoryRepository.buildMemoryBlock(Db(), 3) == '' and UserMemoryRepository.buildMemoryBlock(db, 0) == ''
    r = UserMemoryRepository(Db())
    assert r.buildMerged('A\nb', ['a', 'B', ' c ', '']) == 'A\nb\nc' and r.buildMerged('', ['x']) == 'x' and r.buildMerged('A', ['a']) == 'A'
    assert r.budgetFor('memory') == 2200 and r.budgetFor('user') == 1375


def test_set_truncates_and_validates():
    import pytest
    db = Db(); r = UserMemoryRepository(db)
    r.set(3, 'user', 'x' * 2000)
    assert len(db.calls[-1][1]['content']) == 1375
    with pytest.raises(ValueError, match='Invalid scope: bogus'):
        r.set(3, 'bogus', 'x')
    assert not any('CREATE TABLE' in s for s, _ in db.calls)


def test_events_and_settings():
    db = Db(); ev = UserMemoryEventsRepository(db)
    assert ev.log(3, 'memory', 'auto_extract', 'same', 'same') == 0 and not db.calls
    assert ev.log(3, 'memory', 'auto_extract', 'a', 'b', 'why', 's1') == 5
    assert db.calls[-1][1] == {'user_id': 3, 'scope': 'memory', 'source': 'auto_extract', 'before': 'a', 'after': 'b', 'rationale': 'why', 'session_id': 's1'}
    assert UserMemorySettingsRepository(Db(one=None)).get(3) == {'enabled': True, 'model': 'claude-haiku-4-5-20251001'}
    assert UserMemorySettingsRepository(Db(one={'auto_update_enabled': 0, 'auto_update_model': 'claude-3-haiku-20240307'})).get(3) == {'enabled': False, 'model': 'claude-3-haiku-20240307'}
```

`tests/unit/test_memory_extractor.py`:
```python
import json
import httpx
from app.agent_team.services.memory_extractor import MemoryExtractor


def _ex(reply_text, capture=None):
    def handler(req):
        if capture is not None: capture.append(json.loads(req.content))
        assert req.headers['x-api-key'] == 'K' and req.headers['anthropic-version'] == '2023-06-01'
        return httpx.Response(200, json={'content': [{'type': 'text', 'text': reply_text}]})
    e = MemoryExtractor('K'); e.http = httpx.Client(transport=httpx.MockTransport(handler)); return e


def test_extract_parses_json_and_fences():
    cap = []
    e = _ex('```json\n{"memory_additions":["uses pytest",""],"user_additions":["likes tea"],"reason":"r"}\n```', cap)
    out = e.extract('claude-haiku-4-5-20251001', 'M', '', 'a long enough user message', 'reply')
    assert out == {'memory_additions': ['uses pytest'], 'user_additions': ['likes tea'], 'reason': 'r'}
    assert cap[0]['model'] == 'claude-haiku-4-5-20251001' and cap[0]['max_tokens'] == 512 and '=== CURRENT USER ===\n(empty)' in cap[0]['messages'][0]['content']
    assert _ex('not json').extract('m', '', '', 'u', 'a') is None
    assert MemoryExtractor('').extract('m', '', '', 'u', 'a') is None


def test_filter_duplicates_and_compact():
    e = _ex('[1]')
    assert e.filterDuplicates('m', 'existing', ['dup', 'new']) == ['new']
    assert e.filterDuplicates('m', '', ['a']) == ['a']                       # empty current → all kept, no call
    assert _ex('garbage').filterDuplicates('m', 'x', ['a']) == ['a']
    c = _ex('x' * 50)
    assert c.compact('m', 'content', 20, ['keep']) == 'x' * 20 and c.compact('m', '', 20) is None
```

`tests/unit/test_memory_auto_updater.py`:
```python
from app.agent_team.services.memory_auto_updater import MemoryAutoUpdater


class Db:
    def __init__(self): self.calls = []; self.memory = {'memory': 'old fact', 'user': ''}
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return [{'scope': k, 'content': v} for k, v in self.memory.items()]
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return None
    def execute(self, s, p=None): self.calls.append((s, p)); return 1
    def insert(self, s, p=None): self.calls.append((s, p)); return 1


class FakeExtractor:
    def __init__(self, api_key): pass
    def extract(self, model, mem, user, u, a): return {'memory_additions': ['new fact'], 'user_additions': [], 'reason': 'r'}
    def filterDuplicates(self, model, current, adds): return adds
    def compact(self, *a): return None


def test_run_writes_memory_and_logs_event(monkeypatch):
    monkeypatch.setattr('app.agent_team.services.memory_auto_updater.MemoryExtractor', FakeExtractor)
    db = Db()
    out = MemoryAutoUpdater(db, 'K').run(3, 'sess', 'a sufficiently long user message', 'reply')
    assert out == {'reason': 'r', 'written': ['memory']}
    upsert = next(p for s, p in db.calls if 'INSERT INTO user_memories' in s)
    assert upsert['content'] == 'old fact\nnew fact'
    assert any('INSERT INTO user_memory_events' in s for s, _ in db.calls)


def test_run_guards():
    db = Db()
    assert MemoryAutoUpdater(db, '').run(3, 's', 'x' * 30, 'a') is None
    assert MemoryAutoUpdater(db, 'K').run(3, 's', 'short', 'a') is None and not db.calls
```

- [ ] **Step 2: Run tests to verify they fail** → ImportError.

- [ ] **Step 3: Implement** — port the five PHP files (`backend/src/AgentTeam/Services/{UserMemoryRepository,UserMemoryEventsRepository,UserMemorySettingsRepository,MemoryExtractor,MemoryAutoUpdater}.php`). The `preg_replace('/^```(?:json)?\s*|\s*```$/m', '', $text)` fence strip → `re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.M)`. `MemoryAutoUpdater` imports `MemoryExtractor` at module level (the test monkeypatches that name).

- [ ] **Step 4: Run tests** → the three modules pass; `pytest tests/unit -q` green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): user memory repositories, MemoryExtractor, MemoryAutoUpdater"`

### Task 6: `ClaudeProvider`

**Files:**
- Create: `app/providers/claude_provider.py`
- Test: `tests/unit/test_claude_provider.py`, fixtures `tests/fixtures/claude_stream_text.sse`, `tests/fixtures/claude_stream_tool.sse`

**Interfaces:**
- `ClaudeProvider(config: Configuration)` implements `AIProviderInterface`, `HttpRequestBuilderInterface`, mixes in `ProviderRequestBuilderMixin` and `ClientSideToolsMixin`. Public: `setFunctionExecutor`, `setUsageTracker`, `setSSEClient`, `setLogger`, `getName() -> 'claude'`, `isAvailable()`, `getModel`, `setModel`, `getSupportedModels`, `chat(message, conversationHistory=[], options={})`, `streamChat(message, onChunk, conversationHistory=[], options={})`, static `buildHttpRequest(...)`, static `parseHttpResponse(decoded)`, static `getApiFamily() -> 'claude'`. Private (underscore): `_applyOutputSchemaToTools`, `_makeRequest`, `_makeStreamingRequest`, `_handleToolUseRecursive`, `_executeFunction`, `_hasToolUse`, `_extractTextResponse`, `_buildMessages`, `_lastBlockIsToolResult`, `_extractTextFromContent`, `_getTools`, `getContextWindow() -> 200000`, `getDefaultSystemPrompt()`, `_sendProgress` (prefix `"Claude: "`), `_trackUsage`, `_convertEmptyArraysToObjects` (the ClaudeProvider-private variant: leaves EMPTY lists unchanged — PHP quirk explained in the porting rules), `_stripLargeDataFromResult`, `_parseClaudeStreamEvent`, static `_buildCachedSystemBlocks`.
- HTTP: `self.httpClient = httpx.Client(base_url=self.baseUrl, timeout=600)`; tests replace it with a `MockTransport` client. Streaming uses `self.httpClient.stream('POST', '/v1/messages', headers=..., content=json_payload)`, reads `iter_bytes(1024)` into a UTF-8 incremental decoder buffer and splits on `\n\n` exactly like PHP; the remainder is parsed after the loop.
- Reference accumulators (`&$inputTokens` etc.) are carried in a `_Totals` dataclass instance passed through `_handleToolUseRecursive` (documented in a comment); the method still returns the response dict.

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/fixtures/claude_stream_text.sse`:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}

```

`tests/fixtures/claude_stream_tool.sse`:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":20,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"echo","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"x\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"1\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}

event: message_stop
data: {"type":"message_stop"}

```

`tests/unit/test_claude_provider.py`:
```python
import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.claude_provider import ClaudeProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


def _provider(handler, streaming=True, key='K'):
    p = ClaudeProvider(Configuration({'claude': {'api_key': key, 'streaming': streaming, 'max_tokens': 100}}))
    p.httpClient = httpx.Client(base_url='https://api.anthropic.com', transport=httpx.MockTransport(handler))
    return p


def test_basics():
    p = _provider(lambda r: httpx.Response(200, json={}))
    assert p.getName() == 'claude' and p.isAvailable() and p.getModel() == 'claude-sonnet-4-5-20250929'
    assert p.getSupportedModels()[0] == 'claude-sonnet-4-5-20250929' and p.getContextWindow() == 200000
    assert not _provider(lambda r: None, key='').isAvailable()
    assert p.getDefaultSystemPrompt().startswith('You are')      # resources/prompts/portfolio_assistant.txt


def test_chat_non_streaming_text_and_usage():
    seen = {}
    def handler(req):
        seen['h'] = dict(req.headers); seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'content': [{'type': 'text', 'text': 'hi'}, {'type': 'text', 'text': 'there'}], 'usage': {'input_tokens': 3, 'output_tokens': 4}, 'stop_reason': 'end_turn'})
    p = _provider(handler, streaming=False); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}], {'user_id': 3, 'system_prompt': 'SYS'})
    assert out == {'text': 'hi\nthere', 'usage': {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}, 'model': 'claude-sonnet-4-5-20250929',
                   'provider': 'claude', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    assert seen['h']['x-api-key'] == 'K' and seen['h']['anthropic-version'] == '2023-06-01'
    b = seen['b']
    assert b['system'] == [{'type': 'text', 'text': b['system'][0]['text'], 'cache_control': {'type': 'ephemeral'}}] and b['system'][0]['text'].endswith('\n\nSYS')
    assert b['messages'] == [{'role': 'user', 'content': [{'type': 'text', 'text': 'earlier'}]}, {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]},
                             {'role': 'user', 'content': [{'type': 'text', 'text': 'hello'}]}]
    assert b['max_tokens'] == 100 and 'tools' not in b
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'Claude: Preparing Claude request...'), ('progress', 'Claude: Connecting to Claude API...'), ('progress', 'Claude: Response ready.')]


def test_stream_chat_emits_chunks_and_usage():
    body = (FIX / 'claude_stream_text.sse').read_bytes()
    p = _provider(lambda r: httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})); rec = Rec(); p.setSSEClient(rec)
    chunks = []
    out = p.streamChat('hello', [], {'user_id': 3}, ) if False else p.streamChat('hello', chunks.append, [], {'user_id': 3})
    assert out['text'] == 'hello world' and out['usage'] == {'input_tokens': 12, 'output_tokens': 5, 'total_tokens': 17, 'function_calls': 0}
    assert [e for e in rec.events if e[0] == 'chunk'] == [('chunk', 'hello '), ('chunk', 'world')]
    assert rec.events[0] == ('progress', 'Claude: Preparing Claude streaming request...')
    assert rec.events[1] == ('progress', 'Claude: Connecting to Claude API (streaming)...')
    assert rec.events[-1] == ('progress', 'Claude: Response ready.')


def test_stream_chat_falls_back_to_chat_when_streaming_disabled():
    p = _provider(lambda r: httpx.Response(200, json={'content': [{'type': 'text', 'text': 'x'}], 'usage': {'input_tokens': 1, 'output_tokens': 1}}), streaming=False)
    got = []
    out = p.streamChat('m', got.append, [], {})
    assert out['text'] == 'x' and got == ['x']


def test_tool_loop_executes_server_tool_then_continues():
    calls = []
    def handler(req):
        b = json.loads(req.content); calls.append(b)
        if len(calls) == 1:
            return httpx.Response(200, content=(FIX / 'claude_stream_tool.sse').read_bytes())
        return httpx.Response(200, content=(FIX / 'claude_stream_text.sse').read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, ctx=None: {'echo': params, 'ctx': ctx}, {'description': 'Echo', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('run it', lambda t: None, [], {'user_id': 3})
    assert out['text'] == 'hello world' and out['functions_called'] == ['echo'] and out['usage']['function_calls'] == 1
    assert out['usage'] == {'input_tokens': 32, 'output_tokens': 14, 'total_tokens': 46, 'function_calls': 1}
    prog = [m for e, m in rec.events if e == 'progress']
    assert 'Claude: Processing tool calls...' in prog and 'Claude: Executing function: echo' in prog and 'Claude: Processing Claude response...' in prog
    second = calls[1]['messages']
    assert second[-2] == {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_1', 'name': 'echo', 'input': {'x': '1'}}]}
    assert second[-1]['role'] == 'user' and second[-1]['content'][0]['type'] == 'tool_result' and second[-1]['content'][0]['tool_use_id'] == 'toolu_1'
    assert json.loads(second[-1]['content'][0]['content']) == {'echo': {'x': '1'}, 'ctx': 3}
    assert calls[0]['tools'][0]['name'] == 'echo'


def test_client_tool_short_circuit_emits_event_and_pending():
    tool_sse = (FIX / 'claude_stream_tool.sse').read_text().replace('"name":"echo"', '"name":"run_skill_script"').encode()
    p = _provider(lambda r: httpx.Response(200, content=tool_sse)); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('do', lambda t: None, [], {'user_id': 3, 'tools': [{'name': 'run_skill_script', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {}}}]})
    assert out['pending_client_tool_call'] is True and out['pending_tool_calls'] == [{'id': 'toolu_1', 'name': 'run_skill_script', 'input': {'x': '1'}}]
    assert out['functions_called'] == ['run_skill_script'] and out['text'] == '' and out['stop_reason'] == 'tool_use'
    assert ('client_tool_call', {'assistant_text': '', 'tool_calls': [{'id': 'toolu_1', 'name': 'run_skill_script', 'input': {'x': '1'}}]}) in rec.events


def test_error_mapping():
    with pytest.raises(ProviderException, match='Authentication failed for claude. Please check your API key.'):
        _provider(lambda r: httpx.Response(401, json={'error': 'x'}), streaming=False).chat('m')
    with pytest.raises(ProviderException, match='Rate limited by claude.'):
        _provider(lambda r: httpx.Response(429, json={}), streaming=False).chat('m')
    with pytest.raises(ProviderException) as ei:
        _provider(lambda r: httpx.Response(500, text='boom'), streaming=False).chat('m')
    assert str(ei.value).startswith('claude API error: ') and ei.value.getHttpStatusCode() == 500   # non-streaming path: no ' | Response:' suffix (only makeStreamingRequest appends it)
    with pytest.raises(ProviderException, match='Authentication failed for claude'):
        _provider(lambda r: None, key='').chat('m')


def test_build_messages_and_helpers():
    p = _provider(lambda r: None)
    hist = [{'role': 'tool', 'tool_call_id': 'c1', 'content': {'a': 1}},
            {'role': 'assistant', 'content': ' ', 'tool_calls': [{'id': 'c2', 'function': {'name': 'f', 'arguments': '{}'}}]},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'u'}]}]
    msgs = p._buildMessages(hist, 'new', [{'mime_type': 'image/png', 'data': 'AAA', 'name': 'i'}], [{'mime_type': 'application/pdf', 'data': 'BBB', 'name': 'd'}])
    assert msgs[0] == {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'c1', 'content': '{"a":1}'}]}
    assert msgs[1] == {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'c2', 'name': 'f', 'input': {}}]}
    assert msgs[-1]['content'][0]['type'] == 'document' and msgs[-1]['content'][1]['type'] == 'image' and msgs[-1]['content'][2] == {'type': 'text', 'text': 'new'}
    cont = p._buildMessages([{'role': 'tool', 'tool_call_id': 'c1', 'content': 'r'}], '', [], [])
    assert len(cont) == 1                                           # tool-result continuation: no new user turn
    assert p._stripLargeDataFromResult({'data': 'x' * 2000, 'k': [{'base64': 'y' * 2000}]}) == {'data': '[Base64 data stripped - 2000 bytes]', 'k': [{'base64': '[Base64 data stripped - 2000 bytes]'}]}
    assert p._stripLargeDataFromResult('z' * 60000) == '[Large data truncated - 60000 bytes]'
    assert p._parseClaudeStreamEvent('event: ping\ndata: {"type":"ping"}') == {'event': 'ping', 'data': {'type': 'ping'}}
    assert p._parseClaudeStreamEvent('event: x\ndata: not-json') is None
    assert ClaudeProvider.parseHttpResponse({'content': [{'type': 'text', 'text': 'a'}, {'type': 'tool_use', 'id': 'i', 'name': 'n', 'input': {'q': 1}}], 'usage': {'input_tokens': 1, 'output_tokens': 2}}) == \
        {'text': 'a', 'tool_calls': [{'id': 'i', 'type': 'function', 'function': {'name': 'n', 'arguments': '{"q":1}'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}}
    req = ClaudeProvider.buildHttpRequest('m', [{'role': 'system', 'content': 'S'}, {'role': 'user', 'content': 'u'}], [{'name': 't', 'input_schema': {'type': 'object', 'properties': {}}}], {'api_key': 'K'}, 10, 0.5)
    assert req['url'] == 'https://api.anthropic.com/v1/messages' and req['payload']['tools'][0]['input_schema'] == {'type': 'object', 'properties': {}, 'required': []} and req['provider'] == 'claude'


def test_output_schema_forces_tool_and_extracts_json():
    def handler(req):
        return httpx.Response(200, json={'content': [{'type': 'tool_use', 'id': 'i', 'name': 'answer', 'input': {'k': 'v/é'}}], 'usage': {'input_tokens': 1, 'output_tokens': 1}})
    p = _provider(handler, streaming=False)
    out = p.chat('m', [], {'output_schema': {'name': 'answer', 'schema': {'type': 'object', 'properties': {'k': {'type': 'string'}}}}})
    assert out['text'] == '{"k":"v/é"}' and out['usage']['function_calls'] == 0
```

Fix the accidental `if False` line in `test_stream_chat_emits_chunks_and_usage`: the call is simply `out = p.streamChat('hello', chunks.append, [], {'user_id': 3})` — write it that way.

- [ ] **Step 2: Run tests to verify they fail** → ImportError.

- [ ] **Step 3: Port `backend/src/Providers/ClaudeProvider.php` (all 1854 lines)** using the porting rules. Specific notes:
  - Constructor: `claudeConfig = config.getClaude()`; defaults exactly as PHP; `streamingEnabled = claudeConfig.get('streaming', True)`; `maxRecursionDepth = config.get('max_recursion_depth', 10)`; call `self._init_client_side_tools()`.
  - `chat()` (PHP 164–320): `sendProgress` calls verbatim; `_applyOutputSchemaToTools` (320–363) sets `pendingOutputSchema/pendingSchemaToolName`; when there are no other tools, `toolChoice = f'tool:{name}'` → `_makeRequest` maps a `tool:NAME` string to `{'type': 'tool', 'name': NAME}` (check PHP `makeRequest` lines 543–708 for the exact mapping and copy it).
  - `_makeRequest` (543–708) and `_makeStreamingRequest` (708–965): `Connecting to Claude API...` / `Connecting to Claude API (streaming)...`; payload built exactly (`system` via `_buildCachedSystemBlocks`, `temperature`, `tool_choice` mapping incl. `'required' → {'type': 'any'}`); on `httpx.HTTPStatusError`: 429 → `rateLimited('claude')`, 401 → `authenticationFailed('claude')`, else `apiError('claude', <details>, status)` where `_makeRequest` passes `str(e)` only (PHP 543–708) and `_makeStreamingRequest` passes `f'{e} | Response: {e.response.text}'` (PHP 708–965); on `httpx.RequestError` → `apiError('claude', str(e), 0)`.
  - Streaming parser: replicate the event switch exactly (text_delta → `fullText += ; sseClient.sendChunk`; input_json_delta buffer; content_block_start appends the block and flags tool use; content_block_stop decodes the buffered JSON into `contentBlocks[idx]['input']`; message_delta adds output tokens and calls `emitUsageWarningIfTruncated`; message_start sets input tokens and calls `emitContextWarningIfHigh`; `event == 'error'` raises `Exception(f'Claude API error: {message}')`). Return `{'content': contentBlocks if hasToolUse else [{'type': 'text', 'text': fullText}], 'usage': usage}`.
  - `_handleToolUseRecursive` (965–1209): port the client/server split, the mixed-tool `is_error` result with the exact message, the `stripLargeDataFromResult` + `dumps` + UTF-8 guard, the sanitized assistant content (`tool_use` blocks with empty `input` → `{}`; text blocks with blank text dropped), the continuation request (streaming if enabled), token accumulation, depth check (`>= maxRecursionDepth → return response`).
  - `_executeFunction` (1209–1241): `'error': 'No function executor configured'` when absent; `mcp_ui` custom event when `_mcp_ui` in result; exceptions → `{'error': str(e)}`.
  - `getDefaultSystemPrompt`: `config.get('claude.system_prompt')` if non-empty; else `resources/prompts/portfolio_assistant.txt` read from `backend_python/resources`; else the inline heredoc verbatim.
  - `_trackUsage` → `usageTracker.trackRequest({...})` with the PHP keys.

- [ ] **Step 4: Run tests** → `pytest tests/unit/test_claude_provider.py -q` 9 passed; `pytest tests/unit -q` green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): ClaudeProvider — streaming parser, recursive tool loop, client-tool short-circuit"`

### Task 7: `LLMManager` and `AIPortfolioAssistant`

**Files:**
- Create: `app/services/llm_manager.py`, `app/ai_portfolio_assistant.py`
- Test: `tests/unit/test_llm_manager.py`, `tests/unit/test_ai_portfolio_assistant.py`

**Interfaces:**
- `LLMManager(config: Configuration)`: `registerProvider(name, provider)`, `getProvider(name) -> provider | None`, `getDefaultProvider()`, `getAvailableProviders()`, `isProviderAvailable`, `normalizeConversationHistory(history) -> list` (PHP 107–295 verbatim incl. `_extractTextContent`, `_summarizeToolResults`, `role 'model' → 'assistant'`, tool turns, assistant tool_calls turns with optional `reasoning_content`, blank-content turns dropped, `[Tool Results: ...]` suffix), `chat(message, history=[], options={})`, `streamChat(message, onChunk, history=[], options={})` (both raise `ValueError` with the exact PHP `InvalidArgumentException` text when `options['provider']` is empty; `ProviderException("Provider '{name}' not found")` / `("Provider '{name}' is not available (check API key)")`; result gains `provider_used` and `fallback_used = False`), `_getProvidersToTry`, `setFallbackOrder`, `getProviderInfo(provider=None)`, `getConfig`.
- `AIPortfolioAssistant(config: dict | Configuration = {})`: constructor builds `ToolsManager`, `LLMManager`, calls `_initializeDefaultProvider()`; `setDatabase(db)` (registers DB functions — PortfolioFunctions/WatchlistFunctions/AnalysisFunctions arrive in 2c: in 2a `_registerDatabaseFunctions` registers nothing and logs `[AIPortfolioAssistant] database functions pending 2c`; the usage tracker wiring is ported now); static `resolveToolsForRequest(baseTools, callerTools, options)`; `chat(message, userId=None, history=[], options={})`; `streamChat(message, sessionId, userId=None, history=[], options={})` (creates `SSEHubClient.create(sessionId, config.get('sse.hub_url'), config.isDebugEnabled())`, `markHeadersInitialized()`, raises `ValueError` with the PHP text when provider missing, `setSSEClient` on the provider, `onChunk = sseClient.sendChunk`, then `sendResponse(response)` + `complete()`; on any exception `sendError(str(e))` and re-raise); `chatWithConversation`, `registerFunction(s)`, `loadToolsFromJson`, `getConfig`, `getLLMManager`, `getToolsManager`, `getAvailableProviders`, `getProviderInfo`, `setModel`, `setProvider`, `getCurrentProvider`, `getAllProviders`, `createConversation`; `DEDICATED_PROVIDERS` maps `claude → ClaudeProvider` and, until 2b lands, the other five names to `None`; `_makeProvider(name)` returns `ClaudeProvider` for claude, and for any other name logs `[AIPortfolioAssistant] provider '{name}' not available until Phase 2b` and returns None; `_initializeDefaultProvider` registers `claude` and `anthropic`, skips `openai`/custom providers whose `_makeProvider` returned None, sets the fallback order as PHP, and calls `_registerSearchFunctions()`.

**Ruling (controller):** Until 2b, chatting with a non-Claude provider yields `ProviderException("Provider 'kimi' not found")` → the standard error path (HTTP 500 / SSE `error`). Recorded in the tracker as "pending 2b"; the differential tests for 2a only use Claude.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_llm_manager.py` (port of `LLMManagerHistoryTest.php` + extras):
```python
import pytest
from app.config_.configuration import Configuration
from app.services.llm_manager import LLMManager
from app.exceptions import ProviderException


class Prov:
    def __init__(self, name, avail=True): self.n = name; self.a = avail; self.last = None
    def getName(self): return self.n
    def isAvailable(self): return self.a
    def getModel(self): return 'm'
    def getSupportedModels(self): return ['m']
    def chat(self, message, history=None, options=None): self.last = (message, history, options); return {'text': 'ok'}
    def streamChat(self, message, onChunk, history=None, options=None): onChunk('c'); self.last = (message, history, options); return {'text': 'ok'}


def test_assistant_tool_call_turn_keeps_reasoning_content():
    m = LLMManager(Configuration({}))
    out = m.normalizeConversationHistory([
        {'role': 'user', 'content': 'Create a playbook'},
        {'role': 'assistant', 'content': '', 'reasoning_content': 'I should discover the skill first.',
         'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'discover_skill', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': '{"ok":true}'}])
    assert out[1]['role'] == 'assistant' and out[1]['reasoning_content'] == 'I should discover the skill first.' and out[1]['tool_calls'][0]['id'] == 'c1'
    assert out[2] == {'role': 'tool', 'tool_call_id': 'c1', 'content': '{"ok":true}'}


def test_assistant_tool_call_turn_without_reasoning_has_no_key():
    out = LLMManager(Configuration({})).normalizeConversationHistory([
        {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'x', 'arguments': '{}'}}]}])
    assert 'reasoning_content' not in out[0]


def test_normalize_roles_blanks_blocks_and_tool_results():
    m = LLMManager(Configuration({}))
    out = m.normalizeConversationHistory([
        {'role': 'model', 'content': [{'type': 'text', 'text': 'a'}, {'type': 'tool_use', 'name': 'srch'}, {'type': 'tool_result'}]},
        {'role': 'user', 'content': '   '},
        {'role': 'user', 'text': 'from text', 'provider': 'kimi', 'tool_results': [{'name': 't1'}, {'tool_name': 't2'}]},
        'garbage'])
    assert out == [{'role': 'assistant', 'content': 'a\n[Called tool: srch]\n[Tool returned results]'},
                   {'role': 'user', 'content': 'from text\n\n[Tool Results: t1, t2]'}]


def test_chat_and_stream_require_provider_and_availability():
    m = LLMManager(Configuration({'default_provider': 'claude'}))
    m.registerProvider('claude', Prov('claude')); m.registerProvider('dead', Prov('dead', False))
    with pytest.raises(ValueError, match="LLMManager::chat requires \\$options\\['provider'\\] to be set explicitly"):
        m.chat('x', [], {})
    with pytest.raises(ProviderException, match="Provider 'nope' not found"):
        m.chat('x', [], {'provider': 'nope'})
    with pytest.raises(ProviderException, match="Provider 'dead' is not available \\(check API key\\)"):
        m.streamChat('x', lambda c: None, [], {'provider': 'dead'})
    out = m.chat('x', [{'role': 'user', 'content': 'h'}], {'provider': 'claude'})
    assert out == {'text': 'ok', 'provider_used': 'claude', 'fallback_used': False}
    got = []
    assert m.streamChat('x', got.append, [], {'provider': 'claude'})['provider_used'] == 'claude' and got == ['c']
    assert m.getAvailableProviders() == ['claude'] and m.getDefaultProvider().getName() == 'claude'
    assert m.getProviderInfo('dead') == {'name': 'dead', 'model': 'm', 'available': False, 'supported_models': ['m']}
    assert m.getProviderInfo('zz') == {'error': "Provider 'zz' not found"}
```

`tests/unit/test_ai_portfolio_assistant.py` (port of `ToolsForRequestTest.php` + wiring):
```python
import asyncio
import pytest
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.sse_hub_client import SSEHubClient
from app.support.sse import SseStream

BASE = [{'name': 'serpapi_search'}, {'name': 'search_assets'}]
EXTRA = [{'name': 'mcp_lookup_users'}, {'name': 'mcp_pin_message'}]


def names(x): return [t['name'] for t in x]


def test_default_merges_base_and_caller_tools():
    assert names(AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {})) == ['serpapi_search', 'search_assets', 'mcp_lookup_users', 'mcp_pin_message']


def test_skill_turn_keeps_caller_tools_only():
    assert names(AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {'skill_metadata': {'dir_name': 'x'}})) == ['mcp_lookup_users', 'mcp_pin_message']


def test_empty_filter_yields_no_tools():
    assert AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {'tools_filter': []}) == []


def test_filter_keeps_only_named_tools_from_both_sets():
    assert names(AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {'tools_filter': ['mcp_pin_message', 'search_assets']})) == ['search_assets', 'mcp_pin_message']


def test_constructor_registers_claude_and_search_tools():
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}, 'providers': {'kimi': {'base_url': 'u'}}})
    assert a.getLLMManager().getProvider('claude') is a.getLLMManager().getProvider('anthropic')
    assert a.getLLMManager().getProvider('kimi') is None                      # pending 2b
    assert 'serpapi_search' in a.getToolsManager().getRegisteredFunctions()
    assert a.getAllProviders()[0]['name'] == 'claude' and a.getCurrentProvider() == 'claude'
    with pytest.raises(ValueError, match="Provider 'kimi' is not available"):
        a.setProvider('kimi')


def test_stream_chat_wires_sse_client_and_requires_provider():
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}})
    class FakeProv:
        def __init__(self): self.sse = None
        def setSSEClient(self, c): self.sse = c
        def isAvailable(self): return True
        def getName(self): return 'claude'
        def getModel(self): return 'm'
        def getSupportedModels(self): return []
        def streamChat(self, message, onChunk, history=None, options=None):
            onChunk('piece'); return {'text': 'piece', 'usage': {}}
    fp = FakeProv(); a.getLLMManager().registerProvider('claude', fp)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        SSEHubClient.current_stream.set(s)
        out = await loop.run_in_executor(None, lambda: a.streamChat('hi', 'sess1', 3, [], {'provider': 'claude', 'tools': []}))
        frames = []
        while not s.queue.empty(): frames.append(await s.queue.get())
        return out, frames
    out, frames = asyncio.run(run())
    assert out['provider_used'] == 'claude' and fp.sse.getSessionId() == 'sess1'
    assert frames[0] == b'event: chunk\ndata: piece\n\n' and frames[1].startswith(b'event: response\ndata: {"text":"piece"') and frames[-1] == b'event: complete\ndata: {"status":"done"}\n\n'
    with pytest.raises(ValueError, match="AIPortfolioAssistant::streamChat requires \\$options\\['provider'\\]"):
        a.streamChat('hi', 's', 3, [], {})
```

- [ ] **Step 2: Run tests to verify they fail** → ImportError.

- [ ] **Step 3: Implement** — port `backend/src/Services/LLMManager.php` (1–466) and `backend/src/AIPortfolioAssistant.php` (1–544) per the interfaces and the 2b ruling. `AIPortfolioAssistant.streamChat` obtains the stream via `SSEHubClient.create(...)` which reads `SSEHubClient.current_stream`.

- [ ] **Step 4: Run tests** → both modules pass; `pytest tests/unit -q` green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): LLMManager and AIPortfolioAssistant (Claude only until 2b)"`

### Task 8: `ChatController` — helpers, config appliers, quota, tool builders, SSE client classes

**Files:**
- Create: `app/controllers/chat_controller.py` (helpers only in this task; the flows land in Task 9), `app/controllers/chat_sse_clients.py`
- Test: `tests/unit/test_chat_controller_helpers.py`

**Interfaces:**
- Module-level statics on `ChatController` (PHP `private static` → `@staticmethod` named without underscore where tests call them; keep the PHP names): `humanizeProviderError(raw) -> str`, `stripVisualNoiseFromHistory(history)`, `sanitizeSkillMetadata(raw) -> dict | None`, `sanitizeAvailableSkills(raw) -> list`, `sanitizeClientTools(raw) -> list`, `coerceJsonSchemaObjects(schema) -> dict`, `buildLlmContextSnapshot(provider, model, options, serverTools, history, message) -> dict`, `buildRunSkillScriptTool(metadata)`, `buildTaskTool()`, `buildMultiSkillTool(skills)`, `buildDiscoverSkillTool(skills)` — descriptions and schemas copied VERBATIM from `backend/src/Controllers/ChatController.php` lines 36–686 (byte-identical strings matter: they reach the LLM and the differential snapshot).
- Instance methods: `__init__(db, config)`, `_getEnabledProviderKeys()` (cached; DB `provider_key` list or the six-name fallback), `_applyDatabaseProviderSettings(config)`, `_applyPackageDefaults(config, userId)`, `_resolvePackageMcpAllowlist(userId)`, `_applyUserApiKeys(config, userId, provider=None)`, `_checkFreeTrialQuota(userId) -> dict | None`, `_decryptApiKey(encryptedKey, encryptionKey) -> str | None` (base64 → iv = first 16 bytes, `key = sha256(encryptionKey).digest()`, `aes256cbc_decrypt`, `.decode('utf-8')`).
- `app/controllers/chat_sse_clients.py`: `VerificationSseClient(sendEvent)` and `ComparisonSseClient(sendEvent)` implementing `StreamingClientInterface` exactly as the two anonymous PHP classes (session ids `verify_` / `compare_` + `php_uniqid()`; the comparison client maps `client_tool_call` → `compare_client_tool_call`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_chat_controller_helpers.py` (includes the port of `LlmContextSnapshotTest.php`):
```python
import base64, hashlib, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from app.controllers.chat_controller import ChatController
from app.controllers.chat_sse_clients import VerificationSseClient, ComparisonSseClient


def test_snapshot_lists_what_was_sent():
    options = {'system_prompt': 'You are a dispatcher.', 'client_tools': [{'name': 'route_to', 'description': 'Route it', 'input_schema': {'type': 'object'}}], 'max_tokens': 4096, 'temperature': 0.7}
    server_tools = [{'name': 'mcp_lookup_users', 'description': 'Look up', 'input_schema': []}]
    history = [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}]
    snap = ChatController.buildLlmContextSnapshot('claude', 'claude-sonnet-4-5', options, server_tools, history, 'refund please')
    assert snap['provider'] == 'claude' and snap['model'] == 'claude-sonnet-4-5' and snap['system_prompt'] == 'You are a dispatcher.'
    assert snap['max_tokens'] == 4096 and snap['temperature'] == 0.7
    assert [m['role'] for m in snap['messages']] == ['user', 'assistant', 'user'] and snap['messages'][-1]['content'] == 'refund please'
    assert snap['tools'] == [{'name': 'mcp_lookup_users', 'description': 'Look up', 'source': 'server'}, {'name': 'route_to', 'description': 'Route it', 'source': 'client'}]
    assert snap['estimated_tokens'] > 0 and snap['memory_included'] is False
    assert list(snap) == ['provider', 'model', 'max_tokens', 'temperature', 'system_prompt', 'memory_included', 'memory_context', 'skill_included', 'skill_content', 'messages', 'tools', 'estimated_tokens']


def test_memory_and_skill_flags_are_reported():
    snap = ChatController.buildLlmContextSnapshot('openai', None, {'memory_context': 'likes tea', 'skill_content': '# Skill'}, [], [], 'hi')
    assert snap['memory_included'] is True and snap['memory_context'] == 'likes tea' and snap['skill_included'] is True and snap['skill_content'] == '# Skill'
    assert snap['tools'] == [] and snap['model'] is None


def test_humanize_provider_error_classes():
    h = ChatController.humanizeProviderError
    assert h('GET https://x?api_key=SECRET failed 503 Service Unavailable').startswith('⏳ The model provider is temporarily overloaded')
    assert h('no available server for model').startswith("🚫 This model's server is currently offline")
    assert h('HTTP 429 rate limit').startswith('⏳ Rate limit reached')
    assert h('401 invalid api key').startswith('🔑 Authentication failed')
    assert h('prompt is too long: context window exceeded').startswith('📏 The input is too large')
    assert h('insufficient credit balance').startswith('💳 The provider rejected')
    assert h('cURL error 7: connection refused').startswith("🌐 Couldn't reach the provider")
    assert h('plain message') == 'plain message'
    long = 'x' * 500
    assert h(long) == 'x' * 380 + '… (full error in server log)'
    assert '[REDACTED]' in h('https://h/?key=abc&x=1 something unrelated')


def test_sanitizers():
    assert ChatController.sanitizeSkillMetadata({'dir_name': 'docx', 'scripts': ['scripts/create.py', '/abs.py', '../x', 'scripts/create.py']}) == {'dir_name': 'docx', 'scripts': ['scripts/create.py']}
    assert ChatController.sanitizeSkillMetadata({'dir_name': 'bad..name', 'scripts': ['a']}) is None
    assert ChatController.sanitizeSkillMetadata({'dir_name': 'docx', 'scripts': []}) is None
    skills = ChatController.sanitizeAvailableSkills([{'dir_name': 'a', 'description': ' d ', 'scripts': ['s.py']}, {'dir_name': 'a', 'scripts': ['t.py']}, {'dir_name': 'b', 'scripts': []}, 'x'])
    assert skills == [{'dir_name': 'a', 'description': 'd', 'scripts': ['s.py']}]
    ct = ChatController.sanitizeClientTools([{'name': 'webmcp_go', 'description': 'D', 'input_schema': {'type': 'object', 'properties': {}}},
                                             {'name': 'evil', 'input_schema': {}}, {'name': 'route_to', 'input_schema': 'nope'}, {'name': 'save_playbook_agent', 'input_schema': {'properties': {'p': {'properties': {}}}}}])
    assert ct == [{'name': 'webmcp_go', 'description': 'D', 'input_schema': {'type': 'object', 'properties': {}}},
                  {'name': 'save_playbook_agent', 'description': '', 'input_schema': {'properties': {'p': {'properties': {}}}}}]
    assert ChatController.stripVisualNoiseFromHistory([{'role': 'assistant', 'content': 'a <svg x="1"><g/></svg> b'}]) == [{'role': 'assistant', 'content': 'a [SVG illustration omitted] b'}]


def test_tool_builders_match_php_text():
    t = ChatController.buildRunSkillScriptTool({'dir_name': 'docx', 'scripts': ['scripts/create.py', 'scripts/edit.py']})
    assert t['name'] == 'run_skill_script' and t['description'].startswith('Execute one of the Python scripts bundled with the active skill "docx".')
    assert 'Available scripts: scripts/create.py, scripts/edit.py.\n\nRUNTIME CONTRACT:' in t['description']
    assert t['input_schema']['properties']['script']['enum'] == ['scripts/create.py', 'scripts/edit.py'] and t['input_schema']['required'] == ['script']
    task = ChatController.buildTaskTool()
    assert task['name'] == 'Task' and task['input_schema']['required'] == ['description', 'subagent_type', 'prompt'] and task['input_schema']['properties']['provider']['enum'] == ['claude', 'openai', 'grok', 'gemini', 'deepseek', 'kimi']
    ms = ChatController.buildMultiSkillTool([{'dir_name': 'docx', 'description': '', 'scripts': ['s.py']}])
    assert '  • docx — (no description) | scripts: s.py' in ms['description'] and ms['input_schema']['properties']['dir_name']['enum'] == ['docx'] and ms['input_schema']['required'] == ['dir_name', 'script']
    ds = ChatController.buildDiscoverSkillTool([{'dir_name': 'docx'}, {'dir_name': 'docx'}, {'dir_name': 'html'}])
    assert ds['name'] == 'discover_skill' and ds['input_schema']['properties']['dir_name']['enum'] == ['docx', 'html']


class Db:
    def __init__(self, scripted): self.scripted = list(scripted); self.calls = []
    def _next(self, sql, p):
        self.calls.append((sql, p)); return self.scripted.pop(0) if self.scripted else None
    def fetch_one(self, s, p=None): return self._next(s, p)
    def fetch_all(self, s, p=None): r = self._next(s, p); return r if r is not None else []
    def fetch_column(self, s, p=None): r = self._next(s, p); return r if r is not None else []
    def execute(self, s, p=None): self.calls.append((s, p)); return 1


def _enc(plain: str, secret: str) -> str:
    key = hashlib.sha256(secret.encode()).digest(); iv = os.urandom(16)
    padder = padding.PKCS7(128).padder(); padded = padder.update(plain.encode()) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return base64.b64encode(iv + enc.update(padded) + enc.finalize()).decode()


def test_apply_user_api_keys_decrypts_and_applies_models_only_for_owned_keys():
    cfg = {'auth': {'jwt_secret': 'S'}, 'claude': {'api_key': 'old', 'model': 'm0'}, 'providers': {'kimi': {'api_key': '', 'model': 'k0'}}}
    db = Db([[{'Tables_in_x': 'user_api_keys'}],                                    # SHOW TABLES user_api_keys
             [{'provider': 'claude', 'api_key': _enc('sk-new', 'S'), 'system_prompt': ' P '}],
             [{'Tables_in_x': 'user_model_selections'}],                            # SHOW TABLES user_model_selections
             [{'provider': 'claude', 'model': 'm1'}, {'provider': 'kimi', 'model': 'k1'}]])
    out = ChatController(db, cfg)._applyUserApiKeys(cfg, '3')
    assert out['claude'] == {'api_key': 'sk-new', 'model': 'm1', 'system_prompt': ' P '} and out['providers']['kimi'] == {'api_key': '', 'model': 'k0'}
    assert ChatController(Db([]), cfg)._applyUserApiKeys(cfg, 'demo-user') == cfg


def test_apply_package_defaults_and_quota():
    cfg = {'claude': {'api_key': '', 'model': 'm'}, 'providers': {'kimi': {'api_key': 'x'}}}
    db = Db([{'role': 'user'}, {'capabilities': '{"providers":{"claude":{"enabled":true,"default_api_key":" K ","default_model":"M"},"kimi":{"enabled":false,"default_api_key":"Z"},"ghost":{"enabled":true,"default_api_key":"G"}}}', 'updated_at': None}])
    out = ChatController(db, cfg)._applyPackageDefaults(cfg, '3')
    assert out['claude'] == {'api_key': 'K', 'model': 'M'} and out['providers']['kimi'] == {'api_key': 'x'}
    q = ChatController(Db([{'plan': 'free', 'role': 'user'}, {'role': 'user'}, {'capabilities': '{"quota_tokens":1000}', 'updated_at': None},
                           [{'Tables_in_x': 'llm_usage_balance'}], {'total': 1500}]), cfg)._checkFreeTrialQuota('3')
    assert q == {'success': False, 'error': 'Token quota reached. You have used 1,500 of 1,000 tokens. Please upgrade your plan to continue.', 'code': 'QUOTA_EXCEEDED',
                 'usage': {'total_tokens': 1500, 'quota': 1000}, 'status_code': 403}
    assert ChatController(Db([{'plan': 'premium', 'role': 'user'}]), cfg)._checkFreeTrialQuota('3') is None
    assert ChatController(Db([{'plan': 'free', 'role': 'admin'}]), cfg)._checkFreeTrialQuota('3') is None
    assert ChatController(Db([]), cfg)._checkFreeTrialQuota('demo-user') is None


def test_enabled_provider_keys_fallback():
    assert ChatController(Db([[]]), {})._getEnabledProviderKeys() == ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']
    c = ChatController(Db([['claude', 'kimi', 'claude']]), {})
    assert c._getEnabledProviderKeys() == ['claude', 'kimi'] and c._getEnabledProviderKeys() == ['claude', 'kimi']


def test_sse_client_classes_prefix_events():
    ev = []
    v = VerificationSseClient(lambda e, d: ev.append((e, d)))
    v.sendProgress('p'); v.sendChunk('c'); v.sendResponse({'r': 1}); v.sendError('e', 400); v.sendCustomEvent('client_tool_call', {'x': 1}); v.complete()
    assert ev == [('verification_progress', 'p'), ('verifier_chunk', 'c'), ('verification_response', {'r': 1}), ('verification_error', {'message': 'e', 'code': 400}), ('client_tool_call', {'x': 1})]
    assert v.getSessionId().startswith('verify_') and v.isConnected()
    ev.clear(); c = ComparisonSseClient(lambda e, d: ev.append((e, d)))
    c.sendChunk('c'); c.sendCustomEvent('client_tool_call', {'x': 1}); c.sendCustomEvent('mcp_ui', {'y': 2})
    assert ev == [('compare_chunk', 'c'), ('compare_client_tool_call', {'x': 1}), ('mcp_ui', {'y': 2})] and c.getSessionId().startswith('compare_')
```

- [ ] **Step 2: Run tests to verify they fail** → ImportError.

- [ ] **Step 3: Implement** — port `backend/src/Controllers/ChatController.php` lines 36–686 (helpers) and 2711–3102 (appliers, quota, decrypt, SSE client classes). Notes: `getEnabledProviderKeys` uses `db.fetch_column(...)` and `list(dict.fromkeys(keys))` for `array_values(array_unique)`; `SHOW TABLES LIKE` via `fetch_all` and `len(...) == 0`; `applyUserApiKeys` numeric user id via `php_intval` else `php_crc32`; `number_format` → `f'{n:,}'`; `humanizeProviderError` regexes translated 1:1 with `re.I` (PHP `\b` and `.?` semantics are the same in Python `re`); `mb_strlen/mb_substr` on the 400-char rule → `len`/slicing; the `[REDACTED]=…` replacement keeps the Unicode ellipsis.

- [ ] **Step 4: Run tests** → module passes; `pytest tests/unit -q` green.

- [ ] **Step 5: Commit** — `git add backend_python && git commit -m "feat(py): ChatController helpers — sanitizers, tool builders, snapshot, config appliers, quota"`

### Task 9: `ChatController` flows, route, SSE differential comparator, differential + browser smoke

**Files:**
- Modify: `app/controllers/chat_controller.py` (add `chat`, `_handleStreamingChat`, `_handleRegularChat`), `app/routes.py`
- Create: `tests/differential/sse.py`, `tests/differential/test_chat.py`
- Test: `tests/unit/test_chat_controller_flows.py`

**Interfaces:**
- `ChatController.chat(request) -> dict` (PHP 686–942): app-key scope gate (`'App key not authorized for chat (missing scope "chat")'`, 403), input parsing exactly as PHP (`user_id` from body then ctx then `'demo-user'`, `memory` default True, `tools` must be a list else `{'success': False, 'error': 'tools must be an array of tool names', 'status_code': 400}`), attachments block wrapped in `try/except Exception` (2a: `from app.services.attachment_dispatcher import AttachmentDispatcher` inside the try — the ImportError is swallowed like PHP's catch until 2d ships the class), `'Message is required'` 400 unless tool-result continuation, quota check, then streaming or regular.
- `_handleStreamingChat(...)` (PHP 1499–2091): `sse = request['sse']`; `SSEHubClient.current_stream.set(sse)`; `sendEvent = sse.send`; the assistant/usage-logger/session-search/MCP/tool-executor wiring exactly as PHP; the skill/available-skills/`tool_choice` option building verbatim (incl. the `deliverableSignal` regex and the `grok/deepseek → 'required'` form); memory block; response event with `context` when `return_context`; verification/comparison hooks call `self._handleVerification(...)` / `self._handleComparison(...)` — in 2a these two methods raise `NotImplementedError('pending 2d')` and are only reached when the request enables verification/compare, which the 2a tests never do (tracker note); `complete` event; usage logging; post-stream memory auto-update after `sse.end()`; `CLIENT_ABORTED` handling logs the aborted transaction; generic exceptions log the error transaction and emit the double error exactly as PHP (`sendError` inside `AIPortfolioAssistant.streamChat` already emitted the raw one; the controller emits `('error', {'message': humanized})`). Returns `{'streaming_handled': True, 'status_code': 200}`.
- `_handleRegularChat(...)` (PHP 2360–2711): same wiring without SSE; `max_tokens`/`temperature` overrides applied to the provider config; the shutdown-function memory update runs synchronously after the response dict is built (mirrors `register_shutdown_function` + `fastcgi_finish_request`: run it AFTER `sse`-less response... since the response must be returned first, schedule it with `request['_after_response'] = callable` and have `main.py` run `ctx.get('_after_response')` after `render()` — add that hook to `main.py` in this task with a unit test).
- `app/routes.py`: add `ChatController` to `CONTROLLERS` and `('POST', '/api/v1/chat', ('ChatController', 'chat'))` at the position matching `routes.php` (CHAT ROUTES section, before traces/fetch-url which arrive in 2d).
- `tests/differential/sse.py`: `parse_sse(text) -> list[tuple[str, str]]`, `skeleton(events) -> list[str]` (consecutive duplicate names collapsed), `payload(events, name) -> dict | None` (last occurrence, JSON-decoded), `normalize_usage(d)` (replace ints with `'int'`), `same_stream(a_text, b_text, ignore_payload_keys=())`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/test_chat_controller_flows.py` (fakes for DB and assistant; no network):
```python
import asyncio
import pytest
from starlette.datastructures import Headers
from app.controllers.chat_controller import ChatController
from app.support.http import Ctx
from app.support.sse import SseStream


class Db:
    def __init__(self): self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return None
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return []
    def fetch_column(self, s, p=None): self.calls.append((s, p)); return []
    def execute(self, s, p=None): self.calls.append((s, p)); return 1
    def insert(self, s, p=None): self.calls.append((s, p)); return 1


CFG = {'auth': {'jwt_secret': 'S'}, 'claude': {'api_key': 'K', 'model': 'm'}, 'contexts_database': {'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'}, 'database': {}}


def ctx(body, user_id=3, auth_type='jwt', sse=None):
    c = Ctx(method='POST', uri='/api/v1/chat', headers=Headers({}), query={}, body=body, raw_body='', params={}, user_id=user_id, authenticated=True, remote_addr='')
    c['auth_type'] = auth_type; c['sse'] = sse; c['files'] = {}
    return c


def test_validation_paths():
    c = ChatController(Db(), CFG)
    assert c.chat(ctx({'message': 'x', 'tools': 'bad'})) == {'success': False, 'error': 'tools must be an array of tool names', 'status_code': 400}
    assert c.chat(ctx({'message': ''})) == {'success': False, 'error': 'Message is required', 'status_code': 400}
    r = c.chat(ctx({'message': 'x'}, auth_type='app_key'))
    assert r == {'success': False, 'error': 'App key not authorized for chat (missing scope "chat")', 'status_code': 403}


class FakeAssistant:
    def __init__(self, config): self.config = config; self.tm = __import__('app.services.tools_manager', fromlist=['ToolsManager']).ToolsManager(); self.llm = type('L', (), {'getProvider': lambda s, n: None})()
    def getToolsManager(self): return self.tm
    def getLLMManager(self): return self.llm
    def chat(self, message, userId, history, options):
        FakeAssistant.last = (message, userId, history, options); return {'text': 'reply', 'usage': {'input_tokens': 1, 'output_tokens': 2, 'total_tokens': 3, 'function_calls': 0}, 'model': 'm', 'provider': 'claude', 'provider_used': 'claude', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    def streamChat(self, message, sessionId, userId, history, options):
        from app.services.sse_hub_client import SSEHubClient
        s = SSEHubClient.current_stream.get(); s.send('progress', 'Claude: Thinking...'); s.send('chunk', 'rep'); s.send('chunk', 'ly')
        return self.chat(message, userId, history, options)


def test_regular_chat_builds_options_and_logs_usage(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    db = Db(); c = ChatController(db, CFG)
    r = c.chat(ctx({'message': 'hi', 'provider': 'claude', 'tools': [], 'memory': False, 'return_context': True, 'system_prompt': ' SP ', 'max_tokens': '512', 'temperature': '0.2'}))
    assert r['success'] is True and r['text'] == 'reply' and r['provider'] == 'claude' and r['status_code'] == 200
    assert r['context']['provider'] == 'claude' and r['context']['system_prompt'] == 'SP' and r['context']['max_tokens'] == 512 and r['context']['temperature'] == 0.2
    m, uid, hist, opts = FakeAssistant.last
    assert uid == '3' and opts['provider'] == 'claude' and opts['tools_filter'] == [] and opts['system_prompt'] == 'SP' and 'memory_context' not in opts
    assert any('INSERT INTO llm_usage_transactions' in s for s, _ in db.calls)


def test_streaming_chat_event_sequence(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        c = ChatController(Db(), CFG)
        out = await loop.run_in_executor(None, c.chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        frames = []
        while not s.queue.empty(): frames.append(await s.queue.get())
        return out, frames
    out, frames = asyncio.run(run())
    assert out == {'streaming_handled': True, 'status_code': 200}
    names = [f.split(b'\n', 1)[0] for f in frames if f]
    assert names == [b'event: progress', b'event: chunk', b'event: chunk', b'event: response', b'event: complete']
    assert frames[-2].startswith(b'event: response\ndata: {"success":true,"text":"reply","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"function_calls":0},"provider":"claude"}')
    assert frames[-1] == None or frames[-1] == b'event: complete\ndata: {"status":"done"}\n\n'


def test_streaming_error_emits_humanized_error(monkeypatch):
    class Boom(FakeAssistant):
        def streamChat(self, *a):
            from app.services.sse_hub_client import SSEHubClient
            SSEHubClient.current_stream.get().send('error', '{"error":true,"message":"claude API error: 503 Service Unavailable","code":500}')
            raise RuntimeError('claude API error: 503 Service Unavailable')
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Boom)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        db = Db(); await loop.run_in_executor(None, ChatController(db, CFG).chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        frames = []
        while not s.queue.empty(): frames.append(await s.queue.get())
        return frames, db
    frames, db = asyncio.run(run())
    evs = [f for f in frames if f]
    assert evs[-1].startswith(b'event: error\ndata: {"message":"\xe2\x8f\xb3 The model provider is temporarily overloaded')
    assert any(p and p.get(':status') == 'error' for _, p in db.calls if isinstance(p, dict))


def test_client_abort_logs_aborted_transaction(monkeypatch):
    class Slow(FakeAssistant):
        def streamChat(self, *a):
            from app.services.sse_hub_client import SSEHubClient
            s = SSEHubClient.current_stream.get(); s.mark_aborted(); s.send('chunk', 'x')
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Slow)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop); db = Db()
        out = await loop.run_in_executor(None, ChatController(db, CFG).chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        return out, db
    out, db = asyncio.run(run())
    assert out == {'streaming_handled': True, 'status_code': 200}
    assert any(isinstance(p, dict) and p.get(':status') == 'aborted' and p.get(':error_message') == 'Cancelled by user' for _, p in db.calls)
```

Replace the odd `assert frames[-1] == None or ...` line with `assert frames[-1] == b'event: complete\ndata: {"status":"done"}\n\n'` after filtering out the `None` sentinel (the controller's `end()` pushes it; drop `None` entries when collecting).

- [ ] **Step 2: Run tests to verify they fail** → AttributeError (`chat` missing).

- [ ] **Step 3: Implement the flows** — port PHP 686–942, 1499–2091 and 2360–2711 per the interface notes. `main.py`: after `resp = render(result)` and before returning, run `hook = ctx.get('_after_response')` inside the `finally`-protected block AFTER the response is returned? A Response object cannot be "returned then continued" inside one function; instead keep the hook simple: in `handle_sync`, after computing `resp`, if `ctx.get('_after_response')` is set, call it **before** returning (the client sees a few hundred ms extra latency on non-streaming chats; PHP avoids it with `fastcgi_finish_request`). Record this as a deviation in the tracker ("regular-chat memory auto-update runs before the response is sent"). Unit test in `tests/unit/test_streaming_pipeline.py`: a controller that sets `request['_after_response'] = lambda: marker.append(1)` → after the request completes the marker is set.

- [ ] **Step 4: Register the route** — `app/routes.py`: import `ChatController`, add to `CONTROLLERS`, insert `('POST', '/api/v1/chat', ('ChatController', 'chat'))` under a `# CHAT ROUTES` comment right after the auth rows (matching `routes.php` order).

- [ ] **Step 5: Run unit tests** → `pytest tests/unit -q` green.

- [ ] **Step 6: Differential comparator and tests**

`tests/differential/sse.py`:
```python
import json


def parse_sse(text: str) -> list[tuple[str, str]]:
    events = []
    for block in text.split('\n\n'):
        if not block.strip():
            continue
        lines = block.split('\n')
        ev = next((l[6:].strip() for l in lines if l.startswith('event:')), '')
        data = '\n'.join(l[5:].lstrip(' ') if l.startswith('data:') else l for l in lines if l.startswith('data:'))
        if ev:
            events.append((ev, data))
    return events


def skeleton(events) -> list[str]:
    out = []
    for ev, _ in events:
        if not out or out[-1] != ev:
            out.append(ev)
    return out


def payload(events, name: str):
    for ev, data in reversed(events):
        if ev == name:
            try:
                return json.loads(data)
            except ValueError:
                return data
    return None


def normalize_usage(d):
    if isinstance(d, dict):
        return {k: ('int' if isinstance(v, int) and not isinstance(v, bool) else normalize_usage(v)) for k, v in d.items()}
    if isinstance(d, list):
        return [normalize_usage(x) for x in d]
    return d


def same_stream(a_text: str, b_text: str, *, ignore_response_keys=('text',)):
    a, b = parse_sse(a_text), parse_sse(b_text)
    assert skeleton(a) == skeleton(b), (skeleton(a), skeleton(b))
    ra, rb = payload(a, 'response'), payload(b, 'response')
    if ra is not None or rb is not None:
        for k in ignore_response_keys:
            ra.pop(k, None); rb.pop(k, None)
        assert normalize_usage(ra) == normalize_usage(rb), (ra, rb)
    assert payload(a, 'complete') == payload(b, 'complete')
    ea, eb = payload(a, 'error'), payload(b, 'error')
    assert (ea is None) == (eb is None) and (ea is None or list(ea) == list(eb)), (ea, eb)
```

`tests/differential/test_chat.py`:
```python
import pytest
from app.db import open_primary
from tests.differential.conftest import same
from tests.differential.sse import same_stream, parse_sse, payload

pytestmark = pytest.mark.differential
BODY = {'message': 'Reply with exactly: hello world', 'provider': 'claude', 'tools': [], 'memory': False, 'conversation_history': []}


def _claude_key_configured(config) -> bool:
    db = open_primary(config)
    try:
        row = db.fetch_one("SELECT api_key FROM system_llm_settings WHERE provider_key = 'claude' AND enabled = 1")
        return bool(row and row.get('api_key'))
    finally:
        db.close()


def test_validation_parity_no_llm(both):
    same(*both('POST', '/api/v1/chat', json={'message': ''}))
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'tools': 'bad'}))
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'provider': 'no-such-provider', 'tools': [], 'memory': False}))
    same(*both('POST', '/api/v1/chat', json={}, auth=False))


def test_regular_chat_parity_live(both, config):
    if not _claude_key_configured(config):
        pytest.skip('no Claude key in system_llm_settings')
    a, b = both('POST', '/api/v1/chat', json={**BODY, 'streaming': False})
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb) and ja['provider'] == jb['provider'] == 'claude'
    assert set(ja['usage']) == set(jb['usage']) and 'hello world' in ja['text'].lower() and 'hello world' in jb['text'].lower()


def test_streaming_chat_parity_live(php, py, token, config):
    if not _claude_key_configured(config):
        pytest.skip('no Claude key in system_llm_settings')
    h = {'Authorization': f'Bearer {token}'}
    with php.stream('POST', '/api/v1/chat', json={**BODY, 'streaming': True}, headers=h) as ra:
        a = ra.read().decode()
        assert ra.headers['content-type'].startswith('text/event-stream')
    with py.stream('POST', '/api/v1/chat', json={**BODY, 'streaming': True}, headers=h) as rb:
        b = b''.join(rb.iter_bytes()).decode()
        assert rb.headers['content-type'].startswith('text/event-stream')
    same_stream(a, b)
    ea, eb = parse_sse(a), parse_sse(b)
    assert [d for e, d in ea if e == 'progress'][0] == [d for e, d in eb if e == 'progress'][0]        # first progress string verbatim
    assert payload(ea, 'response')['success'] is True and payload(eb, 'response')['success'] is True


def test_streaming_error_parity_bad_key(php, py, token):
    """Both backends: a user API key row for claude with an invalid decryptable key → provider 401 → error events."""
    pytest.skip('requires a throwaway user with an invalid stored key; covered by unit tests in 2a, enabled in 2b')
```

- [ ] **Step 7: Run the differential tests** — `pytest tests/differential/test_chat.py -q` → 3 passed, 1 skipped (or 1 passed + 3 skipped when no Claude key). If the streaming skeletons differ, paste both skeletons in the report; do not loosen `same_stream`.

- [ ] **Step 8: Browser smoke** — start `./run.sh`, set the frontend to Python (Settings → Account → Python, or `localStorage.setItem('BACKEND_KIND','python')`), send one message to Claude with Tools disabled, watch `progress` → `chunk` → `response` → `complete` in the Network tab. Note in the report whether the reply rendered and whether the usage row appeared in `llm_usage_transactions`.

- [ ] **Step 9: Commit** — `git add backend_python && git commit -m "feat(py): POST /api/v1/chat — streaming + regular Claude chat with SSE differential comparator"`

### Task 10: README, parity tracker, full verification

**Files:**
- Modify: `backend_python/README.md` (Status paragraph: Phase 2a done — Claude chat streaming/regular, MCP tools, search tools, session search, memory, usage; other providers pending 2b; verify/compare/attachments pending 2d), `docs/backend-parity-tracker.md` (rows: SSE JSON payloads are clean JSON; SessionSearchService lazy connection; providers other than Claude "not found" until 2b; regular-chat memory update runs before the response; `AttachmentDispatcher` import swallowed until 2d; `_handleVerification/_handleComparison` NotImplemented until 2d; `llm_function_usage_stats` never created).
- Verification: `pytest -q` (unit + differential, PHP up) → all passed; `logs/backend.log` free of tracebacks.
- Commit: `git add backend_python/README.md docs/backend-parity-tracker.md && git commit -m "docs(py): Phase 2a status + parity rows"`

---

## Self-review notes

- **Spec coverage (Phase 2 §2 row 2a as amended):** bridge → T1; contracts/exceptions/Configuration/models → T2; resolver/pricing/usage/SSE hub → T3; ToolsManager/mixins/SearchFunctions/SessionSearch/executors/MCP loader → T4; memory → T5; ClaudeProvider → T6; LLMManager/Assistant → T7; ChatController → T8+T9; SSE comparator + differential + smoke → T9; docs → T10. §3 items: race/StreamingResponse/abort/post-stream/Db reconnect/transactions/PY_WORKERS/multipart all in T1. §4: httpx, streaming parser, tool loop, exceptions in T2/T6. §6: MockTransport fixtures (T6), comparator (T9), live cases gated on a configured key (T9).
- **Placeholders:** none. Deferred pieces are explicit rulings with tracker rows (2b providers, 2d verification/comparison/attachments).
- **Type consistency:** `SseStream.send(event, data)`/`end()`/`mark_aborted()` used identically in T1, T3, T7, T9; `SSEHubClient.current_stream` ContextVar set in T9 and read in T3/T7; `Db.fetch_column` (Phase 1) used by `_getEnabledProviderKeys`; `ToolsManager.registerFunction(name, handler, schema)` signature shared by T4/T7/T9; `ProviderException` factories from T2 used by T6/T7; `Configuration` from T2 consumed by T4/T6/T7; `ChatController` statics named as in tests (T8) and used by T9.
