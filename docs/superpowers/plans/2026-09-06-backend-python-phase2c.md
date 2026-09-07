# Backend Python Port — Phase 2c (Built-in Functions, delegation tool names, ProviderController) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /api/v1/providers` (+ the two `switch` routes) work on the Python backend with a byte-equal JSON body to PHP, so the frontend picker populates and the UI can chat on Python; port the three remaining built-in Functions classes and the delegation tool names the providers list advertises; register the database-dependent functions in `AIPortfolioAssistant.setDatabase` exactly as PHP does.

**Architecture:** One Python module per PHP file, same class and camelCase method names: `app/functions/{analysis,portfolio,watchlist}_functions.py`, `app/agent_team/functions/agent_delegation_functions.py` (names only in 2c; the handlers land in Phase 5 with `AgentRunner`), `app/controllers/provider_controller.py`. `ProviderController.list` composes 2a/2b pieces already ported: `LLMProviderResolver.applyDbSettings`, `AIPortfolioAssistant`, `PackageResolver`, `MCPToolsLoader`. Functions handlers keep PHP's `(params, userId) -> dict` contract and return the same `{'success': True, …}` / `{'error': '…'}` shapes so tool results are byte-identical when JSON-encoded.

**Tech Stack:** Python 3.13, FastAPI, httpx (+ `MockTransport`), PyMySQL via `app.db.Db`, pytest; differential against live PHP.

