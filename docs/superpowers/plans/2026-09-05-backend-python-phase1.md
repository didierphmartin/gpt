# Backend Python Port — Phase 1 (Skeleton + Auth + Public Routes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `gpt/backend_python` (FastAPI, port 3002) with the request pipeline, auth, and the first ~30 routes, so a token minted by any backend works on Python and the frontend can be pointed at it through the switcher.

**Architecture:** A FastAPI app with ONE catch-all ASGI route. Each request is turned into a PHP-style `Ctx` dict, run through `MiddlewareProcessor` (CORS → auth), matched by a FastRoute-compatible `Dispatcher` against the route table, handed to a controller class that returns a dict which IS the JSON body, and rendered by `render()` using the `index.php` conventions. Controllers, middleware, and services are one-to-one ports of the PHP classes (same class names, same camelCase method names, raw SQL) so the two trees read in parallel. All DB work is synchronous PyMySQL, one connection per request like PHP; handlers run in Starlette's threadpool.

**Tech Stack:** Python 3.13, FastAPI, uvicorn, PyMySQL, PyJWT, bcrypt, python-dotenv, httpx (tests + Google certs), pytest.

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md`

**Scope change vs spec table:** `ProviderController` (`GET/POST /api/v1/providers*`) moves from Phase 1 to Phase 2. Its `list()` builds `AIPortfolioAssistant`, `LLMProviderResolver`, `MCPToolsLoader`, and `AgentDelegationFunctions` — all Phase 2 chat-stack classes. Everything else from the Phase 1 row is here, plus the three admin package routes (same tiny controller).

## Global Constraints

- Python **3.13**; venv at `backend_python/.venv`; run in place from htdocs (not installed elsewhere).
- Listens on **port 3002**. PHP stays at `http://localhost/gpt/backend`.
- Same `.env` values as PHP: `backend_python/.env` if present, else fall back to `../backend/.env`.
- Required env vars (fail closed, same message as `load_env.php`): `DB_HOST DB_NAME DB_USER DB_PASS CTX_DB_HOST CTX_DB_NAME CTX_DB_USER CTX_DB_PASS JWT_SECRET APP_KEY_SECRET`.
- JWT: HS256, claims `iss='gpt-chat', iat, exp, sub, type`; `jwt_expiry=28800`, `refresh_expiry=604800`.
- Wall-clock strings (`date('Y-m-d H:i:s')`) use PHP's timezone: env `PHP_TIMEZONE`, default **`Europe/Berlin`** (XAMPP php.ini value).
- Mirror PHP quirks marked 🪞 in `docs/backend-parity-tracker.md`. New deviations get a tracker line in Task 13.
- Controllers return a dict body; transport keys `status_code` / `content_type` are stripped by `render()`.
- No runtime DDL. All Phase 1 tables exist in `backend/schema/chatbot.sql` (verified: users, prompt_library, conversation_contexts, packages, webauthn_credentials, webauthn_challenges, app_keys).
- JSON output: clean encoding (`ensure_ascii=False`, no escaped slashes), insertion-ordered keys.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```
- Run all commands from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python` with the venv activated (`source .venv/bin/activate`) unless stated otherwise.

## File Structure

```
backend_python/
  .env.example                  documented env template (copy of PHP keys + PORT + PHP_TIMEZONE)
  .gitignore                    .venv/ .env logs/ __pycache__/ .pytest_cache/
  requirements.txt              runtime deps
  requirements-dev.txt          pytest + httpx
  pytest.ini                    testpaths, markers
  README.md                     run/test instructions (Task 13)
  main.py                       create_app(): catch-all route → pipeline
  run.sh                        uvicorn launcher on 3002
  app/__init__.py
  app/config.py                 load_env() + load_config() → nested dict identical to ai_config.php
  app/db.py                     Db: per-request PyMySQL connection, PHP-typed rows, ?/:name params
  app/routes.py                 ROUTES table + CONTROLLERS registry
  app/support/__init__.py
  app/support/phpcompat.py      php_now(), ucfirst(), is_numeric(), validate_email(), b64url_*()
  app/support/phpjson.py        dumps(): clean JSON, PHP key order
  app/support/sql.py            translate(sql, params): PDO placeholders → PyMySQL
  app/support/http.py           Ctx, build_ctx(), render()
  app/support/router.py         Dispatcher: FastRoute pattern syntax, FOUND/NOT_FOUND/METHOD_NOT_ALLOWED
  app/support/logger.py         file logger → logs/backend.log (+ stderr)
  app/middleware/__init__.py
  app/middleware/cors.py        CorsMiddleware
  app/middleware/auth.py        AuthMiddleware (JWT, uak_, ak_ AppKey)
  app/middleware/processor.py   MiddlewareProcessor + PUBLIC_ROUTES + build_request()
  app/controllers/__init__.py
  app/controllers/root_controller.py
  app/controllers/model_catalog_controller.py
  app/controllers/auth_controller.py
  app/controllers/prompt_library_controller.py
  app/controllers/context_controller.py
  app/controllers/package_controller.py
  app/controllers/webauthn_controller.py
  app/services/__init__.py
  app/services/package_resolver.py
  app/services/firebase_tokens.py   Google secure-token certs cache + RS256 verify
  app/agent_team/__init__.py
  app/agent_team/services/__init__.py
  app/agent_team/services/app_key_repository.py
  resources/model_catalog.json  copied from ../backend/resources
  tests/unit/...                one test module per support/middleware/controller module
  tests/differential/conftest.py  PHP-vs-Python fixtures (skip when PHP unreachable)
  tests/differential/test_*.py
```

Frontend/admin files modified in Task 12:
- `frontend/assets/js/api-config.js`, `frontend/assets/js/settings-panel.js`, `frontend/index.html`
- `/Applications/XAMPP/xamppfiles/htdocs/gpt_admin/src/lib/backendConfig.ts` (separate git repo)

---

### Task 1: Project scaffold, env loading, config dict, PHP-compat helpers

**Files:**
- Create: `backend_python/.gitignore`, `backend_python/.env.example`, `backend_python/requirements.txt`, `backend_python/requirements-dev.txt`, `backend_python/pytest.ini`
- Create: `backend_python/app/__init__.py`, `backend_python/app/support/__init__.py`
- Create: `backend_python/app/config.py`, `backend_python/app/support/phpcompat.py`, `backend_python/app/support/logger.py`
- Test: `backend_python/tests/unit/test_config.py`, `backend_python/tests/unit/test_phpcompat.py`

**Interfaces:**
- Produces: `app.config.load_config(env_file: str | None = None) -> dict` (keys exactly as `ai_config.php`: `database, contexts_database, login_db, login_database, video_editor_database, auth{jwt_secret,jwt_expiry,refresh_expiry,app_key_secret,login_jwt_secret}, search, financial, sse, tracking, debug, default_provider, max_recursion_depth, hume_evi, grok_voice, gemini_voice, scheduler, storage, parallel_skill_timeout_ms, metals_news`, plus `port: int`, `firebase: {project_id}`); raises `app.config.ConfigError` with PHP's message when required vars are missing.
- Produces: `app.support.phpcompat.php_now() -> str`, `ucfirst(s)`, `is_numeric(v) -> bool`, `validate_email(s) -> bool`, `b64url_encode(bytes) -> str`, `b64url_decode(str) -> bytes`, `mb_substr(s, start, length)`.
- Produces: `app.support.logger.get_logger() -> logging.Logger` writing to `logs/backend.log` and stderr.

- [ ] **Step 1: Create the venv and dependency files**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt && mkdir -p backend_python && cd backend_python
/usr/bin/env python3.13 -m venv .venv || python3 -m venv .venv
source .venv/bin/activate
cat > requirements.txt <<'REQ'
fastapi>=0.115
uvicorn[standard]>=0.30
PyMySQL>=1.1
PyJWT[crypto]>=2.9
bcrypt>=4.2
python-dotenv>=1.0
httpx>=0.27
REQ
cat > requirements-dev.txt <<'REQ'
-r requirements.txt
pytest>=8.3
REQ
cat > .gitignore <<'GI'
.venv/
.env
logs/
__pycache__/
.pytest_cache/
GI
cat > pytest.ini <<'PT'
[pytest]
testpaths = tests
markers =
    differential: hits the live PHP backend and the Python app; skipped when PHP is unreachable
PT
pip install -r requirements-dev.txt
```

- [ ] **Step 2: Write `.env.example`**

```bash
cat > .env.example <<'ENV'
# Python backend port (PHP is served by Apache under /gpt/backend, Node on 3001).
PORT=3002
# PHP's date.timezone (XAMPP php.ini) — used for date('Y-m-d H:i:s') parity.
PHP_TIMEZONE=Europe/Berlin
# Everything below: SAME values as ../backend/.env. If this file is absent the app
# reads ../backend/.env directly.
DB_HOST=
DB_NAME=
DB_USER=
DB_PASS=
CTX_DB_HOST=
CTX_DB_NAME=
CTX_DB_USER=
CTX_DB_PASS=
JWT_SECRET=
APP_KEY_SECRET=
LOGIN_DB_HOST=
LOGIN_DB_NAME=
LOGIN_DB_USER=
LOGIN_DB_PASS=
LOGIN_JWT_SECRET=
VE_DB_HOST=
VE_DB_NAME=
VE_DB_USER=
VE_DB_PASS=
SERPAPI_KEY=
SCRAPINGDOG_KEY=
BRAVE_KEY=
FMP_KEY=
HUME_API_KEY=
GROK_VOICE_API_KEY=
GEMINI_VOICE_API_KEY=
SCHEDULER_TOKEN=
FIREBASE_PROJECT_ID=transledgersite
ENV
mkdir -p app/support tests/unit tests/differential logs
touch app/__init__.py app/support/__init__.py tests/__init__.py tests/unit/__init__.py tests/differential/__init__.py
```

- [ ] **Step 3: Write the failing config tests**

`tests/unit/test_config.py`:
```python
import pytest
from app.config import load_config, ConfigError

REQUIRED = {
    'DB_HOST': 'h', 'DB_NAME': 'n', 'DB_USER': 'u', 'DB_PASS': 'p',
    'CTX_DB_HOST': 'ch', 'CTX_DB_NAME': 'cn', 'CTX_DB_USER': 'cu', 'CTX_DB_PASS': 'cp',
    'JWT_SECRET': 'jwt-secret', 'APP_KEY_SECRET': 'ak-secret',
}


def _env(monkeypatch, overrides=None):
    for k in list(REQUIRED) + ['PORT', 'PHP_TIMEZONE', 'LOGIN_DB_NAME', 'FIREBASE_PROJECT_ID']:
        monkeypatch.delenv(k, raising=False)
    for k, v in {**REQUIRED, **(overrides or {})}.items():
        monkeypatch.setenv(k, v)


def test_config_mirrors_ai_config_shape(monkeypatch):
    _env(monkeypatch)
    cfg = load_config(env_file=None)
    assert cfg['database'] == {'host': 'h', 'database': 'n', 'username': 'u', 'password': 'p', 'charset': 'utf8mb4'}
    assert cfg['contexts_database']['database'] == 'cn'
    assert cfg['auth'] == {
        'jwt_secret': 'jwt-secret', 'jwt_expiry': 28800, 'refresh_expiry': 604800,
        'app_key_secret': 'ak-secret', 'login_jwt_secret': '',
    }
    assert cfg['login_db']['database'] == 'netfo587_login'   # PHP default when LOGIN_DB_NAME unset
    assert cfg['login_db']['host'] == 'h'                     # falls back to DB_HOST
    assert cfg['login_database']['database'] == ''            # no default in this block (PHP quirk)
    assert cfg['default_provider'] == 'kimi'
    assert cfg['max_recursion_depth'] == 10
    assert cfg['scheduler']['max_concurrent'] == 5
    assert cfg['port'] == 3002
    assert cfg['firebase']['project_id'] == 'transledgersite'


def test_missing_required_raises_php_message(monkeypatch):
    _env(monkeypatch)
    monkeypatch.delenv('JWT_SECRET')
    monkeypatch.delenv('DB_PASS')
    with pytest.raises(ConfigError) as ei:
        load_config(env_file=None)
    assert str(ei.value) == (
        'Missing required env vars: DB_PASS, JWT_SECRET. '
        'Copy backend/.env.example to backend/.env and fill it in.'
    )
```

`tests/unit/test_phpcompat.py`:
```python
import re
from app.support import phpcompat as pc


def test_php_now_format_and_timezone(monkeypatch):
    monkeypatch.setenv('PHP_TIMEZONE', 'Europe/Berlin')
    s = pc.php_now()
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', s)


def test_ucfirst():
    assert pc.ucfirst('prompt') == 'Prompt'
    assert pc.ucfirst('') == ''


def test_is_numeric():
    assert pc.is_numeric(3) and pc.is_numeric('3') and pc.is_numeric('3.5') and pc.is_numeric(' 3')
    assert not pc.is_numeric(None) and not pc.is_numeric('') and not pc.is_numeric('abc') and not pc.is_numeric(True)


def test_validate_email():
    assert pc.validate_email('a.b@example.com')
    assert not pc.validate_email('nope') and not pc.validate_email('a@b') and not pc.validate_email('a b@c.com')


def test_b64url_roundtrip():
    raw = bytes(range(32))
    enc = pc.b64url_encode(raw)
    assert '=' not in enc and '+' not in enc and '/' not in enc
    assert pc.b64url_decode(enc) == raw


def test_mb_substr():
    assert pc.mb_substr('héllo wörld', 0, 5) == 'héllo'
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pytest tests/unit/test_config.py tests/unit/test_phpcompat.py -q`
Expected: FAIL / ImportError (`app.config` not found)

- [ ] **Step 5: Implement `app/config.py`**

```python
"""Mirror of backend/config/load_env.php + backend/config/ai_config.php.

Env resolution: backend_python/.env if present, else ../backend/.env. Real
environment variables always win (dotenv does not override).
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent            # backend_python/
PHP_BACKEND = ROOT.parent / 'backend'                    # ../backend

REQUIRED = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS',
            'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS',
            'JWT_SECRET', 'APP_KEY_SECRET']


class ConfigError(RuntimeError):
    pass


def default_env_file() -> str | None:
    own = ROOT / '.env'
    if own.is_file():
        return str(own)
    php = PHP_BACKEND / '.env'
    return str(php) if php.is_file() else None


def load_env(env_file: str | None) -> None:
    if env_file:
        load_dotenv(env_file, override=False)
    missing = [k for k in REQUIRED if os.environ.get(k, '') == '']
    if missing:
        raise ConfigError(
            'Missing required env vars: ' + ', '.join(missing)
            + '. Copy backend/.env.example to backend/.env and fill it in.'
        )


def _e(key: str, default: str = '') -> str:
    return os.environ.get(key, default)


def _db(prefix: str) -> dict:
    return {
        'host': _e(f'{prefix}_HOST'),
        'database': _e(f'{prefix}_NAME'),
        'username': _e(f'{prefix}_USER'),
        'password': _e(f'{prefix}_PASS'),
        'charset': 'utf8mb4',
    }


def load_config(env_file: str | None = '__default__') -> dict:
    """Build the config dict. env_file=None skips dotenv (tests); default picks .env."""
    load_env(default_env_file() if env_file == '__default__' else env_file)
    return {
        'parallel_skill_timeout_ms': 300000,
        'search': {
            'serpapi': {'api_key': _e('SERPAPI_KEY'), 'base_url': 'https://serpapi.com/search',
                        'engine': 'google', 'max_results': 20},
            'scrapingdog': {'api_key': _e('SCRAPINGDOG_KEY'), 'base_url': 'https://api.scrapingdog.com/google'},
            'brave': {'api_key': _e('BRAVE_KEY'), 'base_url': 'https://api.search.brave.com/res/v1',
                      'max_results': 20},
        },
        'metals_news': {'service_url': 'http://localhost/metals/public'},
        'financial': {'fmp': {'api_key': _e('FMP_KEY'),
                              'base_url': 'https://financialmodelingprep.com/api/v3'}},
        'sse': {'enabled': True, 'hub_url': None},
        'tracking': {'enabled': True, 'track_costs': True},
        'debug': False,
        'default_provider': 'kimi',
        'max_recursion_depth': 10,
        'database': _db('DB'),
        'login_db': {
            'host': _e('LOGIN_DB_HOST') or _e('DB_HOST'),
            'database': _e('LOGIN_DB_NAME') or 'netfo587_login',
            'username': _e('LOGIN_DB_USER'),
            'password': _e('LOGIN_DB_PASS'),
        },
        'contexts_database': _db('CTX_DB'),
        'video_editor_database': _db('VE_DB'),
        'login_database': _db('LOGIN_DB'),
        'auth': {
            'jwt_secret': _e('JWT_SECRET'),
            'jwt_expiry': 28800,
            'refresh_expiry': 604800,
            'app_key_secret': _e('APP_KEY_SECRET'),
            'login_jwt_secret': _e('LOGIN_JWT_SECRET'),
        },
        'hume_evi': {
            'api_key': _e('HUME_API_KEY'), 'base_url': 'https://api.hume.ai/v0/evi',
            'config_id': '0d9df320-ec1d-4e08-8c2e-300e4e8de3b1',
            'auto_sync_on_changes': False, 'cleanup_orphaned_tools': False,
        },
        'grok_voice': {
            'api_key': _e('GROK_VOICE_API_KEY'), 'base_url': 'https://api.x.ai',
            'realtime_endpoint': '/v1/realtime', 'client_secrets_endpoint': '/v1/realtime/client_secrets',
            'default_voice': 'Eve', 'token_expiry_minutes': 5,
        },
        'gemini_voice': {
            'api_key': _e('GEMINI_VOICE_API_KEY'),
            'model': 'gemini-2.5-flash-native-audio-preview-12-2025', 'default_voice': 'Zephyr',
        },
        'scheduler': {'token': _e('SCHEDULER_TOKEN'), 'max_concurrent': 5, 'timeout_minutes': 30},
        'storage': {'default_provider': 's3'},
        # Python-only additions (not in ai_config.php):
        'port': int(_e('PORT', '3002')),
        'firebase': {'project_id': _e('FIREBASE_PROJECT_ID', 'transledgersite')},
    }
```

Note: PHP's `$_ENV['LOGIN_DB_HOST'] ?? ($_ENV['DB_HOST'] ?? '')` falls back only when the key is *unset*; with dotenv an empty `LOGIN_DB_HOST=` line yields `''` in PHP but falls back to `DB_HOST` here. The PHP `.env` has no such empty line today, so behavior is identical in practice.

- [ ] **Step 6: Implement `app/support/phpcompat.py` and `app/support/logger.py`**

`app/support/phpcompat.py`:
```python
"""Small PHP built-in equivalents used by the ported controllers."""
from __future__ import annotations

import base64
import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo

_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$"
)


def php_tz() -> ZoneInfo:
    return ZoneInfo(os.environ.get('PHP_TIMEZONE', 'Europe/Berlin'))


def php_now() -> str:
    """date('Y-m-d H:i:s') in PHP's configured timezone."""
    return datetime.now(php_tz()).strftime('%Y-%m-%d %H:%M:%S')


def ucfirst(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def is_numeric(v) -> bool:
    """PHP is_numeric(): ints/floats (not bool), or numeric strings (leading whitespace allowed)."""
    if isinstance(v, bool) or v is None:
        return False
    if isinstance(v, (int, float)):
        return True
    if isinstance(v, str):
        return re.fullmatch(r'\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', v) is not None
    return False


def validate_email(s: str) -> bool:
    """Approximation of filter_var($s, FILTER_VALIDATE_EMAIL) (see parity tracker)."""
    return bool(s) and len(s) <= 254 and _EMAIL_RE.match(s) is not None


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4))


def mb_substr(s: str, start: int, length: int | None = None) -> str:
    return s[start:] if length is None else s[start:start + length]
```

`app/support/logger.py`:
```python
"""Mirror of the TS backend's Logger: everything to stderr AND logs/backend.log."""
from __future__ import annotations

import logging
from pathlib import Path

_LOG_DIR = Path(__file__).resolve().parent.parent.parent / 'logs'
_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger
    _LOG_DIR.mkdir(exist_ok=True)
    lg = logging.getLogger('gpt-backend-py')
    lg.setLevel(logging.INFO)
    fmt = logging.Formatter('[%(asctime)s] %(message)s', '%Y-%m-%d %H:%M:%S')
    fh = logging.FileHandler(_LOG_DIR / 'backend.log', encoding='utf-8')
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    lg.addHandler(fh)
    lg.addHandler(sh)
    lg.propagate = False
    _logger = lg
    return lg


def error_log(msg: str) -> None:
    """PHP error_log() equivalent."""
    get_logger().info(msg)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pytest tests/unit/test_config.py tests/unit/test_phpcompat.py -q`
Expected: 8 passed

- [ ] **Step 8: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): scaffold backend_python — env loading, ai_config mirror, PHP compat helpers"
```

### Task 2: SQL placeholder translation and the `Db` connection wrapper

**Files:**
- Create: `backend_python/app/support/sql.py`, `backend_python/app/db.py`
- Test: `backend_python/tests/unit/test_sql.py`, `backend_python/tests/unit/test_db.py`

**Interfaces:**
- Produces: `app.support.sql.translate(sql: str, params) -> tuple[str, list | dict | None]` — PDO `?` → `%s` (sequence params), `:name` → `%(name)s` (mapping params; keys may be given with or without the leading colon), literal `%` → `%%` whenever params are present.
- Produces: `app.db.Db` with `Db.connect(cfg: dict, timeout: int = 10) -> Db`; instance methods `fetch_one(sql, params=None) -> dict | None`, `fetch_all(sql, params=None) -> list[dict]`, `fetch_column(sql, params=None) -> list`, `execute(sql, params=None) -> int` (rowcount), `insert(sql, params=None) -> int` (lastrowid), `close()`; context-manager support. `app.db.normalize_value(v)` converts `datetime` → `'YYYY-MM-DD HH:MM:SS'`, `date` → `'YYYY-MM-DD'`, `Decimal` → `str`, `bytes` → utf-8 `str`, everything else unchanged. `app.db.open_primary(config) -> Db` uses `config['contexts_database'] or config['database']` (PHP: `$config['contexts_database'] ?? $config['database']`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_sql.py`:
```python
from app.support.sql import translate


def test_question_marks_become_pyformat():
    sql, p = translate('SELECT * FROM users WHERE email = ? AND id != ?', ['a@b.c', 3])
    assert sql == 'SELECT * FROM users WHERE email = %s AND id != %s'
    assert p == ['a@b.c', 3]


def test_named_params_with_and_without_colon_keys():
    sql, p = translate('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': 7})
    assert sql == 'SELECT role FROM users WHERE id = %(id)s LIMIT 1'
    assert p == {'id': 7}
    sql2, p2 = translate('UPDATE t SET a = :a WHERE b = :b', {'a': 1, 'b': 2})
    assert sql2 == 'UPDATE t SET a = %(a)s WHERE b = %(b)s' and p2 == {'a': 1, 'b': 2}


