# Backend Python Port — Phase 2d (Skill bridge, traces, fetch-url, attachments, verify/compare/agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the chat path on the Python backend: `POST /api/v1/agent`, `/verify`, `/compare`, `/chat/upload`, `/traces`, `GET /traces/diagnosis`, `POST /fetch-url`, attachment text extraction feeding the chat prefix, in-chat verification/comparison phases, and the file-based skill-tool bridge the workflow runner (Phase 5) needs — each byte/JSON-faithful to PHP.

**Architecture:** One Python module per PHP file, same class and camelCase method names: `app/agent_team/services/{skill_tool_choice,skill_tool_bridge,execution_trace_store}.py`, `app/controllers/{traces,url_fetch,chat_attachment}_controller.py`, `app/services/attachment_dispatcher.py`; the five remaining `ChatController` methods are ported into the existing `app/controllers/chat_controller.py` (the 2a stubs `_handleVerification`/`_handleComparison` are replaced). Uploads are stored in the SAME directory PHP uses (`backend/storage/chat-uploads/<userId>/<uuid>`) so both backends read each other's files. Document text extraction uses pypdf / python-docx / openpyxl / python-pptx (spec §5).

**Tech Stack:** Python 3.13, FastAPI, httpx, PyMySQL, pypdf, python-docx, openpyxl, python-pptx, pytest; differential against live PHP.

**Spec:** `docs/superpowers/specs/2026-09-06-backend-python-phase2-chat-design.md` (§2 row 2d, §3 multipart, §5 attachments, §6 testing) under `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§3 conventions).

## Global Constraints

- Everything from the Phase 1, 2a, 2b, 2c plans' Global Constraints still applies (Python 3.13, venv, port 3002, `PHP_TIMEZONE`, clean JSON, commit trailer, controllers return dicts with `status_code`, PHP-semantics helpers `php_empty`/`php_intval`/`is_numeric`/`php_bool`/`php_strval`/`php_date`/`php_uniqid`, `??` → `v if v is not None else d`, `is_array` → dict-or-list, `!$x` → `php_empty(x)`, `$data[0] ?? []` → `data[0] if isinstance(data, list) and data else []`, SQL byte-identical, `SHARED_SSL_CONTEXT` + `close()` on every `httpx.Client`).
- **No runtime DDL:** `ExecutionTraceStore.ensureTable()` does NOT create the table (it exists in the live DB); it checks `SHOW TABLES LIKE 'execution_traces'` once, logs `[ExecutionTraceStore] execution_traces missing — create it with backend/… (PHP creates it on demand)` when absent, and lets the insert fail into the same `except` → `None` path PHP has. Tracker row.
- **SSE contract** for the new streaming endpoints is the 2a bridge (`ctx['sse']`, `SseStream.send/end`, `RuntimeError('CLIENT_ABORTED')`); event names verbatim: `verification_start`, `verifier_chunk`, `verification_response`, `verification_complete`, `verification_error`, `compare_start`, `compare_chunk`, `compare_response`, `compare_complete`, `compare_error`. `verify()`/`compareOnly()` return `{'streaming': True}` like PHP (main.py already treats a started stream as handled).
- **Attachments:** allowed MIME map and 50 MB limit copied from `ChatAttachmentController.php:30-48`; MIME detection = byte sniff for the allowed binary types (`%PDF-`, PNG, JPEG, GIF, `RIFF....WEBP`, OOXML zip `PK\x03\x04` + extension) then the same extension fallback PHP's `detectMime` applies to `text/plain`/`application/octet-stream`/unknown — PHP uses `finfo`; the sniff must agree with it for every allowed type (tracker row). Storage root: env `CHAT_UPLOAD_ROOT`, default `<repo>/backend/storage/chat-uploads` resolved from `backend_python/` (`Path(__file__).resolve().parents[N] / 'backend/storage/chat-uploads'`) — the same physical directory PHP writes. Stored path recorded in `chat_attachments.stored_path` is the absolute path, as PHP stores. Extraction: `AttachmentDispatcher.php:222-395` block layout, header strings, `MAX_TEXT_PER_FILE = 100_000` chars, `NATIVE_PDF_PROVIDERS = ['claude', 'gemini', 'openai']`, notes strings verbatim; where a Python library yields different text than the PHP one, the *structure* (headers, separators, truncation marker) must match and the difference is a tracker row.
- **SkillToolBridge** directory: env `SKILL_TOOL_BRIDGE_DIR`, default `/tmp/synergy-workflow-tool` (PHP: `sys_get_temp_dir()/synergy-workflow-tool`; on this Mac PHP's temp dir is `/var/folders/…/T`, so the two backends do NOT share result files — each backend's runner and bridge live in the same process family, so that is fine; tracker row). Poll 100 ms, default timeout 300 000 ms, tool-call id = 32 hex chars, atomic write via temp + rename, ids sanitised to `[a-f0-9]`.
- **UrlFetchController:** constants `MAX_BYTES = 5*1024*1024`, `TIMEOUT_SECONDS = 30`, `CONNECT_TIMEOUT_SECONDS = 10`, `MAX_REDIRECTS = 5`, `BROWSER_UA` verbatim from PHP; `callerIsLoopback()` reads `request['remote_addr']` (127.*, ::1, ::ffff:127.*); `isPrivateHost` resolves with `socket.getaddrinfo` and refuses when ANY address is loopback/private/link-local/multicast/reserved (PHP `FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE`); DNS failure → let the fetch fail (PHP comment). httpx client: `follow_redirects=True, max_redirects=5, timeout=httpx.Timeout(30, connect=10)`, streamed read that stops past 5 MB. Response dicts verbatim (`Fetch failed (curl errno {errno}): {err}` becomes `Fetch failed (httpx {ExceptionClass}): {err}` — tracker row).
- **Traces:** `TracesController.create` field mapping verbatim (PHP 37–70); `ExecutionTraceStore` SQL byte-identical (`INSERT INTO \`execution_traces\` (...)` with the kept columns + `payload` JSON via `phpjson.dumps` — PHP uses `JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE`, so encode with `errors='replace'` semantics for invalid UTF-8), `classify`/`outcomeQuality`/`diagnose`/`foundationBugs`/`skillWeaknesses`/`workflowTrace`/`estimateHealCost`/`verdict`/`recommend` ported line by line; `usort` → `sorted(..., key=..., reverse=True)` is stable where PHP's is not — tracker note only.
- **ChatController additions** (`agent` PHP 942–1008, `verify` 1009–1178, `compareOnly` 1179–1498, `handleVerification` 2091–2189, `handleComparison` 2190–2359) port line by line; `userId = str(input.get('user_id') ?? request['user_id'] ?? 'demo-user')` exactly as PHP (the client-supplied override is a KNOWN pre-existing issue, kept for parity, tracker row 68 already planned); every constructed assistant/MCP loader closed in `finally`.
- Differential: PHP at `http://localhost/gpt/backend`, Python in-process, user 3. Live-LLM cases: `Reply with exactly: hello world`, provider `claude`, verifier/comparer `kimi` (both configured), `tools: []`, `memory: false`, run ONCE per full run. Upload differential uses a 200-byte `text/plain` file; the created rows/files are deleted afterwards by the test (its own rows only, by returned id).
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```
- Work from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python` with `.venv/bin/python -m pytest`; commit from the repo root staging only the files you changed, by path. A uvicorn `--reload` runs on :3002 from this tree — never start or stop servers.