**Spec:** `docs/superpowers/specs/2026-09-06-backend-python-phase2-chat-design.md` (§2 row 2c) under `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§3 conventions bind).

## Global Constraints

- Everything from the Phase 1, 2a and 2b plans' Global Constraints still applies (Python 3.13, venv, port 3002, `PHP_TIMEZONE`, clean JSON, no runtime DDL, commit trailer, controllers return dicts with `status_code`, PHP-semantics helpers `php_empty`/`php_intval`/`is_numeric`/`php_bool`/`php_strval`/`ucfirst`, `??` → `v if v is not None else d`, `is_array` → dict-or-list).
- **SQL text is byte-identical to PHP** (whitespace inside the string literal included); PDO `?` placeholders stay `?` and named `:user_id` placeholders stay named — `app.db.Db` translates both (Phase 1 contract). `fetchAll(PDO::FETCH_ASSOC)` → `db.fetch_all(sql, params)`; `fetchAll(PDO::FETCH_COLUMN)` → `db.fetch_column(sql, params)`; `fetchColumn()` → `db.fetch_one(...)` first value or `fetch_column(...)[0]`; `rowCount()` → return value of `db.execute(...)`; `lastInsertId()` → `db.insert(...)`.
- **Functions handlers** have the PHP signature `(params: dict, userId) -> dict` and are registered through `ToolsManager.registerFunctions({name: {'handler': fn, 'schema': {...}}})` (2a). Schemas (`name`, `description`, `input_schema`) are copied verbatim from the PHP `getAllFunctions()` arrays — the LLM sees them.
- **HTTP in Functions:** `httpx.Client(timeout=30)` per instance (Guzzle `['timeout' => 30]`), closed by a Python-only `close()`; `->get(url, ['query' => …])` → `client.get(url, params=…)`; `json_decode($body, true)` → `response.json()` guarded to `None` on invalid JSON; `catch (\Throwable $e)` → `except Exception as e` returning `{'error': '<PHP prefix>' + str(e)}`. No `raise_for_status()` where PHP has none (Guzzle throws on 4xx/5xx by default — so DO call `raise_for_status()` where the PHP code relies on Guzzle's exception to reach the catch; every FMP call in `AnalysisFunctions` does).
- **`ProviderController` response** key order and types exactly as PHP: `success, providers, current_provider (always None), user_has_custom_keys, user_enabled_providers, functions, function_count, status_code`. Each provider row from the DB: `name, display_name, model, available (True), supported_models (json.loads(row['supported_models'] ?? '[]') → None on invalid JSON), max_tokens (php_intval), api_format`, then `user_has_key` (bool) appended by the marking loop, and `available` OR-ed with `user_has_key` only when the user has custom keys. `functions` = `assistant.getToolsManager().getRegisteredFunctions()` (search functions only — `ProviderController` never calls `setDatabase`) + MCP tool names in loader order + the three delegation names.
- **Route visibility:** `/api/v1/providers` is protected (live PHP returns 401 `{"success":false,"message":"Authorization token required"}` without a token). The Python auth middleware already does this for non-public routes; do not add it to the public list.
- **Every `AIPortfolioAssistant` the controller constructs is closed** (`assistant.close()` in `finally`) — it builds up to eight `httpx.Client`s.
- Differential tests: PHP at `http://localhost/gpt/backend`, Python in-process, user 3. Live PHP facts (2026-09-06): 8 providers enabled (claude, deepseek, gemini, grok, kimi, openai, gamma4, glm), user 3 has a `user_api_keys` row for kimi, `function_count` 27, `current_provider` null.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```
- Work from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python` with `.venv/bin/python -m pytest`; commit from the repo root staging only the files you changed, by path. A uvicorn `--reload` server runs on :3002 from this tree — never start or stop servers.

## Porting rules

Same table as the Phase 2b plan (`docs/superpowers/plans/2026-09-06-backend-python-phase2b.md` § "Porting rules"). Additions for this phase:

| PHP | Python |
|---|---|
| `strtoupper($s)` | `s.upper()` |
| `array_slice($a, 0, 10)` | list → `a[:10]`; dict (string-keyed array) → first 10 items preserving keys, `dict(list(a.items())[:10])`; anything else (e.g. `None` from invalid JSON) → `[]` |
| `$data[0] ?? []` | `data[0] if isinstance(data, list) and data else []` (PHP's `[]` always JSON-encodes as `[]`, never `{}`) |
| `(int)($params['limit'] ?? 50)` | `php_intval(params.get('limit') if params.get('limit') is not None else 50)` |
| `in_array($x, $list)` (loose) / `in_array($x, $list, true)` | `x in list` (both — values here are strings) |
| `array_values(array_filter($rows, fn))` | `[r for r in rows if fn(r)]` |
| `foreach ($rows as &$row) { $row['k'] = …; }` | mutate the dicts in place in a `for row in rows:` loop |
| `count($x)` | `len(x)` |
| `NOW()` in SQL | leave in the SQL text |

---

### Task 1: `AnalysisFunctions` (FMP-backed analysis tools)

**Files:**
- Create: `app/functions/analysis_functions.py`
- Test: `tests/unit/test_analysis_functions.py`

**Interfaces:**
- `AnalysisFunctions(config: Configuration)` with `self.httpClient = httpx.Client(timeout=30)`, `close()`. `getAllFunctions() -> dict` keyed `get_analyst_ratings, get_financial_ratios, get_price_targets, get_company_profile, get_asset_sentiment` (PHP `AnalysisFunctions.php:27-113`, schemas verbatim). Handlers `getAnalystRatings/getFinancialRatios/getPriceTargets/getCompanyProfile/getAssetSentiment(params, userId) -> dict` (PHP 116–257). API key from `config.get('financial.fmp.api_key')`; `empty` → `{'error': 'FMP API key not configured'}`; missing symbol → `{'error': 'Symbol is required'}`; success shapes and error prefixes exactly as PHP (e.g. `'Failed to fetch analyst ratings: ' + str(e)`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_analysis_functions.py`:
```python
import json
import httpx
import pytest
from app.config_.configuration import Configuration
from app.functions.analysis_functions import AnalysisFunctions


def _af(handler, key='FMP'):
    af = AnalysisFunctions(Configuration({'financial': {'fmp': {'api_key': key}}}))
    af.httpClient = httpx.Client(transport=httpx.MockTransport(handler))
    return af


def test_registry_names_schemas_and_handlers():
    af = _af(lambda r: httpx.Response(200, json=[]))
    fns = af.getAllFunctions()
    assert list(fns) == ['get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment']
    for name, cfg in fns.items():
        assert callable(cfg['handler']) and cfg['schema']['name'] == name and cfg['schema']['input_schema']['type'] == 'object'
    assert fns['get_analyst_ratings']['schema']['input_schema']['required'] == ['symbol']
    assert fns['get_asset_sentiment']['schema']['input_schema']['required'] == ['symbol']
    af.close(); assert af.httpClient.is_closed


def test_missing_key_and_missing_symbol():
    assert _af(lambda r: None, key='').getAnalystRatings({'symbol': 'AAPL'}, 3) == {'error': 'FMP API key not configured'}
    assert _af(lambda r: None).getAnalystRatings({}, 3) == {'error': 'Symbol is required'}
    assert _af(lambda r: None).getFinancialRatios({'symbol': ''}, 3) == {'error': 'Symbol is required'}


def test_analyst_ratings_calls_fmp_and_slices_ten():
    seen = {}
    def handler(req):
        seen['url'] = str(req.url); return httpx.Response(200, json=[{'grade': i} for i in range(15)])
    out = _af(handler).getAnalystRatings({'symbol': 'aapl'}, 3)
    assert seen['url'] == 'https://financialmodelingprep.com/api/v3/grade/AAPL?apikey=FMP'
    assert out == {'success': True, 'symbol': 'AAPL', 'ratings': [{'grade': i} for i in range(10)]}


def test_http_error_becomes_php_error_message():
    out = _af(lambda r: httpx.Response(500, text='boom')).getAnalystRatings({'symbol': 'AAPL'}, 3)
    assert 'error' in out and out['error'].startswith('Failed to fetch analyst ratings: ')


def test_financial_ratios_price_targets_profile_shapes():
    seen = []
    def handler(req):
        seen.append(str(req.url))
        if '/ratios/' in req.url.path:
            return httpx.Response(200, json=[{'peRatio': 30.1}])
        if 'price-target' in req.url.path:
            return httpx.Response(200, json=[{'priceTarget': 200}, {'priceTarget': 210}])
        return httpx.Response(200, json=[{'companyName': 'Apple Inc.'}])
    af = _af(handler)
    ratios = af.getFinancialRatios({'symbol': 'AAPL'}, 3)
    targets = af.getPriceTargets({'symbol': 'AAPL'}, 3)
    profile = af.getCompanyProfile({'symbol': 'AAPL'}, 3)
    assert ratios['success'] is True and ratios['symbol'] == 'AAPL'
    assert targets['success'] is True and targets['symbol'] == 'AAPL'
    assert profile['success'] is True and profile['symbol'] == 'AAPL' and profile['profile'] == {'companyName': 'Apple Inc.'}
    assert any('apikey=FMP&limit=1' in u or 'limit=1&apikey=FMP' in u for u in seen)          # ratios query: apikey + limit=1
    assert any('symbol=AAPL' in u for u in seen)                                              # price targets pass symbol as a query param


def test_asset_sentiment_is_static():
    assert _af(lambda r: None).getAssetSentiment({'symbol': 'tsla'}, 3) == {'success': True, 'symbol': 'TSLA', 'message': 'Sentiment analysis requires integration with news/social APIs'}
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_analysis_functions.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `AnalysisFunctions.php` verbatim** — lines 14–258 into `app/functions/analysis_functions.py`. The exact keys of the ratios/targets/profile success dicts are whatever PHP 149–246 returns (`ratios`, `price_targets`/`targets`, `profile` — copy PHP); the test pins only `success`, `symbol` and `profile`. If PHP's profile handler returns `$data[0] ?? []` the test's `profile == {...}` holds; if it returns the list, adjust the assertion to PHP and report DONE_WITH_CONCERNS citing the line.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python/app/functions/analysis_functions.py backend_python/tests/unit/test_analysis_functions.py && git commit -m "feat(py): AnalysisFunctions (FMP analyst ratings, ratios, targets, profile, sentiment stub)"
```