def test_percent_is_escaped_only_when_params_present():
    sql, _ = translate("SELECT * FROM t WHERE name LIKE '%x%' AND id = ?", [1])
    assert sql == "SELECT * FROM t WHERE name LIKE '%%x%%' AND id = %s"
    sql2, p2 = translate("SELECT * FROM t WHERE name LIKE '%x%'", None)
    assert sql2 == "SELECT * FROM t WHERE name LIKE '%x%'" and p2 is None


def test_time_literal_colon_is_not_a_param():
    sql, _ = translate("SELECT '12:30' AS t, :name", {'name': 'x'})
    assert sql == "SELECT '12:30' AS t, %(name)s"
```

`tests/unit/test_db.py`:
```python
from datetime import datetime, date
from decimal import Decimal
from app.db import normalize_value, normalize_row


def test_normalize_scalars_like_pdo():
    assert normalize_value(datetime(2026, 9, 5, 18, 40, 16)) == '2026-09-05 18:40:16'
    assert normalize_value(date(2026, 9, 5)) == '2026-09-05'
    assert normalize_value(Decimal('12.50')) == '12.50'
    assert normalize_value(b'abc') == 'abc'
    assert normalize_value(7) == 7 and normalize_value(None) is None and normalize_value('s') == 's'


def test_normalize_row_keeps_key_order():
    row = normalize_row({'id': 1, 'created_at': datetime(2026, 1, 2, 3, 4, 5), 'name': 'x'})
    assert list(row) == ['id', 'created_at', 'name']
    assert row['created_at'] == '2026-01-02 03:04:05'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_sql.py tests/unit/test_db.py -q`
Expected: ImportError

- [ ] **Step 3: Implement `app/support/sql.py`**

```python
"""PDO placeholder syntax → PyMySQL. The PHP code is ported with its SQL verbatim
(`?` and `:name`); this shim keeps the queries diffable against the PHP source."""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

# `:name` not preceded by a word char or another colon, and not inside quotes.
_NAMED = re.compile(r"(?<![\w:]):([A-Za-z_]\w*)")
_SPLIT_QUOTES = re.compile(r"('(?:[^']|'')*')")


def _outside_quotes(sql: str, fn) -> str:
    parts = _SPLIT_QUOTES.split(sql)
    return ''.join(p if i % 2 else fn(p) for i, p in enumerate(parts))


def translate(sql: str, params=None):
    if params is None:
        return sql, None
    sql = _outside_quotes(sql, lambda s: s.replace('%', '%%'))
    # `%` inside quoted literals must be escaped too (PyMySQL formats the whole string).
    sql = ''.join(p.replace('%', '%%') if i % 2 else p
                  for i, p in enumerate(_SPLIT_QUOTES.split(sql)))
    if isinstance(params, Mapping):
        clean = {k.lstrip(':'): v for k, v in params.items()}
        return _outside_quotes(sql, lambda s: _NAMED.sub(r'%(\1)s', s)), clean
    if isinstance(params, Sequence) and not isinstance(params, (str, bytes)):
        return _outside_quotes(sql, lambda s: s.replace('?', '%s')), list(params)
    raise TypeError(f'unsupported params type: {type(params)!r}')
```

- [ ] **Step 4: Implement `app/db.py`**

```python
"""One PyMySQL connection per request, PDO-like typing of result rows.

PHP (`PDO::ATTR_EMULATE_PREPARES => false`, mysqlnd) returns INT columns as int,
DECIMAL/DATETIME/TIMESTAMP/JSON as strings. PyMySQL returns datetime/Decimal
objects, so rows are normalized here before controllers see them.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pymysql
import pymysql.cursors

from app.support.sql import translate


def normalize_value(v):
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, date):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode('utf-8', errors='replace')
    return v


def normalize_row(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {k: normalize_value(v) for k, v in row.items()}


class Db:
    def __init__(self, conn: pymysql.connections.Connection):
        self._conn = conn

    @classmethod
    def connect(cls, cfg: dict, timeout: int = 10) -> 'Db':
        conn = pymysql.connect(
            host=cfg['host'], user=cfg['username'], password=cfg['password'],
            database=cfg['database'], charset=cfg.get('charset', 'utf8mb4'),
            port=int(cfg.get('port', 3306)), connect_timeout=timeout,
            cursorclass=pymysql.cursors.DictCursor, autocommit=True,
        )
        return cls(conn)

    def _run(self, sql, params):
        sql, params = translate(sql, params)
        cur = self._conn.cursor()
        cur.execute(sql, params)
        return cur

    def fetch_one(self, sql: str, params=None) -> dict | None:
        with self._run(sql, params) as cur:
            return normalize_row(cur.fetchone())

    def fetch_all(self, sql: str, params=None) -> list[dict]:
        with self._run(sql, params) as cur:
            return [normalize_row(r) for r in cur.fetchall()]

    def fetch_column(self, sql: str, params=None) -> list:
        with self._run(sql, params) as cur:
            return [normalize_value(next(iter(r.values()))) for r in cur.fetchall()]

    def execute(self, sql: str, params=None) -> int:
        with self._run(sql, params) as cur:
            return cur.rowcount

    def insert(self, sql: str, params=None) -> int:
        with self._run(sql, params) as cur:
            return int(cur.lastrowid or 0)

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def open_primary(config: dict) -> Db:
    """index.php: $config['contexts_database'] ?? $config['database']."""
    return Db.connect(config.get('contexts_database') or config['database'])
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/unit/test_sql.py tests/unit/test_db.py -q`
Expected: 6 passed

- [ ] **Step 6: Live connectivity smoke (no assertion in the suite; just verify the pool config works)**

Run:
```bash
python -c "
from app.config import load_config; from app.db import open_primary
c = load_config(); db = open_primary(c); print(db.fetch_one('SELECT COUNT(*) AS n FROM users')); db.close()"
```
Expected: `{'n': <int>}`

- [ ] **Step 7: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): Db wrapper with PDO-style placeholders and PHP-typed rows"
```

### Task 3: JSON encoder, `Ctx`, and the response renderer

**Files:**
- Create: `backend_python/app/support/phpjson.py`, `backend_python/app/support/http.py`
- Test: `backend_python/tests/unit/test_phpjson.py`, `backend_python/tests/unit/test_http.py`

**Interfaces:**
- Produces: `app.support.phpjson.dumps(obj) -> str` (`ensure_ascii=False`, compact separators `(',', ':')`, key order preserved; PHP `json_encode` default separators are also compact).
- Produces: `app.support.http.Ctx(dict)` with keys `method, uri, headers (starlette Headers, case-insensitive), query (dict), body (dict), raw_body (str), params (dict), user_id (None until auth), authenticated (False)`; `build_ctx(request: starlette Request, raw_body: bytes) -> Ctx`; `render(result: dict) -> starlette Response` implementing the `index.php` FOUND branch; `json_response(status: int, body: dict) -> JSONResponse`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_phpjson.py`:
```python
from app.support.phpjson import dumps


def test_clean_json_and_key_order():
    assert dumps({'b': 1, 'a': 'é/x'}) == '{"b":1,"a":"é/x"}'
    assert dumps([1, 2.5, None, True]) == '[1,2.5,null,true]'
```

`tests/unit/test_http.py`:
```python
import json
from starlette.requests import Request
from app.support.http import build_ctx, render


def _req(method='POST', path='/api/v1/auth', headers=None, query=b''):
    scope = {
        'type': 'http', 'method': method, 'path': path, 'query_string': query,
        'headers': [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        'client': ('127.0.0.1', 5555), 'server': ('localhost', 3002), 'scheme': 'http',
    }
    return Request(scope)


def test_build_ctx_mirrors_php_request_array():
    ctx = build_ctx(_req(headers={'Authorization': 'Bearer x'}, query=b'a=1&b=2'),
                    b'{"action":"login"}')
    assert ctx['method'] == 'POST' and ctx['uri'] == '/api/v1/auth'
    assert ctx['body'] == {'action': 'login'} and ctx['raw_body'] == '{"action":"login"}'
    assert ctx['query'] == {'a': '1', 'b': '2'}
    assert ctx['headers'].get('Authorization') == 'Bearer x'   # case-insensitive
    assert ctx['user_id'] is None and ctx['authenticated'] is False and ctx['params'] == {}


def test_invalid_json_body_becomes_empty_dict():
    assert build_ctx(_req(), b'not json')['body'] == {}
    assert build_ctx(_req(), b'')['body'] == {}
    assert build_ctx(_req(), b'[1,2]')['body'] == {}   # PHP controllers index by key; a list is treated as {}


def test_base_path_is_stripped():
    assert build_ctx(_req(path='/gpt/backend/api/v1/auth'), b'')['uri'] == '/api/v1/auth'


def test_render_json_strips_transport_keys():
    r = render({'success': True, 'x': 1, 'status_code': 201, 'content_type': 'application/json'})
    assert r.status_code == 201
    assert json.loads(r.body) == {'success': True, 'x': 1}
    assert r.headers['content-type'].startswith('application/json')


def test_render_html_plain_and_raw():
    r = render({'content_type': 'text/html; charset=utf-8', 'html': '<b>x</b>', 'status_code': 200})
    assert r.body == b'<b>x</b>' and r.headers['content-type'] == 'text/html; charset=utf-8'
    assert r.headers['cache-control'] == 'no-cache'
    r2 = render({'content_type': 'text/plain', 'error': 'boom', 'status_code': 400})
    assert r2.body == b'boom' and r2.status_code == 400
    r3 = render({'raw_body': b'PK..', 'headers': {'Content-Type': 'application/zip', 'X-A': '1'}})
    assert r3.body == b'PK..' and r3.headers['x-a'] == '1' and r3.headers['content-type'] == 'application/zip'


def test_render_streaming_handled_returns_none():
    assert render({'streaming_handled': True}) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_phpjson.py tests/unit/test_http.py -q`
Expected: ImportError

- [ ] **Step 3: Implement `app/support/phpjson.py`**

```python
"""JSON output. PHP json_encode() defaults escape '/' and non-ASCII and print
full-precision floats; the TS port and this port emit clean JSON instead
(parity tracker B.18: cosmetic, every JSON consumer decodes identically)."""
import json


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
```

- [ ] **Step 4: Implement `app/support/http.py`**

```python
"""PHP `$request` array + index.php response conventions."""
from __future__ import annotations

import json
from urllib.parse import parse_qsl

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.support.phpjson import dumps

BASE_PATH = '/gpt/backend'   # MiddlewareProcessor::buildRequest strips this prefix


class Ctx(dict):
    """dict subclass so ported code reads request['body'] exactly like PHP."""


class PhpJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        return dumps(content).encode('utf-8')


def json_response(status: int, body: dict, headers: dict | None = None) -> PhpJSONResponse:
    return PhpJSONResponse(body, status_code=status, headers=headers)


def build_ctx(request: Request, raw_body: bytes) -> Ctx:
    uri = request.url.path
    if uri.startswith(BASE_PATH):
        uri = uri[len(BASE_PATH):]
    if not uri or uri[0] != '/':
        uri = '/' + uri
    raw = raw_body.decode('utf-8', errors='replace')
    try:
        body = json.loads(raw) if raw else {}
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    # PHP $_GET: last value wins for repeated keys (arrays via foo[] are not used by this API)
    query = dict(parse_qsl(request.url.query, keep_blank_values=True))
    return Ctx(
        method=request.method,
        uri=uri,
        headers=request.headers,
        query=query,
        body=body,
        raw_body=raw,
        params={},
        user_id=None,
        authenticated=False,
        remote_addr=(request.client.host if request.client else ''),
    )


def render(result: dict) -> Response | None:
    """The FOUND branch of index.php. Returns None when the controller already streamed."""
    status = int(result.get('status_code', 200))
    if result.get('streaming_handled') is True:
        return None
    ctype = result.get('content_type')
    if isinstance(ctype, str) and 'text/html' in ctype:
        body = result.get('html', result.get('error', ''))
        return Response(content=body, status_code=status,
                        headers={'Cache-Control': 'no-cache'}, media_type=None,
                        ) if False else _raw(body, status, {'Content-Type': ctype, 'Cache-Control': 'no-cache'})
    if ctype == 'text/plain':
        return _raw(result.get('error', 'Unknown error'), status, {'Content-Type': 'text/plain'})
    if 'raw_body' in result:
        return _raw(result['raw_body'], status, dict(result.get('headers') or {}))
    body = {k: v for k, v in result.items() if k not in ('status_code', 'content_type')}
    return json_response(status, body)


def _raw(content, status: int, headers: dict) -> Response:
    if isinstance(content, str):
        content = content.encode('utf-8')
    return Response(content=content, status_code=status, headers=headers, media_type=None)
```

Simplify the html branch to a single `return _raw(...)` call (the `if False` form above is a reminder to NOT let Starlette add its own `content-type`; `_raw` passes `media_type=None` and sets the header explicitly). Final html branch:

```python
    if isinstance(ctype, str) and 'text/html' in ctype:
        body = result.get('html', result.get('error', ''))
        return _raw(body, status, {'Content-Type': ctype, 'Cache-Control': 'no-cache'})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/unit/test_phpjson.py tests/unit/test_http.py -q`
Expected: 7 passed

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): Ctx builder, index.php response renderer, clean JSON encoder"
```

### Task 4: FastRoute-compatible dispatcher

**Files:**
- Create: `backend_python/app/support/router.py`
- Test: `backend_python/tests/unit/test_router.py`

**Interfaces:**
- Produces: `app.support.router.Dispatcher(routes: list[tuple[str, str, tuple[str, str]]])` where each route is `(method, pattern, (controller_name, method_name))` and pattern uses FastRoute syntax: `{id:\d+}`, `{key}` (default `[^/]+`). `dispatch(method, uri) -> DispatchResult` with `status` in `{'FOUND','NOT_FOUND','METHOD_NOT_ALLOWED'}`, `handler` (the tuple) and `params: dict[str, str]` when found, `allowed: list[str]` when method not allowed. First matching route wins (FastRoute registration order).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_router.py`:
```python
from app.support.router import Dispatcher

ROUTES = [
    ('GET', '/', ('RootController', 'index')),
    ('POST', '/api/v1/auth', ('AuthController', 'handleAction')),
    ('GET', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'get')),
    ('PUT', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'update')),
    ('GET', '/api/v1/admin/llm-settings/{key}', ('SystemSettingsController', 'getLLMProvider')),
    ('GET', '/api/v1/workflows/runs/{runId:[a-f0-9]{32}}/events', ('AgentTeam:WorkflowController', 'runEvents')),
    ('GET', '/api/v1/workflows/{id:\\d+}/outputs/{filename}', ('AgentTeam:WorkflowController', 'getOutput')),
]


def test_found_with_typed_params():
    d = Dispatcher(ROUTES)
    r = d.dispatch('GET', '/api/v1/prompts/42')
    assert r.status == 'FOUND' and r.handler == ('PromptLibraryController', 'get') and r.params == {'id': '42'}
    r2 = d.dispatch('GET', '/api/v1/workflows/7/outputs/report.md')
    assert r2.params == {'id': '7', 'filename': 'report.md'}
    r3 = d.dispatch('GET', '/api/v1/workflows/runs/' + 'a' * 32 + '/events')
    assert r3.status == 'FOUND' and r3.params == {'runId': 'a' * 32}


def test_not_found_and_method_not_allowed():
    d = Dispatcher(ROUTES)
    assert d.dispatch('GET', '/api/v1/prompts/abc').status == 'NOT_FOUND'
    r = d.dispatch('DELETE', '/api/v1/prompts/42')
    assert r.status == 'METHOD_NOT_ALLOWED' and sorted(r.allowed) == ['GET', 'PUT']
    assert d.dispatch('GET', '/nope').status == 'NOT_FOUND'
    assert d.dispatch('GET', '/').status == 'FOUND'


def test_head_is_not_get():
    # FastRoute treats HEAD as GET fallback; index.php never receives HEAD from the frontend.
    # Mirror FastRoute: HEAD matches a GET route.
    d = Dispatcher(ROUTES)
    assert d.dispatch('HEAD', '/').status == 'FOUND'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_router.py -q`
Expected: ImportError

- [ ] **Step 3: Implement `app/support/router.py`**

```python
"""Minimal FastRoute equivalent: same pattern syntax, same FOUND / NOT_FOUND /
METHOD_NOT_ALLOWED outcomes, first-registered route wins."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_PLACEHOLDER = re.compile(r'\{(\w+)(?::([^{}]*(?:\{[^{}]*\}[^{}]*)*))?\}')


@dataclass
class DispatchResult:
    status: str
    handler: tuple[str, str] | None = None
    params: dict[str, str] = field(default_factory=dict)
    allowed: list[str] = field(default_factory=list)


def compile_pattern(pattern: str) -> re.Pattern:
    out, pos = [], 0
    for m in _PLACEHOLDER.finditer(pattern):
        out.append(re.escape(pattern[pos:m.start()]))
        name, rx = m.group(1), m.group(2) or '[^/]+'
        out.append(f'(?P<{name}>{rx})')
        pos = m.end()
    out.append(re.escape(pattern[pos:]))
    return re.compile('^' + ''.join(out) + '$')


class Dispatcher:
    def __init__(self, routes):
        self._routes = [(method.upper(), compile_pattern(p), p, handler) for method, p, handler in routes]

    def dispatch(self, method: str, uri: str) -> DispatchResult:
        method = method.upper()
        allowed: list[str] = []
        for m, rx, _raw, handler in self._routes:
            match = rx.match(uri)
            if not match:
                continue
            if m == method or (method == 'HEAD' and m == 'GET'):
                return DispatchResult('FOUND', handler, match.groupdict())
            if m not in allowed:
                allowed.append(m)
        if allowed:
            return DispatchResult('METHOD_NOT_ALLOWED', allowed=allowed)
        return DispatchResult('NOT_FOUND')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/test_router.py -q`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): FastRoute-compatible dispatcher"
```

### Task 5: CORS + Auth middleware + MiddlewareProcessor + AppKeyRepository

**Files:**
- Create: `backend_python/app/middleware/__init__.py`, `backend_python/app/middleware/cors.py`, `backend_python/app/middleware/auth.py`, `backend_python/app/middleware/processor.py`
- Create: `backend_python/app/agent_team/__init__.py`, `backend_python/app/agent_team/services/__init__.py`, `backend_python/app/agent_team/services/app_key_repository.py`
- Test: `backend_python/tests/unit/test_middleware.py`, `backend_python/tests/unit/test_app_key_repository.py`

**Interfaces:**
- Consumes: `Ctx` (Task 3), `Db` (Task 2).
- Produces: `CorsMiddleware(config: dict).headers() -> dict[str,str]` and `.handle(ctx) -> dict | None` (returns `{'status_code': 204, 'headers': {}, 'body': ''}` for OPTIONS).
- Produces: `AuthMiddleware(jwt_secret: str, public_routes: list[dict], config: dict, db_factory: Callable[[], Db])` with `.handle(ctx) -> Ctx | dict` — on failure returns `{'error': True, 'status_code': 401, 'body': {'success': False, 'message': ...}}`; on success returns the ctx with `user_id`, `auth_type` (`'jwt' | 'user_app_key' | 'app_key'`), `authenticated`, and for `app_key` also `app_key_id, application_id, app_key_scopes`. Static helpers `user_app_key_pepper(config, jwt_secret) -> str` and `hash_user_app_key(key, pepper) -> str` (used by `AuthController` in Task 7).
- Produces: `MiddlewareProcessor(config, db_factory).process(ctx) -> dict` (`{'handled': True, 'response': {...}}` or `{'handled': False, 'request': ctx}`), `PUBLIC_ROUTES` constant, `.cors` attribute.
- Produces: `AppKeyRepository(db: Db, server_secret: str)` with `create(user_id, application_id, name, scopes) -> dict`, `findByKey(full_key) -> dict | None`, `recordUse(key_id)`, `revoke(key_id) -> bool`, `listAll(application_id=None, user_id=None) -> list`, `findById(key_id) -> dict | None` (camelCase kept from PHP).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_middleware.py`:
```python
import hashlib, hmac, time
import jwt
import pytest
from starlette.datastructures import Headers
from app.support.http import Ctx
from app.middleware.cors import CorsMiddleware
from app.middleware.auth import AuthMiddleware, user_app_key_pepper, hash_user_app_key
from app.middleware.processor import MiddlewareProcessor, PUBLIC_ROUTES

SECRET = 'test-secret'
CONFIG = {'auth': {'jwt_secret': SECRET, 'app_key_secret': 'ak-secret'}, 'contexts_database': {}}


class FakeDb:
    """Records queries; answers fetch_one from a canned list."""
    def __init__(self, rows=None):
        self.rows = list(rows or []); self.calls = []
    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params)); return self.rows.pop(0) if self.rows else None
    def execute(self, sql, params=None):
        self.calls.append((sql, params)); return 1
    def close(self): pass


def ctx(method='GET', uri='/api/v1/prompts', auth=None):
    h = Headers({'authorization': auth} if auth else {})
    return Ctx(method=method, uri=uri, headers=h, query={}, body={}, raw_body='', params={},
               user_id=None, authenticated=False, remote_addr='')


def token(sub=3, exp_delta=3600, secret=SECRET):
    now = int(time.time())
    return jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + exp_delta, 'sub': sub, 'type': 'access'},
                      secret, algorithm='HS256')