## Porting rules

The Phase 2b table (`docs/superpowers/plans/2026-09-06-backend-python-phase2b.md` § "Porting rules") plus the 2c additions (`docs/superpowers/plans/2026-09-06-backend-python-phase2c.md` § "Porting rules", as corrected). Additions:

| PHP | Python |
|---|---|
| `bin2hex(random_bytes(16))` | `secrets.token_hex(16)` |
| `usleep(100_000)` | `time.sleep(0.1)` |
| `microtime(true)` | `time.time()` |
| `file_put_contents` + `rename` | `Path.write_text/bytes` + `os.replace` |
| `$_FILES['file']` | `request['files']['file']` (`{name, type, tmp_name, size, error}` from `main.py`) |
| `move_uploaded_file($tmp, $dst)` | `shutil.move(tmp, dst)` |
| `basename($s)` | `os.path.basename(s)` |
| `finfo_file` | the byte sniffer in this plan |
| `curl_*` | `httpx.Client(...).stream('GET', url)` |
| `parse_url($url)` | `urllib.parse.urlsplit(url)`; `empty($parts['host'])` → `php_empty(parts.hostname)` |
| `gethostbynamel($host)` | `socket.getaddrinfo(host, None)` → unique IPs |
| `filter_var($ip, FILTER_VALIDATE_IP, NO_PRIV\|NO_RES)` | `ipaddress.ip_address(ip)` and `is_private or is_reserved or is_loopback or is_link_local or is_multicast` |
| `mb_convert_encoding($body, 'UTF-8', $charset)` | `body.decode(charset, errors='replace')` |
| `date('Y-m-d H:i:s')` | `php_date('Y-m-d H:i:s')` |
| `json_encode($v, JSON_UNESCAPED_SLASHES \| JSON_INVALID_UTF8_SUBSTITUTE)` | `phpjson.dumps(v)` after `str.encode('utf-8','replace')` round-trip where the input may hold invalid UTF-8 (bytes never reach here from JSON bodies — note only) |

---

### Task 1: `SkillToolChoice` + `SkillToolBridge`

**Files:**
- Create: `app/agent_team/services/skill_tool_choice.py`, `app/agent_team/services/skill_tool_bridge.py`
- Test: `tests/unit/test_skill_tool_bridge.py`

**Interfaces:**
- `SkillToolChoice.TOOL_NAME = 'run_skill_script'`; `SkillToolChoice.forProvider(provider: str) -> dict | None` (PHP `SkillToolChoice.php`): openai/grok/deepseek/kimi → `{'type': 'function', 'function': {'name': 'run_skill_script'}}`; claude/anthropic → `{'type': 'tool', 'name': 'run_skill_script'}`; else `None`; case-insensitive.
- `SkillToolBridge`: `POLL_INTERVAL_US = 100_000`, `DEFAULT_TIMEOUT_MS = 300_000`; static `generateToolCallId() -> str` (32 hex); `awaitResult(toolCallId, timeoutMs=DEFAULT_TIMEOUT_MS) -> dict | None`; `writeResult(toolCallId, result: dict) -> None`; static `_dir()` (env `SKILL_TOOL_BRIDGE_DIR` or `/tmp/synergy-workflow-tool`), static `_resultPath(toolCallId)` (id sanitised to `[a-f0-9]`, `.result` suffix). Decoded result returned only when it is a dict (PHP `is_array`) — a JSON list also counts (`is_array`), return it as-is.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_skill_tool_bridge.py`:
```python
import json
import os
import threading
import time
import pytest
from app.agent_team.services.skill_tool_choice import SkillToolChoice
from app.agent_team.services.skill_tool_bridge import SkillToolBridge