---

### Task 2: `PortfolioFunctions` + `WatchlistFunctions` (database tools)

**Files:**
- Create: `app/functions/portfolio_functions.py`, `app/functions/watchlist_functions.py`
- Test: `tests/unit/test_portfolio_watchlist_functions.py`

**Interfaces:**
- `PortfolioFunctions(pdo=None)` with `setPDO(pdo) -> self`; `getAllFunctions()` keyed `get_portfolios, get_portfolio_assets_with_discovery, get_portfolio_diversification, get_all_transactions` (PHP `PortfolioFunctions.php:27-104`, schemas verbatim); handlers `getPortfolios/getPortfolioAssetsWithDiscovery/getPortfolioDiversification/getAllTransactions(params, userId)` (PHP 107–322). Guard `if not self.pdo or not userId: return {'error': 'Database connection or user ID not available'}` (PHP truthiness: `not userId` is right for `!$userId` — 0/''/None all falsy in both).
- `WatchlistFunctions(pdo=None)` with `setPDO`; `getAllFunctions()` keyed `get_user_watchlist, get_watchlist_with_market_data, add_to_watchlist, remove_from_watchlist` (PHP `WatchlistFunctions.php:24-100`); handlers (PHP 103–281).
- `pdo` is an `app.db.Db` (or any object with `fetch_all/fetch_one/fetch_column/execute/insert`). SQL strings byte-identical to PHP.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_portfolio_watchlist_functions.py`:
```python
import pytest
from app.functions.portfolio_functions import PortfolioFunctions
from app.functions.watchlist_functions import WatchlistFunctions


