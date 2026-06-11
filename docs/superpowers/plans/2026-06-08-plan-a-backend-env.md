# Plan A — Backend Secret Centralization (`backend/.env`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every secret out of the four `ai_config.php` files into one gitignored `backend/.env`, so no committed PHP file contains a secret — without consolidating or rewiring the configs.

**Architecture:** Add `vlucas/phpdotenv` + a shared `backend/config/load_env.php` loader. Each of the four `ai_config.php` requires the loader at its top and reads its secret values from `$_ENV` (structure otherwise unchanged). A golden-master snapshot guarantees the *effective* config is identical before/after. `.env` is gitignored; `ai_config.php` (now secret-free) becomes committed.

**Tech Stack:** PHP 8.1+, Composer, `vlucas/phpdotenv`, PHPUnit 10.

**Spec:** `docs/superpowers/specs/2026-06-08-secret-centralization-design.md`
**Working dir for all commands:** `/Applications/XAMPP/xamppfiles/htdocs/gpt`

---

## Facts established during planning

- Four configs, all secret-bearing, **not** duplicates but with **consistent values** for shared keys:
  - `backend/config/ai_config.php` (canonical): DB×2, `auth.jwt_secret`, `auth.app_key_secret`, search×3, `financial.fmp`, `hume_evi`, `grok_voice`, `gemini_voice`, `scheduler.token`.
  - `backend/database/config/`, `backend/migrations/config/`, `backend/examples/config/` (18 KB): also carry inline provider keys `claude`, `openai`, `providers.{kimi,grok,gemini,deepseek}`; they have DB×2, `auth.jwt_secret`, search×3, `financial.fmp`, `hume_evi` — but **no** `app_key_secret`/`grok_voice`/`gemini_voice`/`scheduler`.
- Shared keys hold identical values across all four → **one `.env` var per logical secret**.
- `.env` lives at `backend/.env`; the loader (`backend/config/load_env.php`) resolves the backend root from its own `__DIR__`.

### Canonical env-var mapping (the single source of truth for this plan)

| `.env` var | Config path |
|---|---|
| `DB_HOST` `DB_NAME` `DB_USER` `DB_PASS` | `database.{host,database,username,password}` |
| `CTX_DB_HOST` `CTX_DB_NAME` `CTX_DB_USER` `CTX_DB_PASS` | `contexts_database.{host,database,username,password}` |
| `JWT_SECRET` | `auth.jwt_secret` |
| `APP_KEY_SECRET` | `auth.app_key_secret` (canonical only) |
| `SERPAPI_KEY` `SCRAPINGDOG_KEY` `BRAVE_KEY` | `search.{serpapi,scrapingdog,brave}.api_key` |
| `FMP_KEY` | `financial.fmp.api_key` |
| `HUME_API_KEY` | `hume_evi.api_key` |
| `GROK_VOICE_API_KEY` `GEMINI_VOICE_API_KEY` | `grok_voice.api_key`, `gemini_voice.api_key` (canonical only) |
| `SCHEDULER_TOKEN` | `scheduler.token` (canonical only) |
| `CLAUDE_API_KEY` `OPENAI_API_KEY` | `claude.api_key`, `openai.api_key` (18 KB only) |
| `KIMI_API_KEY` `GROK_API_KEY` `GEMINI_API_KEY` `DEEPSEEK_API_KEY` | `providers.{kimi,grok,gemini,deepseek}.api_key` (18 KB only) |

---

## Task 1: Golden-master baseline of all four configs

**Files:** Create `backend/tests/config_baseline.php` (helper, committed — no secrets in it).

- [ ] **Step 1: Write the baseline dumper.** `backend/tests/config_baseline.php`:

```php
<?php
// Dumps each config's effective array (secret values HASHED) to compare before/after the .env move.
declare(strict_types=1);
$files = ['config','database/config','migrations/config','examples/config'];
$flatten = function ($a, $p = '') use (&$flatten) {
    $out = [];
    foreach ($a as $k => $v) {
        $key = $p === '' ? (string)$k : "$p.$k";
        if (is_array($v)) { $out += $flatten($v, $key); }
        else { $out[$key] = preg_match('/(api_key|password|secret|token)$/i', $key) || str_ends_with($key, '.username')
            ? 'H:' . md5((string)$v) : $v; }
    }
    return $out;
};
$snap = [];
foreach ($files as $f) { $snap[$f] = $flatten(require __DIR__ . "/../$f/ai_config.php"); }
echo json_encode($snap, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
```