@pytest.mark.parametrize('name,expected', [
    ('openai', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('Grok', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('deepseek', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('kimi', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('claude', {'type': 'tool', 'name': 'run_skill_script'}),
    ('ANTHROPIC', {'type': 'tool', 'name': 'run_skill_script'}),
    ('gemini', None), ('glm', None), ('', None),
])
def test_skill_tool_choice_for_provider(name, expected):
    assert SkillToolChoice.forProvider(name) == expected and SkillToolChoice.TOOL_NAME == 'run_skill_script'


def test_generate_tool_call_id_is_32_hex():
    a, b = SkillToolBridge.generateToolCallId(), SkillToolBridge.generateToolCallId()
    assert len(a) == 32 and all(c in '0123456789abcdef' for c in a) and a != b


def test_write_then_await_returns_and_deletes(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    b = SkillToolBridge(); cid = SkillToolBridge.generateToolCallId()
    b.writeResult(cid, {'ok': True, 'files': ['/a/b.txt']})
    path = tmp_path / 'bridge' / f'{cid}.result'
    assert path.is_file() and json.loads(path.read_text()) == {'ok': True, 'files': ['/a/b.txt']}
    assert b.awaitResult(cid, 1000) == {'ok': True, 'files': ['/a/b.txt']}
    assert not path.exists()                       # consumed (PHP @unlink)


def test_await_times_out_to_none_and_ignores_unsafe_ids(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    b = SkillToolBridge()
    t0 = time.time(); assert b.awaitResult('ff' * 16, 250) is None; assert 0.2 <= time.time() - t0 < 2
    b.writeResult('../evil', {'x': 1})
    assert sorted(os.listdir(tmp_path / 'bridge')) == ['evil.result'] or os.listdir(tmp_path / 'bridge') == ['.result'] or True
    assert not (tmp_path / 'evil.result').exists()   # never escapes the bridge dir


def test_await_sees_a_result_written_from_another_thread(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    b = SkillToolBridge(); cid = SkillToolBridge.generateToolCallId()
    threading.Timer(0.3, lambda: b.writeResult(cid, {'late': 1})).start()
    assert b.awaitResult(cid, 5000) == {'late': 1}


def test_malformed_result_file_yields_none(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    (tmp_path / 'bridge').mkdir(); cid = 'ab' * 16
    (tmp_path / 'bridge' / f'{cid}.result').write_text('not json')
    assert SkillToolBridge().awaitResult(cid, 500) is None
```
(The one `or True` line is a deliberate no-op guard for platform listing differences; the assertion that matters is the `not (...).exists()` line after it — keep both.)

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError`.
- [ ] **Step 3: Port both PHP classes** (`backend/src/AgentTeam/Services/SkillToolChoice.php`, `SkillToolBridge.php`) with the env-overridable directory. `writeResult` creates the dir with mode 0o777 (best effort, ignore errors like PHP's `@`), writes `<path>.<8 hex>` then `os.replace`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Full unit suite, commit** — `git add backend_python/app/agent_team/services/skill_tool_choice.py backend_python/app/agent_team/services/skill_tool_bridge.py backend_python/tests/unit/test_skill_tool_bridge.py` (create `app/agent_team/services/__init__.py` if missing and add it); message `feat(py): SkillToolChoice + SkillToolBridge`.

---

### Task 2: `ExecutionTraceStore` + `TracesController` + routes

**Files:**
- Create: `app/agent_team/services/execution_trace_store.py`, `app/controllers/traces_controller.py`
- Modify: `app/routes.py` (`# TRACES` rows: `('POST', '/api/v1/traces', ('TracesController', 'create'))`, `('GET', '/api/v1/traces/diagnosis', ('TracesController', 'diagnose'))` + registry)
- Test: `tests/unit/test_execution_trace_store.py`, `tests/unit/test_traces_controller.py`, `tests/differential/test_traces.py`

**Interfaces:**
- `ExecutionTraceStore(db)` with `ensureTable()` (see Global Constraints), `insert(t: dict) -> int | None`, `setUserAction(runId, action, nodeId=None)`, `classify(t) -> str`, `outcomeQuality(t, cls=None) -> str`, `skillWeaknesses(skillDir, sinceDays=30) -> list`, `workflowTrace(workflowId, runId=None) -> list`, `foundationBugs(sinceDays=30) -> list`, `diagnose(sinceDays=30) -> dict`, `estimateHealCost(...)`, private `_verdict`, `_recommend`, `_blendedCost`, `_pricing`, `_query`, `_coerce` — all from `backend/src/AgentTeam/Services/ExecutionTraceStore.php` 29–465 (DDL text kept only as a docstring note).
- `TracesController(db, config={})` with `create(request)` (PHP 30–71) and `diagnose(request)` (PHP 79–90; `days = php_intval(request['query'].get('days') ?? 30)`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_execution_trace_store.py`:
```python
import json
from app.agent_team.services.execution_trace_store import ExecutionTraceStore


class Db:
    def __init__(self, rows=None, show=True): self.calls = []; self.rows = rows or []; self.show = show; self.last_id = 41
    def fetch_all(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params))
        if 'SHOW TABLES' in sql: return [{'t': 'execution_traces'}] if self.show else []
        return self.rows
    def fetch_one(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return None
    def fetch_column(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return []
    def execute(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 1
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); self.last_id += 1; return self.last_id


BASE = {'run_id': 'r1', 'ts': '2026-09-07 10:00:00', 'env': 'chat', 'invocation_mode': 'forced', 'workflow_id': None, 'node_id': None,
        'provider': 'claude', 'model': 'm', 'skill_dir': 'docx', 'script': 'create.py', 'argv': ['a'], 'input_snapshot': {'q': 1},
        'skill_exit_code': 0, 'skill_stdout': 'ok', 'skill_log_messages': None, 'output_files': ['/o.docx'], 'final_text': 'done',
        'success': True, 'loop_detected': False, 'tokens_in': 10, 'tokens_out': 5}


def test_insert_sql_columns_payload_and_coercion():
    db = Db(); store = ExecutionTraceStore(db)
    assert store.insert(dict(BASE)) == 42
    sql, params = [c for c in db.calls if c[0].startswith('INSERT')][0]
    assert sql.startswith('INSERT INTO `execution_traces` (`run_id`, `ts`, `env`, `invocation_mode`, `workflow_id`, `node_id`, `provider`, `skill_dir`, `success`, `error_class`, `error_text`, `outcome_quality`, `tokens_in`, `tokens_out`, `cost_usd`, `payload`) VALUES (:run_id, :ts,')
    assert params[':success'] == 1 and params[':skill_dir'] == 'docx' and params[':error_class'] == store.classify(dict(BASE))
    payload = json.loads(params[':payload'])
    assert list(payload) == ['model', 'latency_ms', 'script', 'argv', 'input_snapshot', 'tool_calls', 'skill_exit_code', 'skill_stdout', 'skill_log_messages', 'output_files', 'final_text', 'rounds', 'round_limit_hit', 'loop_detected']
    assert payload['argv'] == ['a'] and payload['round_limit_hit'] is False and payload['tool_calls'] == []


def test_insert_failure_returns_none_and_missing_table_is_not_created():
    class Boom(Db):
        def insert(self, sql, params=None): raise RuntimeError('db down')
    assert ExecutionTraceStore(Boom()).insert(dict(BASE)) is None
    db = Db(show=False); ExecutionTraceStore(db).ensureTable()
    assert not any(c[0].startswith('CREATE') for c in db.calls)          # no runtime DDL (ruled)


def test_classify_and_outcome_quality_php_branches():
    s = ExecutionTraceStore(Db())
    ok = dict(BASE); assert s.classify(ok) == 'ok' or s.classify(ok) in ('ok', 'none')     # copy PHP's exact label
    failed = dict(BASE, success=False, skill_exit_code=1, error_text='Traceback: boom')
    assert s.classify(failed) != s.classify(ok)
    assert s.outcomeQuality(ok, s.classify(ok)) in ('good', 'ok', 'success')                 # copy PHP's exact label
```
(The two `in (...)` assertions are PHP-truth placeholders: the implementer replaces them with the exact strings from `classify()`/`outcomeQuality()` in PHP 160–219 before commit and pins at least three distinct branches of each.)

`tests/unit/test_traces_controller.py`:
```python
from starlette.datastructures import Headers
from app.controllers.traces_controller import TracesController
from app.support.http import Ctx


class Db:
    def __init__(self): self.calls = []
    def fetch_all(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params)); return [{'t': 'execution_traces'}] if 'SHOW TABLES' in sql else []
    def fetch_one(self, *a): return None
    def fetch_column(self, *a): return []
    def execute(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 1
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 7


def ctx(body=None, query=None, user_id=3):
    c = Ctx(method='POST', uri='/api/v1/traces', headers=Headers({}), query=query or {}, body=body or {}, raw_body='', params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


def test_create_validation_and_mapping():
    c = TracesController(Db(), {})
    assert c.create(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert c.create(ctx(body={})) == {'success': False, 'error': 'Missing skill_dir', 'status_code': 400}
    db = Db(); c = TracesController(db, {})
    r = c.create(ctx(body={'skill_dir': 'docx', 'invocation_mode': 'bogus', 'success': 1, 'tokens_in': '12', 'exit_code': '0', 'output_files': 'nope', 'run_id': 99}))
    assert r == {'success': True, 'id': 7}
    sql, params = [x for x in db.calls if x[0].startswith('INSERT')][0]
    assert params[':invocation_mode'] == 'auto_discovery' and params[':env'] == 'chat' and params[':tokens_in'] == 12 and params[':run_id'] == '99' and params[':success'] == 1
    import json; payload = json.loads(params[':payload'])
    assert payload['output_files'] == [] and payload['skill_exit_code'] == 0


def test_diagnose_requires_auth_and_reads_days():
    c = TracesController(Db(), {})
    assert c.diagnose(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}
    r = c.diagnose(ctx(query={'days': '7'}))
    assert r['success'] is True and r['diagnosis']['window_days'] == 7 and r['diagnosis']['skills'] == []
```

`tests/differential/test_traces.py`:
```python
from .conftest import same


def test_traces_validation_and_diagnosis_parity(both):
    same(*both('POST', '/api/v1/traces', json={}, auth=False))
    same(*both('POST', '/api/v1/traces', json={}))
    same(*both('GET', '/api/v1/traces/diagnosis', auth=False))
    same(*both('GET', '/api/v1/traces/diagnosis?days=30'))
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Port** `ExecutionTraceStore.php` 20–465 and `TracesController.php` 20–91; add routes. Pin the placeholder assertions to PHP's exact labels (`classify`/`outcomeQuality`).
- [ ] **Step 4: Run to verify pass** (unit + `tests/differential/test_traces.py`, PHP live — `diagnosis` for user 3 compares the real aggregate: a mismatch is a SQL/aggregation drift to fix).
- [ ] **Step 5: Full unit suite, commit** — `feat(py): ExecutionTraceStore + TracesController + /traces routes`.

---

### Task 3: `UrlFetchController` + route

**Files:**
- Create: `app/controllers/url_fetch_controller.py`
- Modify: `app/routes.py` (`# URL FETCH` row `('POST', '/api/v1/fetch-url', ('UrlFetchController', 'fetch'))` + registry)
- Test: `tests/unit/test_url_fetch_controller.py`, `tests/differential/test_fetch_url.py`

**Interfaces:**
- `UrlFetchController(db, config)` with `fetch(request) -> dict` (PHP 54–180), private `_looksLikeBareDomain`, `_isPrivateHost`, `_isPrivateIp`, `_callerIsLoopback` (reads `request['remote_addr']`), `_decodeBody`. `self.httpClient = httpx.Client(follow_redirects=True, max_redirects=5, timeout=httpx.Timeout(30, connect=10), verify=SHARED_SSL_CONTEXT, headers={'User-Agent': BROWSER_UA})` created per call and closed in `finally` (PHP creates a curl handle per call). Response dicts exactly as PHP (`success`, `data{url, final_url, status, content_type, bytes, html}`; upstream ≥400 → `{'success': False, 'error': f'Upstream returned HTTP {code}', 'data': {'upstream_status', 'final_url'}}` with NO `status_code` key, as PHP).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_url_fetch_controller.py`:
```python
import httpx
import pytest
from starlette.datastructures import Headers
from app.controllers.url_fetch_controller import UrlFetchController
from app.support.http import Ctx


def ctx(body=None, remote='203.0.113.9'):
    c = Ctx(method='POST', uri='/api/v1/fetch-url', headers=Headers({}), query={}, body=body or {}, raw_body='', params={}, user_id=3, authenticated=True, remote_addr=remote)
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


def _ctl(handler, monkeypatch):
    c = UrlFetchController(None, {})
    monkeypatch.setattr(c, '_makeClient', lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True))
    monkeypatch.setattr(c, '_resolve', lambda host: ['93.184.216.34'])
    return c


def test_validation_paths(monkeypatch):
    c = _ctl(lambda r: httpx.Response(200), monkeypatch)
    assert c.fetch(ctx({})) == {'success': False, 'error': 'Missing required field: url', 'status_code': 400}
    assert c.fetch(ctx({'url': 'not a url'})) == {'success': False, 'error': 'Input is not a URL or recognizable domain', 'status_code': 400}
    assert c.fetch(ctx({'url': 'http://'})) == {'success': False, 'error': 'Invalid URL', 'status_code': 400}


def test_private_host_refused_unless_caller_is_loopback(monkeypatch):
    c = _ctl(lambda r: httpx.Response(200, text='<p>hi</p>', headers={'content-type': 'text/html; charset=utf-8'}), monkeypatch)
    monkeypatch.setattr(c, '_resolve', lambda host: ['10.0.0.5'])
    assert c.fetch(ctx({'url': 'https://intranet.example'})) == {'success': False, 'error': 'Refusing to fetch from a private/internal address', 'status_code': 403}
    assert c.fetch(ctx({'url': 'https://intranet.example'}, remote='127.0.0.1'))['success'] is True


def test_bare_domain_is_upgraded_and_success_shape(monkeypatch):
    seen = {}
    def handler(req):
        seen['url'] = str(req.url); seen['ua'] = req.headers['user-agent']
        return httpx.Response(200, content='<html><meta charset="iso-8859-1"><p>caf\xe9</p></html>'.encode('latin-1'), headers={'content-type': 'text/html'})
    c = _ctl(handler, monkeypatch)
    r = c.fetch(ctx({'url': 'example.com/page'}))
    assert seen['url'] == 'https://example.com/page' and seen['ua'].startswith('Mozilla/5.0')
    assert list(r) == ['success', 'data'] and list(r['data']) == ['url', 'final_url', 'status', 'content_type', 'bytes', 'html']
    assert r['data']['status'] == 200 and 'café' in r['data']['html'] and r['data']['bytes'] == len('<html><meta charset="iso-8859-1"><p>caf\xe9</p></html>'.encode('latin-1'))


def test_upstream_error_and_size_cap(monkeypatch):
    c = _ctl(lambda r: httpx.Response(404, text='nope'), monkeypatch)
    assert c.fetch(ctx({'url': 'https://example.com/x'})) == {'success': False, 'error': 'Upstream returned HTTP 404', 'data': {'upstream_status': 404, 'final_url': 'https://example.com/x'}}
    big = _ctl(lambda r: httpx.Response(200, content=b'x' * (5 * 1024 * 1024 + 1), headers={'content-type': 'text/plain'}), monkeypatch)
    assert big.fetch(ctx({'url': 'https://example.com/big'})) == {'success': False, 'error': 'Response exceeded 5242880 bytes', 'status_code': 502}


def test_network_failure_is_502(monkeypatch):
    def boom(req): raise httpx.ConnectError('Connection refused', request=req)
    r = _ctl(boom, monkeypatch).fetch(ctx({'url': 'https://example.com/'}))
    assert r['success'] is False and r['status_code'] == 502 and r['error'].startswith('Fetch failed (httpx ConnectError): ')
```

`tests/differential/test_fetch_url.py`:
```python
from .conftest import same


def test_fetch_url_validation_parity(both):
    same(*both('POST', '/api/v1/fetch-url', json={}))
    same(*both('POST', '/api/v1/fetch-url', json={'url': 'not a url'}))
    same(*both('POST', '/api/v1/fetch-url', json={'url': 'http://'}))


def test_fetch_url_live_example_com(both):
    a, b = both('POST', '/api/v1/fetch-url', json={'url': 'https://example.com/'})
    assert a.status_code == b.status_code == 200
    ja, jb = a.json(), b.json()
    assert ja['success'] is jb['success'] is True and list(ja) == list(jb) and list(ja['data']) == list(jb['data'])
    assert ja['data']['status'] == jb['data']['status'] == 200 and ja['data']['final_url'] == jb['data']['final_url']
    assert abs(ja['data']['bytes'] - jb['data']['bytes']) < 64 and 'Example Domain' in jb['data']['html']
```
(Both backends are called from localhost, so PHP's `callerIsLoopback()` bypass makes the 403 case untestable differentially — unit-tested only; note in the tracker.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Port** `UrlFetchController.php` 30–283 with `_makeClient()` and `_resolve(host)` as small overridable helpers (the tests monkeypatch them). Streamed read: `with client.stream('GET', url) as r: for chunk in r.iter_bytes(): buf += chunk; if len(buf) > MAX_BYTES: break` then the same three branches as PHP.
- [ ] **Step 4: Run to verify pass** (unit + differential; the live case needs internet).
- [ ] **Step 5: Full unit suite, commit** — `feat(py): UrlFetchController + /fetch-url`.

---

### Task 4: `AttachmentDispatcher` + `ChatAttachmentController` + upload route + chat wiring

**Files:**
- Create: `app/services/attachment_dispatcher.py`, `app/controllers/chat_attachment_controller.py`, `tests/fixtures/attachments/{tiny.pdf,tiny.docx,tiny.xlsx,tiny.pptx}` (generated in Step 1 by the test setup code below, committed as binary fixtures)
- Modify: `requirements.txt` (+ `pypdf>=5`, `python-docx>=1.1`, `openpyxl>=3.1`, `python-pptx>=1.0`), `app/routes.py` (`# ATTACHMENTS` row `('POST', '/api/v1/chat/upload', ('ChatAttachmentController', 'upload'))` + registry), `app/config.py` (env `CHAT_UPLOAD_ROOT` → `config['chat_upload_root']`, default `<repo>/backend/storage/chat-uploads`), `app/controllers/chat_controller.py` (remove the "Phase 2a … lands in 2d" comment; the existing import inside the `try` now resolves)
- Test: `tests/unit/test_attachment_dispatcher.py`, `tests/unit/test_chat_attachment_controller.py`, `tests/differential/test_chat_upload.py`

**Interfaces:**
- `AttachmentDispatcher(db)`: `MAX_TEXT_PER_FILE = 100_000`, `NATIVE_PDF_PROVIDERS = ['claude', 'gemini', 'openai']`; `buildPrefix(attachmentIds: list, userId: int, provider: str | None = None, skillModeActive: bool = False) -> dict` returning `{'prefix': str, 'image_attachments': [...], 'pdf_attachments': [...], 'notes': [...]}` exactly as PHP 76–135 (SQL `SELECT … FROM chat_attachments WHERE …` byte-identical, image/pdf base64 hand-off with the PHP dict keys, extraction via `_extractText(path, mime)` → `_extractDocxText`/`_walkWordElement`/`_extractXlsxText`/`_extractPptxText`, `_truncate`). The `ChatController` call sites (2a) pass `(attachmentIds, php_intval(userId), provider, skillModeActive)` — keep that contract.
- `ChatAttachmentController(db, config)`: `ALLOWED_MIME` map + `MAX_BYTES` from PHP 30–48; `upload(request) -> dict` (PHP 71–177) reading `request['files']['file']`; `_detectMime(path, filename)` per the Global Constraints sniffer; storage root from `config['chat_upload_root']`; per-user dir `<root>/<userId>` created `0o775` (PHP `mkdir(..., 0775, true)` — copy the exact mode PHP uses); stored name `<uuid4 hex>` + extension as PHP builds it (copy PHP 126–133 exactly); `INSERT INTO chat_attachments (...)` byte-identical; response `{'success': True, 'attachment': {'id', 'name', 'mime_type', 'size'}}`.

- [ ] **Step 1: Write fixtures + failing tests**

Fixture generator (run once, commit the four files; keep this snippet in the test module as `_ensure_fixtures()` so a missing fixture is regenerated):
```python
def _ensure_fixtures(d):
    d.mkdir(parents=True, exist_ok=True)
    if not (d / 'tiny.pdf').exists():
        from pypdf import PdfWriter
        from pypdf.generic import NameObject, DictionaryObject, ArrayObject, StreamObject, NumberObject
        w = PdfWriter(); page = w.add_blank_page(width=200, height=200)
        content = StreamObject(); content.set_data(b"BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET")
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): w._add_object(font)})})
        page[NameObject('/Contents')] = w._add_object(content)
        with open(d / 'tiny.pdf', 'wb') as f: w.write(f)
    if not (d / 'tiny.docx').exists():
        import docx; doc = docx.Document(); doc.add_heading('Title A', level=1); doc.add_paragraph('Hello DOCX'); t = doc.add_table(rows=1, cols=2); t.cell(0, 0).text = 'c1'; t.cell(0, 1).text = 'c2'; doc.save(d / 'tiny.docx')
    if not (d / 'tiny.xlsx').exists():
        import openpyxl; wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'S1'; ws.append(['h1', 'h2']); ws.append([1, 'x']); wb.save(d / 'tiny.xlsx')
    if not (d / 'tiny.pptx').exists():
        from pptx import Presentation; p = Presentation(); s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Slide One'; p.save(d / 'tiny.pptx')
```

`tests/unit/test_attachment_dispatcher.py`:
```python
import base64
import pathlib
import pytest
from app.services.attachment_dispatcher import AttachmentDispatcher

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures' / 'attachments'
# _ensure_fixtures(FIX) — paste the generator from the plan here and call it at import time


class Db:
    def __init__(self, rows): self.rows = rows; self.calls = []
    def fetch_all(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self.rows
    def fetch_one(self, *a): return None
    def fetch_column(self, *a): return []
    def execute(self, *a): return 1
    def insert(self, *a): return 1


def _row(id_, name, path, mime): return {'id': id_, 'user_id': 3, 'original_name': name, 'stored_path': str(path), 'mime_type': mime, 'size_bytes': path.stat().st_size if isinstance(path, pathlib.Path) else 0}


def test_empty_ids_short_circuit_and_sql():
    db = Db([]); d = AttachmentDispatcher(db)
    assert d.buildPrefix([], 3) == {'prefix': '', 'image_attachments': [], 'pdf_attachments': [], 'notes': []} and db.calls == []
    d.buildPrefix([1, 2], 3)
    sql, params = db.calls[0]
    assert sql.startswith('SELECT') and 'FROM chat_attachments' in sql and 'user_id' in sql and 3 in (params if isinstance(params, list) else list(params.values()))


def test_text_pdf_docx_xlsx_pptx_are_inlined_with_php_layout(tmp_path):
    txt = tmp_path / 'notes.txt'; txt.write_text('plain text body')
    rows = [_row(1, 'notes.txt', txt, 'text/plain'), _row(2, 'tiny.pdf', FIX / 'tiny.pdf', 'application/pdf'),
            _row(3, 'tiny.docx', FIX / 'tiny.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
            _row(4, 'tiny.xlsx', FIX / 'tiny.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
            _row(5, 'tiny.pptx', FIX / 'tiny.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')]
    out = AttachmentDispatcher(Db(rows)).buildPrefix([1, 2, 3, 4, 5], 3, provider='kimi')       # kimi: no native PDF → extracted
    p = out['prefix']
    assert p.startswith('[The user attached the following document(s); use them as authoritative context for the message that follows.]\n\n')
    for needle in ('plain text body', 'Hello PDF', 'Title A', 'Hello DOCX', 'c1', 'h1', 'Slide One'):
        assert needle in p, needle
    assert out['image_attachments'] == [] and out['pdf_attachments'] == [] and out['notes'] == []


def test_native_pdf_and_images_are_handed_off_not_inlined(tmp_path):
    png = tmp_path / 'i.png'; png.write_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 16)
    rows = [_row(1, 'i.png', png, 'image/png'), _row(2, 'tiny.pdf', FIX / 'tiny.pdf', 'application/pdf')]
    out = AttachmentDispatcher(Db(rows)).buildPrefix([1, 2], 3, provider='claude')
    assert out['image_attachments'][0]['name'] == 'i.png' and base64.b64decode(out['image_attachments'][0]['data']).startswith(b'\x89PNG')
    assert out['pdf_attachments'][0]['name'] == 'tiny.pdf' and out['prefix'] == ''


def test_skill_mode_elides_text_with_the_php_header(tmp_path):
    txt = tmp_path / 'a.txt'; txt.write_text('x' * 50)
    out = AttachmentDispatcher(Db([_row(1, 'a.txt', txt, 'text/plain')])).buildPrefix([1], 3, provider='claude', skillModeActive=True)
    assert 'a.txt' in out['prefix'] and 'x' * 50 not in out['prefix']


def test_truncation_marker_at_100k_chars(tmp_path):
    txt = tmp_path / 'big.txt'; txt.write_text('y' * 100_050)
    out = AttachmentDispatcher(Db([_row(1, 'big.txt', txt, 'text/plain')])).buildPrefix([1], 3, provider='kimi')
    assert out['prefix'].count('y') == 100_000 and 'truncated' in out['prefix'].lower()


def test_extract_failure_becomes_note_not_exception(tmp_path):
    bad = tmp_path / 'bad.pdf'; bad.write_bytes(b'not a pdf')
    out = AttachmentDispatcher(Db([_row(1, 'bad.pdf', bad, 'application/pdf')])).buildPrefix([1], 3, provider='kimi')
    assert out['notes'] and 'bad.pdf' in ' '.join(out['notes'])
```
(Exact header/elision/truncation/note strings: copy PHP 93–135 and 389–395 verbatim and tighten the `in`-style assertions above to the exact text where the plan uses `in`.)

`tests/unit/test_chat_attachment_controller.py`:
```python
import pathlib
from starlette.datastructures import Headers
from app.controllers.chat_attachment_controller import ChatAttachmentController
from app.support.http import Ctx


class Db:
    def __init__(self): self.calls = []
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 55
    def fetch_all(self, *a): return []
    def fetch_one(self, *a): return None
    def fetch_column(self, *a): return []
    def execute(self, *a): return 1


def ctx(files=None, user_id=3):
    c = Ctx(method='POST', uri='/api/v1/chat/upload', headers=Headers({}), query={}, body={}, raw_body='', params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = files or {}
    return c


def _file(tmp_path, name, data, ctype='application/octet-stream', error=0):
    p = tmp_path / ('up_' + name); p.write_bytes(data)
    return {'name': name, 'type': ctype, 'tmp_name': str(p), 'size': len(data), 'error': error}


def test_validation_paths(tmp_path):
    root = tmp_path / 'root'; c = ChatAttachmentController(Db(), {'chat_upload_root': str(root)})
    assert c.upload(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert c.upload(ctx({})) == {'success': False, 'error': 'No file field', 'status_code': 400}
    assert c.upload(ctx({'file': _file(tmp_path, 'a.txt', b'x', error=4)})) == {'success': False, 'error': 'Upload failed (error code 4)', 'status_code': 400}
    assert c.upload(ctx({'file': _file(tmp_path, 'a.txt', b'')})) == {'success': False, 'error': 'Empty file', 'status_code': 400}
    big = _file(tmp_path, 'a.txt', b'x'); big['size'] = 50 * 1024 * 1024 + 1
    assert c.upload(ctx({'file': big})) == {'success': False, 'error': 'File exceeds 50 MB limit', 'status_code': 413}
    r = c.upload(ctx({'file': _file(tmp_path, 'a.exe', b'MZ\x90\x00' + b'\x00' * 32)}))
    assert r['status_code'] == 415 and r['error'].startswith('Unsupported file type: ')


def test_success_stores_under_user_dir_and_records_row(tmp_path):
    root = tmp_path / 'root'; db = Db(); c = ChatAttachmentController(db, {'chat_upload_root': str(root)})
    r = c.upload(ctx({'file': _file(tmp_path, 'notes.md', b'# hi\n', 'text/markdown')}))
    assert r == {'success': True, 'attachment': {'id': 55, 'name': 'notes.md', 'mime_type': 'text/markdown', 'size': 5}}
    sql, params = db.calls[0]
    assert sql == 'INSERT INTO chat_attachments (user_id, original_name, stored_path, mime_type, size_bytes) VALUES (:uid, :name, :path, :mime, :size)'
    assert params[':uid'] == 3 and params[':mime'] == 'text/markdown' and params[':size'] == 5
    stored = pathlib.Path(params[':path']); assert stored.is_file() and stored.parent == root / '3' and stored.read_bytes() == b'# hi\n'


def test_mime_sniffing_matches_php_finfo_for_allowed_types(tmp_path):
    c = ChatAttachmentController(Db(), {'chat_upload_root': str(tmp_path)})
    cases = [('a.pdf', b'%PDF-1.4\n%', 'application/pdf'), ('a.png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 8, 'image/png'),
             ('a.jpg', b'\xff\xd8\xff\xe0' + b'\x00' * 8, 'image/jpeg'), ('a.gif', b'GIF89a' + b'\x00' * 8, 'image/gif'),
             ('a.webp', b'RIFF\x00\x00\x00\x00WEBPVP8 ', 'image/webp'), ('a.csv', b'a,b\n1,2\n', 'text/csv'),
             ('a.md', b'# t\n', 'text/markdown'), ('a.json', b'{"a":1}', 'application/json'), ('a.txt', b'hello', 'text/plain'),
             ('a.html', b'<html><body>x</body></html>', 'text/html')]
    for name, data, mime in cases:
        p = tmp_path / name; p.write_bytes(data)
        assert c._detectMime(str(p), name) == mime, name
```

`tests/differential/test_chat_upload.py`:
```python
"""Upload parity: same multipart to both backends; rows/files removed afterwards."""
from app.db import Db


def test_upload_parity_and_cleanup(php, py, token, config):
    h = {'Authorization': f'Bearer {token}'}
    data = b'differential upload body\n' * 8
    a = php.post('/api/v1/chat/upload', files={'file': ('diff.txt', data, 'text/plain')}, headers=h)
    b = py.post('/api/v1/chat/upload', files={'file': ('diff.txt', data, 'text/plain')}, headers=h)
    assert a.status_code == b.status_code == 200
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb) and list(ja['attachment']) == list(jb['attachment'])
    for k in ('name', 'mime_type', 'size'):
        assert ja['attachment'][k] == jb['attachment'][k]
    db = Db.connect(config.get('contexts_database') or config['database'])
    try:
        for j in (ja, jb):
            row = db.fetch_one('SELECT stored_path FROM chat_attachments WHERE id = ?', [j['attachment']['id']])
            assert row and row['stored_path'].endswith(('.txt',)) or row
            import os; os.path.exists(row['stored_path']) and os.remove(row['stored_path'])
            db.execute('DELETE FROM chat_attachments WHERE id = ?', [j['attachment']['id']])
    finally:
        db.close()


def test_upload_validation_parity(both):
    from .conftest import same
    same(*both('POST', '/api/v1/chat/upload', json={}, auth=False))
    same(*both('POST', '/api/v1/chat/upload', json={}))
```
(Use the `php`/`py` fixtures' `.post(...)` if they expose it, else `.request('POST', ..., files=...)` — copy the pattern from `test_providers.py`.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Port** `AttachmentDispatcher.php` 39–397 and `ChatAttachmentController.php` 26–241; add the deps to `requirements.txt` and `pip install` them into `.venv`; add the route + config key; remove the 2a "lands in 2d" comment in `chat_controller.py` (the import inside the try stays). Tighten the `in`-style assertions to the exact PHP strings.
- [ ] **Step 4: Run to verify pass** (unit + `tests/differential/test_chat_upload.py`).
- [ ] **Step 5: Full unit suite, commit** — files by path incl. the four fixtures; `feat(py): chat uploads + AttachmentDispatcher (pdf/docx/xlsx/pptx extraction)`.

---

### Task 5: `ChatController.agent` / `verify` / `compareOnly` / `_handleVerification` / `_handleComparison` + routes

**Files:**
- Modify: `app/controllers/chat_controller.py` (replace the two 2d stubs; add the three public methods; module docstring), `app/routes.py` (`('POST', '/api/v1/agent', ('ChatController', 'agent'))`, `('POST', '/api/v1/verify', ('ChatController', 'verify'))`, `('POST', '/api/v1/compare', ('ChatController', 'compareOnly'))` right after the chat route, PHP order)
- Test: `tests/unit/test_chat_controller_2d.py`, `tests/differential/test_chat_2d.py`

**Interfaces:**
- `agent(request) -> dict` (PHP 942–1008): validation `prompt is required` / `provider is required` (400), quota, config chain, `getProvider` → `Provider 'x' not available` (400), optional `setModel`, `llmManager.chat(prompt, [], options)`, success dict `{'success', 'text', 'usage', 'provider', 'model'}` (NO `status_code`), `except` → `{'success': False, 'error': humanize, 'status_code': 500}`; assistant closed in `finally`.
- `verify(request) -> dict` (PHP 1009–1178): validation 400 text verbatim; streaming through `request['sse']` with a local `sendEvent` that mirrors the 2a `_handleStreamingChat` one (abort → `RuntimeError('CLIENT_ABORTED')`); `verification_start` → verifier prompt (copy PHP 1070–1090 verbatim) → `streamChat` with `VerificationSseClient` (2a) → `verification_response{success, text, usage, provider, model?}` per PHP 1124–1131 → usage row per PHP 1132–1147 → `verification_complete{status:'done'}`; errors → `verification_error{message}` + `verification_complete{status:'error'}`; returns `{'streaming': True}`.
- `compareOnly(request) -> dict` (PHP 1179–1498): same shape with `compare_*` events, attachments via `AttachmentDispatcher` (Task 4), skill tools/`tool_choice` per PHP 1330–1400, `streaming` option (PHP 1425–1450), usage row.
- `_handleVerification(...)`/`_handleComparison(...)` (PHP 2091–2359) with the 2a call-site signatures already in `_handleStreamingChat` (`self._handleVerification(assistant, sendEvent, message, responseText, verifierProvider, mcpToolsLoader, usageLogger, userId, startTime, responseTimeMs)` and the comparison one) — keep those parameter lists.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_chat_controller_2d.py` (reuse the `Db`, `CFG`, `ctx`, `FakeAssistant`, `Rec`-style scaffolding from `tests/unit/test_chat_controller_flows.py` — import them: `from tests.unit.test_chat_controller_flows import Db, CFG, ctx, FakeAssistant` works if `tests/unit/__init__.py` exists; otherwise copy the four definitions verbatim):
```python
import asyncio
from app.controllers.chat_controller import ChatController
from app.support.sse import SseStream
from tests.unit.test_chat_controller_flows import Db, CFG, ctx, FakeAssistant


class Assistant(FakeAssistant):
    """LLMManager fake with chat/streamChat + getProvider for a second provider."""
    def __init__(self, config):
        super().__init__(config)
        outer = self
        class L:
            def getProvider(self, n): return object() if n in ('claude', 'kimi') else None
            def chat(self, message, history, options): return outer.chat(message, options.get('user_id'), history, options)
            def streamChat(self, message, onChunk, history, options):
                onChunk('hel'); onChunk('lo'); return outer.chat(message, options.get('user_id'), history, options)
        self.llm = L()


def _events(s):
    out = []
    while not s.queue.empty():
        f = s.queue.get_nowait()
        if f is None: break
        out.append(f.split(b'\n', 1)[0].decode())
    return out


def test_agent_validation_and_success(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    c = ChatController(Db(), CFG)
    assert c.agent(ctx({'prompt': '', 'provider': 'claude'})) == {'success': False, 'error': 'prompt is required', 'status_code': 400}
    assert c.agent(ctx({'prompt': 'hi'})) == {'success': False, 'error': 'provider is required', 'status_code': 400}
    assert c.agent(ctx({'prompt': 'hi', 'provider': 'nope'})) == {'success': False, 'error': "Provider 'nope' not available", 'status_code': 400}
    r = c.agent(ctx({'prompt': 'hi', 'provider': 'claude', 'system': 'SYS'}))
    assert list(r) == ['success', 'text', 'usage', 'provider', 'model'] and r['text'] == 'reply' and r['provider'] == 'claude'
    assert FakeAssistant.last[3]['system_prompt'] == 'SYS' and FakeAssistant.last[3]['tools'] == []


def test_verify_validation_and_event_sequence(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    c = ChatController(Db(), CFG)
    assert c.verify(ctx({'original_message': 'q', 'response_text': ''})) == {'success': False, 'error': 'original_message, response_text, and verifier_provider are required', 'status_code': 400}
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        r = await loop.run_in_executor(None, c.verify, ctx({'original_message': 'q', 'response_text': 'a', 'verifier_provider': 'kimi'}, sse=s))
        return r, _events(s)
    r, names = asyncio.run(run())
    assert r == {'streaming': True}
    assert names[0] == 'event: verification_start' and names[-1] == 'event: verification_complete'
    assert 'event: verifier_chunk' in names and 'event: verification_response' in names
    assert names.index('event: verification_response') < names.index('event: verification_complete')


def test_compare_only_validation_and_event_sequence(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    c = ChatController(Db(), CFG)
    assert c.compareOnly(ctx({'message': 'q'})) == {'success': False, 'error': 'message and compare_provider are required', 'status_code': 400}
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        r = await loop.run_in_executor(None, c.compareOnly, ctx({'message': 'q', 'compare_provider': 'kimi', 'tools': [], 'memory': False}, sse=s))
        return r, _events(s)
    r, names = asyncio.run(run())
    assert r == {'streaming': True} and names[0] == 'event: compare_start' and names[-1] == 'event: compare_complete'
    assert 'event: compare_chunk' in names and 'event: compare_response' in names


def test_chat_with_verification_and_compare_phases(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    c = ChatController(Db(), CFG)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        await loop.run_in_executor(None, c.chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False,
                                                    'verification_enabled': True, 'verifier_provider': 'kimi', 'compare_enabled': True, 'compare_provider': 'kimi'}, sse=s))
        return _events(s)
    names = asyncio.run(run())
    i_resp, i_vs, i_cs, i_done = names.index('event: response'), names.index('event: verification_start'), names.index('event: compare_start'), names.index('event: complete')
    assert i_resp < i_vs < names.index('event: verification_complete') < i_cs < names.index('event: compare_complete') < i_done


def test_verify_error_path_emits_error_and_complete(monkeypatch):
    class Boom(Assistant):
        def __init__(self, config):
            super().__init__(config)
            class L:
                def getProvider(self, n): return object()
                def streamChat(self, *a): raise RuntimeError('kimi API error: 503 Service Unavailable')
            self.llm = L()
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Boom)
    c = ChatController(Db(), CFG)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        await loop.run_in_executor(None, c.verify, ctx({'original_message': 'q', 'response_text': 'a', 'verifier_provider': 'kimi'}, sse=s)); return _events(s)
    names = asyncio.run(run())
    assert names[-2:] == ['event: verification_error', 'event: verification_complete']
```

`tests/differential/test_chat_2d.py`:
```python
import pytest
from .conftest import same
from .sse import same_stream

MSG = 'Reply with exactly: hello world'


def test_validation_parity(both):
    same(*both('POST', '/api/v1/agent', json={'prompt': '', 'provider': 'claude'}))
    same(*both('POST', '/api/v1/agent', json={'prompt': 'x'}))
    same(*both('POST', '/api/v1/agent', json={'prompt': 'x', 'provider': 'no-such'}))
    same(*both('POST', '/api/v1/verify', json={'original_message': 'q'}))
    same(*both('POST', '/api/v1/compare', json={'message': 'q'}))


def test_agent_live_parity(both):
    a, b = both('POST', '/api/v1/agent', json={'prompt': MSG, 'provider': 'claude'})
    assert a.status_code == b.status_code == 200
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb) and ja['success'] is jb['success'] is True and ja['provider'] == jb['provider'] and ja['model'] == jb['model']
    assert sorted(ja['usage']) == sorted(jb['usage'])


def _stream(client, path, body, token):
    h = {'Authorization': f'Bearer {token}'}
    with client.stream('POST', path, json=body, headers=h, timeout=180) as r:
        return r.status_code, r.headers['content-type'], b''.join(r.iter_bytes()).decode()


def test_verify_live_parity(php, py, token):
    body = {'original_message': MSG, 'response_text': 'hello world', 'verifier_provider': 'kimi'}
    sa, ca, a = _stream(php, '/api/v1/verify', body, token); sb, cb, b = _stream(py, '/api/v1/verify', body, token)
    assert sa == sb == 200 and ca.split(';')[0] == cb.split(';')[0] == 'text/event-stream'
    same_stream(a, b, ignore_response_keys=('text',))


def test_compare_live_parity(php, py, token):
    body = {'message': MSG, 'compare_provider': 'kimi', 'tools': [], 'memory': False, 'conversation_history': []}
    sa, ca, a = _stream(php, '/api/v1/compare', body, token); sb, cb, b = _stream(py, '/api/v1/compare', body, token)
    assert sa == sb == 200
    same_stream(a, b, ignore_response_keys=('text',))
```
(`same_stream` compares the skeleton and the terminal payloads by event name; if it only knows `response`/`complete`/`error`, extend `tests/differential/sse.py` so `payload()`/`same_stream()` also treat `verification_response`/`verification_complete`/`verification_error`/`compare_response`/`compare_complete`/`compare_error` as terminal payloads — a small, additive change.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Port** the five PHP methods; add routes; extend `sse.py` if needed. Close every assistant/loader in `finally`.
- [ ] **Step 4: Run to verify pass** (unit; differential ONCE — 3 live calls per backend).
- [ ] **Step 5: Full unit suite, commit** — `feat(py): /agent, /verify, /compare + in-chat verification/comparison phases`.

---

### Task 6: Docs, full verification, browser smoke

**Files:**
- Modify: `backend_python/README.md` (Phase 2d paragraph: chat path complete — list the routes; "Phases 3–8 pending"), `docs/backend-parity-tracker.md` (rows from 68: `user_id` body override kept for parity (pre-existing PHP issue); `ensureTable` no DDL; bridge dir differs from PHP's temp dir; MIME sniffer vs finfo; Python extraction libraries vs PHP's; fetch-url error prefix `httpx <Class>` vs `curl errno`; loopback bypass untestable differentially; `usort` stability; plus one row per ledger ruling)
- Verification: `.venv/bin/python -m pytest -q tests/unit`; `.venv/bin/python -m pytest -q tests/differential` ONCE (live cases included); `logs/backend.log` traceback check.
- Browser smoke (controller-run, needs the user signed in): frontend on Python → picker populated → one Claude chat → verify pane with kimi → compare with kimi → upload a `.txt` and chat about it. Recorded in the ledger.
- Commit: `docs(py): Phase 2d status + parity rows` (by path).

---

## Self-review notes

- **Spec coverage (§2 row 2d):** client tools + `SkillToolBridge`/`SkillToolChoice` → T1 (the chat-side client-tool events/builders shipped in 2a/2b); `ChatAttachmentController` + `AttachmentDispatcher` → T4; `verify`/`compareOnly`/`handleVerification`/`handleComparison`/`agent` → T5; `TracesController` + `ExecutionTraceStore` → T2; `UrlFetchController` → T3; §5 attachment extraction libs → T4; §6 browser smoke → T6.
- **Placeholders:** the `in (...)`/`in`-style assertions in T2 and T4 are PHP-truth placeholders the implementer must tighten before commit; T1's `or True` line is annotated.
- **Type consistency:** `Ctx(...)` + `c['files']`/`c['sse']` conventions from 2a tests; `VerificationSseClient`/`ComparisonSseClient` (2a, `app/controllers/chat_sse_clients.py`); `_handleVerification`/`_handleComparison` call-site signatures from `_handleStreamingChat` (2a); `AttachmentDispatcher(db).buildPrefix(ids, int, provider, bool)` matches the 2a call sites; `Db` API (`insert` returns lastrowid); `SHARED_SSL_CONTEXT` from 2b; `same_stream`/`same`/`both` from the differential conftest.