def test_cors_headers_and_options():
    c = CorsMiddleware({})
    assert c.headers() == {'Access-Control-Allow-Origin': '*',
                           'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                           'Access-Control-Allow-Headers': 'Content-Type, Authorization'}
    assert c.handle(ctx('OPTIONS')) == {'status_code': 204, 'headers': {}, 'body': ''}
    assert c.handle(ctx('GET')) is None


def test_protected_route_without_header_is_401():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    assert a.handle(ctx()) == {'error': True, 'status_code': 401,
                               'body': {'success': False, 'message': 'Authorization token required'}}


def test_bad_or_expired_jwt_is_401_invalid_credential():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx(auth='Bearer ' + token(exp_delta=-10)))
    assert r['body']['message'] == 'Invalid or expired credential'
    r2 = a.handle(ctx(auth='Bearer ' + token(secret='other')))
    assert r2['status_code'] == 401


def test_valid_jwt_sets_identity():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx(auth='Bearer ' + token(sub=3)))
    assert r['user_id'] == 3 and r['auth_type'] == 'jwt' and r['authenticated'] is True


def test_public_route_passes_without_auth_and_marks_identity_when_present():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx('POST', '/api/v1/auth'))
    assert r['user_id'] is None and r['authenticated'] is False
    r2 = a.handle(ctx('POST', '/api/v1/auth', auth='Bearer ' + token(sub=9)))
    assert r2['user_id'] == 9 and r2['authenticated'] is True
    # method matters: GET /api/v1/auth is NOT public
    assert a.handle(ctx('GET', '/api/v1/auth'))['status_code'] == 401


def test_uak_key_via_bearer_and_appkey_schemes():
    pepper = user_app_key_pepper(CONFIG, SECRET)
    assert pepper == hmac.new(SECRET.encode(), b'user_app_key.v1', hashlib.sha256).hexdigest()
    key = 'uak_' + 'ab' * 16
    db = FakeDb(rows=[{'id': 5}, {'id': 5}])
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: db)
    r = a.handle(ctx(auth='Bearer ' + key))
    assert r['user_id'] == 5 and r['auth_type'] == 'user_app_key'
    r2 = a.handle(ctx(auth='AppKey ' + key))
    assert r2['user_id'] == 5 and r2['auth_type'] == 'user_app_key'
    assert db.calls[0][1] == [hash_user_app_key(key, pepper)]


def test_ak_app_key_scheme_uses_repository():
    full = 'ak_' + '0f' * 16
    h = hmac.new(b'ak-secret', full.encode(), hashlib.sha256).hexdigest()
    row = {'id': 11, 'user_id': 3, 'application_id': 'geoapps', 'name': 'n', 'key_prefix': full[:12],
           'key_hash': h, 'scopes': '["run"]', 'created_at': 'x', 'last_used_at': None, 'revoked_at': None}
    db = FakeDb(rows=[row])
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: db)
    r = a.handle(ctx(auth='AppKey ' + full))
    assert r['user_id'] == 3 and r['auth_type'] == 'app_key' and r['app_key_id'] == 11
    assert r['application_id'] == 'geoapps' and r['app_key_scopes'] == ['run']
    assert any('last_used_at = NOW()' in c[0] for c in db.calls)   # recordUse


def test_processor_short_circuits_options_and_401():
    p = MiddlewareProcessor(CONFIG, lambda: FakeDb())
    assert p.process(ctx('OPTIONS'))['handled'] is True
    r = p.process(ctx())
    assert r['handled'] is True and r['response']['status_code'] == 401
    ok = p.process(ctx(auth='Bearer ' + token()))
    assert ok['handled'] is False and ok['request']['user_id'] == 3


def test_processor_fails_closed_without_secret():
    with pytest.raises(RuntimeError, match='JWT secret is not configured'):
        MiddlewareProcessor({'auth': {'jwt_secret': ''}}, lambda: FakeDb())
```

`tests/unit/test_app_key_repository.py`:
```python
import hashlib, hmac
import pytest
from app.agent_team.services.app_key_repository import AppKeyRepository


class FakeDb:
    def __init__(self, row=None): self.row = row; self.calls = []
    def fetch_one(self, sql, params=None): self.calls.append((sql, params)); return self.row
    def execute(self, sql, params=None): self.calls.append((sql, params)); return 1


def test_requires_secret():
    with pytest.raises(RuntimeError):
        AppKeyRepository(FakeDb(), '')


def test_find_by_key_rejects_bad_prefix_and_hash_mismatch():
    repo = AppKeyRepository(FakeDb(), 's')
    assert repo.findByKey('uak_xyz') is None
    assert repo.findByKey('ak_short') is None
    full = 'ak_' + 'aa' * 16
    db = FakeDb({'id': 1, 'user_id': 2, 'key_hash': 'nope', 'scopes': '[]', 'application_id': 'a',
                 'name': 'n', 'key_prefix': full[:12], 'created_at': 'c', 'last_used_at': None, 'revoked_at': None})
    assert AppKeyRepository(db, 's').findByKey(full) is None


def test_find_by_key_success_strips_hash_and_decodes_scopes():
    full = 'ak_' + 'aa' * 16
    h = hmac.new(b's', full.encode(), hashlib.sha256).hexdigest()
    db = FakeDb({'id': '1', 'user_id': '2', 'key_hash': h, 'scopes': '["a","b"]', 'application_id': 'app',
                 'name': 'n', 'key_prefix': full[:12], 'created_at': 'c', 'last_used_at': None, 'revoked_at': None})
    row = AppKeyRepository(db, 's').findByKey(full)
    assert row['id'] == 1 and row['user_id'] == 2 and row['scopes'] == ['a', 'b'] and 'key_hash' not in row
    assert db.calls[0][1] == {':prefix': full[:12]}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_middleware.py tests/unit/test_app_key_repository.py -q`
Expected: ImportError

- [ ] **Step 3: Implement `app/agent_team/services/app_key_repository.py`**

```python
"""Port of backend/src/AgentTeam/Services/AppKeyRepository.php."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets

from app.support.logger import error_log
from app.support.phpcompat import php_now

KEY_BYTES = 16
PREFIX_LEN = 12


class AppKeyRepository:
    def __init__(self, db, server_secret: str):
        if server_secret == '':
            raise RuntimeError('AppKeyRepository: app_key_secret is not configured.')
        self.db = db
        self.server_secret = server_secret

    def create(self, user_id: int, application_id: str, name: str, scopes: list) -> dict:
        full_key = 'ak_' + secrets.token_bytes(KEY_BYTES).hex()
        prefix = full_key[:PREFIX_LEN]
        key_id = self.db.insert(
            "INSERT INTO app_keys (user_id, application_id, name, key_prefix, key_hash, scopes)"
            " VALUES (:user_id, :application_id, :name, :key_prefix, :key_hash, :scopes)",
            {':user_id': user_id, ':application_id': application_id, ':name': name,
             ':key_prefix': prefix, ':key_hash': self._hash(full_key),
             ':scopes': json.dumps(list(scopes), separators=(',', ':'))})
        return {'id': key_id, 'user_id': user_id, 'application_id': application_id, 'name': name,
                'key_prefix': prefix, 'scopes': list(scopes), 'full_key': full_key, 'created_at': php_now()}

    def findByKey(self, full_key: str) -> dict | None:
        full_key = full_key.strip()
        if not full_key.startswith('ak_') or len(full_key) < PREFIX_LEN:
            return None
        row = self.db.fetch_one(
            "SELECT id, user_id, application_id, name, key_prefix, key_hash, scopes,"
            " created_at, last_used_at, revoked_at FROM app_keys"
            " WHERE key_prefix = :prefix AND revoked_at IS NULL LIMIT 1",
            {':prefix': full_key[:PREFIX_LEN]})
        if not row:
            return None
        if not hmac.compare_digest(str(row['key_hash']), self._hash(full_key)):
            return None
        row = dict(row)
        del row['key_hash']
        row['scopes'] = self._decode_scopes(row['scopes'])
        row['id'] = int(row['id'])
        row['user_id'] = int(row['user_id'])
        return row

    def recordUse(self, key_id: int) -> None:
        try:
            self.db.execute("UPDATE app_keys SET last_used_at = NOW() WHERE id = ?", [key_id])
        except Exception as e:  # noqa: BLE001
            error_log(f'[AppKeyRepository] recordUse failed: {e}')

    def revoke(self, key_id: int) -> bool:
        return self.db.execute("UPDATE app_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL",
                               [key_id]) > 0

    def listAll(self, application_id: str | None = None, user_id: int | None = None) -> list:
        sql = ("SELECT id, user_id, application_id, name, key_prefix, scopes, created_at, last_used_at, revoked_at"
               " FROM app_keys WHERE 1=1")
        params: dict = {}
        if application_id is not None:
            sql += " AND application_id = :application_id"; params[':application_id'] = application_id
        if user_id is not None:
            sql += " AND user_id = :user_id"; params[':user_id'] = user_id
        sql += " ORDER BY created_at DESC"
        rows = self.db.fetch_all(sql, params) if params else self.db.fetch_all(sql, {})
        for r in rows:
            r['id'] = int(r['id']); r['user_id'] = int(r['user_id']); r['scopes'] = self._decode_scopes(r['scopes'])
        return rows

    def findById(self, key_id: int) -> dict | None:
        row = self.db.fetch_one(
            "SELECT id, user_id, application_id, name, key_prefix, scopes, created_at, last_used_at, revoked_at"
            " FROM app_keys WHERE id = ? LIMIT 1", [key_id])
        if not row:
            return None
        row['id'] = int(row['id']); row['user_id'] = int(row['user_id']); row['scopes'] = self._decode_scopes(row['scopes'])
        return row

    def _hash(self, full_key: str) -> str:
        return hmac.new(self.server_secret.encode(), full_key.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _decode_scopes(raw) -> list:
        if isinstance(raw, list):
            return raw
        try:
            decoded = json.loads(str(raw))
        except ValueError:
            return []
        return decoded if isinstance(decoded, list) else []
```

Note: `translate()` requires a non-None params object to substitute `:name`; `listAll` passes `{}` when no filters so `%%` escaping stays consistent (there are no `%` in that SQL anyway).

- [ ] **Step 4: Implement `app/middleware/cors.py`**

```python
"""Port of CorsMiddleware.php. Headers are applied to EVERY response by main.py."""
from __future__ import annotations


class CorsMiddleware:
    def __init__(self, config: dict | None = None):
        config = config or {}
        self.allowed_origins = config.get('allowed_origins', ['*'])
        self.allowed_methods = config.get('allowed_methods', ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
        self.allowed_headers = config.get('allowed_headers', ['Content-Type', 'Authorization'])

    def handle(self, ctx) -> dict | None:
        if ctx['method'] == 'OPTIONS':
            return {'status_code': 204, 'headers': {}, 'body': ''}
        return None

    def headers(self, request_origin: str = '') -> dict:
        return {
            'Access-Control-Allow-Origin': self._origin(request_origin),
            'Access-Control-Allow-Methods': ', '.join(self.allowed_methods),
            'Access-Control-Allow-Headers': ', '.join(self.allowed_headers),
        }

    def _origin(self, request_origin: str) -> str:
        if '*' in self.allowed_origins:
            return '*'
        if request_origin in self.allowed_origins:
            return request_origin
        return self.allowed_origins[0] if self.allowed_origins else '*'
```

- [ ] **Step 5: Implement `app/middleware/auth.py`**

```python
"""Port of AuthMiddleware.php: JWT bearer, per-user `uak_` keys (Bearer or AppKey
scheme), and application `ak_` keys (AppKey scheme, via AppKeyRepository)."""
from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Callable

import jwt

from app.agent_team.services.app_key_repository import AppKeyRepository
from app.support.logger import error_log

_BEARER = re.compile(r'^Bearer\s+(.+)$', re.I)
_APPKEY = re.compile(r'^AppKey\s+(.+)$', re.I)


def user_app_key_pepper(config: dict, jwt_secret: str) -> str:
    explicit = str((config.get('auth') or {}).get('user_app_key_secret', '') or '')
    if explicit:
        return explicit
    return hmac.new(jwt_secret.encode(), b'user_app_key.v1', hashlib.sha256).hexdigest()


def hash_user_app_key(key: str, pepper: str) -> str:
    return hmac.new(pepper.encode(), key.encode(), hashlib.sha256).hexdigest()


def decode_hs256(token: str, secret: str) -> dict | None:
    """firebase/php-jwt JWT::decode(token, Key(secret,'HS256')) equivalent: verifies
    signature + exp/nbf/iat; returns claims or None."""
    try:
        return jwt.decode(token, secret, algorithms=['HS256'], options={'require': []})
    except jwt.PyJWTError:
        return None


class AuthMiddleware:
    def __init__(self, jwt_secret: str, public_routes: list[dict], config: dict, db_factory: Callable):
        self.jwt_secret = jwt_secret
        self.public_routes = public_routes
        self.config = config
        self._db_factory = db_factory
        self._db = None

    def handle(self, ctx):
        is_public = self._is_public_route(ctx['uri'], ctx['method'])
        auth = self._extract_auth(ctx['headers'])
        identity = None
        if auth is not None:
            if auth['scheme'] == 'bearer':
                if auth['token'].startswith('uak_'):
                    uid = self._validate_user_app_key(auth['token'])
                    if uid is not None:
                        identity = {'user_id': uid, 'auth_type': 'user_app_key'}
                else:
                    uid = self._validate_token(auth['token'])
                    if uid is not None:
                        identity = {'user_id': uid, 'auth_type': 'jwt'}
            elif auth['scheme'] == 'appkey':
                if auth['token'].startswith('uak_'):
                    uid = self._validate_user_app_key(auth['token'])
                    if uid is not None:
                        identity = {'user_id': uid, 'auth_type': 'user_app_key'}
                else:
                    row = self._validate_app_key(auth['token'])
                    if row is not None:
                        identity = {'user_id': int(row['user_id']), 'auth_type': 'app_key',
                                    'app_key_id': int(row['id']), 'application_id': row['application_id'],
                                    'app_key_scopes': row['scopes']}
        if is_public:
            if identity is not None:
                ctx.update(identity)
            else:
                ctx['user_id'] = None
            ctx['authenticated'] = identity is not None
            return ctx
        if auth is None:
            return self._error(401, 'Authorization token required')
        if identity is None:
            return self._error(401, 'Invalid or expired credential')
        ctx.update(identity)
        ctx['authenticated'] = True
        return ctx

    def _is_public_route(self, uri: str, method: str) -> bool:
        for route in self.public_routes:
            pattern = route['pattern'].replace('*', '.*')
            methods = route.get('methods', ['GET', 'POST', 'PUT', 'DELETE'])
            if re.match(f'^{pattern}$', uri) and method in methods:
                return True
        return False

    @staticmethod
    def _extract_auth(headers) -> dict | None:
        value = headers.get('Authorization') or headers.get('authorization') or ''
        m = _BEARER.match(value)
        if m:
            return {'scheme': 'bearer', 'token': m.group(1).strip()}
        m = _APPKEY.match(value)
        if m:
            return {'scheme': 'appkey', 'token': m.group(1).strip()}
        return None

    def _validate_token(self, token: str) -> int | None:
        claims = decode_hs256(token, self.jwt_secret)
        if claims is None:
            error_log('[AuthMiddleware] JWT validation failed')
            return None
        return int(claims['sub']) if 'sub' in claims else None

    def _validate_app_key(self, key: str) -> dict | None:
        try:
            secret = str((self.config.get('auth') or {}).get('app_key_secret', '') or '')
            if secret == '':
                error_log('[AuthMiddleware] app_key_secret is not configured — app keys disabled.')
                return None
            repo = AppKeyRepository(self._get_db(), secret)
            row = repo.findByKey(key)
            if row is not None:
                repo.recordUse(int(row['id']))
            return row
        except Exception as e:  # noqa: BLE001
            error_log(f'[AuthMiddleware] app key validation error: {e}')
            return None

    def _validate_user_app_key(self, key: str) -> int | None:
        try:
            h = hash_user_app_key(key, user_app_key_pepper(self.config, self.jwt_secret))
            row = self._get_db().fetch_one('SELECT id FROM users WHERE app_key_hash = ? LIMIT 1', [h])
            return int(row['id']) if row else None
        except Exception as e:  # noqa: BLE001
            error_log(f'[AuthMiddleware] user app key validation error: {e}')
            return None

    def _get_db(self):
        if self._db is None:
            self._db = self._db_factory()
        return self._db

    @staticmethod
    def _error(status: int, message: str) -> dict:
        return {'error': True, 'status_code': status, 'body': {'success': False, 'message': message}}
```

- [ ] **Step 6: Implement `app/middleware/processor.py`**

```python
"""Port of MiddlewareProcessor.php (PUBLIC_ROUTES verbatim)."""
from __future__ import annotations

from collections.abc import Callable

from app.middleware.auth import AuthMiddleware
from app.middleware.cors import CorsMiddleware

PUBLIC_ROUTES = [
    {'pattern': '/api/v1/auth', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/login', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/register', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/firebase', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/verify', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/logout', 'methods': ['POST']},
    {'pattern': '/api/v1/evi/webhook', 'methods': ['POST']},
    {'pattern': '/api/v1/mcp/app', 'methods': ['GET']},
    {'pattern': '/api/mcp-app.php', 'methods': ['GET']},
    {'pattern': '/api/v1/scheduler/run', 'methods': ['POST']},
    {'pattern': '/api/v1/webauthn/challenge', 'methods': ['POST']},
    {'pattern': '/api/v1/webauthn/authenticate', 'methods': ['POST']},
    {'pattern': '/api/v1/models/catalog', 'methods': ['GET']},
    {'pattern': '/', 'methods': ['GET']},
]


class MiddlewareProcessor:
    def __init__(self, config: dict, db_factory: Callable):
        self.config = config
        self.cors = CorsMiddleware(config.get('cors') or {})
        jwt_secret = str((config.get('auth') or {}).get('jwt_secret', '') or '')
        if jwt_secret == '':
            raise RuntimeError('JWT secret is not configured (set JWT_SECRET).')
        self.auth = AuthMiddleware(jwt_secret, PUBLIC_ROUTES, config, db_factory)

    def process(self, ctx) -> dict:
        cors = self.cors.handle(ctx)
        if cors is not None:
            return {'handled': True, 'response': cors}
        result = self.auth.handle(ctx)
        if isinstance(result, dict) and result.get('error') is True and 'body' in result and not isinstance(result, type(ctx)):
            return {'handled': True, 'response': result}
        return {'handled': False, 'request': result}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pytest tests/unit/test_middleware.py tests/unit/test_app_key_repository.py -q`
Expected: 12 passed

- [ ] **Step 8: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): CORS + auth middleware (JWT, uak_, ak_) and AppKeyRepository"
```

### Task 6: `main.py` pipeline, route table, RootController, ModelCatalogController, differential harness

**Files:**
- Create: `backend_python/main.py`, `backend_python/run.sh`, `backend_python/app/routes.py`
- Create: `backend_python/app/controllers/__init__.py`, `backend_python/app/controllers/root_controller.py`, `backend_python/app/controllers/model_catalog_controller.py`
- Create: `backend_python/resources/model_catalog.json` (copy)
- Create: `backend_python/tests/conftest.py`, `backend_python/tests/differential/conftest.py`
- Test: `backend_python/tests/unit/test_app_pipeline.py`, `backend_python/tests/differential/test_public.py`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `main.create_app(config: dict | None = None) -> FastAPI`; module-level `app`. `app.routes.ROUTES: list[(method, pattern, (controller, method))]` in the same order as `routes.php`; `app.routes.CONTROLLERS: dict[str, type]` keyed by the PHP handler name (`'AuthController'`, `'AgentTeam:TeamController'`, ...). Controllers are constructed as `Controller(db: Db, config: dict)` and methods are called as `method(ctx, *params)` with numeric params cast to `int` (index.php: `is_numeric($v) ? (int)$v : $v`), and `ctx['params']` set to the raw route params.
- Produces (tests): `tests/conftest.py` fixture `client` (FastAPI `TestClient` over the real DB config); `tests/differential/conftest.py` fixtures `php` (base URL `http://localhost/gpt/backend`), `py` (TestClient), `token` (HS256 JWT for `DIFF_USER_ID`, default 3, minted with the shared secret), `both(method, path, json=None, headers=None) -> (php_resp, py_resp)` helper with `.status_code` and `.json()`; auto-skip of the whole `differential` marker when `GET {php}/` is not 200.

- [ ] **Step 1: Write the failing pipeline tests**

`tests/conftest.py`:
```python
import os
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope='session')
def config():
    from app.config import load_config
    return load_config()


@pytest.fixture(scope='session')
def client(config):
    from main import create_app
    return TestClient(create_app(config))
```

`tests/unit/test_app_pipeline.py`:
```python
import time
import jwt


def test_health_is_public_and_returns_root_payload(client):
    r = client.get('/')
    assert r.status_code == 200
    body = r.json()
    assert body['success'] is True and body['message'] == 'GPT Chat Backend API' and body['version'] == '2.0.0'
    assert body['endpoints']['drive'] == '/api/v1/drive/*'
    assert 'status_code' not in body
    assert r.headers['access-control-allow-origin'] == '*'


def test_options_preflight_204_with_cors_headers(client):
    r = client.options('/api/v1/prompts')
    assert r.status_code == 204 and r.headers['access-control-allow-methods'] == 'GET, POST, PUT, DELETE, OPTIONS'


def test_unknown_route_404_envelope(client):
    r = client.get('/api/v1/does-not-exist', headers={'Authorization': 'Bearer nope'})
    # auth runs first: an invalid token on a protected URI is 401 before routing (same as PHP)
    assert r.status_code == 401
    r2 = client.get('/api/v1/does-not-exist', headers=_auth(client))
    assert r2.status_code == 404 and r2.json() == {'success': False, 'error': 'Endpoint not found',
                                                    'uri': '/api/v1/does-not-exist'}


def test_method_not_allowed_405(client):
    r = client.patch('/api/v1/prompts', headers=_auth(client))
    assert r.status_code == 405
    assert r.json()['error'] == 'Method not allowed' and set(r.json()['allowed_methods']) == {'GET', 'POST'}


def test_protected_route_without_token_401_message_envelope(client):
    r = client.get('/api/v1/prompts')
    assert r.status_code == 401 and r.json() == {'success': False, 'message': 'Authorization token required'}


def test_model_catalog_public(client):
    r = client.get('/api/v1/models/catalog')
    assert r.status_code == 200 and r.json()['success'] is True and isinstance(r.json()['providers'], dict | list)


def _auth(client):
    from app.config import load_config
    secret = load_config()['auth']['jwt_secret']
    now = int(time.time())
    tok = jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 600, 'sub': 3, 'type': 'access'}, secret, 'HS256')
    return {'Authorization': f'Bearer {tok}'}
```

Note: the 404 test hits a protected URI; PHP's middleware runs before routing, so an unknown protected path without a valid token is 401, and with a valid token is 404. The test encodes both.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_app_pipeline.py -q`
Expected: ImportError (`main`)

- [ ] **Step 3: Implement the two controllers**

`app/controllers/__init__.py`: empty.

`app/controllers/root_controller.py`:
```python
"""Port of Controllers/RootController.php."""


class RootController:
    def __init__(self, db, config):
        self.db = db
        self.config = config

    def index(self, request):
        return {
            'success': True,
            'message': 'GPT Chat Backend API',
            'version': '2.0.0',
            'architecture': 'MVC with FastRoute',
            'endpoints': {
                'auth': '/api/v1/auth/*', 'chat': '/api/v1/chat', 'contexts': '/api/v1/contexts',
                'providers': '/api/v1/providers', 'settings': '/api/v1/settings/*', 'usage': '/api/v1/usage/*',
                'prompts': '/api/v1/prompts', 'admin': '/api/v1/admin/*', 'mcp': '/api/v1/mcp/*',
                'hume': '/api/v1/hume/*', 'evi': '/api/v1/evi/*', 'drive': '/api/v1/drive/*',
            },
            'status_code': 200,
        }
```

`app/controllers/model_catalog_controller.py`:
```python
"""Port of Controllers/ModelCatalogController.php (public; reads resources/model_catalog.json)."""
import json
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parent.parent.parent / 'resources' / 'model_catalog.json'


class ModelCatalogController:
    def __init__(self, db, config):
        pass

    def get(self, request):
        if not CATALOG_PATH.is_file():
            return {'success': False, 'error': 'Model catalog file not found', 'status_code': 500}
        try:
            raw = CATALOG_PATH.read_text(encoding='utf-8')
        except OSError:
            return {'success': False, 'error': 'Failed to read model catalog', 'status_code': 500}
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get('providers'), (dict, list)):
            return {'success': False, 'error': 'Model catalog is malformed', 'status_code': 500}
        return {'success': True, 'providers': data['providers'], 'updated': data.get('_updated')}
```

Copy the resource: `cp ../backend/resources/model_catalog.json resources/` (create `resources/` first). Keep it a copy, as the TS port does; Task 13's README notes it must be re-copied when PHP's changes.

- [ ] **Step 4: Write `app/routes.py`**

Only the Phase 1 rows are registered now; later phases append rows in `routes.php` order. Keep the PHP section comments so the file diffs cleanly against `routes.php`.

```python
"""Route table — mirrors backend/src/routes.php (same order, same handler names).
Rows for controllers not yet ported are added phase by phase."""
from app.controllers.auth_controller import AuthController
from app.controllers.context_controller import ContextController
from app.controllers.model_catalog_controller import ModelCatalogController
from app.controllers.package_controller import PackageController
from app.controllers.prompt_library_controller import PromptLibraryController
from app.controllers.root_controller import RootController
from app.controllers.webauthn_controller import WebAuthnController

CONTROLLERS = {
    'AuthController': AuthController,
    'ContextController': ContextController,
    'ModelCatalogController': ModelCatalogController,
    'PackageController': PackageController,
    'PromptLibraryController': PromptLibraryController,
    'RootController': RootController,
    'WebAuthnController': WebAuthnController,
}

ROUTES = [
    # AUTH ROUTES (Public)
    ('POST', '/api/v1/auth', ('AuthController', 'handleAction')),
    ('POST', '/api/v1/auth/login', ('AuthController', 'login')),
    ('POST', '/api/v1/auth/register', ('AuthController', 'register')),
    ('POST', '/api/v1/auth/firebase', ('AuthController', 'firebaseAuth')),
    ('POST', '/api/v1/auth/verify', ('AuthController', 'verify')),
    ('POST', '/api/v1/auth/logout', ('AuthController', 'logout')),
    # AUTH ROUTES (Protected)
    ('POST', '/api/v1/auth/link-phone', ('AuthController', 'linkPhone')),
    ('POST', '/api/v1/auth/upgrade-plan', ('AuthController', 'upgradePlan')),
    # MODEL CATALOG (public)
    ('GET', '/api/v1/models/catalog', ('ModelCatalogController', 'get')),
    # PACKAGE ROUTES
    ('GET', '/api/v1/me/package', ('PackageController', 'me')),
    ('GET', '/api/v1/admin/packages', ('PackageController', 'adminList')),
    ('GET', '/api/v1/admin/packages/{role:[a-z]+}', ('PackageController', 'adminGet')),
    ('PUT', '/api/v1/admin/packages/{role:[a-z]+}', ('PackageController', 'adminUpdate')),
    # CONTEXT ROUTES
    ('GET', '/api/v1/contexts', ('ContextController', 'list')),
    ('GET', '/api/v1/contexts/{id:\\d+}', ('ContextController', 'get')),
    ('POST', '/api/v1/contexts', ('ContextController', 'create')),
    ('PUT', '/api/v1/contexts/{id:\\d+}', ('ContextController', 'update')),
    ('DELETE', '/api/v1/contexts/{id:\\d+}', ('ContextController', 'delete')),
    # PROMPT LIBRARY
    ('GET', '/api/v1/prompts', ('PromptLibraryController', 'getTree')),
    ('GET', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'get')),
    ('POST', '/api/v1/prompts', ('PromptLibraryController', 'create')),
    ('PUT', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'update')),
    ('DELETE', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'delete')),
    # WEBAUTHN
    ('POST', '/api/v1/webauthn/challenge', ('WebAuthnController', 'challenge')),
    ('POST', '/api/v1/webauthn/register', ('WebAuthnController', 'register')),
    ('POST', '/api/v1/webauthn/authenticate', ('WebAuthnController', 'authenticate')),
    ('DELETE', '/api/v1/webauthn/register', ('WebAuthnController', 'delete')),
    # ROOT / DEBUG
    ('GET', '/', ('RootController', 'index')),
    ('GET', '/api/v1', ('RootController', 'index')),
    ('GET', '/api/v1/debug/auth', ('AuthController', 'debugAuth')),
]
```

For THIS task, the controllers for Tasks 7–11 do not exist yet. Create the four modules as one-line stubs so imports resolve, and replace them in their tasks:

```python
# app/controllers/auth_controller.py (stub — replaced in Task 7)
class AuthController:
    def __init__(self, db, config): self.db, self.config = db, config
```
Same shape for `context_controller.py` (`ContextController`), `package_controller.py` (`PackageController`), `prompt_library_controller.py` (`PromptLibraryController`), `webauthn_controller.py` (`WebAuthnController`).

- [ ] **Step 5: Write `main.py` and `run.sh`**

`main.py`:
```python
"""Entry point — the Python twin of backend/index.php.