class Db:
    """Records SQL + params; answers from a queue of canned results."""
    def __init__(self, results=None): self.calls = []; self.results = list(results or [])
    def _next(self, default):
        return self.results.pop(0) if self.results else default
    def fetch_all(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next([])
    def fetch_one(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next(None)
    def fetch_column(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next([])
    def execute(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next(1)
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next(1)


def test_portfolio_registry_and_guards():
    pf = PortfolioFunctions()
    assert list(pf.getAllFunctions()) == ['get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions']
    assert pf.getPortfolios({}, 3) == {'error': 'Database connection or user ID not available'}
    assert PortfolioFunctions(Db()).getPortfolios({}, None) == {'error': 'Database connection or user ID not available'}
    assert pf.setPDO(Db()) is pf


def test_get_portfolios_sql_and_shape():
    db = Db([[{'id': 1, 'name': 'Main', 'description': None, 'is_default': 1, 'currency': 'USD', 'created_at': '2026-01-01 00:00:00'}]])
    out = PortfolioFunctions(db).getPortfolios({}, 3)
    sql, params = db.calls[0]
    assert sql == 'SELECT id, name, description, is_default, currency, created_at FROM portfolios WHERE user_id = ? ORDER BY is_default DESC, name ASC' and params == [3]
    assert out == {'success': True, 'portfolios': db.results_snapshot if hasattr(db, 'results_snapshot') else out['portfolios'], 'count': 1} or (out['success'] is True and out['count'] == 1 and out['portfolios'][0]['name'] == 'Main')


def test_assets_with_discovery_falls_back_to_default_then_first_portfolio():
    db = Db([None, None])                       # no default portfolio, no portfolio at all
    out = PortfolioFunctions(db).getPortfolioAssetsWithDiscovery({}, 3)
    sqls = [s for s, _ in db.calls]
    assert 'SELECT id FROM portfolios WHERE user_id = ? AND is_default = 1 LIMIT 1' in sqls
    assert 'SELECT id FROM portfolios WHERE user_id = ? ORDER BY id ASC LIMIT 1' in sqls
    assert out.get('assets') == [] or 'error' in out          # PHP returns the "no portfolio" shape from lines 160-172 — copy it exactly


def test_all_transactions_pagination_params():
    db = Db([[], [0]])
    out = PortfolioFunctions(db).getAllTransactions({'page': '2', 'limit': '10', 'sort': 'date', 'order': 'asc'}, 3)
    assert out['success'] is True and out['pagination']['page'] == 2 and out['pagination']['limit'] == 10
    first_sql, first_params = db.calls[0]
    assert first_sql.startswith('SELECT') and 'FROM transactions t' in first_sql and 3 in first_params


def test_watchlist_registry_guards_and_get():
    wf = WatchlistFunctions()
    assert list(wf.getAllFunctions()) == ['get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist']
    assert wf.getUserWatchlist({}, 3) == {'error': 'Database connection or user ID not available'}
    db = Db([[{'id': 9, 'user_id': 3, 'asset_id': 4, 'name': 'Apple', 'symbol': 'AAPL', 'type': 'stock', 'exchange': 'NASDAQ', 'currency': 'USD'}]])
    out = WatchlistFunctions(db).getUserWatchlist({}, 3)
    sql, params = db.calls[0]
    assert sql == 'SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency FROM watchlist w JOIN assets a ON w.asset_id = a.id WHERE w.user_id = ? ORDER BY w.created_at DESC' and params == [3]
    assert out['success'] is True and out['count'] == 1 and out['watchlist'][0]['symbol'] == 'AAPL'


def test_add_to_watchlist_creates_asset_then_link():
    db = Db([None, 42, None, 1])                # no asset → insert id 42 → not yet in watchlist → insert link
    out = WatchlistFunctions(db).addToWatchlist({'symbol': 'aapl', 'name': 'Apple', 'type': 'stock'}, 3)
    sqls = [s for s, _ in db.calls]
    assert sqls[0] == 'SELECT id FROM assets WHERE symbol = ?'
    assert any(s.startswith('INSERT INTO assets (symbol, name, type, exchange, currency, created_at)') for s in sqls)
    assert 'SELECT id FROM watchlist WHERE user_id = ? AND asset_id = ?' in sqls
    assert 'INSERT INTO watchlist (user_id, asset_id, created_at) VALUES (?, ?, NOW())' in sqls
    assert out['success'] is True


def test_add_to_watchlist_validation_and_duplicate():
    assert WatchlistFunctions(Db()).addToWatchlist({'symbol': 'AAPL'}, 3).get('error')      # name/type required → PHP error text, copy it
    db = Db([{'id': 4}, {'id': 9}])                                                        # asset exists, already on watchlist
    out = WatchlistFunctions(db).addToWatchlist({'symbol': 'AAPL', 'name': 'Apple', 'type': 'stock'}, 3)
    assert 'error' in out or out.get('message')                                            # PHP's "already in watchlist" response — copy exactly


def test_remove_from_watchlist_uses_delete_join_and_rowcount():
    db = Db([1])
    out = WatchlistFunctions(db).removeFromWatchlist({'symbol': 'aapl'}, 3)
    sql, params = db.calls[0]
    assert sql.startswith('DELETE w FROM watchlist w') and params[0] == 3 and 'AAPL' in params
    assert out['success'] is True
    assert WatchlistFunctions(Db([0])).removeFromWatchlist({'symbol': 'AAPL'}, 3).get('error') or WatchlistFunctions(Db([0])).removeFromWatchlist({'symbol': 'AAPL'}, 3).get('success') is False
```

The loosely-asserted lines (`or` forms) exist because the plan cannot pin PHP's exact response text without copying 600 lines here: the implementer copies PHP's exact strings into the port AND tightens each of those assertions to the exact PHP dict once ported (they are placeholders for the PHP truth, not for guesses). The reviewer verifies every tightened assertion against the PHP line.

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError`.

- [ ] **Step 3: Port both PHP files verbatim** — `PortfolioFunctions.php` 14–329 and `WatchlistFunctions.php` 11–288. Read `app/db.py` first for the `Db` API; `$stmt->fetchColumn()` after `SELECT id …` → `row = db.fetch_one(...); id = row['id'] if row else None` (or `fetch_column(...)`, pick one and use it consistently — the test `Db` answers both). Tighten the `or` assertions in the test to PHP's exact dicts.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python/app/functions/portfolio_functions.py backend_python/app/functions/watchlist_functions.py backend_python/tests/unit/test_portfolio_watchlist_functions.py && git commit -m "feat(py): PortfolioFunctions + WatchlistFunctions (database tools)"
```

---

### Task 3: Delegation tool names + `AIPortfolioAssistant.setDatabase` registers the database functions

**Files:**
- Create: `app/agent_team/functions/__init__.py` (empty), `app/agent_team/functions/agent_delegation_functions.py`
- Modify: `app/ai_portfolio_assistant.py` (`_registerDatabaseFunctions`, imports, docstring)
- Test: `tests/unit/test_agent_delegation_functions.py`, `tests/unit/test_ai_portfolio_assistant.py` (add one test)

**Interfaces:**
- `AgentDelegationFunctions.getToolNames() -> list` static, returning `['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']` (PHP `AgentTeam/Functions/AgentDelegationFunctions.php:41-48`). The class docstring states that the constructor and handlers (`delegateToAgent`, `listAvailableAgents`, `runAgentsParallel`, `completeTask`) are ported in Phase 5 with `AgentRunner`/`AgentRepository`; in 2c the class has only the static method. Task 4 consumes `getToolNames()`.
- `AIPortfolioAssistant._registerDatabaseFunctions()` = PHP 505–522: return when `not self.pdo`; register `PortfolioFunctions(self.pdo).getAllFunctions()`, `WatchlistFunctions(self.pdo).getAllFunctions()`, `AnalysisFunctions(self.config).getAllFunctions()` in that order; keep the `AnalysisFunctions` instance in `self._analysisFunctions` and close it in `close()` (Python-only, like `_searchFunctions`). Remove the "pending 2c" docstring/`error_log`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_agent_delegation_functions.py`:
```python
from app.agent_team.functions.agent_delegation_functions import AgentDelegationFunctions


def test_tool_names_match_php():
    assert AgentDelegationFunctions.getToolNames() == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']
```

Append to `tests/unit/test_ai_portfolio_assistant.py`:
```python
def test_set_database_registers_portfolio_watchlist_analysis_functions_in_php_order():
    class Db:
        def fetch_all(self, *a): return []
        def fetch_one(self, *a): return None
        def fetch_column(self, *a): return []
        def execute(self, *a): return 1
        def insert(self, *a): return 1
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}, 'tracking': {'enabled': False}})
    try:
        before = a.getToolsManager().getRegisteredFunctions()
        a.setDatabase(Db())
        after = a.getToolsManager().getRegisteredFunctions()
        assert after[:len(before)] == before
        assert after[len(before):] == ['get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions',
                                       'get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist',
                                       'get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment']
    finally:
        a.close()
    assert a._analysisFunctions.httpClient.is_closed
```

- [ ] **Step 2: Run to verify failure** — the delegation test fails with `ModuleNotFoundError`; the assistant test fails because `after == before`.

- [ ] **Step 3: Implement** per the Interfaces block. In `_registerDatabaseFunctions` mirror PHP's comments (`# Portfolio functions`, …).

- [ ] **Step 4: Run to verify pass** — both files PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python/app/agent_team/functions backend_python/app/ai_portfolio_assistant.py backend_python/tests/unit/test_agent_delegation_functions.py backend_python/tests/unit/test_ai_portfolio_assistant.py && git commit -m "feat(py): delegation tool names; setDatabase registers portfolio/watchlist/analysis functions"
```

---

### Task 4: `ProviderController` + routes + differential + docs

**Files:**
- Create: `app/controllers/provider_controller.py`, `tests/unit/test_provider_controller.py`, `tests/differential/test_providers_route.py`
- Modify: `app/routes.py` (three rows + registry entry), `backend_python/README.md` (Status: Phase 2c paragraph), `docs/backend-parity-tracker.md` (rows from the next free number)

**Interfaces:**
- `ProviderController(db, config)` with `list(request) -> dict` and `switch(request) -> dict` (PHP `ProviderController.php:36-205`), private `_resolvePackageAllowedProviders(userId: int | None) -> list | None` (PHP 213–235), `_getProvidersFromDatabase() -> list` (PHP 240–248). Consumes `LLMProviderResolver.applyDbSettings(db, config)`, `AIPortfolioAssistant(config)` (`getAllProviders`, `getToolsManager().getRegisteredFunctions()`, `setProvider`, `close`), `PackageResolver(db)` (`resolveForUser`, `allowedMcpServers`), `MCPToolsLoader(db)` (`loadToolsForUser(None, allowlist)`, `hasTools`, `getTools`), `AgentDelegationFunctions.getToolNames()`.
- `request['user_id']` may be `None` (app-key auth) — PHP's `is_numeric($userIdForPackage) ? (int)… : null` → `php_intval(x) if is_numeric(x) else None`; the custom-keys block runs only `if userId:` (PHP truthiness).
- `switch`: `request['body'].get('provider')`; falsy → 400 `'Provider name is required'`; `assistant.setProvider(name)` raising (`ValueError`, PHP `InvalidArgumentException`) → 400 with `str(e)` (= `"Provider 'x' is not available"`, same text both backends); success → `{'success': True, 'message': f'Switched to provider: {name}', 'current_provider': name, 'status_code': 200}`.
- Routes (PHP `routes.php:107-109`): `('GET', '/api/v1/providers', ('ProviderController', 'list'))`, `('POST', '/api/v1/providers', ('ProviderController', 'switch'))`, `('POST', '/api/v1/providers/switch', ('ProviderController', 'switch'))` — placed under a `# PROVIDER ROUTES` comment after the chat route, and `'ProviderController': ProviderController` in the registry dict.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_provider_controller.py`:
```python
import json
import pytest
from starlette.datastructures import Headers
from app.controllers.provider_controller import ProviderController
from app.support.http import Ctx

ROW = {'provider_key': 'kimi', 'display_name': 'Kimi', 'model': 'kimi-k2.6', 'supported_models': '["kimi-k2.6"]', 'max_tokens': '32768', 'api_format': 'openai',
       'enabled': 1, 'api_key': 'K', 'base_url': 'https://api.moonshot.ai', 'sort_order': 1}
ROW2 = {**ROW, 'provider_key': 'claude', 'display_name': 'Claude', 'model': 'claude-sonnet-4-5', 'supported_models': None, 'max_tokens': '8192', 'api_format': 'anthropic', 'base_url': 'https://api.anthropic.com'}


class Db:
    def __init__(self, keys=('kimi',)): self.keys = list(keys); self.calls = []
    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        if 'FROM system_llm_settings' in sql:
            return [ROW2, ROW]
        return []
    def fetch_column(self, sql, params=None):
        self.calls.append((sql, params))
        if 'FROM user_api_keys' in sql:
            return self.keys
        return []
    def fetch_one(self, sql, params=None): self.calls.append((sql, params)); return None
    def execute(self, sql, params=None): return 1
    def insert(self, sql, params=None): return 1


CFG = {'auth': {'jwt_secret': 'S'}, 'claude': {'api_key': 'K'}, 'database': {}, 'contexts_database': {}}


def ctx(body=None, user_id=3):
    c = Ctx(method='GET', uri='/api/v1/providers', headers=Headers({}), query={}, body=body or {}, raw_body='', params={}, user_id=user_id, authenticated=True, remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


@pytest.fixture
def quiet(monkeypatch):
    # No DB-backed provider settings, no package restrictions, no MCP servers.
    monkeypatch.setattr('app.controllers.provider_controller.LLMProviderResolver.applyDbSettings', staticmethod(lambda db, cfg: cfg))
    class PR:
        def __init__(self, db): pass
        def resolveForUser(self, uid): return {'capabilities': {}}
        def allowedMcpServers(self, uid): return None
    monkeypatch.setattr('app.controllers.provider_controller.PackageResolver', PR)
    class ML:
        def __init__(self, db): pass
        def loadToolsForUser(self, uid, allow): return {}
        def hasTools(self): return False
        def getTools(self): return {}
    monkeypatch.setattr('app.controllers.provider_controller.MCPToolsLoader', ML)


def test_list_shape_types_and_key_order(quiet):
    db = Db(); r = ProviderController(db, CFG).list(ctx())
    assert list(r) == ['success', 'providers', 'current_provider', 'user_has_custom_keys', 'user_enabled_providers', 'functions', 'function_count', 'status_code']
    assert r['success'] is True and r['current_provider'] is None and r['status_code'] == 200
    assert [p['name'] for p in r['providers']] == ['claude', 'kimi']
    claude, kimi = r['providers']
    assert list(claude) == ['name', 'display_name', 'model', 'available', 'supported_models', 'max_tokens', 'api_format', 'user_has_key']
    assert claude['supported_models'] == [] and claude['max_tokens'] == 8192 and claude['user_has_key'] is False and claude['available'] is True
    assert kimi['supported_models'] == ['kimi-k2.6'] and kimi['max_tokens'] == 32768 and kimi['user_has_key'] is True
    assert r['user_has_custom_keys'] is True and r['user_enabled_providers'] == ['kimi']
    assert r['functions'][-3:] == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel'] and r['function_count'] == len(r['functions'])
    assert r['functions'][0] == 'serpapi_search'                         # built-ins first, in ToolsManager order
    sql, params = [c for c in db.calls if 'FROM user_api_keys' in c[0]][0]
    assert sql == "SELECT provider FROM user_api_keys WHERE user_id = :user_id AND api_key IS NOT NULL AND api_key != ''" and params == {':user_id': 3}


def test_list_without_user_keys_and_without_user(quiet):
    r = ProviderController(Db(keys=()), CFG).list(ctx())
    assert r['user_has_custom_keys'] is False and r['user_enabled_providers'] == [] and all(p['user_has_key'] is False for p in r['providers'])
    r2 = ProviderController(Db(), CFG).list(ctx(user_id=None))
    assert r2['user_has_custom_keys'] is False and 'FROM user_api_keys' not in ' '.join(s for s, _ in Db().calls)


def test_package_allowlist_filters_and_mcp_tools_are_appended(quiet, monkeypatch):
    class PR:
        def __init__(self, db): pass
        def resolveForUser(self, uid): return {'capabilities': {'providers': {'kimi': {'enabled': True}, 'claude': {'enabled': False}}}}
        def allowedMcpServers(self, uid): return ['S']
    monkeypatch.setattr('app.controllers.provider_controller.PackageResolver', PR)
    class ML:
        def __init__(self, db): self.seen = None
        def loadToolsForUser(self, uid, allow): ML.seen = (uid, allow); return {}
        def hasTools(self): return True
        def getTools(self): return {'mcp_a': {}, 'mcp_b': {}}
    monkeypatch.setattr('app.controllers.provider_controller.MCPToolsLoader', ML)
    r = ProviderController(Db(), CFG).list(ctx())
    assert [p['name'] for p in r['providers']] == ['kimi']
    assert ML.seen == (None, ['S'])
    assert r['functions'][-5:] == ['mcp_a', 'mcp_b', 'delegate_to_agent', 'list_available_agents', 'run_agents_parallel']


def test_list_falls_back_to_assistant_providers_when_table_empty(quiet):
    class EmptyDb(Db):
        def fetch_all(self, sql, params=None): return []
    r = ProviderController(EmptyDb(keys=()), CFG).list(ctx())
    assert r['success'] is True and any(p['name'] == 'claude' for p in r['providers'])


def test_mcp_failure_is_logged_not_fatal(quiet, monkeypatch):
    class Boom:
        def __init__(self, db): raise RuntimeError('mcp down')
    monkeypatch.setattr('app.controllers.provider_controller.MCPToolsLoader', Boom)
    r = ProviderController(Db(), CFG).list(ctx())
    assert r['success'] is True and r['functions'][-3:] == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']


def test_switch_paths(quiet):
    c = ProviderController(Db(), CFG)
    assert c.switch(ctx(body={})) == {'success': False, 'error': 'Provider name is required', 'status_code': 400}
    assert c.switch(ctx(body={'provider': 'nope'})) == {'success': False, 'error': "Provider 'nope' is not available", 'status_code': 400}
    assert c.switch(ctx(body={'provider': 'claude'})) == {'success': True, 'message': 'Switched to provider: claude', 'current_provider': 'claude', 'status_code': 200}


def test_assistants_are_closed(quiet, monkeypatch):
    closed = []
    import app.controllers.provider_controller as pc
    real = pc.AIPortfolioAssistant
    class Spy(real):
        def close(self): closed.append(True); super().close()
    monkeypatch.setattr(pc, 'AIPortfolioAssistant', Spy)
    c = ProviderController(Db(), CFG); c.list(ctx()); c.switch(ctx(body={'provider': 'claude'})); c.switch(ctx(body={'provider': 'nope'}))
    assert closed == [True, True, True]
```

`tests/differential/test_providers_route.py`:
```python
"""GET /api/v1/providers and the switch routes: exact JSON parity vs live PHP (no LLM calls)."""
from .conftest import same


def test_list_exact(both):
    same(*both('GET', '/api/v1/providers'))


def test_list_requires_auth(both):
    same(*both('GET', '/api/v1/providers', auth=False))


def test_switch_missing_invalid_and_valid(both):
    same(*both('POST', '/api/v1/providers/switch', json={}))
    same(*both('POST', '/api/v1/providers/switch', json={'provider': 'no-such-provider'}))
    same(*both('POST', '/api/v1/providers/switch', json={'provider': 'kimi'}))
    same(*both('POST', '/api/v1/providers', json={'provider': 'claude'}))         # legacy POST alias
```

- [ ] **Step 2: Run to verify failure** — unit: `ModuleNotFoundError`; differential: Python returns 404 `Endpoint not found` vs PHP 200.

- [ ] **Step 3: Port `ProviderController.php` verbatim** (lines 20–249) and add the routes. Wrap each constructed assistant in `try/finally: assistant.close()`. Module docstring names the PHP source.

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python -m pytest -q tests/unit/test_provider_controller.py tests/differential/test_providers_route.py` → PASS (PHP up). A `test_list_exact` diff means either a `functions` ordering/naming drift (compare the two lists in the failure output — MCP tool names come from the same DB, so a difference is a loader-order or search-function-name drift, fix the port) or a provider row typing drift (`max_tokens` int, `supported_models` decoded, booleans).

- [ ] **Step 5: Browser smoke (controller-run, after the review)** — the controller (not the implementer) points the frontend at Python in Chrome, confirms the provider picker populates from `/api/v1/providers`, sends one Claude chat through the UI and checks the streamed reply and the usage row. Recorded in the ledger.

- [ ] **Step 6: Docs**

`backend_python/README.md` — after the Phase 2b paragraph add: "Phase 2c (2026-09): `GET /api/v1/providers` (+ `POST /api/v1/providers`, `POST /api/v1/providers/switch`) with a byte-equal body to PHP, so the frontend picker works on Python; built-in `AnalysisFunctions` (FMP), `PortfolioFunctions` and `WatchlistFunctions` (registered by `setDatabase`, used by the agent-team paths in Phase 5), and the delegation tool names. Verify/compare, attachments and the client-tool bridge remain pending Phase 2d."

`docs/backend-parity-tracker.md` — append rows (continue numbering; same format as rows 30–54):
- PY: `ProviderController` closes every `AIPortfolioAssistant` it constructs (Python-only; PHP relies on request teardown) | 🪞 | Up to eight httpx clients per call otherwise leak until GC.
- PY: `AgentDelegationFunctions` is names-only until Phase 5 (`getToolNames()`); handlers land with `AgentRunner` | 🪞 | `/providers` advertises the three names exactly as PHP.
- PY: Functions handlers call `raise_for_status()` on FMP responses so 4xx/5xx reach the same `catch` PHP's Guzzle exception reaches | 🪞 | Error text differs only after the PHP prefix (`Failed to fetch …: `).
- PY: `MetalsNewsFunctions` deleted in PHP and never ported (commented out; Metals News is an MCP server) | 🪞 | Owner rule: commented-out functions are deleted in every implementation.
- plus one row per additional ruling recorded in the ledger during 2c.

- [ ] **Step 7: Full verification, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
.venv/bin/python -m pytest -q tests/differential -k "not live"        # exact-compare cases only; the live LLM cases were run in 2b
cd .. && git add backend_python/app/controllers/provider_controller.py backend_python/app/routes.py backend_python/tests/unit/test_provider_controller.py backend_python/tests/differential/test_providers_route.py backend_python/README.md docs/backend-parity-tracker.md && git commit -m "feat(py): ProviderController + /api/v1/providers routes; docs(py): Phase 2c status + parity rows"
```

---

## Self-review notes

- **Spec coverage (§2 row 2c as amended):** `AnalysisFunctions` → T1; `PortfolioFunctions`/`WatchlistFunctions` → T2; `AgentDelegationFunctions` (names) → T3; `ProviderController` → T4. `setDatabase` registration (PHP 86–99/505–522) → T3 so Phase 5 finds the functions in place. Browser smoke per sub-phase (§6) → T4 Step 5, controller-run.
- **Placeholders:** the `or`-form assertions in T2 are explicitly PHP-truth placeholders the implementer must tighten before commit and the reviewer must verify against PHP lines; no other step defers content.
- **Type consistency:** `Db` fake methods match `app.db.Db` (`fetch_all/fetch_one/fetch_column/execute/insert`); `ToolsManager.registerFunctions(dict)`/`getRegisteredFunctions() -> list` (2a); `PackageResolver.resolveForUser/allowedMcpServers` and `MCPToolsLoader.loadToolsForUser(userId, allowedServerNames)/hasTools/getTools` (2a signatures confirmed); `AIPortfolioAssistant.setProvider` raises `ValueError("Provider 'x' is not available")` matching PHP's `InvalidArgumentException` text; `Ctx(...)` constructor and `c['auth_type']` convention from `tests/unit/test_chat_controller_flows.py`.