- [ ] **Step 2: Capture the BEFORE snapshot.**

Run: `php backend/tests/config_baseline.php > /tmp/gpt_config_before.json && wc -l /tmp/gpt_config_before.json`
Expected: a JSON file with four top-level keys; non-zero line count. (Secrets are stored only as `H:<md5>`.)

- [ ] **Step 3: Commit the helper.**

```bash
git add backend/tests/config_baseline.php
git commit -m "test: golden-master config baseline dumper (hashed secrets)"
```

---

## Task 2: Add phpdotenv + the shared env loader (TDD)

**Files:** Modify `backend/composer.json` (via composer); Create `backend/config/load_env.php`, `backend/tests/EnvLoaderTest.php`.

- [ ] **Step 1: Install phpdotenv.**

Run: `cd backend && composer require vlucas/phpdotenv:^5.6 && cd ..`
Expected: `vlucas/phpdotenv` added to `composer.json` require + installed to `vendor/`.

- [ ] **Step 2: Write the failing test — `backend/tests/EnvLoaderTest.php`:**

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests;
use PHPUnit\Framework\TestCase;

final class EnvLoaderTest extends TestCase
{
    public function testLoadsValuesFromEnvFile(): void
    {
        // A .env at backend/.env must exist with the required keys for the app to boot.
        require __DIR__ . '/../config/load_env.php';
        $this->assertNotSame('', $_ENV['DB_HOST'] ?? '', 'DB_HOST should be loaded from backend/.env');
        $this->assertNotSame('', $_ENV['JWT_SECRET'] ?? '', 'JWT_SECRET should be loaded from backend/.env');
    }
}
```

- [ ] **Step 3: Run it — expect FAIL** (no `load_env.php` yet / no `.env`):

Run: `cd backend && ./vendor/bin/phpunit tests/EnvLoaderTest.php; cd ..`
Expected: FAIL (file not found, or required-keys error). Xdebug warnings are harmless.

- [ ] **Step 4: Create `backend/config/load_env.php`:**

```php
<?php
declare(strict_types=1);
// Loads backend/.env once into $_ENV and validates required keys.
// Required at the top of every ai_config.php so all consumers get secrets from one file.
if (defined('GPT_ENV_LOADED')) { return; }

$backendRoot = dirname(__DIR__); // .../backend/config -> .../backend
require_once $backendRoot . '/vendor/autoload.php';

\Dotenv\Dotenv::createImmutable($backendRoot)->safeLoad(); // no throw if .env absent (prod may set real env)