One catch-all route. Per request: build Ctx → MiddlewareProcessor (CORS, auth) →
Dispatcher → controller(db, config).method(ctx, *params) → render(). Controllers are
synchronous (PyMySQL), so the whole pipeline runs in Starlette's threadpool.
"""
from __future__ import annotations

import traceback

from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from app.config import load_config
from app.db import open_primary
from app.middleware.processor import MiddlewareProcessor
from app.routes import CONTROLLERS, ROUTES
from app.support.http import build_ctx, json_response, render
from app.support.logger import error_log, get_logger
from app.support.phpcompat import is_numeric
from app.support.router import Dispatcher

METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']


def create_app(config: dict | None = None) -> FastAPI:
    config = config or load_config()
    get_logger()
    dispatcher = Dispatcher(ROUTES)
    processor = MiddlewareProcessor(config, lambda: open_primary(config))
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def handle_sync(request: Request, raw_body: bytes) -> Response:
        ctx = build_ctx(request, raw_body)
        cors_headers = processor.cors.headers(request.headers.get('origin', ''))

        def with_cors(resp: Response | None) -> Response | None:
            if resp is not None:
                for k, v in cors_headers.items():
                    resp.headers[k] = v
            return resp

        mw = processor.process(ctx)
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
                return with_cors(json_response(405, {'success': False, 'error': 'Method not allowed',
                                                     'allowed_methods': route.allowed}))
            controller_name, method_name = route.handler
            cls = CONTROLLERS.get(controller_name)
            if cls is None:
                return with_cors(json_response(500, {'success': False, 'error': f'Controller not found: {controller_name}'}))
            try:
                controller = cls(db, config)
                fn = getattr(controller, method_name, None)
                if fn is None:
                    return with_cors(json_response(500, {'success': False, 'error': f'Method not found: {method_name}'}))
                if route.params:
                    params = [int(v) if is_numeric(v) else v for v in route.params.values()]
                    ctx['params'] = dict(route.params)
                    result = fn(ctx, *params)
                else:
                    result = fn(ctx)
                resp = render(result)
                if resp is None:
                    # streaming_handled: the controller returned its own Response via ctx['_response']
                    resp = ctx.get('_response') or Response(status_code=200)
                return with_cors(resp)
            except Exception as e:  # noqa: BLE001
                error_log(f'[Backend] Controller error: {e}\n{traceback.format_exc()}')
                return with_cors(json_response(500, {'success': False, 'error': str(e)}))
        finally:
            db.close()

    @app.api_route('/{path:path}', methods=METHODS, include_in_schema=False)
    @app.api_route('/', methods=METHODS, include_in_schema=False)
    async def catch_all(request: Request):
        raw = await request.body()
        return await run_in_threadpool(handle_sync, request, raw)

    return app


app = create_app()
```

`run.sh`:
```bash
#!/usr/bin/env bash
# Start the Python backend on port 3002 (PHP: Apache /gpt/backend, Node: 3001).
cd "$(dirname "$0")"
source .venv/bin/activate
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-3002}" --reload
```
`chmod +x run.sh`.

Note on `app = create_app()` at import: `tests/conftest.py` imports `create_app` from `main`, which executes the module-level `create_app()` too. That is fine (it loads `.env`), and it means `uvicorn main:app` works without a factory flag.

- [ ] **Step 6: Run the pipeline tests**

Run: `pytest tests/unit/test_app_pipeline.py -q`
Expected: 6 passed

- [ ] **Step 7: Write the differential harness and the first differential tests**

`tests/differential/conftest.py`:
```python
"""PHP-vs-Python differential fixtures. PHP is hit over HTTP (Apache), Python in-process."""
import os
import time

import httpx
import jwt
import pytest

PHP_BASE = os.environ.get('DIFF_PHP_BASE', 'http://localhost/gpt/backend')
DIFF_USER_ID = int(os.environ.get('DIFF_USER_ID', '3'))


def _php_up() -> bool:
    try:
        return httpx.get(PHP_BASE + '/', timeout=3).status_code == 200
    except Exception:  # noqa: BLE001
        return False


@pytest.fixture(scope='session', autouse=True)
def _require_php():
    if not _php_up():
        pytest.skip(f'PHP backend not reachable at {PHP_BASE}', allow_module_level=True)


@pytest.fixture(scope='session')
def php():
    return httpx.Client(base_url=PHP_BASE, timeout=60)


@pytest.fixture(scope='session')
def py(client):
    return client


@pytest.fixture(scope='session')
def token(config):
    now = int(time.time())
    return jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 3600, 'sub': DIFF_USER_ID, 'type': 'access'},
                      config['auth']['jwt_secret'], algorithm='HS256')


@pytest.fixture(scope='session')
def both(php, py, token):
    def _both(method: str, path: str, json=None, headers=None, auth=True):
        h = dict(headers or {})
        if auth and 'Authorization' not in h:
            h['Authorization'] = f'Bearer {token}'
        a = php.request(method, path, json=json, headers=h)
        b = py.request(method, path, json=json, headers=h)
        return a, b
    return _both


def same(a, b, ignore=()):
    """Assert status + JSON equality, ignoring listed top-level keys (e.g. wall-clock fields)."""
    assert a.status_code == b.status_code, (a.status_code, b.status_code, a.text, b.text)
    ja, jb = a.json(), b.json()
    for k in ignore:
        ja.pop(k, None); jb.pop(k, None)
    assert ja == jb, (ja, jb)
```

Add `pytestmark = pytest.mark.differential` to every differential module.

`tests/differential/test_public.py`:
```python
import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_root(both):
    same(*both('GET', '/', auth=False))


def test_model_catalog(both):
    a, b = both('GET', '/api/v1/models/catalog', auth=False)
    same(a, b)


def test_404_and_405_envelopes(both):
    same(*both('GET', '/api/v1/definitely-missing'))
    a, b = both('PATCH', '/api/v1/prompts')
    assert a.status_code == b.status_code == 405
    assert sorted(a.json()['allowed_methods']) == sorted(b.json()['allowed_methods'])


def test_401_envelopes(both):
    same(*both('GET', '/api/v1/prompts', auth=False))
    same(*both('GET', '/api/v1/prompts', headers={'Authorization': 'Bearer garbage'}, auth=False))
```

- [ ] **Step 8: Run the differential tests (Apache must be running)**

Run: `pytest tests/differential/test_public.py -q`
Expected: 4 passed (or a clean module skip if PHP is down — then start XAMPP Apache and re-run)

- [ ] **Step 9: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): request pipeline, route table, root + model catalog, differential harness"
```

### Task 7: AuthController (all actions except Firebase verification)

**Files:**
- Replace stub: `backend_python/app/controllers/auth_controller.py`
- Create: `backend_python/app/services/__init__.py`, `backend_python/app/services/firebase_tokens.py` (stub that raises; real body in Task 8)
- Test: `backend_python/tests/unit/test_auth_controller.py`, `backend_python/tests/differential/test_auth.py`

**Interfaces:**
- Consumes: `Db` (Task 2), `php_now`, `validate_email`, `is_numeric` (Task 1), `user_app_key_pepper`, `hash_user_app_key`, `decode_hs256` (Task 5).
- Produces: `AuthController(db, config)` with public methods `handleAction, login, ssoExchange, register, firebaseAuth, verify, logout, linkPhone, unlinkPhone, upgradePlan, debugAuth, generateAppKey, revokeAppKey, adminGenerateAppKeyForUser, adminRevokeAppKeyForUser`, and module-level pure helpers `normalize_plan(plan) -> str`, `role_for_plan(plan) -> str`, `plan_rank(plan) -> int`, `generate_tokens(user_id, secret, jwt_expiry, refresh_expiry) -> dict(access_token, refresh_token)` (reused by `WebAuthnController` in Task 11).
- Produces: `app.services.firebase_tokens.verify_firebase_id_token(id_token: str, project_id: str) -> dict | None` (Task 8 implements; Task 7 ships `return None` with an `error_log`).

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/test_auth_controller.py`:
```python
import time
import bcrypt
import jwt
import pytest
from starlette.datastructures import Headers
from app.controllers.auth_controller import (AuthController, normalize_plan, role_for_plan, plan_rank,
                                             generate_tokens)
from app.support.http import Ctx

SECRET = 'unit-secret'
CONFIG = {'auth': {'jwt_secret': SECRET, 'jwt_expiry': 28800, 'refresh_expiry': 604800,
                   'app_key_secret': 'x', 'login_jwt_secret': ''}, 'login_db': {}}


class FakeDb:
    def __init__(self, one=None, all_=None):
        self.one = list(one or []); self.all_ = list(all_ or []); self.calls = []; self.next_id = 77
    def fetch_one(self, sql, p=None):
        self.calls.append((sql, p)); return self.one.pop(0) if self.one else None
    def fetch_all(self, sql, p=None):
        self.calls.append((sql, p)); return self.all_.pop(0) if self.all_ else []
    def execute(self, sql, p=None):
        self.calls.append((sql, p)); return 1
    def insert(self, sql, p=None):
        self.calls.append((sql, p)); return self.next_id


def ctx(body=None, user_id=None, auth_type=None, headers=None):
    c = Ctx(method='POST', uri='/api/v1/auth', headers=Headers(headers or {}), query={}, body=body or {},
            raw_body='', params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    if auth_type:
        c['auth_type'] = auth_type
    return c


def test_plan_helpers():
    assert normalize_plan('Synergy_Premium') == 'premium' and normalize_plan('standard') == 'standard'
    assert normalize_plan('gold') == 'free' and normalize_plan(None) == 'free'
    assert role_for_plan('free') == 'prospect' and role_for_plan('premium') == 'user'
    assert plan_rank('premium') == 2 and plan_rank('bogus') == 0


def test_generate_tokens_claims():
    t = generate_tokens(3, SECRET, 28800, 604800)
    a = jwt.decode(t['access_token'], SECRET, algorithms=['HS256'])
    r = jwt.decode(t['refresh_token'], SECRET, algorithms=['HS256'])
    assert a['iss'] == 'gpt-chat' and a['sub'] == 3 and a['type'] == 'access' and a['exp'] - a['iat'] == 28800
    assert r['type'] == 'refresh' and r['exp'] - r['iat'] == 604800


def test_constructor_fails_closed_without_secret():
    with pytest.raises(RuntimeError, match='JWT secret is not configured'):
        AuthController(FakeDb(), {'auth': {'jwt_secret': ''}})


def test_login_validation_and_bad_credentials():
    c = AuthController(FakeDb(), CONFIG)
    assert c.login(ctx({'email': '', 'password': 'x'})) == {
        'success': False, 'message': 'Email and password are required', 'status_code': 400}
    db = FakeDb(one=[None])
    c = AuthController(db, CONFIG)
    assert c.login(ctx({'email': ' A@B.com ', 'password': 'x'}))['status_code'] == 401
    assert db.calls[0][1] == ['a@b.com']     # lowercased + trimmed


def test_login_success_shape_accepts_php_2y_hash():
    pw_hash = bcrypt.hashpw(b'secret', bcrypt.gensalt()).decode().replace('$2b$', '$2y$', 1)
    user = {'id': 3, 'email': 'a@b.com', 'password': pw_hash, 'first_name': 'A', 'last_name': 'B',
            'role': 'admin', 'plan': 'premium', 'provider': 'email', 'created_at': '2026-01-01 00:00:00',
            'app_key_prefix': None, 'app_key_created_at': None}
    db = FakeDb(one=[user])
    r = AuthController(db, CONFIG).login(ctx({'email': 'a@b.com', 'password': 'secret'}))
    assert r['success'] is True and r['message'] == 'Login successful' and r['status_code'] == 200
    u = r['data']['user']
    assert list(u) == ['id', 'email', 'first_name', 'last_name', 'role', 'plan', 'provider', 'last_login',
                       'created_at', 'app_key_prefix', 'app_key_created_at']
    assert u['id'] == 3 and r['data']['expires_in'] == 28800
    assert any('last_login = NOW()' in s for s, _ in db.calls)


def test_register_validation_order():
    c = AuthController(FakeDb(), CONFIG)
    assert c.register(ctx({'email': 'x@y.com'}))['message'] == 'Email and password are required'
    assert c.register(ctx({'email': 'bad', 'password': 'p'}))['message'] == 'Invalid email format'
    r = c.register(ctx({'email': 'x@y.com', 'password': 'p'}))
    assert r['code'] == 'LEDGER_ACCOUNT_REQUIRED' and r['status_code'] == 400
    db = FakeDb(one=[{'id': 1}])
    r2 = AuthController(db, CONFIG).register(ctx({'email': 'x@y.com', 'password': 'p', 'ledger_user_id': 'L1'}))
    assert r2 == {'success': False, 'message': 'Email already registered', 'status_code': 409}


def test_register_success_hashes_with_bcrypt_and_returns_tokens():
    db = FakeDb(one=[None])
    r = AuthController(db, CONFIG).register(ctx({'email': 'N@y.com', 'password': 'p', 'ledger_user_id': 'L1',
                                                 'plan': 'synergy_standard', 'first_name': ' F '}))
    assert r['success'] and r['data']['user'] == {
        'id': 77, 'email': 'n@y.com', 'first_name': 'F', 'last_name': '', 'role': 'user', 'plan': 'standard',
        'provider': 'email', 'last_login': r['data']['user']['last_login'],
        'created_at': r['data']['user']['created_at'], 'app_key_prefix': None, 'app_key_created_at': None}
    insert_params = [p for s, p in db.calls if s.strip().startswith('INSERT')][0]
    assert bcrypt.checkpw(b'p', insert_params[1].encode())


def test_verify_reads_authorization_header():
    c = AuthController(FakeDb(), CONFIG)
    assert c.verify(ctx())['message'] == 'Authorization token required'
    tok = generate_tokens(9, SECRET, 10, 10)['access_token']
    assert c.verify(ctx(headers={'authorization': 'Bearer ' + tok})) == {
        'success': True, 'message': 'Token is valid', 'data': {'user_id': 9}, 'status_code': 200}
    assert c.verify(ctx(headers={'authorization': 'Bearer nope'}))['message'] == 'Invalid or expired token'


def test_handle_action_gate_and_dispatch():
    c = AuthController(FakeDb(), CONFIG)
    assert c.handleAction(ctx({'action': 'upgrade_plan'})) == {
        'success': False, 'message': 'Authentication required', 'status_code': 401}
    assert c.handleAction(ctx({'action': 'nope'})) == {'success': False, 'message': 'Invalid action', 'status_code': 400}
    assert c.handleAction(ctx({'action': 'logout'})) == {'success': True, 'message': 'Logout successful', 'status_code': 200}


def test_upgrade_plan_and_link_phone():
    db = FakeDb()
    c = AuthController(db, CONFIG)
    assert c.upgradePlan(ctx({'plan': 'gold'}, user_id=3))['message'] == 'Invalid plan. Must be standard or premium.'
    r = c.upgradePlan(ctx({'plan': 'app_premium'}, user_id=3))
    assert r == {'success': True, 'message': 'Plan upgraded to premium', 'plan': 'premium', 'role': 'user', 'status_code': 200}
    assert c.linkPhone(ctx({'phone_number': ''}, user_id=3))['message'] == 'Phone number is required'
    db2 = FakeDb(one=[{'id': 4}])
    assert AuthController(db2, CONFIG).linkPhone(ctx({'phone_number': '+1'}, user_id=3))['status_code'] == 409


def test_app_key_generation_requires_jwt_auth_type():
    c = AuthController(FakeDb(), CONFIG)
    assert c.generateAppKey(ctx(user_id=3, auth_type='user_app_key'))['status_code'] == 401
    r = c.generateAppKey(ctx(user_id=3, auth_type='jwt'))
    key = r['data']['app_key']
    assert key.startswith('uak_') and len(key) == 36 and r['data']['app_key_prefix'] == key[:12]


def test_admin_generate_requires_admin_role():
    db = FakeDb(one=[{'role': 'user'}])
    r = AuthController(db, CONFIG).adminGenerateAppKeyForUser(ctx({'user_id': 5}, user_id=3, auth_type='jwt'))
    assert r == {'success': False, 'message': 'Admin privileges required', 'status_code': 403}
    db2 = FakeDb(one=[{'role': 'admin'}, None])
    r2 = AuthController(db2, CONFIG).adminGenerateAppKeyForUser(ctx({'user_id': 5}, user_id=3, auth_type='jwt'))
    assert r2 == {'success': False, 'message': 'User not found', 'status_code': 404}


def test_debug_auth():
    r = AuthController(FakeDb(), CONFIG).debugAuth(ctx(user_id=3, headers={'authorization': 'Bearer x'}))
    assert r['user_id'] == 3 and r['authenticated'] is True and r['has_auth_header'] is True
    assert 'php_version' in r
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_auth_controller.py -q`
Expected: ImportError (`normalize_plan`)

- [ ] **Step 3: Write the Firebase stub**

`app/services/__init__.py`: empty.

`app/services/firebase_tokens.py` (stub; Task 8 replaces the body):
```python
"""Firebase ID token verification (RS256 vs Google secure-token certs). Real body: Task 8."""
from app.support.logger import error_log


def verify_firebase_id_token(id_token: str, project_id: str) -> dict | None:
    error_log('[AuthController] Firebase ID token verification failed: not implemented yet')
    return None
```

- [ ] **Step 4: Implement `app/controllers/auth_controller.py`**

```python
"""Port of Controllers/AuthController.php. Method names and response dicts are kept
verbatim; key order matters (it is the JSON key order)."""
from __future__ import annotations

import os
import secrets
import time

import bcrypt
import jwt

from app.db import Db
from app.middleware.auth import decode_hs256, hash_user_app_key, user_app_key_pepper
from app.services.firebase_tokens import verify_firebase_id_token
from app.support.logger import error_log
from app.support.phpcompat import php_now, validate_email

FREE_TRIAL_TOKEN_QUOTA = 50000
PHP_VERSION = '8.2.4'   # debugAuth reports PHP_VERSION; mirrored constant (XAMPP's PHP)


def normalize_plan(plan) -> str:
    p = str(plan or '').strip().lower()
    if '_' in p:
        p = p.split('_', 1)[1]
    return p if p in ('standard', 'premium') else 'free'


def role_for_plan(plan: str) -> str:
    return 'prospect' if plan == 'free' else 'user'


def plan_rank(plan) -> int:
    return {'free': 0, 'standard': 1, 'premium': 2}.get(normalize_plan(plan), 0)


def generate_tokens(user_id: int, secret: str, jwt_expiry: int, refresh_expiry: int) -> dict:
    now = int(time.time())
    access = {'iss': 'gpt-chat', 'iat': now, 'exp': now + jwt_expiry, 'sub': user_id, 'type': 'access'}
    refresh = {'iss': 'gpt-chat', 'iat': now, 'exp': now + refresh_expiry, 'sub': user_id, 'type': 'refresh'}
    return {'access_token': jwt.encode(access, secret, algorithm='HS256'),
            'refresh_token': jwt.encode(refresh, secret, algorithm='HS256')}


def password_verify(password: str, stored_hash) -> bool:
    """PHP password_verify(): accepts $2y$/$2a$/$2b$ bcrypt hashes."""
    if not stored_hash:
        return False
    h = str(stored_hash)
    if h.startswith('$2y$'):
        h = '$2b$' + h[4:]
    try:
        return bcrypt.checkpw(password.encode('utf-8'), h.encode('utf-8'))
    except ValueError:
        return False


def password_hash(password: str) -> str:
    """PHP password_hash(PASSWORD_BCRYPT) (cost 10). Emits $2b$; PHP verifies $2b$ fine."""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt(rounds=10)).decode('ascii')


def _user_payload(user: dict, user_id: int, provider_default: str, provider_override: str | None = None) -> dict:
    return {
        'id': user_id,
        'email': user['email'],
        'first_name': user['first_name'],
        'last_name': user['last_name'],
        'role': user.get('role') or 'prospect',
        'plan': user.get('plan') or 'free',
        'provider': provider_override if provider_override is not None else (user.get('provider') or provider_default),
        'last_login': php_now(),
        'created_at': user.get('created_at'),
        'app_key_prefix': user.get('app_key_prefix'),
        'app_key_created_at': user.get('app_key_created_at'),
    }


class AuthController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        auth = config.get('auth') or {}
        self.jwt_secret = str(auth.get('jwt_secret', '') or '')
        if self.jwt_secret == '':
            raise RuntimeError('JWT secret is not configured (set JWT_SECRET).')
        self.jwt_expiry = int(auth.get('jwt_expiry', 28800))
        self.refresh_expiry = int(auth.get('refresh_expiry', 604800))

    # ---- helpers -------------------------------------------------------------
    def _tokens(self, user_id: int) -> dict:
        return generate_tokens(user_id, self.jwt_secret, self.jwt_expiry, self.refresh_expiry)

    def _firebase_project_id(self) -> str:
        from_config = str((self.config.get('firebase') or {}).get('project_id', '') or '')
        if from_config:
            return from_config
        from_env = os.environ.get('FIREBASE_PROJECT_ID', '')
        return from_env or 'transledgersite'

    def _app_key_pepper(self) -> str:
        return user_app_key_pepper(self.config, self.jwt_secret)

    def _generate_app_key_material(self) -> dict:
        key = 'uak_' + secrets.token_bytes(16).hex()
        return {'key': key, 'prefix': key[:12], 'hash': hash_user_app_key(key, self._app_key_pepper())}

    @staticmethod
    def _auth_required() -> dict:
        return {'success': False, 'message': 'Authentication required', 'status_code': 401}

    # ---- legacy action dispatcher ------------------------------------------
    def handleAction(self, request) -> dict:
        action = request['body'].get('action', '')
        protected = ['link_phone', 'unlink_phone', 'upgrade_plan', 'generate_app_key', 'revoke_app_key',
                     'admin_generate_app_key', 'admin_revoke_app_key']
        if action in protected and not request.get('user_id'):
            return self._auth_required()
        table = {
            'login': self.login, 'register': self.register, 'firebase': self.firebaseAuth, 'verify': self.verify,
            'sso_exchange': self.ssoExchange, 'logout': self.logout, 'link_phone': self.linkPhone,
            'unlink_phone': self.unlinkPhone, 'upgrade_plan': self.upgradePlan,
            'generate_app_key': self.generateAppKey, 'revoke_app_key': self.revokeAppKey,
            'admin_generate_app_key': self.adminGenerateAppKeyForUser,
            'admin_revoke_app_key': self.adminRevokeAppKeyForUser,
        }
        fn = table.get(action)
        if fn is None:
            return {'success': False, 'message': 'Invalid action', 'status_code': 400}
        return fn(request)

    # ---- login / sso / register --------------------------------------------
    def login(self, request) -> dict:
        email = request['body'].get('email', '') or ''
        password = request['body'].get('password', '') or ''
        if not email or not password:
            return {'success': False, 'message': 'Email and password are required', 'status_code': 400}
        user = self.db.fetch_one("SELECT * FROM users WHERE email = ?", [str(email).strip().lower()])
        if not user or not password_verify(str(password), user.get('password')):
            return {'success': False, 'message': 'Invalid email or password', 'status_code': 401}
        tokens = self._tokens(int(user['id']))
        self.db.execute("UPDATE users SET last_login = NOW() WHERE id = ?", [user['id']])
        return {
            'success': True, 'message': 'Login successful',
            'data': {'user': _user_payload(user, int(user['id']), 'email'),
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    def ssoExchange(self, request) -> dict:
        login_token = str(request['body'].get('login_token', '') or '')
        if login_token == '':
            return {'success': False, 'message': 'login_token is required', 'status_code': 400}
        secret = str((self.config.get('auth') or {}).get('login_jwt_secret', '') or '')
        if secret == '':
            return {'success': False, 'message': 'SSO is not configured (LOGIN_JWT_SECRET missing)', 'status_code': 500}
        claims = decode_hs256(login_token, secret)
        if claims is None:
            return {'success': False, 'message': 'Invalid SSO token', 'status_code': 401}
        if claims.get('iss') != 'login-service':
            return {'success': False, 'message': 'Invalid SSO token', 'status_code': 401}
        if claims.get('type') != 'access' or 'sub' not in claims:
            return {'success': False, 'message': 'Invalid SSO token', 'status_code': 401}
        ld = self.config.get('login_db') or {}
        try:
            ldb = Db.connect({'host': ld.get('host', ''), 'database': ld.get('database', ''),
                              'username': ld.get('username', ''), 'password': ld.get('password', ''),
                              'charset': 'utf8mb4'}, timeout=5)
            try:
                login_user = ldb.fetch_one('SELECT email, email_verified FROM users WHERE id = ?',
                                           [int(claims['sub'])]) or {}
            finally:
                ldb.close()
            email = str(login_user.get('email', '') or '').strip().lower()
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'SSO temporarily unavailable', 'status_code': 503}
        if email == '':
            return {'success': False, 'message': 'Unknown SSO user', 'status_code': 401}
        if not login_user.get('email_verified'):
            return {'success': False, 'message': 'SSO account email not verified', 'status_code': 403}
        user = self.db.fetch_one('SELECT * FROM users WHERE email = ?', [email])
        if not user:
            return {'success': False, 'message': f'No account for {email} — sign up first', 'status_code': 403}
        tokens = self._tokens(int(user['id']))
        self.db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user['id']])
        return {
            'success': True, 'message': 'Login successful',
            'data': {'user': _user_payload(user, int(user['id']), 'sso', provider_override='sso'),
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    def register(self, request) -> dict:
        b = request['body']
        email = str(b.get('email', '') or '').strip().lower()
        password = b.get('password', '') or ''
        first_name = str(b.get('first_name', '') or '').strip()
        last_name = str(b.get('last_name', '') or '').strip()
        ledger_user_id = str(b.get('ledger_user_id', '') or '').strip()
        plan = str(b.get('plan', 'free') or 'free').strip()
        if not email or not password:
            return {'success': False, 'message': 'Email and password are required', 'status_code': 400}
        if not validate_email(email):
            return {'success': False, 'message': 'Invalid email format', 'status_code': 400}
        if not ledger_user_id:
            return {'success': False,
                    'message': 'Registration requires a valid subscription. Please register through synergyaichat.com',
                    'code': 'LEDGER_ACCOUNT_REQUIRED', 'status_code': 400}
        plan = normalize_plan(plan)
        role = role_for_plan(plan)
        if self.db.fetch_one("SELECT id FROM users WHERE email = ?", [email]):
            return {'success': False, 'message': 'Email already registered', 'status_code': 409}
        user_id = self.db.insert(
            "INSERT INTO users (email, password, first_name, last_name, role, ledger_user_id, plan, provider, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'email', NOW(), NOW())",
            [email, password_hash(str(password)), first_name, last_name, role, ledger_user_id, plan])
        tokens = self._tokens(user_id)
        now = php_now()
        return {
            'success': True, 'message': 'Registration successful',
            'data': {'user': {'id': user_id, 'email': email, 'first_name': first_name, 'last_name': last_name,
                              'role': role, 'plan': plan, 'provider': 'email', 'last_login': now, 'created_at': now,
                              'app_key_prefix': None, 'app_key_created_at': None},
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    # ---- firebase ------------------------------------------------------------
    def firebaseAuth(self, request) -> dict:
        b = request['body']
        provider = b.get('provider', '') or ''
        id_token = b.get('idToken', '') or ''
        user_data = b.get('userData') or {}
        if not id_token:
            return {'success': False, 'message': 'Invalid authentication data', 'status_code': 400}
        claims = verify_firebase_id_token(str(id_token), self._firebase_project_id())
        if claims is None:
            return {'success': False, 'message': 'Invalid or expired authentication token', 'status_code': 401}
        verified_email = str(claims.get('email', '')).strip().lower() if 'email' in claims else ''
        verified_phone = str(claims.get('phone_number', '')).strip() if 'phone_number' in claims else ''
        firebase_uid = str(claims.get('sub', ''))
        if not verified_email and not verified_phone:
            return {'success': False, 'message': 'Invalid authentication data', 'status_code': 400}
        email = verified_email if verified_email else verified_phone.lower() + '@phone.auth'
        phone_number = verified_phone if verified_phone else None
        first_name = user_data.get('first_name', '') or ''
        last_name = user_data.get('last_name', '') or ''
        user = self.db.fetch_one("SELECT * FROM users WHERE email = ? OR firebase_uid = ? OR phone = ?",
                                 [email, firebase_uid, phone_number])
        ledger_user_id = str(user_data.get('ledger_user_id') or b.get('ledger_user_id') or '').strip()
        plan = normalize_plan(user_data.get('plan') or b.get('plan') or 'free')
        role = role_for_plan(plan)
        if user:
            self.db.execute(
                "UPDATE users SET last_login = NOW(), firebase_uid = COALESCE(firebase_uid, ?), provider = ?,"
                " phone = COALESCE(phone, ?) WHERE id = ?", [firebase_uid, provider, phone_number, user['id']])
            user_id = int(user['id'])
            if plan != 'free' and (user.get('role') or '') != 'admin' and plan_rank(plan) > plan_rank(user.get('plan') or 'free'):
                self.db.execute("UPDATE users SET plan = ?, role = ?, updated_at = NOW() WHERE id = ?", [plan, role, user_id])
                user = dict(user); user['plan'] = plan; user['role'] = role
        else:
            if not ledger_user_id:
                return {'success': False,
                        'message': 'Registration requires a valid subscription. Please register through synergyaichat.com',
                        'code': 'LEDGER_ACCOUNT_REQUIRED', 'status_code': 400}
            user_id = self.db.insert(
                "INSERT INTO users (email, first_name, last_name, firebase_uid, provider, phone, role, ledger_user_id, plan, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())",
                [email, first_name, last_name, firebase_uid, provider, phone_number, role, ledger_user_id, plan])
            user = self.db.fetch_one("SELECT * FROM users WHERE id = ?", [user_id])
        tokens = self._tokens(user_id)
        return {
            'success': True, 'message': 'Authentication successful',
            'data': {'user': _user_payload(user, user_id, 'firebase'),
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    # ---- verify / logout -----------------------------------------------------
    def verify(self, request) -> dict:
        value = request['headers'].get('Authorization') or request['headers'].get('authorization') or ''
        import re
        m = re.search(r'Bearer\s+(.*)$', value, re.I)
        if not m:
            return {'success': False, 'message': 'Authorization token required', 'status_code': 401}
        claims = decode_hs256(m.group(1), self.jwt_secret)
        if claims is None:
            return {'success': False, 'message': 'Invalid or expired token', 'status_code': 401}
        return {'success': True, 'message': 'Token is valid', 'data': {'user_id': claims.get('sub')}, 'status_code': 200}

    def logout(self, request) -> dict:
        return {'success': True, 'message': 'Logout successful', 'status_code': 200}

    # ---- phone / plan --------------------------------------------------------
    def linkPhone(self, request) -> dict:
        user_id = request.get('user_id')
        phone_number = request['body'].get('phone_number', '') or ''
        if not user_id:
            return self._auth_required()
        if not phone_number:
            return {'success': False, 'message': 'Phone number is required', 'status_code': 400}
        if self.db.fetch_one("SELECT id FROM users WHERE phone = ? AND id != ?", [phone_number, user_id]):
            return {'success': False, 'message': 'Phone number is already linked to another account', 'status_code': 409}
        self.db.execute("UPDATE users SET phone = ?, updated_at = NOW() WHERE id = ?", [phone_number, user_id])
        error_log(f'[AuthController] Phone linked: user_id={user_id}, phone={phone_number}')
        return {'success': True, 'message': 'Phone number linked successfully', 'status_code': 200}

    def unlinkPhone(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id:
            return self._auth_required()
        self.db.execute("UPDATE users SET phone = NULL, updated_at = NOW() WHERE id = ?", [user_id])
        error_log(f'[AuthController] Phone unlinked: user_id={user_id}')
        return {'success': True, 'message': 'Phone number unlinked successfully', 'status_code': 200}

    def upgradePlan(self, request) -> dict:
        user_id = request.get('user_id')
        plan = str(request['body'].get('plan', '') or '').strip()
        if not user_id:
            return self._auth_required()
        plan = normalize_plan(plan)
        if plan not in ('standard', 'premium'):
            return {'success': False, 'message': 'Invalid plan. Must be standard or premium.', 'status_code': 400}
        role = role_for_plan(plan)
        self.db.execute("UPDATE users SET plan = ?, role = ?, updated_at = NOW() WHERE id = ?", [plan, role, user_id])
        error_log(f'[AuthController] Plan upgraded: user_id={user_id}, plan={plan}, role={role}')
        return {'success': True, 'message': f'Plan upgraded to {plan}', 'plan': plan, 'role': role, 'status_code': 200}

    def debugAuth(self, request) -> dict:
        has_header = bool(request['headers'].get('Authorization') or request['headers'].get('authorization'))
        return {'success': True, 'user_id': request.get('user_id'), 'authenticated': request.get('authenticated', False),
                'has_auth_header': has_header, 'php_version': PHP_VERSION, 'status_code': 200}

    # ---- per-user app keys ---------------------------------------------------
    def generateAppKey(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id or request.get('auth_type') != 'jwt':
            return self._auth_required()
        m = self._generate_app_key_material()
        self.db.execute("UPDATE users SET app_key_hash = ?, app_key_prefix = ?, app_key_created_at = NOW(), updated_at = NOW() WHERE id = ?",
                        [m['hash'], m['prefix'], user_id])
        return {'success': True, 'message': 'App key generated. Save it now — it will not be shown again.',
                'data': {'app_key': m['key'], 'app_key_prefix': m['prefix'], 'app_key_created_at': php_now()},
                'status_code': 200}

    def revokeAppKey(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id or request.get('auth_type') != 'jwt':
            return self._auth_required()
        self.db.execute("UPDATE users SET app_key_hash = NULL, app_key_prefix = NULL, app_key_created_at = NULL, updated_at = NOW() WHERE id = ?",
                        [user_id])
        return {'success': True, 'message': 'App key revoked.', 'status_code': 200}

    def _require_admin_caller(self, request) -> dict | None:
        caller_id = request.get('user_id')
        if not caller_id or request.get('auth_type') != 'jwt':
            return self._auth_required()
        caller = self.db.fetch_one("SELECT role FROM users WHERE id = ?", [caller_id])
        if not caller or (caller.get('role') or '') != 'admin':
            return {'success': False, 'message': 'Admin privileges required', 'status_code': 403}
        return None

    def adminGenerateAppKeyForUser(self, request) -> dict:
        err = self._require_admin_caller(request)
        if err:
            return err
        target = int(request['body'].get('user_id') or 0)
        if target <= 0:
            return {'success': False, 'message': 'user_id is required', 'status_code': 400}
        if not self.db.fetch_one("SELECT id FROM users WHERE id = ?", [target]):
            return {'success': False, 'message': 'User not found', 'status_code': 404}
        m = self._generate_app_key_material()
        self.db.execute("UPDATE users SET app_key_hash = ?, app_key_prefix = ?, app_key_created_at = NOW(), updated_at = NOW() WHERE id = ?",
                        [m['hash'], m['prefix'], target])
        error_log(f"[AuthController] Admin user_id={request.get('user_id')} generated app key for user_id={target}")
        return {'success': True, 'message': 'App key generated for user. Save it now — it will not be shown again.',
                'data': {'user_id': target, 'app_key': m['key'], 'app_key_prefix': m['prefix'],
                         'app_key_created_at': php_now()}, 'status_code': 200}

    def adminRevokeAppKeyForUser(self, request) -> dict:
        err = self._require_admin_caller(request)
        if err:
            return err
        target = int(request['body'].get('user_id') or 0)
        if target <= 0:
            return {'success': False, 'message': 'user_id is required', 'status_code': 400}
        self.db.execute("UPDATE users SET app_key_hash = NULL, app_key_prefix = NULL, app_key_created_at = NULL, updated_at = NOW() WHERE id = ?",
                        [target])
        error_log(f"[AuthController] Admin user_id={request.get('user_id')} revoked app key for user_id={target}")
        return {'success': True, 'message': 'App key revoked.', 'data': {'user_id': target}, 'status_code': 200}
```

Move the `import re` in `verify` to the module top (`import re` alongside the other imports) — it is shown inline only to keep the method self-explanatory.

Note on `int(request['body'].get('user_id') or 0)`: PHP `(int)"abc"` is 0, Python raises. Use a helper `_to_int(v) -> int` that returns `int(v)` when `is_numeric(v)` else 0, and use it in both admin methods.

- [ ] **Step 5: Run unit tests**

Run: `pytest tests/unit/test_auth_controller.py -q`
Expected: 14 passed

- [ ] **Step 6: Write the differential tests**

`tests/differential/test_auth.py` — register creates a throwaway user on ONE backend, logs in on the OTHER (cross-backend bcrypt + token interop), then deletes it directly in the DB:
```python
import time
import uuid
import pytest
from app.db import open_primary
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_login_validation_and_bad_credentials(both):
    same(*both('POST', '/api/v1/auth/login', json={'email': '', 'password': ''}, auth=False))
    same(*both('POST', '/api/v1/auth/login', json={'email': 'nobody@example.invalid', 'password': 'x'}, auth=False))


def test_register_validation_matrix(both):
    same(*both('POST', '/api/v1/auth/register', json={'email': 'x@y.com'}, auth=False))
    same(*both('POST', '/api/v1/auth/register', json={'email': 'bad', 'password': 'p'}, auth=False))
    same(*both('POST', '/api/v1/auth/register', json={'email': 'x@y.com', 'password': 'p'}, auth=False))


def test_legacy_action_dispatcher(both):
    same(*both('POST', '/api/v1/auth', json={'action': 'nope'}, auth=False))
    same(*both('POST', '/api/v1/auth', json={'action': 'logout'}, auth=False))
    same(*both('POST', '/api/v1/auth', json={'action': 'upgrade_plan', 'plan': 'premium'}, auth=False))
    same(*both('POST', '/api/v1/auth', json={'action': 'upgrade_plan', 'plan': 'gold'}))   # authed, invalid plan
    same(*both('POST', '/api/v1/auth', json={'action': 'link_phone', 'phone_number': ''}))


def test_verify_and_logout(both, token):
    same(*both('POST', '/api/v1/auth/verify'))
    same(*both('POST', '/api/v1/auth/verify', headers={'Authorization': 'Bearer junk'}, auth=False))
    same(*both('POST', '/api/v1/auth/logout', auth=False))


def test_debug_auth(both):
    same(*both('GET', '/api/v1/debug/auth'))


def test_register_on_python_login_on_php_and_vice_versa(php, py, config):
    email_a = f'diff-{uuid.uuid4().hex[:10]}@example.invalid'
    email_b = f'diff-{uuid.uuid4().hex[:10]}@example.invalid'
    body = lambda e: {'email': e, 'password': 'Pw-123456', 'ledger_user_id': 'diff-test', 'plan': 'standard'}
    try:
        ra = py.post('/api/v1/auth/register', json=body(email_a)); assert ra.status_code == 200, ra.text
        rb = php.post('/api/v1/auth/register', json=body(email_b)); assert rb.status_code == 200, rb.text
        # shape parity (ignore ids/tokens/timestamps)
        ua, ub = ra.json()['data']['user'], rb.json()['data']['user']
        assert list(ua) == list(ub) and ua['role'] == ub['role'] == 'user' and ua['plan'] == ub['plan'] == 'standard'
        # cross-login
        la = php.post('/api/v1/auth/login', json={'email': email_a, 'password': 'Pw-123456'})
        lb = py.post('/api/v1/auth/login', json={'email': email_b, 'password': 'Pw-123456'})
        assert la.status_code == 200 and lb.status_code == 200, (la.text, lb.text)
        # token interop: python-minted token verifies on PHP and vice versa
        ta, tb = ra.json()['data']['access_token'], rb.json()['data']['access_token']
        assert php.post('/api/v1/auth/verify', headers={'Authorization': f'Bearer {ta}'}).json()['data']['user_id'] == ua['id']
        assert py.post('/api/v1/auth/verify', headers={'Authorization': f'Bearer {tb}'}).json()['data']['user_id'] == ub['id']
    finally:
        db = open_primary(config)
        db.execute('DELETE FROM users WHERE email IN (?, ?)', [email_a, email_b])
        db.close()
```

- [ ] **Step 7: Run the differential tests**

Run: `pytest tests/differential/test_auth.py -q`
Expected: 6 passed. If `test_debug_auth` fails on `php_version`, read the PHP value from the failure and update `PHP_VERSION` in `auth_controller.py`.

- [ ] **Step 8: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): AuthController — login/register/verify/sso/app-keys, cross-backend parity tests"
```

### Task 8: Firebase ID token verification

**Files:**
- Replace stub: `backend_python/app/services/firebase_tokens.py`
- Test: `backend_python/tests/unit/test_firebase_tokens.py`, add cases to `backend_python/tests/differential/test_auth.py`

**Interfaces:**
- Consumes: nothing new (httpx, PyJWT[crypto]).
- Produces: `verify_firebase_id_token(id_token: str, project_id: str, *, fetch_certs=None, now=None) -> dict | None`. Mirrors `AuthController::verifyFirebaseIdToken`: RS256 verify against `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`, key chosen by header `kid`, certs cached in `tempfile.gettempdir()/gpt_firebase_securetoken_certs.json` for 3600 s, then `aud == project_id`, `iss == 'https://securetoken.google.com/' + project_id`, non-empty `sub`. Returns claims dict or `None` (never raises).

- [ ] **Step 1: Write the failing tests** (self-signed RSA key stands in for Google's cert)

`tests/unit/test_firebase_tokens.py`:
```python
import datetime as dt
import time
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from app.services import firebase_tokens as ft

PROJECT = 'transledgersite'


def _keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'securetoken.system.gserviceaccount.com')])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(dt.datetime.now(dt.UTC) - dt.timedelta(days=1))
            .not_valid_after(dt.datetime.now(dt.UTC) + dt.timedelta(days=1)).sign(key, hashes.SHA256()))
    return key, cert.public_bytes(serialization.Encoding.PEM).decode()


def _token(key, kid, **over):
    now = int(time.time())
    claims = {'iss': f'https://securetoken.google.com/{PROJECT}', 'aud': PROJECT, 'sub': 'uid-1',
              'iat': now, 'exp': now + 600, 'email': 'U@Example.com', **over}
    return jwt.encode(claims, key, algorithm='RS256', headers={'kid': kid})


def test_valid_token_returns_claims(tmp_path, monkeypatch):
    key, pem = _keypair()
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs.json')
    claims = ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=lambda: {'k1': pem})
    assert claims['sub'] == 'uid-1' and claims['email'] == 'U@Example.com'
    assert (tmp_path / 'certs.json').is_file()          # cached


def test_cache_is_used_within_an_hour(tmp_path, monkeypatch):
    key, pem = _keypair()
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs.json')
    calls = []
    fetch = lambda: (calls.append(1), {'k1': pem})[1]
    assert ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=fetch)
    assert ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=fetch)
    assert len(calls) == 1


def test_rejections(tmp_path, monkeypatch):
    key, pem = _keypair()
    other, _ = _keypair()
    monkeypatch.setattr(ft, 'CACHE_FILE', tmp_path / 'certs.json')
    certs = lambda: {'k1': pem}
    assert ft.verify_firebase_id_token(_token(other, 'k1'), PROJECT, fetch_certs=certs) is None      # bad signature
    assert ft.verify_firebase_id_token(_token(key, 'k9'), PROJECT, fetch_certs=certs) is None         # unknown kid
    assert ft.verify_firebase_id_token(_token(key, 'k1', aud='x'), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1', iss='https://evil'), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1', sub=''), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1', exp=int(time.time()) - 5), PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token('garbage', PROJECT, fetch_certs=certs) is None
    assert ft.verify_firebase_id_token(_token(key, 'k1'), PROJECT, fetch_certs=lambda: (_ for _ in ()).throw(OSError())) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_firebase_tokens.py -q`
Expected: FAIL (stub returns None / no CACHE_FILE attribute)

- [ ] **Step 3: Implement `app/services/firebase_tokens.py`**

```python
"""Port of AuthController::googleSecureTokenKeys() + verifyFirebaseIdToken()."""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import httpx
import jwt
from cryptography import x509

CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
CACHE_FILE = Path(tempfile.gettempdir()) / 'gpt_firebase_securetoken_certs.json'
CACHE_TTL = 3600


def _default_fetch() -> dict:
    r = httpx.get(CERTS_URL, timeout=10)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict) or not data:
        raise RuntimeError('Unable to fetch Google secure token certificates')
    return data


def google_secure_token_certs(fetch_certs=None) -> dict:
    certs = None
    try:
        if CACHE_FILE.is_file() and (time.time() - CACHE_FILE.stat().st_mtime) < CACHE_TTL:
            decoded = json.loads(CACHE_FILE.read_text())
            if isinstance(decoded, dict) and decoded:
                certs = decoded
    except (OSError, ValueError):
        certs = None
    if certs is None:
        certs = (fetch_certs or _default_fetch)()
        try:
            CACHE_FILE.write_text(json.dumps(certs))
        except OSError:
            pass
    return certs


def verify_firebase_id_token(id_token: str, project_id: str, *, fetch_certs=None) -> dict | None:
    from app.support.logger import error_log
    try:
        certs = google_secure_token_certs(fetch_certs)
        kid = jwt.get_unverified_header(id_token).get('kid')
        pem = certs.get(kid)
        if not pem:
            raise jwt.InvalidTokenError('unknown kid')
        public_key = x509.load_pem_x509_certificate(pem.encode()).public_key()
        claims = jwt.decode(id_token, public_key, algorithms=['RS256'], options={'verify_aud': False})
        if claims.get('aud', '') != project_id:
            return None
        if claims.get('iss', '') != 'https://securetoken.google.com/' + project_id:
            return None
        if str(claims.get('sub', '') or '') == '':
            return None
        return claims
    except Exception as e:  # noqa: BLE001
        error_log(f'[AuthController] Firebase ID token verification failed: {e}')
        return None
```

- [ ] **Step 4: Run unit tests**

Run: `pytest tests/unit/test_firebase_tokens.py -q`
Expected: 3 passed

- [ ] **Step 5: Add differential reject-parity cases** (append to `tests/differential/test_auth.py`)

```python
def test_firebase_reject_parity(both):
    same(*both('POST', '/api/v1/auth/firebase', json={'provider': 'google', 'idToken': ''}, auth=False))
    same(*both('POST', '/api/v1/auth/firebase', json={'provider': 'google', 'idToken': 'garbage'}, auth=False))
    forged = ('eyJhbGciOiJSUzI1NiIsImtpZCI6Im5vcGUifQ.'
              'eyJhdWQiOiJ0cmFuc2xlZGdlcnNpdGUiLCJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vdHJhbnNsZWRnZXJzaXRlIiwic3ViIjoieCJ9.'
              'c2ln')
    same(*both('POST', '/api/v1/auth/firebase', json={'provider': 'google', 'idToken': forged}, auth=False))
```

Run: `pytest tests/differential/test_auth.py -q` → 7 passed (the forged case reaches Google for certs on both sides; network required).

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): Firebase ID token verification with cached Google certs"
```

### Task 9: PromptLibraryController and ContextController

**Files:**
- Replace stubs: `backend_python/app/controllers/prompt_library_controller.py`, `backend_python/app/controllers/context_controller.py`
- Test: `backend_python/tests/unit/test_prompt_context_controllers.py`, `backend_python/tests/differential/test_prompts_contexts.py`

**Interfaces:**
- Consumes: `Db`, `ucfirst`, `mb_substr`.
- Produces: `PromptLibraryController(db, config)` with `getTree(request)`, `get(request, id)`, `create(request)`, `update(request, id)`, `delete(request, id)`; `ContextController(db, config)` with `list, get, create, update, delete` (same signatures).

PHP quirks to keep (parity tracker B.10 and new lines in Task 13):
- `PromptLibraryController::create` returns `data.id` as the raw `lastInsertId()` **string** (`"123"`); `ContextController::create` casts to int. Mirror both.
- `buildTree` compares `parent_id == $parentId` loosely (`null == null`, `"3" == 3`), drops orphans, adds `children` only when non-empty.
- `ContextController::create` with `id` set is an upsert by `UPDATE ... WHERE id = ? AND user_id = ?` and reports success even when 0 rows match.
- `ContextController::update` / `delete` use `rowCount() === 0` → 404. Note MySQL `UPDATE` with an identical title reports 0 affected rows unless `CLIENT_FOUND_ROWS` is set; PDO MySQL sets `FOUND_ROWS` by default, so PHP returns 200 there. Set `client_flag=CLIENT.FOUND_ROWS` in `Db.connect` to match (add to Task 2's `pymysql.connect(...)`: `client_flag=pymysql.constants.CLIENT.FOUND_ROWS`).

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/test_prompt_context_controllers.py`:
```python
import json
from starlette.datastructures import Headers
from app.controllers.prompt_library_controller import PromptLibraryController, build_tree
from app.controllers.context_controller import ContextController
from app.support.http import Ctx


class FakeDb:
    def __init__(self, one=None, all_=None, rowcount=1, insert_id=55):
        self.one = list(one or []); self.all_ = list(all_ or []); self.rowcount = rowcount
        self.insert_id = insert_id; self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one.pop(0) if self.one else None
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return self.all_.pop(0) if self.all_ else []
    def execute(self, s, p=None): self.calls.append((s, p)); return self.rowcount
    def insert(self, s, p=None): self.calls.append((s, p)); return self.insert_id


def ctx(body=None, user_id=3):
    return Ctx(method='POST', uri='/', headers=Headers({}), query={}, body=body or {}, raw_body='', params={},
               user_id=user_id, authenticated=True, remote_addr='')


def test_build_tree_loose_match_drops_orphans_and_children_only_when_present():
    items = [{'id': 1, 'parent_id': None, 'name': 'root'}, {'id': 2, 'parent_id': 1, 'name': 'c'},
             {'id': 3, 'parent_id': 99, 'name': 'orphan'}, {'id': 4, 'parent_id': '1', 'name': 'str-parent'}]
    tree = build_tree(items)
    assert [n['id'] for n in tree] == [1]
    assert [c['id'] for c in tree[0]['children']] == [2, 4]
    assert 'children' not in tree[0]['children'][0]


def test_prompt_create_validation_and_string_id():
    c = PromptLibraryController(FakeDb(), {})
    assert c.create(ctx({'type': 'x', 'name': 'n'}))['message'] == 'Valid type (folder or prompt) is required'
    assert c.create(ctx({'type': 'prompt'}))['message'] == 'Name is required'
    db = FakeDb(one=[None])
    assert PromptLibraryController(db, {}).create(ctx({'type': 'prompt', 'name': 'n', 'parent_id': 9}))['message'] == 'Parent folder not found'
    r = PromptLibraryController(FakeDb(insert_id=55), {}).create(ctx({'type': 'folder', 'name': ' F ', 'content': 'ignored'}))
    assert r == {'success': True, 'message': 'Folder created successfully',
                 'data': {'id': '55', 'type': 'folder', 'name': 'F', 'parent_id': None, 'content': None}, 'status_code': 200}


def test_prompt_update_builds_dynamic_set():
    db = FakeDb(one=[{'id': 5, 'type': 'prompt'}])
    r = PromptLibraryController(db, {}).update(ctx({'name': ' N ', 'sort_order': 2}), 5)
    assert r == {'success': True, 'message': 'Prompt updated successfully', 'data': {'id': 5}, 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == 'UPDATE prompt_library SET name = ?, sort_order = ? WHERE id = ? AND user_id = ?' and params == ['N', 2, 5, 3]
    db2 = FakeDb(one=[{'id': 5, 'type': 'prompt'}])
    assert PromptLibraryController(db2, {}).update(ctx({'name': '  '}), 5)['message'] == 'No fields to update'
    assert PromptLibraryController(FakeDb(one=[None]), {}).update(ctx({'name': 'x'}), 5)['status_code'] == 404


def test_context_create_derives_title_provider_count_and_int_id():
    db = FakeDb(insert_id=9)
    msgs = [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'é' * 150},
            {'role': 'assistant', 'content': 'a', 'provider': 'claude'}, {'role': 'assistant', 'content': 'b'}]
    r = ContextController(db, {}).create(ctx({'messages': msgs, 'metadata': {'k': 1}}))
    assert r == {'success': True, 'message': 'Context created successfully', 'data': {'id': 9}, 'status_code': 200}
    sql, params = db.calls[-1]
    assert params[1] == 'é' * 100 and params[3] == 'claude' and params[4] == 4
    assert json.loads(params[2]) == {'messages': msgs, 'metadata': {'k': 1}}
    assert ContextController(FakeDb(), {}).create(ctx({'messages': []}))['message'] == 'Messages array is required'
    r2 = ContextController(FakeDb(), {}).create(ctx({'id': 4, 'messages': [{'role': 'assistant', 'content': 'x'}]}))
    assert r2['message'] == 'Context updated successfully' and r2['data'] == {'id': 4}


def test_context_get_decodes_json_and_update_delete_404_on_zero_rows():
    db = FakeDb(one=[{'id': 1, 'title': 't', 'context_data': '{"messages":[]}', 'provider': 'p', 'message_count': 0,
                      'created_at': 'c', 'updated_at': 'u'}])
    r = ContextController(db, {}).get(ctx(), 1)
    assert r['data']['context_data'] == {'messages': []}
    assert ContextController(FakeDb(rowcount=0), {}).update(ctx({'title': 'x'}), 1)['status_code'] == 404
    assert ContextController(FakeDb(rowcount=0), {}).delete(ctx(), 1)['status_code'] == 404
    assert ContextController(FakeDb(), {}).update(ctx({'title': ' '}), 1)['message'] == 'Title is required'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_prompt_context_controllers.py -q`
Expected: ImportError (`build_tree`)

- [ ] **Step 3: Implement `app/controllers/prompt_library_controller.py`**

```python
"""Port of Controllers/PromptLibraryController.php."""
from __future__ import annotations

from app.support.phpcompat import ucfirst

_SELECT = ('SELECT id, parent_id, type, name, content, sort_order, created_at, updated_at'
           ' FROM prompt_library')


def _loose_eq(a, b) -> bool:
    """PHP `==` for the parent_id comparison: null==null, "3"==3, 3==3."""
    if a is None or b is None:
        return a is None and b is None
    try:
        return int(a) == int(b)
    except (TypeError, ValueError):
        return str(a) == str(b)


def build_tree(items: list[dict], parent_id=None) -> list[dict]:
    branch = []
    for item in items:
        if _loose_eq(item.get('parent_id'), parent_id):
            node = dict(item)
            children = build_tree(items, int(item['id']))
            if children:
                node['children'] = children
            branch.append(node)
    return branch


class PromptLibraryController:
    def __init__(self, db, config):
        self.db = db
        self.config = config

    def getTree(self, request) -> dict:
        items = self.db.fetch_all(_SELECT + ' WHERE user_id = ? ORDER BY parent_id, sort_order, name',
                                  [request['user_id']])
        return {'success': True, 'data': build_tree(items), 'status_code': 200}

    def get(self, request, id: int) -> dict:
        item = self.db.fetch_one(_SELECT + ' WHERE id = ? AND user_id = ?', [id, request['user_id']])
        if not item:
            return {'success': False, 'message': 'Item not found', 'status_code': 404}
        return {'success': True, 'data': item, 'status_code': 200}

    def create(self, request) -> dict:
        user_id = request['user_id']
        inp = request['body']
        if not inp.get('type') or inp['type'] not in ('folder', 'prompt'):
            return {'success': False, 'message': 'Valid type (folder or prompt) is required', 'status_code': 400}
        if not inp.get('name'):
            return {'success': False, 'message': 'Name is required', 'status_code': 400}
        type_ = inp['type']
        name = str(inp['name']).strip()
        parent_id = inp.get('parent_id')
        content = inp['content'] if (type_ == 'prompt' and 'content' in inp) else None
        sort_order = inp.get('sort_order', 0)
        if parent_id is not None:
            if not self.db.fetch_one('SELECT id FROM prompt_library WHERE id = ? AND user_id = ?', [parent_id, user_id]):
                return {'success': False, 'message': 'Parent folder not found', 'status_code': 400}
        new_id = self.db.insert(
            'INSERT INTO prompt_library (user_id, parent_id, type, name, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, parent_id, type_, name, content, sort_order])
        return {'success': True, 'message': ucfirst(type_) + ' created successfully',
                'data': {'id': str(new_id), 'type': type_, 'name': name, 'parent_id': parent_id, 'content': content},
                'status_code': 200}

    def update(self, request, id: int) -> dict:
        user_id = request['user_id']
        inp = request['body']
        item = self.db.fetch_one('SELECT id, type FROM prompt_library WHERE id = ? AND user_id = ?', [id, user_id])
        if not item:
            return {'success': False, 'message': 'Item not found', 'status_code': 404}
        updates, params = [], []
        if inp.get('name') is not None and str(inp['name']).strip():
            updates.append('name = ?'); params.append(str(inp['name']).strip())
        if inp.get('content') is not None:
            updates.append('content = ?'); params.append(inp['content'])
        if inp.get('parent_id') is not None:
            updates.append('parent_id = ?'); params.append(inp['parent_id'])
        if inp.get('sort_order') is not None:
            updates.append('sort_order = ?'); params.append(inp['sort_order'])
        if not updates:
            return {'success': False, 'message': 'No fields to update', 'status_code': 400}
        params += [id, user_id]
        self.db.execute('UPDATE prompt_library SET ' + ', '.join(updates) + ' WHERE id = ? AND user_id = ?', params)
        return {'success': True, 'message': ucfirst(item['type']) + ' updated successfully', 'data': {'id': id},
                'status_code': 200}

    def delete(self, request, id: int) -> dict:
        user_id = request['user_id']
        item = self.db.fetch_one('SELECT id, type, name FROM prompt_library WHERE id = ? AND user_id = ?', [id, user_id])
        if not item:
            return {'success': False, 'message': 'Item not found', 'status_code': 404}
        self.db.execute('DELETE FROM prompt_library WHERE id = ? AND user_id = ?', [id, user_id])
        return {'success': True, 'message': ucfirst(item['type']) + ' deleted successfully', 'status_code': 200}
```

PHP `isset($x)` is false for null, so `.get(k) is not None` is the right translation everywhere above.

- [ ] **Step 4: Implement `app/controllers/context_controller.py`**

```python
"""Port of Controllers/ContextController.php."""
from __future__ import annotations

import json

from app.support.phpcompat import mb_substr


class ContextController:
    def __init__(self, db, config):
        self.db = db
        self.config = config

    def list(self, request) -> dict:
        rows = self.db.fetch_all(
            'SELECT id, title, provider, message_count, created_at, updated_at FROM conversation_contexts'
            ' WHERE user_id = ? ORDER BY updated_at DESC', [request['user_id']])
        return {'success': True, 'data': rows, 'status_code': 200}

    def get(self, request, id: int) -> dict:
        row = self.db.fetch_one(
            'SELECT id, title, context_data, provider, message_count, created_at, updated_at'
            ' FROM conversation_contexts WHERE id = ? AND user_id = ?', [id, request['user_id']])
        if not row:
            return {'success': False, 'message': 'Context not found', 'status_code': 404}
        try:
            row['context_data'] = json.loads(row['context_data']) if row['context_data'] is not None else None
        except ValueError:
            row['context_data'] = None
        return {'success': True, 'data': row, 'status_code': 200}

    def create(self, request) -> dict:
        user_id = request['user_id']
        inp = request['body']
        messages = inp.get('messages')
        if not messages or not isinstance(messages, list):
            return {'success': False, 'message': 'Messages array is required', 'status_code': 400}
        context_id = inp.get('id')
        metadata = inp.get('metadata', [])
        title = ''
        for msg in messages:
            if msg.get('role') == 'user':
                title = mb_substr(str(msg.get('content', '')), 0, 100)
                break
        if not title:
            title = 'Untitled Conversation'
        provider = 'unknown'
        for msg in reversed(messages):
            if msg.get('role') == 'assistant' and msg.get('provider'):
                provider = msg['provider']
                break
        message_count = len(messages)
        context_data = json.dumps({'messages': messages, 'metadata': metadata}, ensure_ascii=False,
                                  separators=(',', ':'))
        if context_id:
            self.db.execute(
                'UPDATE conversation_contexts SET title = ?, context_data = ?, provider = ?, message_count = ?,'
                ' updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                [title, context_data, provider, message_count, context_id, user_id])
            return {'success': True, 'message': 'Context updated successfully', 'data': {'id': context_id},
                    'status_code': 200}
        new_id = self.db.insert(
            'INSERT INTO conversation_contexts (user_id, title, context_data, provider, message_count)'
            ' VALUES (?, ?, ?, ?, ?)', [user_id, title, context_data, provider, message_count])
        return {'success': True, 'message': 'Context created successfully', 'data': {'id': int(new_id)},
                'status_code': 200}

    def update(self, request, id: int) -> dict:
        inp = request['body']
        if inp.get('title') is None or str(inp['title']).strip() == '':
            return {'success': False, 'message': 'Title is required', 'status_code': 400}
        n = self.db.execute('UPDATE conversation_contexts SET title = ? WHERE id = ? AND user_id = ?',
                            [str(inp['title']).strip(), id, request['user_id']])
        if n == 0:
            return {'success': False, 'message': 'Context not found', 'status_code': 404}
        return {'success': True, 'message': 'Context updated successfully', 'status_code': 200}

    def delete(self, request, id: int) -> dict:
        n = self.db.execute('DELETE FROM conversation_contexts WHERE id = ? AND user_id = ?', [id, request['user_id']])
        if n == 0:
            return {'success': False, 'message': 'Context not found', 'status_code': 404}
        return {'success': True, 'message': 'Context deleted successfully', 'status_code': 200}
```

PHP stores `context_data` with `JSON_UNESCAPED_UNICODE` but escaped slashes; the stored bytes differ only in `\/` vs `/`, which decodes identically on read (tracker line in Task 13). `metadata` default `[]` mirrors PHP (`[]` encodes as `[]`, an empty object would be `{}`); keep the list.

- [ ] **Step 5: Add `client_flag=CLIENT.FOUND_ROWS` to `Db.connect`** (Task 2 file)

In `app/db.py`: `from pymysql.constants import CLIENT` and pass `client_flag=CLIENT.FOUND_ROWS` to `pymysql.connect(...)`.

- [ ] **Step 6: Run unit tests**

Run: `pytest tests/unit -q`
Expected: all passed (previous suites + 5 new)

- [ ] **Step 7: Write the differential tests** (create → read → update → delete round trip on both, compare each step; clean up)

`tests/differential/test_prompts_contexts.py`:
```python
import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_prompt_tree_and_404s(both):
    same(*both('GET', '/api/v1/prompts'))
    same(*both('GET', '/api/v1/prompts/999999999'))
    same(*both('PUT', '/api/v1/prompts/999999999', json={'name': 'x'}))
    same(*both('DELETE', '/api/v1/prompts/999999999'))
    same(*both('POST', '/api/v1/prompts', json={'type': 'x', 'name': 'n'}))
    same(*both('POST', '/api/v1/prompts', json={'type': 'prompt'}))
    same(*both('POST', '/api/v1/prompts', json={'type': 'prompt', 'name': 'n', 'parent_id': 999999999}))


def test_prompt_crud_round_trip_each_backend(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        r = c.post('/api/v1/prompts', json={'type': 'folder', 'name': 'diff-folder'}, headers=h)
        assert r.status_code == 200 and isinstance(r.json()['data']['id'], str), r.text
        fid = int(r.json()['data']['id'])
        try:
            r2 = c.post('/api/v1/prompts', json={'type': 'prompt', 'name': 'p', 'content': 'c/é', 'parent_id': fid}, headers=h)
            pid = int(r2.json()['data']['id'])
            got = c.get(f'/api/v1/prompts/{pid}', headers=h).json()['data']
            assert got['content'] == 'c/é' and got['parent_id'] == fid
            assert c.put(f'/api/v1/prompts/{pid}', json={'content': 'c2'}, headers=h).json()['message'] == 'Prompt updated successfully'
            assert c.put(f'/api/v1/prompts/{pid}', json={}, headers=h).status_code == 400
            tree = c.get('/api/v1/prompts', headers=h).json()['data']
            folder = next(n for n in tree if n['id'] == fid)
            assert folder['children'][0]['id'] == pid
            assert c.delete(f'/api/v1/prompts/{pid}', headers=h).json()['message'] == 'Prompt deleted successfully'
        finally:
            c.delete(f'/api/v1/prompts/{fid}', headers=h)


def test_context_list_and_404s(both):
    same(*both('GET', '/api/v1/contexts'))
    same(*both('GET', '/api/v1/contexts/999999999'))
    same(*both('PUT', '/api/v1/contexts/999999999', json={'title': 'x'}))
    same(*both('DELETE', '/api/v1/contexts/999999999'))
    same(*both('POST', '/api/v1/contexts', json={'messages': []}))
    same(*both('PUT', '/api/v1/contexts/1', json={'title': ' '}))


def test_context_round_trip_each_backend(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    msgs = [{'role': 'user', 'content': 'hello/é'}, {'role': 'assistant', 'content': 'hi', 'provider': 'claude'}]
    for c in (php, py):
        r = c.post('/api/v1/contexts', json={'messages': msgs, 'metadata': {'m': 1}}, headers=h)
        assert r.status_code == 200 and isinstance(r.json()['data']['id'], int), r.text
        cid = r.json()['data']['id']
        try:
            got = c.get(f'/api/v1/contexts/{cid}', headers=h).json()['data']
            assert got['title'] == 'hello/é' and got['provider'] == 'claude' and got['message_count'] == 2
            assert got['context_data'] == {'messages': msgs, 'metadata': {'m': 1}}
            assert c.put(f'/api/v1/contexts/{cid}', json={'title': 'renamed'}, headers=h).status_code == 200
            assert c.put(f'/api/v1/contexts/{cid}', json={'title': 'renamed'}, headers=h).status_code == 200  # FOUND_ROWS
            up = c.post('/api/v1/contexts', json={'id': cid, 'messages': msgs + [{'role': 'user', 'content': 'x'}]}, headers=h)
            assert up.json()['message'] == 'Context updated successfully'
        finally:
            assert c.delete(f'/api/v1/contexts/{cid}', headers=h).status_code == 200
```

- [ ] **Step 8: Run the differential tests**

Run: `pytest tests/differential/test_prompts_contexts.py -q`
Expected: 4 passed

- [ ] **Step 9: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): PromptLibraryController + ContextController with round-trip parity tests"
```

### Task 10: PackageResolver and PackageController

**Files:**
- Create: `backend_python/app/services/package_resolver.py`
- Replace stub: `backend_python/app/controllers/package_controller.py`
- Test: `backend_python/tests/unit/test_package.py`, `backend_python/tests/differential/test_package.py`

**Interfaces:**
- Consumes: `Db`, `is_numeric`.
- Produces: `PackageResolver(db)` with `resolveForUser(user_id: int | None) -> dict`, `resolveRole(user_id) -> str`, `loadPackage(role) -> dict(role, capabilities, updated_at)` (per-instance cache), `allowedMcpServers(user_id) -> list[str] | None`, classmethod `validRoles() -> list[str]` = `['guest','prospect','user','admin']`. Reused by `ProviderController` (Phase 2) and MCP controllers (Phase 3).
- Produces: `PackageController(db, config)` with `me(request)`, `adminList(request)`, `adminGet(request, role: str)`, `adminUpdate(request, role: str)`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_package.py`:
```python
from starlette.datastructures import Headers
from app.services.package_resolver import PackageResolver
from app.controllers.package_controller import PackageController
from app.support.http import Ctx


class FakeDb:
    def __init__(self, one=None): self.one = list(one or []); self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one.pop(0) if self.one else None
    def execute(self, s, p=None): self.calls.append((s, p)); return 1


def ctx(body=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query={}, body=body or {}, raw_body='', params={},
               user_id=user_id, authenticated=user_id is not None, remote_addr='')


def test_resolver_guest_when_anonymous_unknown_or_bad_role():
    assert PackageResolver(FakeDb()).resolveRole(None) == 'guest'
    assert PackageResolver(FakeDb(one=[None])).resolveRole(5) == 'guest'
    assert PackageResolver(FakeDb(one=[{'role': 'affiliate'}])).resolveRole(5) == 'guest'
    assert PackageResolver(FakeDb(one=[{'role': 'admin'}])).resolveRole(5) == 'admin'


def test_load_package_defaults_and_cache():
    db = FakeDb(one=[None])
    r = PackageResolver(db)
    p = r.loadPackage('user')
    assert p == {'role': 'user', 'capabilities': {'providers': {}, 'mcp_servers': None, 'skills': None,
                                                  'sidebar': {}, 'quota_tokens': None, 'voice': False, 'avatar': False},
                 'updated_at': None}
    assert r.loadPackage('user') is p and len(db.calls) == 1
    db2 = FakeDb(one=[{'capabilities': '{"providers":{"claude":{"enabled":true}},"sidebar":{},"mcp_servers":["a",3]}',
                       'updated_at': '2026-01-01 00:00:00'}])
    r2 = PackageResolver(db2)
    assert r2.loadPackage('bogus')['role'] == 'guest'
    assert r2.allowedMcpServers(None) == ['a']


def test_me_and_admin_gates():
    db = FakeDb(one=[{'role': 'user'}, None])
    r = PackageController(db, {}).me(ctx())
    assert r['role'] == 'user' and r['success'] is True and 'status_code' not in r
    assert PackageController(FakeDb(), {}).adminList(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert PackageController(FakeDb(one=[{'role': 'user'}]), {}).adminList(ctx()) == {
        'success': False, 'error': 'Admin access required', 'status_code': 403}
    assert PackageController(FakeDb(one=[{'role': 'admin'}]), {}).adminGet(ctx(), 'nope') == {
        'success': False, 'error': 'Invalid role', 'status_code': 400}


def test_admin_update_validation():
    def c(): return PackageController(FakeDb(one=[{'role': 'admin'}]), {})
    assert c().adminUpdate(ctx({}), 'user')['error'] == 'capabilities object is required'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}}}), 'user')['error'] == 'capabilities.sidebar must be object'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}, 'sidebar': {}, 'skills': 'x'}}), 'user')['error'] == 'capabilities.skills must be null or an array'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}, 'sidebar': {}, 'quota_tokens': 1.5}}), 'user')['error'] == 'capabilities.quota_tokens must be null or an integer'
```

Note the PHP message is literally `"capabilities.{$required} must be an object"` — fix the second assertion to `'capabilities.sidebar must be an object'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_package.py -q`
Expected: ImportError

- [ ] **Step 3: Implement `app/services/package_resolver.py`**

```python
"""Port of Services/PackageResolver.php."""
from __future__ import annotations

import json

VALID_ROLES = ['guest', 'prospect', 'user', 'admin']


class PackageResolver:
    def __init__(self, db):
        self.db = db
        self._cache: dict[str, dict] = {}

    def resolveForUser(self, user_id: int | None) -> dict:
        return self.loadPackage(self.resolveRole(user_id))

    def resolveRole(self, user_id: int | None) -> str:
        if user_id is None:
            return 'guest'
        row = self.db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': user_id})
        if not row or row.get('role') not in VALID_ROLES:
            return 'guest'
        return str(row['role'])

    def loadPackage(self, role: str) -> dict:
        if role not in VALID_ROLES:
            role = 'guest'
        if role in self._cache:
            return self._cache[role]
        row = self.db.fetch_one('SELECT capabilities, updated_at FROM packages WHERE role = :role LIMIT 1', {':role': role})
        if not row:
            capabilities = {'providers': {}, 'mcp_servers': None, 'skills': None, 'sidebar': {},
                            'quota_tokens': None, 'voice': False, 'avatar': False}
            updated_at = None
        else:
            try:
                decoded = json.loads(str(row['capabilities']))
            except ValueError:
                decoded = None
            capabilities = decoded if isinstance(decoded, dict) else {}
            updated_at = row['updated_at']
        package = {'role': role, 'capabilities': capabilities, 'updated_at': updated_at}
        self._cache[role] = package
        return package

    @classmethod
    def validRoles(cls) -> list[str]:
        return list(VALID_ROLES)

    def allowedMcpServers(self, user_id: int | None) -> list[str] | None:
        lst = (self.resolveForUser(user_id).get('capabilities') or {}).get('mcp_servers')
        if lst is None:
            return None
        if not isinstance(lst, list):
            return []
        return [s for s in lst if isinstance(s, str)]
```

PHP's default `providers => []` and `sidebar => []` encode as JSON `[]`, not `{}`. To be byte-faithful, the default capabilities should use **empty lists** for `providers` and `sidebar`. Change both to `[]` in the code above and in the unit test expectation. (The frontend treats both as "nothing configured".)

- [ ] **Step 4: Implement `app/controllers/package_controller.py`**

```python
"""Port of Controllers/PackageController.php."""
from __future__ import annotations

import json

from app.services.package_resolver import PackageResolver
from app.support.phpcompat import is_numeric


class PackageController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.resolver = PackageResolver(db)

    def me(self, request) -> dict:
        uid = request.get('user_id')
        package = self.resolver.resolveForUser(int(uid) if is_numeric(uid) else None)
        return {'success': True, 'role': package['role'], 'capabilities': package['capabilities'],
                'updated_at': package['updated_at']}

    def adminList(self, request) -> dict:
        err = self._require_admin(request)
        if err:
            return err
        return {'success': True, 'packages': [self.resolver.loadPackage(r) for r in PackageResolver.validRoles()]}

    def adminGet(self, request, role: str) -> dict:
        err = self._require_admin(request)
        if err:
            return err
        if role not in PackageResolver.validRoles():
            return {'success': False, 'error': 'Invalid role', 'status_code': 400}
        return {'success': True, 'package': self.resolver.loadPackage(role)}

    def adminUpdate(self, request, role: str) -> dict:
        err = self._require_admin(request)
        if err:
            return err
        if role not in PackageResolver.validRoles():
            return {'success': False, 'error': 'Invalid role', 'status_code': 400}
        caps = (request.get('body') or {}).get('capabilities')
        if not isinstance(caps, (dict, list)):
            return {'success': False, 'error': 'capabilities object is required', 'status_code': 400}
        v = self._validate_capabilities(caps)
        if v is not None:
            return {'success': False, 'error': v, 'status_code': 400}
        encoded = json.dumps(caps, ensure_ascii=False, separators=(',', ':'))
        admin_id = int(request['user_id']) if is_numeric(request.get('user_id')) else None
        self.db.execute(
            'INSERT INTO packages (role, capabilities, updated_by) VALUES (:role, :caps, :uid)'
            ' ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), updated_by = VALUES(updated_by)',
            {':role': role, ':caps': encoded, ':uid': admin_id})
        self.resolver = PackageResolver(self.db)   # PHP re-reads because loadPackage cache is per request
        return {'success': True, 'package': self.resolver.loadPackage(role)}

    def _require_admin(self, request) -> dict | None:
        uid = request.get('user_id')
        if not uid:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        user = self.db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': uid})
        if not user or (user.get('role') or '') != 'admin':
            return {'success': False, 'error': 'Admin access required', 'status_code': 403}
        return None

    @staticmethod
    def _validate_capabilities(caps) -> str | None:
        if isinstance(caps, list):
            caps = {}   # PHP array with no keys: required keys missing → first error below
        for required in ('providers', 'sidebar'):
            if required not in caps or not isinstance(caps[required], (dict, list)):
                return f'capabilities.{required} must be an object'
        for optional in ('mcp_servers', 'skills'):
            if optional in caps and caps[optional] is not None and not isinstance(caps[optional], (dict, list)):
                return f'capabilities.{optional} must be null or an array'
        if 'quota_tokens' in caps and caps['quota_tokens'] is not None and \
                (isinstance(caps['quota_tokens'], bool) or not isinstance(caps['quota_tokens'], int)):
            return 'capabilities.quota_tokens must be null or an integer'
        return None
```

Careful: in PHP, `adminUpdate` calls `$this->resolver->loadPackage($role)` on the SAME resolver, whose cache was **not** populated before the write in this request (the `requireAdmin` path does not touch packages), so it reads fresh. Re-instantiating the resolver here yields the same result and protects against a cache hit if the method is ever called twice on one instance.

- [ ] **Step 5: Run unit tests**

Run: `pytest tests/unit/test_package.py -q`
Expected: 4 passed

- [ ] **Step 6: Differential tests** — `tests/differential/test_package.py`:
```python
import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_me_and_admin_reads(both):
    same(*both('GET', '/api/v1/me/package'))
    same(*both('GET', '/api/v1/me/package', auth=False))          # 401 (protected route)
    same(*both('GET', '/api/v1/admin/packages'))                  # 200 for admin user 3, else 403 — same on both
    same(*both('GET', '/api/v1/admin/packages/user'))
    same(*both('GET', '/api/v1/admin/packages/bogus'))            # 404 route (regex [a-z]+ matches; 400 invalid role)
    same(*both('PUT', '/api/v1/admin/packages/user', json={}))
    same(*both('PUT', '/api/v1/admin/packages/user', json={'capabilities': {'providers': {}}}))
```

Run: `pytest tests/differential/test_package.py -q` → 1 passed. (No write test: `adminUpdate` with valid capabilities would mutate the shared `packages` table; the validation matrix covers the code path up to the write.)

- [ ] **Step 7: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): PackageResolver + PackageController"
```

### Task 11: WebAuthnController

**Files:**
- Replace stub: `backend_python/app/controllers/webauthn_controller.py`
- Test: `backend_python/tests/unit/test_webauthn_controller.py`, `backend_python/tests/differential/test_webauthn.py`

**Interfaces:**
- Consumes: `generate_tokens` (Task 7), `b64url_encode`, `php_now`.
- Produces: `WebAuthnController(db, config)` with `challenge, register, authenticate, delete` (each `(request) -> dict`).

Behavior to mirror exactly (this controller does NOT cryptographically verify assertions in PHP either — tracker line in Task 13):
- `challenge`: 32 random bytes, base64url; stored via `INSERT ... ON DUPLICATE KEY UPDATE` only when `user_id !== 0`; `rp_id` from `config['webauthn']['rp_id']` else the `Host` header else `'localhost'`, with a trailing `:port` stripped; `rp_name` default `'Voice Assistant'`.
- `authenticate` returns `token` (access only) and `user.id` as a **string**.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/test_webauthn_controller.py`:
```python
import jwt
from starlette.datastructures import Headers
from app.controllers.webauthn_controller import WebAuthnController
from app.support.http import Ctx

CONFIG = {'auth': {'jwt_secret': 's', 'jwt_expiry': 28800, 'refresh_expiry': 604800}}


class FakeDb:
    def __init__(self, one=None, all_=None, rowcount=1):
        self.one = list(one or []); self.all_ = list(all_ or []); self.rowcount = rowcount; self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one.pop(0) if self.one else None
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return self.all_.pop(0) if self.all_ else []
    def execute(self, s, p=None): self.calls.append((s, p)); return self.rowcount
    def insert(self, s, p=None): self.calls.append((s, p)); return 1


def ctx(body=None, user_id=None, host='localhost:3002'):
    c = Ctx(method='POST', uri='/', headers=Headers({'host': host}), query={}, body=body or {}, raw_body='',
            params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    if user_id is None:
        del c['user_id']   # PHP: isset($request['user_id']) false for public routes w/o token? No — middleware
        c['user_id'] = None  # sets user_id=null on public routes; keep the key, value None.
    return c


def test_challenge_register_requires_auth_and_authenticate_by_email():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.challenge(ctx({'action': 'register'}))['status_code'] == 401
    db = FakeDb(one=[{'id': 3}], all_=[[{'credential_id': 'abc'}]])
    r = WebAuthnController(db, CONFIG).challenge(ctx({'action': 'authenticate', 'email': 'a@b.c'}))
    assert r['success'] and r['rp_id'] == 'localhost' and r['rp_name'] == 'Voice Assistant'
    assert r['allow_credentials'] == [{'id': 'abc', 'type': 'public-key', 'transports': ['internal']}]
    assert len(r['challenge']) == 43 and '=' not in r['challenge']
    assert any('INSERT INTO webauthn_challenges' in s for s, _ in db.calls)


def test_challenge_error_codes():
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).challenge(ctx({'action': 'authenticate', 'credential_id': 'x'}))['code'] == 'CREDENTIAL_NOT_FOUND'
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).challenge(ctx({'action': 'authenticate', 'email': 'x'}))['code'] == 'USER_NOT_FOUND'
    assert WebAuthnController(FakeDb(one=[{'id': 1}], all_=[[]]), CONFIG).challenge(ctx({'action': 'authenticate', 'email': 'x'}))['code'] == 'NO_CREDENTIALS'
    db = FakeDb()
    r = WebAuthnController(db, CONFIG).challenge(ctx({'action': 'authenticate'}))
    assert r['success'] and not any('INSERT' in s for s, _ in db.calls)     # user_id 0 → not stored


def test_register_and_delete():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.register(ctx({}))['status_code'] == 401
    assert c.register(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential ID and public key are required'
    assert WebAuthnController(FakeDb(one=[{'id': 1}]), CONFIG).register(ctx({'credential_id': 'x', 'public_key': 'k'}, user_id=3))['status_code'] == 409
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).register(ctx({'credential_id': 'x', 'public_key': 'k'}, user_id=3))['message'] == 'Credential registered successfully'
    assert WebAuthnController(FakeDb(rowcount=0), CONFIG).delete(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential not found or not owned by user'
    assert WebAuthnController(FakeDb(rowcount=1), CONFIG).delete(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential deleted'


def test_authenticate_issues_token_and_string_id():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.authenticate(ctx({'credential_id': 'x'}))['message'] == 'Credential ID and signature are required'
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's'}))['code'] == 'CREDENTIAL_NOT_FOUND'
    row = {'uid': 3, 'email': 'e', 'first_name': 'f', 'last_name': 'l', 'role': 'admin', 'plan': 'premium',
           'provider': 'email', 'created_at': 'c'}
    assert WebAuthnController(FakeDb(one=[row]), CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's'}))['message'] == 'Invalid authentication data'
    r = WebAuthnController(FakeDb(one=[row]), CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's', 'authenticator_data': 'a'}))
    assert r['success'] and r['user']['id'] == '3' and jwt.decode(r['token'], 's', algorithms=['HS256'])['sub'] == 3
    assert list(r['user']) == ['id', 'email', 'first_name', 'last_name', 'role', 'plan', 'provider', 'last_login', 'created_at']
```

Simplify `ctx()` in the test to always keep `user_id` in the dict (value `None` when anonymous); delete the confusing `del`/re-add lines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit/test_webauthn_controller.py -q`
Expected: AttributeError (stub has no `challenge`)

- [ ] **Step 3: Implement `app/controllers/webauthn_controller.py`**

```python
"""Port of Controllers/WebAuthnController.php (no assertion crypto in PHP either)."""
from __future__ import annotations

import re
import secrets

from app.controllers.auth_controller import generate_tokens
from app.support.logger import error_log
from app.support.phpcompat import b64url_encode, php_now

CHALLENGE_EXPIRY = 120


class WebAuthnController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        auth = config.get('auth') or {}
        self.jwt_secret = str(auth.get('jwt_secret', '') or '')
        if self.jwt_secret == '':
            raise RuntimeError('JWT secret is not configured (set JWT_SECRET).')
        self.jwt_expiry = int(auth.get('jwt_expiry', 28800))
        self.refresh_expiry = int(auth.get('refresh_expiry', 604800))

    def challenge(self, request) -> dict:
        b = request['body']
        action = b.get('action', '') or ''
        user_id = b.get('user_id')
        credential_id = b.get('credential_id')
        email = b.get('email')
        allow_credentials: list = []
        if action == 'register':
            if request.get('user_id') is None:
                return {'success': False, 'message': 'Authentication required', 'status_code': 401}
            user_id = request['user_id']
        if action == 'authenticate':
            if credential_id:
                cred = self.db.fetch_one("SELECT user_id FROM webauthn_credentials WHERE credential_id = ?", [credential_id])
                if not cred:
                    return {'success': False, 'message': 'Credential not found', 'code': 'CREDENTIAL_NOT_FOUND', 'status_code': 404}
                user_id = cred['user_id']
            elif email:
                user = self.db.fetch_one("SELECT id FROM users WHERE email = ?", [email])
                if not user:
                    return {'success': False, 'message': 'No account found for this email', 'code': 'USER_NOT_FOUND', 'status_code': 404}
                user_id = int(user['id'])
                rows = self.db.fetch_all("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?", [user_id])
                if not rows:
                    return {'success': False,
                            'message': 'No passkey registered for this account. Sign in with email/password and enable biometric login first.',
                            'code': 'NO_CREDENTIALS', 'status_code': 404}
                allow_credentials = [{'id': r['credential_id'], 'type': 'public-key', 'transports': ['internal']} for r in rows]
            else:
                user_id = 0
        challenge = b64url_encode(secrets.token_bytes(32))
        if user_id != 0:
            self.db.execute(
                "INSERT INTO webauthn_challenges (challenge, user_id, action, created_at) VALUES (?, ?, ?, NOW())"
                " ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()",
                [challenge, user_id, action])
        wa = self.config.get('webauthn') or {}
        rp_id = wa.get('rp_id') or request['headers'].get('host') or 'localhost'
        rp_name = wa.get('rp_name') or 'Voice Assistant'
        rp_id = re.sub(r':\d+$', '', rp_id)
        return {'success': True, 'challenge': challenge, 'rp_id': rp_id, 'rp_name': rp_name,
                'allow_credentials': allow_credentials, 'status_code': 200}

    def register(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id:
            return {'success': False, 'message': 'Authentication required', 'status_code': 401}
        b = request['body']
        credential_id = b.get('credential_id', '') or ''
        public_key = b.get('public_key', '') or ''
        if not credential_id or not public_key:
            return {'success': False, 'message': 'Credential ID and public key are required', 'status_code': 400}
        if self.db.fetch_one("SELECT id FROM webauthn_credentials WHERE credential_id = ?", [credential_id]):
            return {'success': False, 'message': 'Credential already registered', 'status_code': 409}
        self.db.insert("INSERT INTO webauthn_credentials (user_id, credential_id, public_key, created_at) VALUES (?, ?, ?, NOW())",
                       [user_id, credential_id, public_key])
        error_log(f'[WebAuthnController] Credential registered: user_id={user_id}, credential_id={credential_id[:20]}...')
        self._cleanup_challenges()
        return {'success': True, 'message': 'Credential registered successfully', 'status_code': 200}

    def authenticate(self, request) -> dict:
        b = request['body']
        credential_id = b.get('credential_id', '') or ''
        authenticator_data = b.get('authenticator_data', '') or ''
        signature = b.get('signature', '') or ''
        if not credential_id or not signature:
            return {'success': False, 'message': 'Credential ID and signature are required', 'status_code': 400}
        cred = self.db.fetch_one(
            "SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.role, u.plan, u.ledger_user_id, u.provider,"
            " u.last_login, u.created_at FROM webauthn_credentials wc JOIN users u ON wc.user_id = u.id"
            " WHERE wc.credential_id = ?", [credential_id])
        if not cred:
            return {'success': False, 'message': 'Credential not found', 'code': 'CREDENTIAL_NOT_FOUND', 'status_code': 404}
        if not authenticator_data or not signature:
            return {'success': False, 'message': 'Invalid authentication data', 'status_code': 400}
        user_id = int(cred['uid'])
        tokens = generate_tokens(user_id, self.jwt_secret, self.jwt_expiry, self.refresh_expiry)
        self.db.execute("UPDATE users SET last_login = NOW() WHERE id = ?", [user_id])
        error_log(f'[WebAuthnController] Biometric auth successful: user_id={user_id}')
        self._cleanup_challenges()
        return {
            'success': True, 'message': 'Authentication successful', 'token': tokens['access_token'],
            'user': {'id': str(user_id), 'email': cred['email'], 'first_name': cred['first_name'],
                     'last_name': cred['last_name'], 'role': cred.get('role') or 'prospect',
                     'plan': cred.get('plan') or 'free', 'provider': cred.get('provider') or 'webauthn',
                     'last_login': php_now(), 'created_at': cred.get('created_at')},
            'status_code': 200,
        }

    def delete(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id:
            return {'success': False, 'message': 'Authentication required', 'status_code': 401}
        credential_id = request['body'].get('credential_id', '') or ''
        if not credential_id:
            return {'success': False, 'message': 'Credential ID is required', 'status_code': 400}
        deleted = self.db.execute("DELETE FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?",
                                  [credential_id, user_id]) > 0
        error_log(f"[WebAuthnController] Credential deleted: user_id={user_id}, credential_id={credential_id[:20]}..., success={'true' if deleted else 'false'}")
        return {'success': True, 'message': 'Credential deleted' if deleted else 'Credential not found or not owned by user',
                'status_code': 200}

    def _cleanup_challenges(self) -> None:
        try:
            self.db.execute("DELETE FROM webauthn_challenges WHERE created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)",
                            [CHALLENGE_EXPIRY])
        except Exception as e:  # noqa: BLE001
            error_log(f'[WebAuthnController] Challenge cleanup failed: {e}')
```

PHP's `challenge` checks `!isset($request['user_id'])` for `register`; on a public route without a token the middleware sets `user_id = null`, so `isset` is false → 401. `request.get('user_id') is None` matches.

- [ ] **Step 4: Run unit tests**

Run: `pytest tests/unit/test_webauthn_controller.py -q`
Expected: 4 passed

- [ ] **Step 5: Differential tests** — `tests/differential/test_webauthn.py`:
```python
import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_challenge_and_authenticate_error_parity(both):
    same(*both('POST', '/api/v1/webauthn/challenge', json={'action': 'register'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/challenge', json={'action': 'authenticate', 'credential_id': 'nope'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/challenge', json={'action': 'authenticate', 'email': 'nobody@example.invalid'}, auth=False))
    a, b = both('POST', '/api/v1/webauthn/challenge', json={'action': 'authenticate'}, auth=False)
    assert a.status_code == b.status_code == 200
    assert {k: v for k, v in a.json().items() if k != 'challenge'} == {k: v for k, v in b.json().items() if k != 'challenge'}
    same(*both('POST', '/api/v1/webauthn/authenticate', json={'credential_id': 'x'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/authenticate', json={'credential_id': 'nope', 'signature': 's'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/register', json={}, auth=False))          # 401 from middleware
    same(*both('POST', '/api/v1/webauthn/register', json={'credential_id': 'x'}))  # 400
    same(*both('DELETE', '/api/v1/webauthn/register', json={}))                    # 400
    same(*both('DELETE', '/api/v1/webauthn/register', json={'credential_id': 'diff-none'}))  # 200 not found message
```

The `rp_id` comparison in the 4th case will differ if PHP sees `Host: localhost` and Python sees `Host: testserver` (TestClient default). Pass `headers={'Host': 'localhost'}` to that `both()` call so both compute `rp_id == 'localhost'`.

Run: `pytest tests/differential/test_webauthn.py -q` → 1 passed

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python
git commit -m "feat(py): WebAuthnController"
```

### Task 12: Backend switcher — third `python` kind (gpt frontend + gpt_admin)

**Files:**
- Modify: `frontend/assets/js/api-config.js` (BY_HOST maps, kind normalization, `BACKEND_URLS`, `setBackendKind`)
- Modify: `frontend/assets/js/settings-panel.js:1518-1526` (click handler kind mapping + label) and `:1614-1633` (`renderBackendConnection` kind + label)
- Modify: `frontend/index.html:3081-3088` (third button), `:52` and `:4165` (cache-busters)
- Modify: `/Applications/XAMPP/xamppfiles/htdocs/gpt_admin/src/lib/backendConfig.ts` (`BackendId` union + `BACKENDS` entry + `getBackendId`), then rebuild `gpt_admin/dist`
- Test: `frontend/tests/api-config.test.mjs` if it exists (check with `ls frontend/tests`), else a Node one-liner shown below

**Interfaces:**
- Produces: `localStorage.BACKEND_KIND ∈ {'php','node','python'}`; `window.APP_CONFIG.BACKEND_URLS.python`; `window.setBackendKind('python')`. gpt_admin: `BackendId = 'php' | 'ts' | 'py'`, `BACKENDS.py.apiV1 = 'http://localhost:3002/api/v1'`.

- [ ] **Step 1: api-config.js — add the Python map and generalize the kind handling**

Replace the `NODE_BY_HOST` block and the kind logic with:
```js
  var NODE_BY_HOST = {
    'localhost': 'http://localhost:3001/api/v1',
    '127.0.0.1': 'http://localhost:3001/api/v1',
    'synergyaichat.com': '/gpt/backend-node/api/v1', // prod Node URL (update when deployed)
  };
  var PYTHON_BY_HOST = {
    'localhost': 'http://localhost:3002/api/v1',
    '127.0.0.1': 'http://localhost:3002/api/v1',
    'synergyaichat.com': '/gpt/backend-python/api/v1', // prod Python URL (update when deployed)
  };
  var KINDS = { php: PHP_BY_HOST, node: NODE_BY_HOST, python: PYTHON_BY_HOST };
  function normalizeKind(k) { return KINDS[k] ? k : 'php'; }
```
Then:
```js
  var override = null, kind = 'php';
  try { override = localStorage.getItem('API_BASE_URL'); } catch (e) { override = null; }
  try { kind = normalizeKind((localStorage.getItem('BACKEND_KIND') || 'php').toLowerCase()); } catch (e) { kind = 'php'; }

  var base = resolveApiBase({ override: override, hostname: location.hostname, byHost: KINDS[kind], fallback: FALLBACK });
  ...
  window.APP_CONFIG.BACKEND_KIND = kind;                 // 'php' | 'node' | 'python'
  window.APP_CONFIG.BACKEND_URLS = {
    php: PHP_BY_HOST[location.hostname] || FALLBACK,
    node: NODE_BY_HOST[location.hostname] || FALLBACK,
    python: PYTHON_BY_HOST[location.hostname] || FALLBACK,
  };
  ...
  window.setBackendKind = function (k) {
    k = normalizeKind(k);
    try { localStorage.setItem('BACKEND_KIND', k); } catch (e) {}
    location.reload();
  };
```
Keep everything else in the file as is. Verify with Node (pure helpers still exposed):
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt && node -e "
require('./frontend/assets/js/api-config.js');
const {resolveApiBase} = globalThis.__API_CONFIG_TEST__;
console.log(resolveApiBase({override:null, hostname:'localhost', byHost:{localhost:'http://localhost:3002/api/v1'}, fallback:'/x'}));"
```
Expected: `http://localhost:3002/api/v1`

- [ ] **Step 2: settings-panel.js — three-way kind + labels**

In the click handler (around line 1518) replace the two `kind`/`label` lines with:
```js
                const kind = ['node', 'python'].includes(btn.dataset.backendKind) ? btn.dataset.backendKind : 'php';
                const current = (window.APP_CONFIG && window.APP_CONFIG.BACKEND_KIND) || 'php';
                if (kind === current) return;
                const label = { php: 'PHP', node: 'Node.js', python: 'Python' }[kind];
```
In `renderBackendConnection` replace `const kind = cfg.BACKEND_KIND === 'node' ? 'node' : 'php';` with
```js
        const kind = ['node', 'python'].includes(cfg.BACKEND_KIND) ? cfg.BACKEND_KIND : 'php';
```
and the `Active:` line with
```js
        if (cur) cur.textContent = 'Active: ' + ({ php: 'PHP', node: 'Node.js', python: 'Python' }[kind]) + ' → ' + (urls[kind] || cfg.API_BASE_URL || '');
```

- [ ] **Step 3: index.html — third button and cache-busters**

After the Node.js button (line ~3088) add:
```html
                                <button type="button" data-backend-kind="python"
                                        class="backend-kind-btn flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition flex items-center justify-center gap-1.5">
                                    <span>🐍</span><span>Python</span>
                                </button>
```
Bump both script tags (stale JS is served otherwise — see memory `feedback_bump_cache_buster`):
- line 52: `assets/js/api-config.js?v=20260905-python`
- line 4165: `assets/js/settings-panel.js?v=20260905-python`

- [ ] **Step 4: gpt_admin backendConfig.ts**

```ts
export type BackendId = 'php' | 'ts' | 'py';
...
export const BACKENDS: Record<BackendId, BackendDef> = {
  php: { id: 'php', label: 'PHP', apiV1: '/gpt/backend/api/v1' },
  ts: { id: 'ts', label: 'TypeScript', apiV1: 'http://localhost:3001/api/v1' },
  py: { id: 'py', label: 'Python', apiV1: 'http://localhost:3002/api/v1' },
};
...
export function getBackendId(): BackendId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'ts' || v === 'py' ? v : 'php';
  } catch {
    return 'php';
  }
}
```
Find the UI that renders the switcher (`grep -rn "BACKENDS\|setBackendId" gpt_admin/src --include=*.tsx`) — if it iterates `Object.values(BACKENDS)` nothing else changes; if it hardcodes two buttons, add a third following the existing pattern. Then:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt_admin && npm run build
```
Expected: build succeeds; `dist/assets/backendConfig-*.js` contains `3002`.

- [ ] **Step 5: Browser smoke**

Start Python (`backend_python/run.sh`), open `http://localhost/gpt/frontend/`, log in as admin, Settings → Account → Backend Connection → **Python**. After reload, the console shows `[api-config] backend = python → http://localhost:3002/api/v1`; login still valid (shared JWT); Prompt Library tree loads. Switch back to PHP afterwards.

- [ ] **Step 6: Commit (two repos)**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/api-config.js frontend/assets/js/settings-panel.js frontend/index.html
git commit -m "feat(frontend): third backend kind 'python' (port 3002) in the admin backend switcher"
cd /Applications/XAMPP/xamppfiles/htdocs/gpt_admin
git add src/lib/backendConfig.ts dist
git commit -m "feat: Python backend option in the backend switcher"
```
(The gpt_admin repo may have its own commit conventions; check `git log -3` there first.)

### Task 13: README, parity tracker, full verification

**Files:**
- Create: `backend_python/README.md`
- Modify: `docs/backend-parity-tracker.md` (add a `PY` column to table A and new rows)
- Modify: `backend_python/tests/differential/conftest.py` if any fixture proved flaky

- [ ] **Step 1: Write `backend_python/README.md`**

```markdown
# gpt backend — Python (FastAPI) port

Third implementation of the PHP backend (`../backend`) behind the same HTTP contract, next to
`../backend_typescript`. Same MySQL databases, same `.env` values, same `JWT_SECRET`, so tokens
interoperate across all three backends. Spec: `../docs/superpowers/specs/2026-09-05-backend-python-port-design.md`.

## Run
    python3.13 -m venv .venv && source .venv/bin/activate
    pip install -r requirements-dev.txt
    ./run.sh                      # uvicorn on http://localhost:3002 (reads ../backend/.env if no local .env)

Point the frontend at it: Settings → Account → Backend Connection → Python (admin only), or
`localStorage.setItem('BACKEND_KIND','python'); location.reload()`.

## Test
    pytest tests/unit -q                 # no external services
    pytest tests/differential -q         # needs Apache (PHP backend) + the DBs; skips cleanly otherwise
    DIFF_USER_ID=3 pytest -q             # differential user (default 3)

## Layout
Mirrors `../backend/src` one to one (class names, camelCase method names, raw SQL):
`main.py` (index.php) · `app/routes.py` (routes.php) · `app/middleware/` · `app/controllers/` ·
`app/agent_team/` · `app/services/` · `app/support/` (Ctx, renderer, dispatcher, PDO placeholder
shim, PHP compat helpers). `resources/model_catalog.json` is a copy of the PHP file — re-copy when it changes.

## Status
Phase 1 (2026-09): pipeline, auth (all actions, Firebase verify, SSO, app keys), model catalog,
prompts, contexts, packages, WebAuthn — differential-tested against live PHP. Everything else: see the
phase table in the spec.
```

- [ ] **Step 2: Parity tracker rows**

In `docs/backend-parity-tracker.md`, add a `PY` column to table A (✅ for #1, #2, #4, #8; ➖ for #7; ⬜ for #7b, #5) and append to table B:

| # | Item | Status | Notes |
|---|------|--------|-------|
| 19 | PY: `password_hash` emits `$2b$` (PHP `$2y$`); both verify each other's hashes | 🪞 | Cross-backend login test in `tests/differential/test_auth.py`. |
| 20 | PY: `filter_var(FILTER_VALIDATE_EMAIL)` approximated by RFC-5322-ish regex | 🪞 | Edge cases (quoted local parts, IP literals) may differ; frontend validates first. |
| 21 | PY: `PromptLibraryController::create` returns `data.id` as string (PDO `lastInsertId`) | 🪞 | Mirrored; contexts return int. |
| 22 | PY: `debugAuth.php_version` is a mirrored constant (`8.2.4`) | 🪞 | Update when XAMPP PHP changes. |
| 23 | PY: stored JSON (`context_data`, `packages.capabilities`) written without `\/` escaping | 🪞 | Decodes identically; PHP reads it fine. |
| 24 | PY: WebAuthn assertions are not cryptographically verified (same as PHP) | 🪞 | Pre-existing PHP gap; listed for visibility. |
| 25 | PY: `date('Y-m-d H:i:s')` uses `PHP_TIMEZONE` env (default Europe/Berlin) | 🪞 | Must match php.ini `date.timezone`. |

Update the `Last updated:` line.

- [ ] **Step 3: Full verification**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python && source .venv/bin/activate
pytest -q                                   # unit + differential; expect all passed, 0 skipped (Apache up)
./run.sh &                                  # then the browser smoke from Task 12 Step 5 if not done
```
Confirm `logs/backend.log` contains request errors only (no tracebacks from the differential run).

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend_python/README.md docs/backend-parity-tracker.md backend_python
git commit -m "docs(py): README + parity tracker rows for the Python backend (Phase 1)"
```

---

## Self-review notes (done while writing)

- **Spec coverage:** Phase 1 row → Tasks 1–11 (skeleton, config, pools, middleware, all auth routes + legacy dispatcher, health, catalog, prompts, contexts, package `me`, WebAuthn) and Task 12 (minimal switcher). `ProviderController` deferred to Phase 2 with the reason stated in the header. Spec §3 conventions each map to a task: Ctx/contract/envelopes → 3 & 6; auth → 5; DB rules → 2 (+ FOUND_ROWS in 9); JSON → 3; parity policy → 13. Spec §5 testing: unit → every task; differential → harness in 6, cases in 6–11; browser smoke → 12. Spec §6 error handling → 6 (500 envelope + file log); deviations → 13.
- **Placeholders:** none; every code step has full content. The only "replace stub" steps are explicitly sequenced (stubs created in Task 6 Step 4, replaced in 7, 9, 10, 11).
- **Type consistency:** `Db` API (`fetch_one/fetch_all/fetch_column/execute/insert`) used identically in Tasks 5–11; `generate_tokens(user_id, secret, jwt_expiry, refresh_expiry)` defined in 7, consumed in 11; `user_app_key_pepper(config, jwt_secret)` / `hash_user_app_key(key, pepper)` / `decode_hs256(token, secret)` defined in 5, consumed in 7; `render()` special-shape keys match `index.php`; controller ctor `(db, config)` everywhere; route handler tuples match `CONTROLLERS` keys.