$required = ['DB_HOST','DB_NAME','DB_USER','DB_PASS','CTX_DB_HOST','CTX_DB_NAME','CTX_DB_USER','CTX_DB_PASS','JWT_SECRET','APP_KEY_SECRET'];
$missing = array_values(array_filter($required, static fn($k) => ($_ENV[$k] ?? '') === ''));
if ($missing !== []) {
    throw new \RuntimeException(
        'Missing required env vars: ' . implode(', ', $missing)
        . '. Copy backend/.env.example to backend/.env and fill it in.'
    );
}
define('GPT_ENV_LOADED', true);
```

- [ ] **Step 5: Note** — the test fully passes only after Task 3 creates `backend/.env`. For now confirm the file parses:

Run: `php -l backend/config/load_env.php`
Expected: `No syntax errors detected`.

- [ ] **Step 6: Commit.**

```bash
git add backend/composer.json backend/composer.lock backend/config/load_env.php backend/tests/EnvLoaderTest.php
git commit -m "feat(backend): add phpdotenv + shared env loader with required-keys check"
```

---

## Task 3: Generate `backend/.env` + commit `backend/.env.example`

**Files:** Create `backend/.env` (gitignored), `backend/.env.example` (committed). Temp script not committed.

- [ ] **Step 1: Write the one-off generator — `/tmp/gpt_gen_env.php`:**

```php
<?php
// Reads the CURRENT (still-literal) configs and writes backend/.env + backend/.env.example.
// MUST run BEFORE the configs are converted to read $_ENV.
$root = '/Applications/XAMPP/xamppfiles/htdocs/gpt/backend';
$canon = require "$root/config/ai_config.php";
$big   = require "$root/database/config/ai_config.php";
$g = function($a, $path){ foreach (explode('.', $path) as $k){ $a = $a[$k] ?? null; } return $a; };
$map = [
  'DB_HOST'=>$g($canon,'database.host'),'DB_NAME'=>$g($canon,'database.database'),
  'DB_USER'=>$g($canon,'database.username'),'DB_PASS'=>$g($canon,'database.password'),
  'CTX_DB_HOST'=>$g($canon,'contexts_database.host'),'CTX_DB_NAME'=>$g($canon,'contexts_database.database'),
  'CTX_DB_USER'=>$g($canon,'contexts_database.username'),'CTX_DB_PASS'=>$g($canon,'contexts_database.password'),
  'JWT_SECRET'=>$g($canon,'auth.jwt_secret'),'APP_KEY_SECRET'=>$g($canon,'auth.app_key_secret'),
  'SERPAPI_KEY'=>$g($canon,'search.serpapi.api_key'),'SCRAPINGDOG_KEY'=>$g($canon,'search.scrapingdog.api_key'),
  'BRAVE_KEY'=>$g($canon,'search.brave.api_key'),'FMP_KEY'=>$g($canon,'financial.fmp.api_key'),
  'HUME_API_KEY'=>$g($canon,'hume_evi.api_key'),
  'GROK_VOICE_API_KEY'=>$g($canon,'grok_voice.api_key'),'GEMINI_VOICE_API_KEY'=>$g($canon,'gemini_voice.api_key'),
  'SCHEDULER_TOKEN'=>$g($canon,'scheduler.token'),
  'CLAUDE_API_KEY'=>$g($big,'claude.api_key'),'OPENAI_API_KEY'=>$g($big,'openai.api_key'),
  'KIMI_API_KEY'=>$g($big,'providers.kimi.api_key'),'GROK_API_KEY'=>$g($big,'providers.grok.api_key'),
  'GEMINI_API_KEY'=>$g($big,'providers.gemini.api_key'),'DEEPSEEK_API_KEY'=>$g($big,'providers.deepseek.api_key'),
];
$env=''; $ex='';
foreach ($map as $k=>$v){ $env .= "$k=\"" . str_replace('"','\"',(string)$v) . "\"\n"; $ex .= "$k=\n"; }
file_put_contents("$root/.env", $env);
file_put_contents("$root/.env.example", $ex);
$blank = array_keys(array_filter($map, fn($v)=>($v??'')===''));
echo 'WROTE backend/.env (' . count($map) . " keys); blank: " . (implode(',', $blank) ?: 'none') . "\n";
```

- [ ] **Step 2: Run it.**

Run: `php /tmp/gpt_gen_env.php`
Expected: `WROTE backend/.env (24 keys); blank: none`. (If any key is blank, STOP — a source value was missing.)

- [ ] **Step 3: Sanity-check `.env`** (counts only, no values):

Run: `grep -c '=' backend/.env && grep -c '=' backend/.env.example`
Expected: `24` and `24`.

- [ ] **Step 4: Confirm the loader now passes.**

Run: `cd backend && ./vendor/bin/phpunit tests/EnvLoaderTest.php; cd ..`
Expected: PASS (1 test).

- [ ] **Step 5: Commit ONLY the example** (`.env` is ignored — verify in Task 8 it is):

```bash
git add backend/.env.example
git commit -m "feat(backend): commit .env.example template (placeholders)"
```

---

## Task 4: Convert `backend/config/ai_config.php` to read `$_ENV`

**Files:** Modify `backend/config/ai_config.php`.

- [ ] **Step 1: Add the loader at the very top** (after `<?php`):

```php
require_once __DIR__ . '/load_env.php';
```

- [ ] **Step 2: Replace each secret literal with an `$_ENV` read**, using the mapping table. Examples:

```php
// database
'host'     => $_ENV['DB_HOST'] ?? '',
'database' => $_ENV['DB_NAME'] ?? '',
'username' => $_ENV['DB_USER'] ?? '',
'password' => $_ENV['DB_PASS'] ?? '',
// contexts_database → CTX_DB_*  (same shape)
// auth
'jwt_secret'     => $_ENV['JWT_SECRET'] ?? '',
'app_key_secret' => $_ENV['APP_KEY_SECRET'] ?? '',
// search.serpapi/scrapingdog/brave .api_key → SERPAPI_KEY / SCRAPINGDOG_KEY / BRAVE_KEY
// financial.fmp.api_key → FMP_KEY ; hume_evi.api_key → HUME_API_KEY
// grok_voice.api_key → GROK_VOICE_API_KEY ; gemini_voice.api_key → GEMINI_VOICE_API_KEY
// scheduler.token → SCHEDULER_TOKEN
```

Leave all **non-secret** values as literals (`base_url`, `charset`, `engine`, `max_results`, model names, booleans, etc.). The secret keys for THIS file are exactly: `database.{host,database,username,password}`, `contexts_database.{host,database,username,password}`, `auth.jwt_secret`, `auth.app_key_secret`, `search.{serpapi,scrapingdog,brave}.api_key`, `financial.fmp.api_key`, `hume_evi.api_key`, `grok_voice.api_key`, `gemini_voice.api_key`, `scheduler.token`.

- [ ] **Step 3: Verify the effective config is unchanged** (golden master):

Run: `php backend/tests/config_baseline.php > /tmp/gpt_config_after.json && php -r '$a=json_decode(file_get_contents("/tmp/gpt_config_before.json"),true)["config"]; $b=json_decode(file_get_contents("/tmp/gpt_config_after.json"),true)["config"]; echo $a==$b ? "MATCH\n" : "DIFF: ".json_encode(array_keys(array_diff_assoc($a,$b)))."\n";'`
Expected: `MATCH` (the `config` section's effective values, incl. hashed secrets, are identical).

- [ ] **Step 4: Commit.**

```bash
git add backend/config/ai_config.php
git commit -m "refactor(backend): config/ai_config.php reads secrets from .env"
```

---

## Task 5: Convert `backend/database/config/ai_config.php`

**Files:** Modify `backend/database/config/ai_config.php`.

- [ ] **Step 1: Add the loader at the top** (note the deeper path):

```php
require_once dirname(__DIR__, 2) . '/config/load_env.php';
```

- [ ] **Step 2: Replace this file's secret literals** with `$_ENV` reads. Secret keys for the 18 KB configs are: `claude.api_key`→`CLAUDE_API_KEY`, `openai.api_key`→`OPENAI_API_KEY`, `providers.{kimi,grok,gemini,deepseek}.api_key`→`{KIMI,GROK,GEMINI,DEEPSEEK}_API_KEY`, `search.{serpapi,scrapingdog,brave}.api_key`, `financial.fmp.api_key`→`FMP_KEY`, `database.{host,database,username,password}`→`DB_*`, `contexts_database.*`→`CTX_DB_*`, `auth.jwt_secret`→`JWT_SECRET`, `hume_evi.api_key`→`HUME_API_KEY`. (This file has **no** `app_key_secret`/`grok_voice`/`gemini_voice`/`scheduler` — don't add them.)

- [ ] **Step 3: Verify golden master for this section:**

Run: `php backend/tests/config_baseline.php > /tmp/gpt_config_after.json && php -r '$k="database/config"; $a=json_decode(file_get_contents("/tmp/gpt_config_before.json"),true)[$k]; $b=json_decode(file_get_contents("/tmp/gpt_config_after.json"),true)[$k]; echo $a==$b?"MATCH\n":"DIFF: ".json_encode(array_keys(array_diff_assoc($a,$b)))."\n";'`
Expected: `MATCH`.

- [ ] **Step 4: Commit.**

```bash
git add backend/database/config/ai_config.php
git commit -m "refactor(backend): database/config/ai_config.php reads secrets from .env"
```

---

## Task 6: Convert `backend/migrations/config/ai_config.php`

**Files:** Modify `backend/migrations/config/ai_config.php`.

- [ ] **Step 1: Loader at top:** `require_once dirname(__DIR__, 2) . '/config/load_env.php';`
- [ ] **Step 2: Replace secret literals** — identical secret-key set and mapping as Task 5.
- [ ] **Step 3: Verify golden master** (use key `"migrations/config"` in the compare command from Task 5 Step 3). Expected: `MATCH`.
- [ ] **Step 4: Commit:** `git add backend/migrations/config/ai_config.php && git commit -m "refactor(backend): migrations/config/ai_config.php reads secrets from .env"`

---

## Task 7: Convert `backend/examples/config/ai_config.php`

**Files:** Modify `backend/examples/config/ai_config.php`.

- [ ] **Step 1: Loader at top:** `require_once dirname(__DIR__, 2) . '/config/load_env.php';`
- [ ] **Step 2: Replace secret literals** — identical secret-key set and mapping as Task 5.
- [ ] **Step 3: Verify golden master** (key `"examples/config"`). Expected: `MATCH`.
- [ ] **Step 4: Commit:** `git add backend/examples/config/ai_config.php && git commit -m "refactor(backend): examples/config/ai_config.php reads secrets from .env"`

---

## Task 8: Flip `.gitignore` + secret gates

**Files:** Modify `.gitignore`.

- [ ] **Step 1: Update `.gitignore`.** Remove the `ai_config.php` lines (now secret-free → committed) and add `backend/.env` + the temp baseline:

Remove:
```
ai_config.php
**/ai_config.php
```
Add (under the secrets section):
```
backend/.env
```

- [ ] **Step 2: Stage the now-tracked configs + verify `.env` is NOT staged.**

Run:
```bash
git add .gitignore backend/config/ai_config.php backend/database/config/ai_config.php backend/migrations/config/ai_config.php backend/examples/config/ai_config.php
git status --porcelain | grep -E "\.env$" && echo "ERROR: .env staged" || echo "OK: .env not staged"
```
Expected: `OK: .env not staged`.

- [ ] **Step 3: Secret gate — no key patterns in any tracked config now.**

Run:
```bash
git add -A
git grep --cached -lIE "sk-ant-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}" -- 'backend/**/ai_config.php' ; echo "exit=$?"
```
Expected: no filenames printed (`exit=1` from git grep = no matches).

- [ ] **Step 4: Commit.**

```bash
git commit -m "chore(backend): gitignore .env, commit secret-free ai_config.php files"
```

---

## Task 9: Full verification

- [ ] **Step 1: Loader + DB still work** (reads from `.env`):

Run:
```bash
php -r 'require "backend/config/ai_config.php"; $c=require "backend/config/ai_config.php"; $d=$c["database"];
new PDO("mysql:host={$d["host"]};dbname={$d["database"]};charset=utf8mb4",$d["username"],$d["password"],[PDO::ATTR_TIMEOUT=>8]); echo "DB OK\n";'
```
Expected: `DB OK`.

- [ ] **Step 2: Backend test suite.**

Run: `cd backend && ./vendor/bin/phpunit; cd ..`
Expected: passes (same as before the change; the new `EnvLoaderTest` included). Note pre-existing failures unrelated to config, if any, separately.

- [ ] **Step 3: Live auth smoke** (the original login-blocking path): an authed request validates the app key via DB using `.env` creds.

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost/gpt/backend/api/v1/webauthn/challenge -H 'Authorization: Bearer test'`
Expected: a **non-500** status (401/400 is fine — it means the DB/app-key path ran). A 500 means a config/DB regression.

- [ ] **Step 4: No secret remains in any tracked PHP config.**

Run: `git grep -IlE "sk-ant-[A-Za-z0-9_-]{15,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}" -- 'backend/**/*.php' ; echo "exit=$?"`
Expected: nothing printed (`exit=1`).

- [ ] **Step 5: Manual** — confirm the app login works in the browser (DB-backed auth via `.env`).

---

## Done — Plan A outcome

All four `ai_config.php` are secret-free and read from one gitignored `backend/.env`; the effective
config is provably unchanged (golden master MATCH ×4); `.env.example` documents the keys; the app and
tests run from `.env`. No PHP file contains a secret. **Frontend (Plan B)** handled separately.
