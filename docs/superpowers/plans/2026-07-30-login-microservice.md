# Login Microservice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone SSO-style login microservice at `/Applications/XAMPP/xamppfiles/htdocs/login` with its own DB; apps send the browser there with an app key + redirect URL and get a JWT back via URL fragment.

**Architecture:** PHP front-controller service (FastRoute + firebase/php-jwt) ported from gpt's auth stack, trimmed of gpt-specific concerns (plans, ledger, per-user app keys). New `registered_apps` table pins each app's key to its entry-point URL. Tokens are HS256 with the SAME `JWT_SECRET` as gpt, so gpt's middleware validates them unchanged.

**Tech Stack:** PHP 8.4 (XAMPP Apache), MySQL (`netfo587_login`), composer (`firebase/php-jwt ^7`, `nikic/fast-route ^1.3`, `vlucas/phpdotenv ^5.6`), PHPUnit 10 (sqlite in-memory), vanilla JS + Tailwind CDN frontend, Firebase Auth (project `transledgersite`) for social login.

**Spec:** `/Applications/XAMPP/xamppfiles/htdocs/gpt/docs/superpowers/specs/2026-07-30-login-microservice-design.md`

## Global Constraints

- Project root: `/Applications/XAMPP/xamppfiles/htdocs/login` (NEW git repo — `git init` in Task 1; all commits below run there)
- PHP namespace: `LoginService\` → `backend/src/` (tests: `LoginService\Tests\` → `backend/tests/`)
- JWT claims: `iss: 'login-service'`, `iat`, `exp`, `sub` = user id (int), `type` = `'access'` (28800s) | `'refresh'` (604800s), HS256
- `JWT_SECRET` in `login/backend/.env` MUST be copied verbatim from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/.env`
- App keys: prefix `lak_` + 32 hex chars; stored as `key_prefix` (first 12 chars) + `key_hash` = HMAC-SHA256(`LOGIN_APP_KEY_SECRET`, full key)
- DB name: `netfo587_login`; charset utf8mb4; MySQL binary: `/Applications/XAMPP/xamppfiles/bin/mysql`
- API base path (behind Apache rewrite): `/login/backend/api/v1`
- Error responses are JSON `{success: false, message: ...}`; expired refresh adds `error: "refresh_expired"`
- No plans/ledger/`uak_`/`ak_` logic anywhere — those stay in gpt
- Unit tests use `PDO('sqlite::memory:')` with `$db->sqliteCreateFunction('NOW', fn() => date('Y-m-d H:i:s'))` because production SQL uses MySQL `NOW()`
- Run tests from `backend/`: `vendor/bin/phpunit` (composer at `/usr/local/bin/composer`)

---

### Task 1: Project scaffold

**Files:**
- Create: `login/.gitignore`, `login/backend/composer.json`, `login/backend/phpunit.xml`, `login/backend/config/load_env.php`, `login/backend/config/config.php`, `login/backend/.env.example`, `login/backend/.env`

**Interfaces:**
- Produces: `$config = require backend/config/config.php` — keys `database`, `import_database`, `auth.{jwt_secret,jwt_expiry,refresh_expiry,app_key_secret}`, `firebase.project_id`, `webauthn.rp_name`. Composer autoload `LoginService\` → `src/`, `LoginService\Tests\` → `tests/`.

- [ ] **Step 1: Create directory tree and git repo**

```bash
mkdir -p /Applications/XAMPP/xamppfiles/htdocs/login/backend/{config,src/{Controllers,Middleware,Services,Support},schema,scripts,tests/Unit} \
         /Applications/XAMPP/xamppfiles/htdocs/login/frontend/assets/js
cd /Applications/XAMPP/xamppfiles/htdocs/login && git init
```

- [ ] **Step 2: Write `login/.gitignore`**

```
backend/vendor/
backend/.env
```

- [ ] **Step 3: Write `login/backend/composer.json`**

```json
{
    "name": "didierphmartin/login-service",
    "description": "Standalone SSO-style login microservice for the htdocs apps",
    "type": "project",
    "license": "MIT",
    "require": {
        "php": ">=8.1",
        "firebase/php-jwt": "^7.0",
        "nikic/fast-route": "^1.3",
        "vlucas/phpdotenv": "^5.6"
    },
    "require-dev": {
        "phpunit/phpunit": "^10.0"
    },
    "autoload": {
        "psr-4": { "LoginService\\": "src/" }
    },
    "autoload-dev": {
        "psr-4": { "LoginService\\Tests\\": "tests/" }
    },
    "scripts": { "test": "phpunit" },
    "config": { "sort-packages": true }
}
```

- [ ] **Step 4: Write `login/backend/phpunit.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"
         bootstrap="vendor/autoload.php"
         colors="true">
    <testsuites>
        <testsuite name="unit">
            <directory>tests/Unit</directory>
        </testsuite>
    </testsuites>
</phpunit>
```

- [ ] **Step 5: Write `login/backend/config/load_env.php`**

```php
<?php
declare(strict_types=1);
// Loads backend/.env once into $_ENV and validates required keys.
if (defined('LOGIN_ENV_LOADED')) { return; }

$backendRoot = dirname(__DIR__); // .../backend/config -> .../backend
require_once $backendRoot . '/vendor/autoload.php';

\Dotenv\Dotenv::createImmutable($backendRoot)->safeLoad();

$required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'JWT_SECRET', 'LOGIN_APP_KEY_SECRET'];
$missing = array_values(array_filter($required, static fn($k) => ($_ENV[$k] ?? '') === ''));
if ($missing !== []) {
    throw new \RuntimeException(
        'Missing required env vars: ' . implode(', ', $missing)
        . '. Copy backend/.env.example to backend/.env and fill it in.'
    );
}
define('LOGIN_ENV_LOADED', true);
```

- [ ] **Step 6: Write `login/backend/config/config.php`**

```php
<?php

require_once __DIR__ . '/load_env.php';

return [
    // Own database (netfo587_login)
    'database' => [
        'host' => $_ENV['DB_HOST'] ?? '',
        'database' => $_ENV['DB_NAME'] ?? '',
        'username' => $_ENV['DB_USER'] ?? '',
        'password' => $_ENV['DB_PASS'] ?? '',
        'charset' => 'utf8mb4',
    ],
    // Source DB for scripts/import-users.php (gpt's contexts DB, netfo587_chatbot)
    'import_database' => [
        'host' => $_ENV['IMPORT_DB_HOST'] ?? '',
        'database' => $_ENV['IMPORT_DB_NAME'] ?? '',
        'username' => $_ENV['IMPORT_DB_USER'] ?? '',
        'password' => $_ENV['IMPORT_DB_PASS'] ?? '',
        'charset' => 'utf8mb4',
    ],
    'auth' => [
        // Same value as gpt's JWT_SECRET so gpt validates our tokens unchanged.
        'jwt_secret' => $_ENV['JWT_SECRET'] ?? '',
        'jwt_expiry' => 28800,      // 8 hours
        'refresh_expiry' => 604800, // 7 days
        // HMAC pepper for registered_apps.key_hash ('lak_' app keys).
        'app_key_secret' => $_ENV['LOGIN_APP_KEY_SECRET'] ?? '',
    ],
    'firebase' => [
        'project_id' => $_ENV['FIREBASE_PROJECT_ID'] ?? 'transledgersite',
    ],
    'webauthn' => [
        'rp_name' => 'Login Service',
    ],
];
```

- [ ] **Step 7: Write `login/backend/.env.example`**

```
# Own database (netfo587_login — created in Task 2)
DB_HOST=localhost
DB_NAME=netfo587_login
DB_USER=
DB_PASS=
# MUST equal gpt's JWT_SECRET (gpt/backend/.env) so gpt validates our tokens
JWT_SECRET=
# HMAC pepper for registered_apps keys — generate: php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
LOGIN_APP_KEY_SECRET=
# Firebase project for social-login ID token verification
FIREBASE_PROJECT_ID=transledgersite
# Source DB for scripts/import-users.php (gpt's contexts DB, netfo587_chatbot)
IMPORT_DB_HOST=
IMPORT_DB_NAME=
IMPORT_DB_USER=
IMPORT_DB_PASS=
```

- [ ] **Step 8: Write `login/backend/.env` with real values**

Copy `.env.example` to `.env`, then fill it: `DB_USER`/`DB_PASS` and all four `IMPORT_DB_*` values come from the `CTX_DB_HOST/CTX_DB_NAME/CTX_DB_USER/CTX_DB_PASS` lines of `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/.env` (IMPORT_DB_NAME = that CTX_DB_NAME, i.e. netfo587_chatbot; our own DB_NAME stays `netfo587_login`). `JWT_SECRET` is copied verbatim from the same file. Generate the pepper:

```bash
php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'   # → LOGIN_APP_KEY_SECRET
```

- [ ] **Step 9: Install dependencies and verify**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login/backend && composer install
vendor/bin/phpunit --version
php -r '$c = require "config/config.php"; echo $c["database"]["database"], PHP_EOL;'
```
Expected: PHPUnit 10.x banner; `netfo587_login` printed (proves .env loads and required keys present).

- [ ] **Step 10: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "chore: scaffold login service (composer, config, env loading)"
```

---

### Task 2: Database schema

**Files:**
- Create: `login/backend/schema/login.sql`

**Interfaces:**
- Produces: MySQL DB `netfo587_login` with tables `users`, `registered_apps`, `webauthn_credentials`, `webauthn_challenges`. Later tasks' SQL depends on exactly these column names.

- [ ] **Step 1: Write `login/backend/schema/login.sql`**

```sql
-- Login service schema. Users/webauthn ported from gpt's netfo587_chatbot
-- (chatbot.sql) minus gpt-only columns (ledger_user_id, plan, storage_*,
-- app_key_*). registered_apps is new. Ids are preserved on import, so
-- users.id stays a plain AUTO_INCREMENT int like the source.

CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'bcrypt hash; NULL for social-only accounts',
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `firebase_uid` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `provider` enum('email','google','facebook','phone') COLLATE utf8mb4_unicode_ci DEFAULT 'email',
  `role` enum('guest','prospect','user','admin','affiliate') COLLATE utf8mb4_unicode_ci DEFAULT 'user',
  `profile_picture` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email_verified` tinyint(1) DEFAULT '0',
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `firebase_uid` (`firebase_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `registered_apps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `app_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_prefix` char(12) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'HMAC-SHA256(LOGIN_APP_KEY_SECRET, full key)',
  `entry_point` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Absolute URL; redirect targets must live under it',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `app_id` (`app_id`),
  KEY `key_prefix` (`key_prefix`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `webauthn_credentials` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `credential_id` varchar(255) NOT NULL,
  `public_key` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `credential_id` (`credential_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `webauthn_challenges` (
  `challenge` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `action` varchar(20) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`challenge`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: Create the database and apply the schema**

Read `DB_USER`/`DB_PASS` from `login/backend/.env`, then:

```bash
MYSQL=/Applications/XAMPP/xamppfiles/bin/mysql
$MYSQL -u "$DB_USER" -p"$DB_PASS" -e "CREATE DATABASE IF NOT EXISTS netfo587_login CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
$MYSQL -u "$DB_USER" -p"$DB_PASS" netfo587_login < /Applications/XAMPP/xamppfiles/htdocs/login/backend/schema/login.sql
```

- [ ] **Step 3: Verify tables exist**

```bash
$MYSQL -u "$DB_USER" -p"$DB_PASS" -e "SHOW TABLES FROM netfo587_login;"
```
Expected output lists: `registered_apps`, `users`, `webauthn_challenges`, `webauthn_credentials`.

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: netfo587_login schema (users, registered_apps, webauthn)"
```

### Task 3: TokenService (TDD)

**Files:**
- Create: `login/backend/src/Services/TokenService.php`
- Test: `login/backend/tests/Unit/Services/TokenServiceTest.php`

**Interfaces:**
- Produces: `LoginService\Services\TokenService::__construct(string $secret, int $accessTtl = 28800, int $refreshTtl = 604800)` (throws `RuntimeException` on empty secret); `mintAccess(int $userId): string`; `mintPair(int $userId): array{access_token: string, refresh_token: string}`; `decode(string $jwt): ?object` (null on any failure); `accessTtl(): int`. Used by AuthController, AuthMiddleware, WebAuthnController.

- [ ] **Step 1: Write the failing test**

`login/backend/tests/Unit/Services/TokenServiceTest.php`:

```php
<?php

declare(strict_types=1);

namespace LoginService\Tests\Unit\Services;

use LoginService\Services\TokenService;
use PHPUnit\Framework\TestCase;

final class TokenServiceTest extends TestCase
{
    public function testMintPairProducesDecodableAccessAndRefreshTokens(): void
    {
        $svc = new TokenService('secret-1', 3600, 7200);
        $pair = $svc->mintPair(42);

        $access = $svc->decode($pair['access_token']);
        $refresh = $svc->decode($pair['refresh_token']);

        $this->assertSame(42, (int) $access->sub);
        $this->assertSame('access', $access->type);
        $this->assertSame('login-service', $access->iss);
        $this->assertSame('refresh', $refresh->type);
        $this->assertGreaterThan(time() + 3500, $access->exp);
        $this->assertLessThan(time() + 3700, $access->exp);
        $this->assertGreaterThan(time() + 7100, $refresh->exp);
    }

    public function testDecodeRejectsWrongSecret(): void
    {
        $pair = (new TokenService('secret-1'))->mintPair(1);
        $this->assertNull((new TokenService('secret-2'))->decode($pair['access_token']));
    }

    public function testDecodeRejectsGarbage(): void
    {
        $this->assertNull((new TokenService('secret-1'))->decode('not-a-jwt'));
    }

    public function testEmptySecretThrows(): void
    {
        $this->expectException(\RuntimeException::class);
        new TokenService('');
    }

    public function testAccessTtlAccessor(): void
    {
        $this->assertSame(3600, (new TokenService('s', 3600, 7200))->accessTtl());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/login/backend && vendor/bin/phpunit --filter TokenServiceTest`
Expected: FAIL — `Class "LoginService\Services\TokenService" not found`

- [ ] **Step 3: Write the implementation**

`login/backend/src/Services/TokenService.php`:

```php
<?php

declare(strict_types=1);

namespace LoginService\Services;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

/**
 * Mints and validates the service's HS256 JWTs.
 * Claim shape matches gpt's tokens (sub = user id, type = access|refresh)
 * so gpt's existing AuthMiddleware validates these tokens unchanged.
 */
class TokenService
{
    private string $secret;
    private int $accessTtl;
    private int $refreshTtl;

    public function __construct(string $secret, int $accessTtl = 28800, int $refreshTtl = 604800)
    {
        if ($secret === '') {
            // Fail closed: never sign/verify with a weak default secret.
            throw new \RuntimeException('JWT secret is not configured (set JWT_SECRET).');
        }
        $this->secret = $secret;
        $this->accessTtl = $accessTtl;
        $this->refreshTtl = $refreshTtl;
    }

    public function mintAccess(int $userId): string
    {
        return $this->mint($userId, 'access', $this->accessTtl);
    }

    /** @return array{access_token: string, refresh_token: string} */
    public function mintPair(int $userId): array
    {
        return [
            'access_token' => $this->mintAccess($userId),
            'refresh_token' => $this->mint($userId, 'refresh', $this->refreshTtl),
        ];
    }

    /** Decoded claims object, or null when invalid/expired. */
    public function decode(string $jwt): ?object
    {
        try {
            return JWT::decode($jwt, new Key($this->secret, 'HS256'));
        } catch (\Throwable $e) {
            return null;
        }
    }

    public function accessTtl(): int
    {
        return $this->accessTtl;
    }

    private function mint(int $userId, string $type, int $ttl): string
    {
        $now = time();
        return JWT::encode([
            'iss' => 'login-service',
            'iat' => $now,
            'exp' => $now + $ttl,
            'sub' => $userId,
            'type' => $type,
        ], $this->secret, 'HS256');
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vendor/bin/phpunit --filter TokenServiceTest`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: TokenService — HS256 access/refresh JWTs, gpt-compatible claims"
```

---

### Task 4: AppRepository — registered apps + redirect pinning (TDD)

**Files:**
- Create: `login/backend/src/Services/AppRepository.php`, `login/backend/src/Support/Database.php`
- Test: `login/backend/tests/Unit/Services/AppRepositoryTest.php`

**Interfaces:**
- Produces: `LoginService\Services\AppRepository::__construct(PDO $db, string $serverSecret)` (throws on empty secret); `create(string $appId, string $name, string $entryPoint): array` (returns row + `full_key`, shown once); `findByKey(string $fullKey): ?array` (row without hash, null on unknown/revoked/mismatch); `validateRedirect(array $app, string $redirect): ?string` (the redirect URL when allowed, else null); `recordUse(int $id): void`; `revoke(int $id): bool`; `findByAppId(string $appId): ?array`.
- Produces: `LoginService\Support\Database::connect(array $cfg): PDO` — used by the front controller, login page, and scripts.

- [ ] **Step 1: Write the failing test**

`login/backend/tests/Unit/Services/AppRepositoryTest.php`:

```php
<?php

declare(strict_types=1);

namespace LoginService\Tests\Unit\Services;

use LoginService\Services\AppRepository;
use PDO;
use PHPUnit\Framework\TestCase;

final class AppRepositoryTest extends TestCase
{
    private PDO $db;
    private AppRepository $repo;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        // Production SQL uses MySQL NOW(); register it for SQLite.
        $this->db->sqliteCreateFunction('NOW', fn() => date('Y-m-d H:i:s'));
        $this->db->exec("CREATE TABLE registered_apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            app_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            key_prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            entry_point TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_used_at TEXT,
            revoked_at TEXT
        )");
        $this->repo = new AppRepository($this->db, 'test-secret');
    }

    public function testEmptySecretThrows(): void
    {
        $this->expectException(\RuntimeException::class);
        new AppRepository($this->db, '');
    }

    public function testCreateReturnsLakKeyOnce(): void
    {
        $app = $this->repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');
        $this->assertStringStartsWith('lak_', $app['full_key']);
        $this->assertSame(36, strlen($app['full_key'])); // 'lak_' + 32 hex
        $this->assertSame(substr($app['full_key'], 0, 12), $app['key_prefix']);
        $this->assertSame('dialog', $app['app_id']);
    }

    public function testFindByKeyRoundTrip(): void
    {
        $created = $this->repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');
        $found = $this->repo->findByKey($created['full_key']);
        $this->assertNotNull($found);
        $this->assertSame('dialog', $found['app_id']);
        $this->assertSame('http://localhost/dialog/', $found['entry_point']);
        $this->assertArrayNotHasKey('key_hash', $found);
    }

    public function testFindByKeyRejectsWrongKeyWithSamePrefix(): void
    {
        $created = $this->repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');
        $tampered = substr($created['full_key'], 0, -1) . (substr($created['full_key'], -1) === 'a' ? 'b' : 'a');
        $this->assertNull($this->repo->findByKey($tampered));
    }

    public function testFindByKeyRejectsRevokedAndBadFormat(): void
    {
        $created = $this->repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');
        $this->assertTrue($this->repo->revoke($created['id']));
        $this->assertNull($this->repo->findByKey($created['full_key']));
        $this->assertFalse($this->repo->revoke($created['id'])); // idempotent
        $this->assertNull($this->repo->findByKey('ak_notourprefix00000000000000000000'));
        $this->assertNull($this->repo->findByKey(''));
    }

    public function testRecordUseStampsLastUsed(): void
    {
        $created = $this->repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');
        $this->repo->recordUse($created['id']);
        $found = $this->repo->findByKey($created['full_key']);
        $this->assertNotNull($found['last_used_at']);
    }

    public function testFindByAppId(): void
    {
        $this->repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');
        $this->assertSame('AI Dialog', $this->repo->findByAppId('dialog')['name']);
        $this->assertNull($this->repo->findByAppId('nope'));
    }

    /** @dataProvider redirectCases */
    public function testValidateRedirect(string $entry, string $redirect, bool $allowed): void
    {
        $app = ['entry_point' => $entry];
        $result = $this->repo->validateRedirect($app, $redirect);
        $this->assertSame($allowed, $result !== null);
        if ($allowed) {
            $this->assertSame($redirect, $result);
        }
    }

    public static function redirectCases(): array
    {
        return [
            'exact'             => ['http://localhost/dialog/', 'http://localhost/dialog/', true],
            'no trailing slash' => ['http://localhost/dialog/', 'http://localhost/dialog', true],
            'sub path'          => ['http://localhost/dialog/', 'http://localhost/dialog/app.html', true],
            'evil suffix dir'   => ['http://localhost/dialog/', 'http://localhost/dialog.evil/', false],
            'prefix trick'      => ['http://localhost/dialog/', 'http://localhost/dialogevil', false],
            'wrong host'        => ['http://localhost/dialog/', 'http://evil.com/dialog/', false],
            'wrong scheme'      => ['http://localhost/dialog/', 'https://localhost/dialog/', false],
            'wrong port'        => ['http://localhost:5173/', 'http://localhost/', false],
            'different app'     => ['http://localhost/dialog/', 'http://localhost/gpt/', false],
            'relative url'      => ['http://localhost/dialog/', '/dialog/', false],
            'js scheme'         => ['http://localhost/dialog/', 'javascript:alert(1)', false],
        ];
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter AppRepositoryTest`
Expected: FAIL — `Class "LoginService\Services\AppRepository" not found`

- [ ] **Step 3: Write `login/backend/src/Support/Database.php`**

```php
<?php

declare(strict_types=1);

namespace LoginService\Support;

use PDO;

/** Shared MySQL connection factory (front controller, login page, scripts). */
class Database
{
    public static function connect(array $cfg): PDO
    {
        $dsn = "mysql:host={$cfg['host']};dbname={$cfg['database']};charset={$cfg['charset']}";
        return new PDO($dsn, $cfg['username'], $cfg['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }
}
```

- [ ] **Step 4: Write `login/backend/src/Services/AppRepository.php`**

```php
<?php

declare(strict_types=1);

namespace LoginService\Services;

use PDO;

/**
 * registered_apps repository — the apps allowed to use this login service.
 *
 * Key storage model (same scheme as gpt's AppKeyRepository):
 *   key_prefix : first 12 chars ("lak_xxxxxxxx"), indexed, not secret
 *   key_hash   : hex HMAC-SHA256(app_key_secret, full_key)
 * The full key is returned exactly once, by create().
 */
class AppRepository
{
    private const KEY_BYTES  = 16;  // 32 hex chars
    private const PREFIX_LEN = 12;  // "lak_" + 8 hex chars

    private PDO $db;
    private string $serverSecret;

    public function __construct(PDO $db, string $serverSecret)
    {
        if ($serverSecret === '') {
            // Fail loud: an empty pepper would make every hash forgeable.
            throw new \RuntimeException('AppRepository: app_key_secret is not configured.');
        }
        $this->db = $db;
        $this->serverSecret = $serverSecret;
    }

    /** @return array Row data plus full_key — the only time the raw key is visible. */
    public function create(string $appId, string $name, string $entryPoint): array
    {
        $fullKey = 'lak_' . bin2hex(random_bytes(self::KEY_BYTES));
        $prefix  = substr($fullKey, 0, self::PREFIX_LEN);

        $stmt = $this->db->prepare(
            "INSERT INTO registered_apps (app_id, name, key_prefix, key_hash, entry_point)
             VALUES (?, ?, ?, ?, ?)"
        );
        $stmt->execute([$appId, $name, $prefix, $this->hash($fullKey), $entryPoint]);

        return [
            'id' => (int) $this->db->lastInsertId(),
            'app_id' => $appId,
            'name' => $name,
            'key_prefix' => $prefix,
            'entry_point' => $entryPoint,
            'full_key' => $fullKey,
        ];
    }

    /** Prefix lookup → constant-time hash compare → not-revoked check. */
    public function findByKey(string $fullKey): ?array
    {
        $fullKey = trim($fullKey);
        if (!str_starts_with($fullKey, 'lak_') || strlen($fullKey) < self::PREFIX_LEN) {
            return null;
        }
        $stmt = $this->db->prepare(
            "SELECT id, app_id, name, key_prefix, key_hash, entry_point, created_at, last_used_at
             FROM registered_apps
             WHERE key_prefix = ? AND revoked_at IS NULL
             LIMIT 1"
        );
        $stmt->execute([substr($fullKey, 0, self::PREFIX_LEN)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || !hash_equals((string) $row['key_hash'], $this->hash($fullKey))) {
            return null;
        }
        unset($row['key_hash']);
        $row['id'] = (int) $row['id'];
        return $row;
    }

    /**
     * Validate a requested redirect URL against the app's registered entry
     * point: scheme, host, and port must match exactly, and the redirect
     * path must be the entry path or live under it ("/dialog" and
     * "/dialog/x" match entry "/dialog/"; "/dialog.evil/" does not).
     * Returns the redirect URL when allowed, null otherwise.
     */
    public function validateRedirect(array $app, string $redirect): ?string
    {
        $e = parse_url((string) $app['entry_point']);
        $r = parse_url($redirect);
        if (!is_array($e) || !is_array($r)) {
            return null;
        }
        if (strcasecmp($r['scheme'] ?? '', $e['scheme'] ?? '') !== 0) return null;
        if (strcasecmp($r['host'] ?? '', $e['host'] ?? '') !== 0) return null;
        if (($r['port'] ?? null) !== ($e['port'] ?? null)) return null;

        $entryPath = $e['path'] ?? '/';
        if (!str_ends_with($entryPath, '/')) {
            $entryPath .= '/';
        }
        $redirectPath = $r['path'] ?? '/';
        if ($redirectPath !== rtrim($entryPath, '/') && !str_starts_with($redirectPath, $entryPath)) {
            return null;
        }
        return $redirect;
    }

    /** Fire-and-forget last_used_at stamp — must never block an auth request. */
    public function recordUse(int $id): void
    {
        try {
            $stmt = $this->db->prepare("UPDATE registered_apps SET last_used_at = NOW() WHERE id = ?");
            $stmt->execute([$id]);
        } catch (\Throwable $e) {
            error_log('[AppRepository] recordUse failed: ' . $e->getMessage());
        }
    }

    /** Soft delete. Returns true if a row was changed. */
    public function revoke(int $id): bool
    {
        $stmt = $this->db->prepare(
            "UPDATE registered_apps SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL"
        );
        $stmt->execute([$id]);
        return $stmt->rowCount() > 0;
    }

    public function findByAppId(string $appId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT id, app_id, name, key_prefix, entry_point, created_at, last_used_at, revoked_at
             FROM registered_apps WHERE app_id = ? LIMIT 1"
        );
        $stmt->execute([$appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $row['id'] = (int) $row['id'];
        return $row;
    }

    private function hash(string $fullKey): string
    {
        return hash_hmac('sha256', $fullKey, $this->serverSecret);
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `vendor/bin/phpunit --filter AppRepositoryTest`
Expected: PASS (7 tests + 11 data-provider cases)

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: AppRepository — lak_ app keys with entry-point redirect pinning"
```

### Task 5: AuthController + SsoResolver (TDD)

**Files:**
- Create: `login/backend/src/Services/SsoResolver.php`, `login/backend/src/Controllers/AuthController.php`
- Test: `login/backend/tests/Unit/Controllers/AuthControllerTest.php`

**Interfaces:**
- Consumes: `TokenService` (Task 3), `AppRepository` (Task 4).
- Produces: `LoginService\Services\SsoResolver::resolve(PDO $db, array $config, array $body): array` — `{ok: true, redirect_url: ?string}` or `{ok: false, response: array}`. Used again by WebAuthnController (Task 7).
- Produces: `LoginService\Controllers\AuthController::__construct(PDO $db, array $config)` with public methods `handleAction`, `login`, `register`, `firebaseAuth`, `refresh`, `verify`, `logout` — each takes the `$request` array (`['method','uri','headers','query','body','user_id'?]`) and returns a response array with `status_code`. Success payload shape: `{success, message, data: {user, access_token, refresh_token, expires_in, redirect_url?}}`.

Behavior notes (differences from gpt's AuthController, all intentional per spec):
- No `ledger_user_id` requirement, no plans, no phone-link/upgrade/app-key actions. New accounts get `role='user'`.
- Every login/register/firebase call resolves optional `app_key`+`redirect` via SsoResolver FIRST; invalid → 400 before touching credentials.
- New `refresh()`; expired/invalid refresh → 401 with `error: "refresh_expired"`.
- `verify()` also returns `email` and `role` (needs a DB lookup).
- Firebase ID-token verification (RS256 against Google secure-token certs, `aud`/`iss` bound to the project) is ported VERBATIM from gpt — identity must come from verified claims, never client `userData`.

- [ ] **Step 1: Write the failing test**

`login/backend/tests/Unit/Controllers/AuthControllerTest.php`:

```php
<?php

declare(strict_types=1);

namespace LoginService\Tests\Unit\Controllers;

use LoginService\Controllers\AuthController;
use LoginService\Services\AppRepository;
use PDO;
use PHPUnit\Framework\TestCase;

final class AuthControllerTest extends TestCase
{
    private PDO $db;
    private AuthController $auth;
    private array $config;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->sqliteCreateFunction('NOW', fn() => date('Y-m-d H:i:s'));
        $this->db->exec("CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            phone TEXT, password TEXT, first_name TEXT, last_name TEXT,
            firebase_uid TEXT, provider TEXT DEFAULT 'email', role TEXT DEFAULT 'user',
            profile_picture TEXT, email_verified INTEGER DEFAULT 0,
            last_login TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )");
        $this->db->exec("CREATE TABLE registered_apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            app_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL,
            entry_point TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, revoked_at TEXT
        )");
        $this->config = ['auth' => [
            'jwt_secret' => 'test-secret',
            'jwt_expiry' => 3600,
            'refresh_expiry' => 7200,
            'app_key_secret' => 'test-app-secret',
        ]];
        $this->auth = new AuthController($this->db, $this->config);
    }

    private function req(array $body, array $headers = []): array
    {
        return ['method' => 'POST', 'uri' => '/api/v1/auth', 'headers' => $headers, 'query' => [], 'body' => $body];
    }

    private function registerUser(string $email = 'a@b.co', string $pass = 'pw-123456'): array
    {
        return $this->auth->register($this->req([
            'email' => $email, 'password' => $pass, 'first_name' => 'A', 'last_name' => 'B',
        ]));
    }

    public function testRegisterThenLoginRoundTrip(): void
    {
        $reg = $this->registerUser();
        $this->assertTrue($reg['success']);
        $this->assertSame('user', $reg['data']['user']['role']);
        $this->assertNotEmpty($reg['data']['access_token']);

        $login = $this->auth->login($this->req(['email' => 'a@b.co', 'password' => 'pw-123456']));
        $this->assertTrue($login['success']);
        $this->assertSame($reg['data']['user']['id'], $login['data']['user']['id']);
        $this->assertSame(3600, $login['data']['expires_in']);
        $this->assertArrayNotHasKey('redirect_url', $login['data']);
    }

    public function testLoginWrongPasswordIs401(): void
    {
        $this->registerUser();
        $res = $this->auth->login($this->req(['email' => 'a@b.co', 'password' => 'nope']));
        $this->assertFalse($res['success']);
        $this->assertSame(401, $res['status_code']);
    }

    public function testRegisterDuplicateEmailIs409AndBadEmailIs400(): void
    {
        $this->registerUser();
        $dup = $this->registerUser();
        $this->assertSame(409, $dup['status_code']);
        $bad = $this->auth->register($this->req(['email' => 'not-an-email', 'password' => 'x']));
        $this->assertSame(400, $bad['status_code']);
    }

    public function testVerifyReturnsUserIdEmailRole(): void
    {
        $reg = $this->registerUser();
        $res = $this->auth->verify($this->req([], ['Authorization' => 'Bearer ' . $reg['data']['access_token']]));
        $this->assertTrue($res['success']);
        $this->assertSame($reg['data']['user']['id'], $res['data']['user_id']);
        $this->assertSame('a@b.co', $res['data']['email']);
        $this->assertSame('user', $res['data']['role']);

        $bad = $this->auth->verify($this->req([], ['Authorization' => 'Bearer garbage']));
        $this->assertSame(401, $bad['status_code']);
    }

    public function testRefreshMintsNewAccessToken(): void
    {
        $reg = $this->registerUser();
        $res = $this->auth->refresh($this->req(['refresh_token' => $reg['data']['refresh_token']]));
        $this->assertTrue($res['success']);
        $this->assertNotEmpty($res['data']['access_token']);
        $this->assertSame(3600, $res['data']['expires_in']);
    }

    public function testRefreshRejectsAccessTokenAndGarbage(): void
    {
        $reg = $this->registerUser();
        // An ACCESS token is not a refresh token.
        $res = $this->auth->refresh($this->req(['refresh_token' => $reg['data']['access_token']]));
        $this->assertSame(401, $res['status_code']);
        $this->assertSame('refresh_expired', $res['error']);

        $res = $this->auth->refresh($this->req(['refresh_token' => 'garbage']));
        $this->assertSame(401, $res['status_code']);
        $this->assertSame('refresh_expired', $res['error']);
    }

    public function testLoginWithValidAppKeyAndRedirectReturnsRedirectUrl(): void
    {
        $this->registerUser();
        $repo = new AppRepository($this->db, 'test-app-secret');
        $app = $repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');

        $res = $this->auth->login($this->req([
            'email' => 'a@b.co', 'password' => 'pw-123456',
            'app_key' => $app['full_key'], 'redirect' => 'http://localhost/dialog/app.html',
        ]));
        $this->assertTrue($res['success']);
        $this->assertSame('http://localhost/dialog/app.html', $res['data']['redirect_url']);
    }

    public function testLoginWithEvilRedirectOrUnknownKeyIs400(): void
    {
        $this->registerUser();
        $repo = new AppRepository($this->db, 'test-app-secret');
        $app = $repo->create('dialog', 'AI Dialog', 'http://localhost/dialog/');

        $evil = $this->auth->login($this->req([
            'email' => 'a@b.co', 'password' => 'pw-123456',
            'app_key' => $app['full_key'], 'redirect' => 'http://localhost/dialog.evil/',
        ]));
        $this->assertSame(400, $evil['status_code']);

        $unknown = $this->auth->login($this->req([
            'email' => 'a@b.co', 'password' => 'pw-123456',
            'app_key' => 'lak_00000000000000000000000000000000', 'redirect' => 'http://localhost/dialog/',
        ]));
        $this->assertSame(400, $unknown['status_code']);
    }

    public function testHandleActionDispatchesAndRejectsUnknown(): void
    {
        $this->registerUser();
        $ok = $this->auth->handleAction($this->req(['action' => 'login', 'email' => 'a@b.co', 'password' => 'pw-123456']));
        $this->assertTrue($ok['success']);
        $bad = $this->auth->handleAction($this->req(['action' => 'upgrade_plan']));
        $this->assertSame(400, $bad['status_code']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter AuthControllerTest`
Expected: FAIL — `Class "LoginService\Controllers\AuthController" not found`

- [ ] **Step 3: Write `login/backend/src/Services/SsoResolver.php`**

```php
<?php

declare(strict_types=1);

namespace LoginService\Services;

use PDO;

/**
 * Resolves the optional SSO fields (app_key + redirect) on an auth request.
 * Shared by AuthController and WebAuthnController so both re-validate
 * server-side even though the login page already validated on render.
 */
final class SsoResolver
{
    /** @return array{ok: bool, redirect_url?: ?string, response?: array} */
    public static function resolve(PDO $db, array $config, array $body): array
    {
        $appKey = trim((string) ($body['app_key'] ?? ''));
        $redirect = trim((string) ($body['redirect'] ?? ''));
        if ($appKey === '') {
            return ['ok' => true, 'redirect_url' => null];
        }
        $repo = new AppRepository($db, (string) ($config['auth']['app_key_secret'] ?? ''));
        $app = $repo->findByKey($appKey);
        if ($app === null) {
            return ['ok' => false, 'response' => [
                'success' => false, 'message' => 'Unknown or revoked app key', 'status_code' => 400,
            ]];
        }
        $repo->recordUse($app['id']);
        if ($redirect === '') {
            // Standalone mode: valid app key but no redirect — sign in and stay.
            return ['ok' => true, 'redirect_url' => null];
        }
        $validated = $repo->validateRedirect($app, $redirect);
        if ($validated === null) {
            return ['ok' => false, 'response' => [
                'success' => false, 'message' => 'Redirect URL is not allowed for this app', 'status_code' => 400,
            ]];
        }
        return ['ok' => true, 'redirect_url' => $validated];
    }
}
```

- [ ] **Step 4: Write `login/backend/src/Controllers/AuthController.php`**

Ported from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/src/Controllers/AuthController.php`, trimmed per the behavior notes above. Full file:

```php
<?php

declare(strict_types=1);

namespace LoginService\Controllers;

use LoginService\Services\SsoResolver;
use LoginService\Services\TokenService;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PDO;
use Exception;

/**
 * Authentication Controller — ported from gpt's AuthController, trimmed to
 * the login-service scope (no plans/ledger/per-user app keys).
 *
 * Handles email/password login, registration, Firebase social auth, JWT
 * verify + refresh, and SSO app_key/redirect resolution.
 */
class AuthController
{
    private PDO $db;
    private array $config;
    private TokenService $tokens;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->tokens = new TokenService(
            (string) ($config['auth']['jwt_secret'] ?? ''),
            (int) ($config['auth']['jwt_expiry'] ?? 28800),
            (int) ($config['auth']['refresh_expiry'] ?? 604800)
        );
    }

    /** Legacy action-based dispatcher — the ported login page posts here. */
    public function handleAction(array $request): array
    {
        $action = $request['body']['action'] ?? '';
        return match ($action) {
            'login' => $this->login($request),
            'register' => $this->register($request),
            'firebase' => $this->firebaseAuth($request),
            'verify' => $this->verify($request),
            'logout' => $this->logout($request),
            default => ['success' => false, 'message' => 'Invalid action', 'status_code' => 400],
        };
    }

    public function login(array $request): array
    {
        $sso = SsoResolver::resolve($this->db, $this->config, $request['body'] ?? []);
        if (!$sso['ok']) {
            return $sso['response'];
        }

        $email = $request['body']['email'] ?? '';
        $password = $request['body']['password'] ?? '';
        if (empty($email) || empty($password)) {
            return ['success' => false, 'message' => 'Email and password are required', 'status_code' => 400];
        }

        $stmt = $this->db->prepare("SELECT * FROM users WHERE email = ?");
        $stmt->execute([strtolower(trim($email))]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, (string) $user['password'])) {
            return ['success' => false, 'message' => 'Invalid email or password', 'status_code' => 401];
        }

        $pair = $this->tokens->mintPair((int) $user['id']);
        $stmt = $this->db->prepare("UPDATE users SET last_login = NOW() WHERE id = ?");
        $stmt->execute([$user['id']]);

        return $this->authSuccess('Login successful', $this->userPayload($user), $pair, $sso['redirect_url']);
    }

    public function register(array $request): array
    {
        $sso = SsoResolver::resolve($this->db, $this->config, $request['body'] ?? []);
        if (!$sso['ok']) {
            return $sso['response'];
        }

        $email = strtolower(trim($request['body']['email'] ?? ''));
        $password = $request['body']['password'] ?? '';
        $firstName = trim($request['body']['first_name'] ?? '');
        $lastName = trim($request['body']['last_name'] ?? '');

        if (empty($email) || empty($password)) {
            return ['success' => false, 'message' => 'Email and password are required', 'status_code' => 400];
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return ['success' => false, 'message' => 'Invalid email format', 'status_code' => 400];
        }

        $stmt = $this->db->prepare("SELECT id FROM users WHERE email = ?");
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            return ['success' => false, 'message' => 'Email already registered', 'status_code' => 409];
        }

        $hashedPassword = password_hash($password, PASSWORD_BCRYPT);
        $stmt = $this->db->prepare(
            "INSERT INTO users (email, password, first_name, last_name, role, provider, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'user', 'email', NOW(), NOW())"
        );
        $stmt->execute([$email, $hashedPassword, $firstName, $lastName]);
        $userId = (int) $this->db->lastInsertId();

        $pair = $this->tokens->mintPair($userId);
        $user = [
            'id' => $userId, 'email' => $email, 'first_name' => $firstName, 'last_name' => $lastName,
            'role' => 'user', 'provider' => 'email', 'created_at' => date('Y-m-d H:i:s'),
        ];
        return $this->authSuccess('Registration successful', $this->userPayload($user), $pair, $sso['redirect_url']);
    }

    /** Firebase social authentication (Google, Facebook, phone, email-via-Firebase). */
    public function firebaseAuth(array $request): array
    {
        $sso = SsoResolver::resolve($this->db, $this->config, $request['body'] ?? []);
        if (!$sso['ok']) {
            return $sso['response'];
        }

        $provider = $request['body']['provider'] ?? '';
        $idToken = $request['body']['idToken'] ?? '';
        $userData = $request['body']['userData'] ?? [];

        if (empty($idToken)) {
            return ['success' => false, 'message' => 'Invalid authentication data', 'status_code' => 400];
        }

        // SECURITY: verify the Firebase ID token server-side and derive identity
        // (email / phone / firebase_uid) from the VERIFIED claims. Never trust
        // client-supplied userData for identity.
        $claims = $this->verifyFirebaseIdToken($idToken);
        if ($claims === null) {
            return ['success' => false, 'message' => 'Invalid or expired authentication token', 'status_code' => 401];
        }

        $verifiedEmail = isset($claims['email']) ? strtolower(trim((string) $claims['email'])) : '';
        $verifiedPhone = isset($claims['phone_number']) ? trim((string) $claims['phone_number']) : '';
        $firebaseUid = (string) ($claims['sub'] ?? '');

        if ($verifiedEmail === '' && $verifiedPhone === '') {
            return ['success' => false, 'message' => 'Invalid authentication data', 'status_code' => 400];
        }

        $email = $verifiedEmail !== '' ? $verifiedEmail : strtolower($verifiedPhone) . '@phone.auth';
        $phoneNumber = $verifiedPhone !== '' ? $verifiedPhone : null;
        // Display-only profile fields are non-identity; client userData is fine here.
        $firstName = $userData['first_name'] ?? '';
        $lastName = $userData['last_name'] ?? '';

        $stmt = $this->db->prepare("SELECT * FROM users WHERE email = ? OR firebase_uid = ? OR phone = ?");
        $stmt->execute([$email, $firebaseUid, $phoneNumber]);
        $user = $stmt->fetch();

        if ($user) {
            $stmt = $this->db->prepare(
                "UPDATE users SET last_login = NOW(), firebase_uid = COALESCE(firebase_uid, ?),
                        provider = ?, phone = COALESCE(phone, ?) WHERE id = ?"
            );
            $stmt->execute([$firebaseUid, $provider, $phoneNumber, $user['id']]);
            $userId = (int) $user['id'];
        } else {
            $stmt = $this->db->prepare(
                "INSERT INTO users (email, first_name, last_name, firebase_uid, provider, phone, role, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'user', NOW(), NOW())"
            );
            $stmt->execute([$email, $firstName, $lastName, $firebaseUid, $provider, $phoneNumber]);
            $userId = (int) $this->db->lastInsertId();
            $stmt = $this->db->prepare("SELECT * FROM users WHERE id = ?");
            $stmt->execute([$userId]);
            $user = $stmt->fetch();
        }

        $pair = $this->tokens->mintPair($userId);
        return $this->authSuccess('Authentication successful', $this->userPayload($user), $pair, $sso['redirect_url']);
    }

    /** Exchange a valid refresh token for a fresh access token. */
    public function refresh(array $request): array
    {
        $refreshToken = (string) ($request['body']['refresh_token'] ?? '');
        $decoded = $refreshToken !== '' ? $this->tokens->decode($refreshToken) : null;
        if ($decoded === null || (($decoded->type ?? '') !== 'refresh') || !isset($decoded->sub)) {
            return [
                'success' => false, 'error' => 'refresh_expired',
                'message' => 'Refresh token is invalid or expired', 'status_code' => 401,
            ];
        }
        $stmt = $this->db->prepare("SELECT id FROM users WHERE id = ?");
        $stmt->execute([(int) $decoded->sub]);
        if (!$stmt->fetch()) {
            return [
                'success' => false, 'error' => 'refresh_expired',
                'message' => 'Refresh token is invalid or expired', 'status_code' => 401,
            ];
        }
        return [
            'success' => true,
            'data' => [
                'access_token' => $this->tokens->mintAccess((int) $decoded->sub),
                'expires_in' => $this->tokens->accessTtl(),
            ],
            'status_code' => 200,
        ];
    }

    /** Validate a Bearer token and return who it belongs to. */
    public function verify(array $request): array
    {
        $authHeader = $request['headers']['Authorization'] ?? $request['headers']['authorization'] ?? '';
        if (!preg_match('/Bearer\s+(.*)$/i', $authHeader, $matches)) {
            return ['success' => false, 'message' => 'Authorization token required', 'status_code' => 401];
        }
        $decoded = $this->tokens->decode(trim($matches[1]));
        if ($decoded === null || !isset($decoded->sub)) {
            return ['success' => false, 'message' => 'Invalid or expired token', 'status_code' => 401];
        }
        $stmt = $this->db->prepare("SELECT id, email, role FROM users WHERE id = ?");
        $stmt->execute([(int) $decoded->sub]);
        $user = $stmt->fetch();
        if (!$user) {
            return ['success' => false, 'message' => 'Invalid or expired token', 'status_code' => 401];
        }
        return [
            'success' => true,
            'message' => 'Token is valid',
            'data' => ['user_id' => (int) $user['id'], 'email' => $user['email'], 'role' => $user['role']],
            'status_code' => 200,
        ];
    }

    public function logout(array $request): array
    {
        // Stateless JWT: logout is handled client-side by removing the token.
        return ['success' => true, 'message' => 'Logout successful', 'status_code' => 200];
    }

    // ---------------------------------------------------------------
    // Firebase ID-token verification — ported verbatim from gpt.
    // ---------------------------------------------------------------

    /** Firebase project id this service accepts ID tokens for (token `aud`). */
    private function firebaseProjectId(): string
    {
        $fromConfig = (string) ($this->config['firebase']['project_id'] ?? '');
        if ($fromConfig !== '') {
            return $fromConfig;
        }
        $fromEnv = (string) ($_ENV['FIREBASE_PROJECT_ID'] ?? getenv('FIREBASE_PROJECT_ID') ?: '');
        return $fromEnv !== '' ? $fromEnv : 'transledgersite';
    }

    /**
     * Google's Secure Token x509 signing certs (kid => Key), cached to a temp
     * file for 1 hour (Firebase rotates these ~daily). Throws on fetch failure.
     */
    private function googleSecureTokenKeys(): array
    {
        $url = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
        $cacheFile = sys_get_temp_dir() . '/login_firebase_securetoken_certs.json';

        $certs = null;
        if (is_file($cacheFile) && (time() - filemtime($cacheFile) < 3600)) {
            $raw = @file_get_contents($cacheFile);
            $decoded = $raw ? json_decode($raw, true) : null;
            if (is_array($decoded) && $decoded) {
                $certs = $decoded;
            }
        }
        if ($certs === null) {
            $raw = @file_get_contents($url);
            $decoded = $raw ? json_decode($raw, true) : null;
            if (!is_array($decoded) || !$decoded) {
                throw new Exception('Unable to fetch Google secure token certificates');
            }
            $certs = $decoded;
            @file_put_contents($cacheFile, json_encode($certs));
        }

        $keys = [];
        foreach ($certs as $kid => $pem) {
            $keys[$kid] = new Key($pem, 'RS256');
        }
        return $keys;
    }

    /**
     * Verify a Firebase ID token: RS256 signature against Google's secure-token
     * keys, plus aud/iss bound to OUR project. Returns the verified claims, or
     * null on any failure.
     */
    private function verifyFirebaseIdToken(string $idToken): ?array
    {
        try {
            $keys = $this->googleSecureTokenKeys();
            $decoded = JWT::decode($idToken, $keys); // verifies RS256 + exp/iat/nbf, selects key by header kid
            $claims = (array) $decoded;

            $projectId = $this->firebaseProjectId();
            if (($claims['aud'] ?? '') !== $projectId) {
                return null;
            }
            if (($claims['iss'] ?? '') !== 'https://securetoken.google.com/' . $projectId) {
                return null;
            }
            if ((string) ($claims['sub'] ?? '') === '') {
                return null;
            }
            return $claims;
        } catch (\Throwable $e) {
            error_log('[AuthController] Firebase ID token verification failed: ' . $e->getMessage());
            return null;
        }
    }

    // ---------------------------------------------------------------
    // Response helpers
    // ---------------------------------------------------------------

    /** @param array $user users row (or equivalent field set) */
    private function userPayload(array $user): array
    {
        return [
            'id' => (int) $user['id'],
            'email' => $user['email'],
            'first_name' => $user['first_name'] ?? '',
            'last_name' => $user['last_name'] ?? '',
            'role' => $user['role'] ?? 'user',
            'provider' => $user['provider'] ?? 'email',
            'last_login' => date('Y-m-d H:i:s'),
            'created_at' => $user['created_at'] ?? null,
        ];
    }

    private function authSuccess(string $message, array $user, array $pair, ?string $redirectUrl): array
    {
        $data = [
            'user' => $user,
            'access_token' => $pair['access_token'],
            'refresh_token' => $pair['refresh_token'],
            'expires_in' => $this->tokens->accessTtl(),
        ];
        if ($redirectUrl !== null) {
            $data['redirect_url'] = $redirectUrl;
        }
        return ['success' => true, 'message' => $message, 'data' => $data, 'status_code' => 200];
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `vendor/bin/phpunit --filter AuthControllerTest`
Expected: PASS (9 tests). Also run the full suite: `vendor/bin/phpunit` → all green.

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: AuthController — login/register/firebase/verify/refresh + SSO resolution"
```

### Task 6: AuthMiddleware, front controller, routes, Apache rewrite

**Files:**
- Create: `login/backend/src/Middleware/AuthMiddleware.php`, `login/backend/src/routes.php`, `login/backend/index.php`, `login/backend/.htaccess`
- Test: `login/backend/tests/Unit/Middleware/AuthMiddlewareTest.php`, plus live curl round-trip

**Interfaces:**
- Consumes: `TokenService` (Task 3), `Database::connect` (Task 4).
- Produces: HTTP surface at `http://localhost/login/backend/api/v1/...`. Route table (public unless noted): `POST /auth` (handleAction), `POST /auth/login|register|firebase|refresh|logout`, `GET /verify`, `POST /webauthn/challenge|register|authenticate` (`register` is protected — needs Bearer), `DELETE /webauthn/credential` (protected), `GET /apps/whoami`. Controllers are constructed as `new LoginService\Controllers\<Name>($pdo, $config)` and called as `$controller->$method($request)`.

- [ ] **Step 1: Write the failing middleware test**

`login/backend/tests/Unit/Middleware/AuthMiddlewareTest.php`:

```php
<?php

declare(strict_types=1);

namespace LoginService\Tests\Unit\Middleware;

use LoginService\Middleware\AuthMiddleware;
use LoginService\Services\TokenService;
use PHPUnit\Framework\TestCase;

final class AuthMiddlewareTest extends TestCase
{
    private TokenService $tokens;
    private AuthMiddleware $mw;

    protected function setUp(): void
    {
        $this->tokens = new TokenService('test-secret', 3600, 7200);
        $this->mw = new AuthMiddleware($this->tokens, [
            ['pattern' => '/api/v1/auth(/.*)?', 'methods' => ['POST']],
        ]);
    }

    private function req(string $uri, string $method = 'POST', array $headers = []): array
    {
        return ['method' => $method, 'uri' => $uri, 'headers' => $headers, 'query' => [], 'body' => []];
    }

    public function testPublicRouteWithoutTokenPassesWithNullUser(): void
    {
        $out = $this->mw->handle($this->req('/api/v1/auth/login'));
        $this->assertNull($out['user_id']);
        $this->assertFalse($out['authenticated']);
    }

    public function testPublicRouteWithValidTokenGetsIdentity(): void
    {
        $jwt = $this->tokens->mintAccess(7);
        $out = $this->mw->handle($this->req('/api/v1/auth', 'POST', ['Authorization' => "Bearer $jwt"]));
        $this->assertSame(7, $out['user_id']);
        $this->assertTrue($out['authenticated']);
    }

    public function testProtectedRouteWithoutTokenIs401(): void
    {
        $out = $this->mw->handle($this->req('/api/v1/webauthn/register'));
        $this->assertTrue($out['error']);
        $this->assertSame(401, $out['status_code']);
    }

    public function testProtectedRouteWithValidTokenPasses(): void
    {
        $jwt = $this->tokens->mintAccess(9);
        $out = $this->mw->handle($this->req('/api/v1/webauthn/register', 'POST', ['Authorization' => "Bearer $jwt"]));
        $this->assertSame(9, $out['user_id']);
    }

    public function testProtectedRouteWithBadTokenIs401(): void
    {
        $out = $this->mw->handle($this->req('/api/v1/webauthn/register', 'POST', ['Authorization' => 'Bearer nope']));
        $this->assertSame(401, $out['status_code']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter AuthMiddlewareTest`
Expected: FAIL — `Class "LoginService\Middleware\AuthMiddleware" not found`

- [ ] **Step 3: Write `login/backend/src/Middleware/AuthMiddleware.php`**

```php
<?php

declare(strict_types=1);

namespace LoginService\Middleware;

use LoginService\Services\TokenService;

/**
 * Validates `Authorization: Bearer <jwt>` and injects user_id into the
 * request. Public routes pass through (with identity attached when a valid
 * token happens to be present). JWT-only — this service has no uak_/ak_
 * credential schemes.
 */
class AuthMiddleware
{
    private TokenService $tokens;
    private array $publicRoutes;

    public function __construct(TokenService $tokens, array $publicRoutes = [])
    {
        $this->tokens = $tokens;
        $this->publicRoutes = $publicRoutes;
    }

    /** @return array Request with identity injected, or ['error'=>true, ...]. */
    public function handle(array $request): array
    {
        $userId = null;
        $authHeader = $request['headers']['Authorization'] ?? $request['headers']['authorization'] ?? '';
        if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
            $decoded = $this->tokens->decode(trim($m[1]));
            if ($decoded !== null && isset($decoded->sub)) {
                $userId = (int) $decoded->sub;
            }
        }

        if ($this->isPublicRoute($request['uri'], $request['method'])) {
            $request['user_id'] = $userId;
            $request['authenticated'] = $userId !== null;
            return $request;
        }

        if ($userId === null) {
            return [
                'error' => true,
                'status_code' => 401,
                'body' => ['success' => false, 'message' => 'Authorization token required'],
            ];
        }
        $request['user_id'] = $userId;
        $request['authenticated'] = true;
        return $request;
    }

    private function isPublicRoute(string $uri, string $method): bool
    {
        foreach ($this->publicRoutes as $route) {
            $pattern = str_replace('*', '.*', $route['pattern']);
            $methods = (array) ($route['methods'] ?? ['GET', 'POST', 'PUT', 'DELETE']);
            if (preg_match("#^{$pattern}$#", $uri) && in_array($method, $methods, true)) {
                return true;
            }
        }
        return false;
    }
}
```

- [ ] **Step 4: Run middleware test to verify it passes**

Run: `vendor/bin/phpunit --filter AuthMiddlewareTest`
Expected: PASS (5 tests)

- [ ] **Step 5: Write `login/backend/src/routes.php`**

```php
<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

/** Route table for the login service API. Format: [Controller, method]. */
function createRouteDispatcher(): \FastRoute\Dispatcher
{
    return \FastRoute\simpleDispatcher(function (RouteCollector $r) {
        // Legacy action dispatcher — the ported login page posts here.
        $r->post('/api/v1/auth', ['AuthController', 'handleAction']);
        // RESTful routes
        $r->post('/api/v1/auth/login', ['AuthController', 'login']);
        $r->post('/api/v1/auth/register', ['AuthController', 'register']);
        $r->post('/api/v1/auth/firebase', ['AuthController', 'firebaseAuth']);
        $r->post('/api/v1/auth/refresh', ['AuthController', 'refresh']);
        $r->post('/api/v1/auth/logout', ['AuthController', 'logout']);
        $r->get('/api/v1/verify', ['AuthController', 'verify']);

        // WebAuthn (passkeys). challenge/authenticate are public (needed to
        // log in); register/delete require a Bearer token (middleware).
        $r->post('/api/v1/webauthn/challenge', ['WebAuthnController', 'challenge']);
        $r->post('/api/v1/webauthn/register', ['WebAuthnController', 'register']);
        $r->post('/api/v1/webauthn/authenticate', ['WebAuthnController', 'authenticate']);
        $r->delete('/api/v1/webauthn/credential', ['WebAuthnController', 'delete']);

        // Registered-app introspection (validates the app key it is given).
        $r->get('/api/v1/apps/whoami', ['AppController', 'whoami']);
    });
}
```

- [ ] **Step 6: Write `login/backend/index.php`** (front controller)

```php
<?php

declare(strict_types=1);

/**
 * Login Service backend entry point. All /login/backend/* requests are
 * rewritten here (.htaccess) and dispatched via FastRoute.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');

require_once __DIR__ . '/vendor/autoload.php';

$config = require __DIR__ . '/config/config.php';
require_once __DIR__ . '/src/routes.php';

use FastRoute\Dispatcher;
use LoginService\Middleware\AuthMiddleware;
use LoginService\Services\TokenService;
use LoginService\Support\Database;

// ---- build request from globals ----
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$basePath = '/login/backend';
if (str_starts_with($uri, $basePath)) {
    $uri = substr($uri, strlen($basePath));
}
if ($uri === '' || $uri[0] !== '/') {
    $uri = '/' . $uri;
}
$headers = function_exists('getallheaders') ? (getallheaders() ?: []) : [];
$rawBody = file_get_contents('php://input');
$request = [
    'method' => $_SERVER['REQUEST_METHOD'],
    'uri' => $uri,
    'headers' => $headers,
    'query' => $_GET,
    'body' => json_decode($rawBody, true) ?? [],
];

// ---- CORS (LAN-internal service: permissive by design) ----
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
if ($request['method'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function sendJson(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
    exit;
}

// ---- auth middleware ----
$tokens = new TokenService(
    (string) ($config['auth']['jwt_secret'] ?? ''),
    (int) ($config['auth']['jwt_expiry'] ?? 28800),
    (int) ($config['auth']['refresh_expiry'] ?? 604800)
);
$publicRoutes = [
    ['pattern' => '/api/v1/auth(/.*)?', 'methods' => ['POST']],
    ['pattern' => '/api/v1/verify', 'methods' => ['GET']],
    ['pattern' => '/api/v1/webauthn/challenge', 'methods' => ['POST']],
    ['pattern' => '/api/v1/webauthn/authenticate', 'methods' => ['POST']],
    ['pattern' => '/api/v1/apps/whoami', 'methods' => ['GET']],
];
$auth = new AuthMiddleware($tokens, $publicRoutes);
$request = $auth->handle($request);
if (($request['error'] ?? false) === true) {
    sendJson($request['status_code'], $request['body']);
}

// ---- database ----
try {
    $pdo = Database::connect($config['database']);
} catch (\PDOException $e) {
    error_log('[login-backend] DB connection failed: ' . $e->getMessage());
    sendJson(500, ['success' => false, 'error' => 'Database connection failed']);
}

// ---- dispatch ----
$dispatcher = createRouteDispatcher();
$routeInfo = $dispatcher->dispatch($request['method'], $request['uri']);

switch ($routeInfo[0]) {
    case Dispatcher::NOT_FOUND:
        sendJson(404, ['success' => false, 'error' => 'Endpoint not found', 'uri' => $request['uri']]);
        break;
    case Dispatcher::METHOD_NOT_ALLOWED:
        sendJson(405, ['success' => false, 'error' => 'Method not allowed']);
        break;
    case Dispatcher::FOUND:
        [$controllerName, $methodName] = $routeInfo[1];
        $controllerClass = 'LoginService\\Controllers\\' . $controllerName;
        try {
            $controller = new $controllerClass($pdo, $config);
            $result = $controller->$methodName($request);
            $status = $result['status_code'] ?? 200;
            unset($result['status_code']);
            sendJson($status, $result);
        } catch (\Throwable $e) {
            error_log('[login-backend] Controller error: ' . $e->getMessage());
            sendJson(500, ['success' => false, 'error' => 'Internal server error']);
        }
        break;
}
```

- [ ] **Step 7: Write `login/backend/.htaccess`** (ported from gpt's, minus upload sizing)

```
RewriteEngine On

# Pass Authorization header to PHP (required for JWT auth via curl/CLI)
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [e=HTTP_AUTHORIZATION:%1]

# If the file or directory exists, serve it directly
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d

# Route everything through index.php
RewriteRule ^(.*)$ index.php [QSA,L]

# Security headers
<IfModule mod_headers.c>
    Header set X-Content-Type-Options "nosniff"
</IfModule>

# Disable directory browsing
Options -Indexes

# Never serve the env file even if rewrites are bypassed
<Files ".env">
    Require all denied
</Files>
```

- [ ] **Step 8: Live curl round-trip against Apache + MySQL**

XAMPP Apache must be running (check: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost/` → 200). Then:

```bash
BASE=http://localhost/login/backend/api/v1
# register (email must be unused; delete the row afterwards if rerunning)
curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"task6@test.local","password":"pw-123456","first_name":"T","last_name":"Six"}'
# expect {"success":true,...} with access_token + refresh_token

curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"task6@test.local","password":"pw-123456"}'
# expect success; capture ACCESS and REFRESH from the JSON

curl -s $BASE/verify -H "Authorization: Bearer $ACCESS"
# expect {"success":true,...,"data":{"user_id":...,"email":"task6@test.local","role":"user"}}

curl -s -X POST $BASE/auth/refresh -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$REFRESH\"}"
# expect a fresh access_token

curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/webauthn/credential
# expect 401 (protected route without token)
```

- [ ] **Step 9: Cross-service check — gpt accepts our token**

The whole design hinges on this: a token minted by the login service must pass gpt's middleware.

```bash
curl -s -X POST http://localhost/gpt/backend/api/v1/auth/verify -H "Authorization: Bearer $ACCESS"
```
Expected: `{"success":true,...}` (gpt decodes it with the shared `JWT_SECRET`; it ignores `iss`). If this returns 401, the `JWT_SECRET` values differ — fix `login/backend/.env` before continuing.

- [ ] **Step 10: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: HTTP surface — front controller, routes, JWT middleware, Apache rewrite"
```

---

### Task 7: WebAuthnController port

**Files:**
- Create: `login/backend/src/Controllers/WebAuthnController.php` (copy of `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/src/Controllers/WebAuthnController.php` + edits below)

**Interfaces:**
- Consumes: `TokenService`, `SsoResolver`.
- Produces: `challenge`, `register`, `authenticate`, `delete` methods with gpt's request/response shapes, except `authenticate` now also returns `refresh_token` and (when SSO fields were sent) `redirect_url`, and the `user` object has no `plan`.

Known limitation carried over intentionally (documented in gpt's source): WebAuthn signature verification is NOT cryptographically checked — the credential lookup + browser attestation is trusted. Do not "fix" this here; it is a straight port.

- [ ] **Step 1: Copy the file**

```bash
cp /Applications/XAMPP/xamppfiles/htdocs/gpt/backend/src/Controllers/WebAuthnController.php \
   /Applications/XAMPP/xamppfiles/htdocs/login/backend/src/Controllers/WebAuthnController.php
```

- [ ] **Step 2: Apply the edits**

Edit 1 — header/namespace/constructor. Replace the block from `namespace Quantis\AIPortfolioAssistant\Controllers;` down to the end of the constructor with:

```php
namespace LoginService\Controllers;

use LoginService\Services\SsoResolver;
use LoginService\Services\TokenService;
use PDO;
use Exception;

/**
 * WebAuthn (passkey/biometric) controller — ported from gpt.
 * NOTE: signature verification is trusted to the browser (same as gpt);
 * full attestation verification is a known TODO inherited from the source.
 */
class WebAuthnController
{
    private PDO $db;
    private array $config;
    private TokenService $tokens;

    // Challenge expiry in seconds
    private const CHALLENGE_EXPIRY = 120;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->tokens = new TokenService(
            (string) ($config['auth']['jwt_secret'] ?? ''),
            (int) ($config['auth']['jwt_expiry'] ?? 28800),
            (int) ($config['auth']['refresh_expiry'] ?? 604800)
        );
    }
```
(The original `use Firebase\JWT\JWT; use Firebase\JWT\Key;` imports are dropped.)

Edit 2 — in `challenge()`, the default rp_name: change `'Voice Assistant'` to `'Login Service'` (config `webauthn.rp_name` already supplies it).

Edit 3 — in `authenticate()`, insert SSO resolution as the FIRST statement of the method body:

```php
        $sso = SsoResolver::resolve($this->db, $this->config, $request['body'] ?? []);
        if (!$sso['ok']) {
            return $sso['response'];
        }
```

Edit 4 — in `authenticate()`, the credential lookup JOIN: replace the line

```php
            SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.role, u.plan, u.ledger_user_id, u.provider, u.last_login, u.created_at
```
with
```php
            SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.role, u.provider, u.last_login, u.created_at
```

Edit 5 — in `authenticate()`, replace `$tokens = $this->generateTokens($userId);` with `$pair = $this->tokens->mintPair($userId);` and replace the whole success `return [...]` with:

```php
        $response = [
            'success' => true,
            'message' => 'Authentication successful',
            'token' => $pair['access_token'],
            'refresh_token' => $pair['refresh_token'],
            'user' => [
                'id' => (string) $userId,
                'email' => $credential['email'],
                'first_name' => $credential['first_name'],
                'last_name' => $credential['last_name'],
                'role' => $credential['role'] ?? 'user',
                'provider' => $credential['provider'] ?? 'webauthn',
                'last_login' => date('Y-m-d H:i:s'),
                'created_at' => $credential['created_at'] ?? null,
            ],
            'status_code' => 200
        ];
        if ($sso['redirect_url'] !== null) {
            $response['redirect_url'] = $sso['redirect_url'];
        }
        return $response;
```

Edit 6 — delete the entire `private function generateTokens(int $userId): array { ... }` method (TokenService replaces it). Keep `base64UrlEncode`, `base64UrlDecode`, `cleanupChallenges` as-is.

- [ ] **Step 3: Lint and run the full suite**

```bash
php -l src/Controllers/WebAuthnController.php
vendor/bin/phpunit
```
Expected: `No syntax errors detected`; all existing tests still pass.

- [ ] **Step 4: Live curl check of the public challenge endpoint**

```bash
curl -s -X POST http://localhost/login/backend/api/v1/webauthn/challenge \
  -H 'Content-Type: application/json' -d '{"action":"authenticate"}'
```
Expected: `{"success":true,"challenge":"...","rp_id":"localhost","rp_name":"Login Service","allow_credentials":[],...}` (discoverable-credential flow, no user bound). The full passkey flow is browser-only and is verified in Task 12's manual checklist.

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: WebAuthnController port (TokenService, SSO redirect, no plan fields)"
```

### Task 8: AppController + mint-app-key script

**Files:**
- Create: `login/backend/src/Controllers/AppController.php`, `login/backend/scripts/mint-app-key.php`

**Interfaces:**
- Consumes: `AppRepository`, `Database::connect`.
- Produces: `GET /api/v1/apps/whoami?app_key=lak_…` → `{success, data: {id, app_id, name, key_prefix, entry_point, created_at, last_used_at}}`; CLI `php scripts/mint-app-key.php <app_id> "<name>" <entry_point>` printing the full key once. Used by Task 12's smoke script and by every future app integration.

- [ ] **Step 1: Write `login/backend/src/Controllers/AppController.php`**

```php
<?php

declare(strict_types=1);

namespace LoginService\Controllers;

use LoginService\Services\AppRepository;
use PDO;

/** Registered-app introspection. */
class AppController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /** GET /api/v1/apps/whoami?app_key=lak_… — lets an app sanity-check its key. */
    public function whoami(array $request): array
    {
        $appKey = trim((string) ($request['query']['app_key'] ?? ''));
        if ($appKey === '') {
            return ['success' => false, 'message' => 'app_key query parameter is required', 'status_code' => 400];
        }
        $repo = new AppRepository($this->db, (string) ($this->config['auth']['app_key_secret'] ?? ''));
        $app = $repo->findByKey($appKey);
        if ($app === null) {
            return ['success' => false, 'message' => 'Unknown or revoked app key', 'status_code' => 401];
        }
        return ['success' => true, 'data' => $app, 'status_code' => 200];
    }
}
```

- [ ] **Step 2: Write `login/backend/scripts/mint-app-key.php`**

```php
<?php

declare(strict_types=1);

/**
 * Register an app with the login service and print its key (shown once).
 *
 * Usage:
 *   php scripts/mint-app-key.php <app_id> "<name>" <entry_point>
 *   php scripts/mint-app-key.php dialog "AI Dialog" http://localhost/dialog/
 */

require_once __DIR__ . '/../vendor/autoload.php';

use LoginService\Services\AppRepository;
use LoginService\Support\Database;

if ($argc < 4) {
    fwrite(STDERR, "Usage: php scripts/mint-app-key.php <app_id> \"<name>\" <entry_point>\n");
    exit(1);
}
[, $appId, $name, $entryPoint] = $argv;

$parts = parse_url($entryPoint);
if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
    fwrite(STDERR, "entry_point must be an absolute URL (e.g. http://localhost/dialog/)\n");
    exit(1);
}

$config = require __DIR__ . '/../config/config.php';
$db = Database::connect($config['database']);
$repo = new AppRepository($db, (string) $config['auth']['app_key_secret']);

if ($repo->findByAppId($appId) !== null) {
    fwrite(STDERR, "App '$appId' already exists. Pick another app_id or clean up registered_apps first.\n");
    exit(1);
}

$app = $repo->create($appId, $name, $entryPoint);

echo "App registered.\n";
echo "  app_id:      {$app['app_id']}\n";
echo "  name:        {$app['name']}\n";
echo "  entry_point: {$app['entry_point']}\n";
echo "  app_key:     {$app['full_key']}\n";
echo "Save the app_key now — it is not recoverable.\n";
```

- [ ] **Step 3: Verify — mint a key and introspect it**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login/backend
php scripts/mint-app-key.php task8-check "Task 8 Check" http://localhost/task8/
# capture the printed app_key, then:
curl -s "http://localhost/login/backend/api/v1/apps/whoami?app_key=<printed key>"
```
Expected: mint prints all fields incl. `lak_…`; whoami returns `{"success":true,"data":{"app_id":"task8-check",...}}`. Re-running the mint with the same app_id exits 1 with the "already exists" message. Clean up:

```bash
# Read DB_USER/DB_PASS from backend/.env first
/Applications/XAMPP/xamppfiles/bin/mysql -u "$DB_USER" -p"$DB_PASS" \
  -e "DELETE FROM netfo587_login.registered_apps WHERE app_id='task8-check';"
```

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: app whoami endpoint + mint-app-key CLI"
```

---

### Task 9: User import from gpt's DB

**Files:**
- Create: `login/backend/scripts/import-users.php`

**Interfaces:**
- Consumes: `Database::connect`, config keys `import_database` (source: netfo587_chatbot) and `database` (dest: netfo587_login).
- Produces: dest `users` + `webauthn_credentials` populated with source rows, ids preserved. Idempotent (`INSERT IGNORE`).

- [ ] **Step 1: Write `login/backend/scripts/import-users.php`**

```php
<?php

declare(strict_types=1);

/**
 * One-time import of users + webauthn credentials from gpt's contexts DB
 * (netfo587_chatbot) into the login service DB. Preserves ids and bcrypt
 * hashes. Idempotent: rows whose primary/unique keys already exist are
 * skipped (INSERT IGNORE), so it is safe to re-run.
 *
 * Usage: php scripts/import-users.php
 */

require_once __DIR__ . '/../vendor/autoload.php';

use LoginService\Support\Database;

$config = require __DIR__ . '/../config/config.php';
if (($config['import_database']['database'] ?? '') === '') {
    fwrite(STDERR, "IMPORT_DB_* is not configured in backend/.env\n");
    exit(1);
}
$src = Database::connect($config['import_database']);
$dst = Database::connect($config['database']);

$cols = ['id', 'email', 'phone', 'password', 'first_name', 'last_name', 'firebase_uid',
         'provider', 'role', 'profile_picture', 'email_verified', 'last_login',
         'created_at', 'updated_at'];
$colList = implode(', ', $cols);
$placeholders = implode(', ', array_fill(0, count($cols), '?'));

$users = $src->query("SELECT $colList FROM users")->fetchAll();
$ins = $dst->prepare("INSERT IGNORE INTO users ($colList) VALUES ($placeholders)");
$inserted = 0;
foreach ($users as $u) {
    $ins->execute(array_map(fn($c) => $u[$c], $cols));
    $inserted += $ins->rowCount();
}
echo "users: " . count($users) . " in source, $inserted inserted\n";

$creds = $src->query(
    "SELECT id, user_id, credential_id, public_key, created_at FROM webauthn_credentials"
)->fetchAll();
$ins = $dst->prepare(
    "INSERT IGNORE INTO webauthn_credentials (id, user_id, credential_id, public_key, created_at)
     VALUES (?, ?, ?, ?, ?)"
);
$inserted = 0;
foreach ($creds as $c) {
    $ins->execute([$c['id'], $c['user_id'], $c['credential_id'], $c['public_key'], $c['created_at']]);
    $inserted += $ins->rowCount();
}
echo "webauthn_credentials: " . count($creds) . " in source, $inserted inserted\n";
echo "Done.\n";
```

- [ ] **Step 2: Run the import**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login/backend
php scripts/import-users.php
```
Expected: `users: N in source, M inserted` (M = N minus any rows already present, e.g. the Task 6 curl test user if its email collides — it won't, so normally M = N on first run), then the webauthn line, then `Done.`

- [ ] **Step 3: Verify counts and spot-check a login**

```bash
# Read DB_USER/DB_PASS from backend/.env first
MYSQL=/Applications/XAMPP/xamppfiles/bin/mysql
$MYSQL -u "$DB_USER" -p"$DB_PASS" -e \
  "SELECT (SELECT COUNT(*) FROM netfo587_chatbot.users) AS src, (SELECT COUNT(*) FROM netfo587_login.users) AS dst;"
```
Expected: dst ≥ src (dst includes the Task 6 test user). Re-run `php scripts/import-users.php` → `0 inserted` both lines (idempotency proof). Then confirm an imported REAL account logs in on the new service (bcrypt hash survived) — use your own email + password:

```bash
curl -s -X POST http://localhost/login/backend/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"<your email>","password":"<your password>"}'
```
Expected: `{"success":true,...}`. (Skip if your account is social-only — password is NULL; that path is covered by the Task 12 browser checklist.)

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: idempotent user + passkey import from netfo587_chatbot"
```

### Task 10: Frontend — login page, auth.js port, register page

**Files:**
- Create: `login/frontend/index.php` (from gpt's `frontend/login.html` + edits), `login/frontend/register.html` (new), `login/frontend/assets/js/api-config.js` (new), `login/frontend/assets/js/config.js` (new), `login/frontend/assets/js/account-store.js` (verbatim copy), `login/frontend/assets/js/auth.js` (copy + edits)

**Interfaces:**
- Consumes: the whole Task 6 HTTP surface; `AppRepository`/`Database` (server-side render validation in index.php).
- Produces: `http://localhost/login/?app_key=lak_…&redirect=<url>` — validated SSO login page; on success browser lands on `<redirect>#token=<access>&refresh=<refresh>`. Standalone `http://localhost/login/` shows a signed-in banner instead.

Source files in gpt (read-only, never edit them): `frontend/login.html`, `frontend/assets/js/auth.js`, `frontend/assets/js/account-store.js`.

- [ ] **Step 1: Copy the verbatim + new asset files**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs
cp gpt/frontend/assets/js/account-store.js login/frontend/assets/js/account-store.js
cp gpt/frontend/assets/js/auth.js         login/frontend/assets/js/auth.js
```

Write `login/frontend/assets/js/api-config.js`:

```js
/** Backend base-URL single source of truth for the login service frontend. */
(function () {
  var base = '/login/backend/api/v1';
  window.APP_CONFIG = window.APP_CONFIG || {};
  window.APP_CONFIG.API_BASE_URL = base;
  window.apiUrl = function (path) {
    return base + (String(path).startsWith('/') ? path : '/' + path);
  };
})();
```

Write `login/frontend/assets/js/config.js` (Firebase client config only — public values, same project as gpt):

```js
/** Firebase client config for the login service (public values). */
const CONFIG = {
  firebase: {
    apiKey: "AIzaSyCYmWOIuWmuZ0SK_q1SrJRhYIPfx0CyQOk",
    authDomain: "transledgersite.firebaseapp.com",
    databaseURL: "https://transledgersite.firebaseio.com",
    projectId: "transledgersite",
    storageBucket: "transledgersite.firebasestorage.app",
    messagingSenderId: "809533058456",
    appId: "1:809533058456:web:7cc07b837befbf28a04fed",
    measurementId: "G-FH0NFVW4KQ"
  }
};
window.APP_CONFIG = Object.assign(window.APP_CONFIG || {}, CONFIG);
let firebaseApp, firebaseAuth;
try {
  firebaseApp = firebase.initializeApp(CONFIG.firebase);
  firebaseAuth = firebase.auth();
} catch (error) {
  console.error('Firebase initialization failed:', error);
}
window.firebaseApp = firebaseApp;
window.firebaseAuth = firebaseAuth;
```

- [ ] **Step 2: Build `login/frontend/index.php` from gpt's `login.html`**

Copy the full contents of `gpt/frontend/login.html` into `login/frontend/index.php`, then apply these edits in order:

Edit 1 — prepend this PHP block ABOVE `<!DOCTYPE html>`:

```php
<?php
declare(strict_types=1);

// SSO entry: /login/?app_key=lak_…&redirect=<url>
// Validates the app key + redirect BEFORE rendering the form; the backend
// re-validates on every auth POST (defense in depth). No app_key →
// standalone mode (plain sign-in, banner on success).
require_once __DIR__ . '/../backend/vendor/autoload.php';

use LoginService\Services\AppRepository;
use LoginService\Support\Database;

$config = require __DIR__ . '/../backend/config/config.php';

$ssoAppKey = trim((string) ($_GET['app_key'] ?? ''));
$ssoRedirect = trim((string) ($_GET['redirect'] ?? ''));
$ssoAppName = '';
$ssoError = null;

if ($ssoAppKey !== '') {
    try {
        $repo = new AppRepository(Database::connect($config['database']), (string) $config['auth']['app_key_secret']);
        $app = $repo->findByKey($ssoAppKey);
        if ($app === null) {
            $ssoError = 'Unknown or revoked app key.';
        } else {
            $ssoAppName = $app['name'];
            if ($ssoRedirect !== '' && $repo->validateRedirect($app, $ssoRedirect) === null) {
                $ssoError = 'The redirect URL is not allowed for this app.';
            }
        }
    } catch (Throwable $e) {
        error_log('[login-page] ' . $e->getMessage());
        $ssoError = 'Login service configuration error.';
    }
}

$h = fn(string $s): string => htmlspecialchars($s, ENT_QUOTES);

if ($ssoError !== null) {
    http_response_code(400);
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Login Error</title></head>
    <body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1e3a8a; color: white;">
        <div style="text-align: center; max-width: 28rem; padding: 1rem;">
            <h1>Cannot sign you in</h1>
            <p><?= $h($ssoError) ?></p>
            <p style="opacity: .8;">Contact the administrator of the app that sent you here.</p>
        </div>
    </body>
    </html>
    <?php
    exit;
}
?>
```

Edit 2 — replace the `<body ...>` open tag

```html
<body class="min-h-screen bg-gradient-to-br from-blue-600 to-indigo-700">
```
with
```html
<body class="min-h-screen bg-gradient-to-br from-blue-600 to-indigo-700"
      data-app-key="<?= $h($ssoAppKey) ?>"
      data-redirect="<?= $h($ssoRedirect) ?>"
      data-app-name="<?= $h($ssoAppName) ?>">
```

Edit 3 — delete the two favicon `<link ...>` lines (no favicon asset in this project) and change `<title>Sign In - AI Assistant</title>` to `<title>Sign In</title>`.

Edit 4 — rebrand the left panel: change `<h1 class="text-4xl font-bold mb-2">AI Assistant</h1>` / `<h2 class="text-4xl font-bold text-blue-100 mb-6">Multi-Provider</h2>` to `Sign-In` / `One account, every app`, and replace the `<p class="text-lg ...">Chat with multiple AI providers...</p>` paragraph text with `One login for all local apps. Sign in once and you'll be sent straight back to the app you came from.` Also change the mobile header `<h5 ...>AI Assistant</h5>` to `<h5 class="text-lg font-semibold">Sign-In</h5>`.

Edit 5 — under `<h2 class="text-xl font-semibold text-gray-700">Sign In</h2>` add:

```html
<?php if ($ssoAppName !== ''): ?>
<p class="text-sm text-gray-500 mt-1">to continue to <strong><?= $h($ssoAppName) ?></strong></p>
<?php endif; ?>
```

Edit 6 — directly after the closing `</div>` of the `id="error-message"` block, add the standalone-mode banner:

```html
<div id="signed-in-banner" class="hidden bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-md mb-6">
    Signed in successfully. You can close this page.
</div>
```

Edit 7 — the Sign Up link: replace `<a href="register.html" ...>` with

```html
<a href="register.html<?= $ssoAppKey !== '' ? '?' . $h(http_build_query(['app_key' => $ssoAppKey, 'redirect' => $ssoRedirect])) : '' ?>" class="text-blue-600 hover:text-blue-500 font-semibold">
```

Edit 8 — the script tags at the bottom: remove the `?v=…` cache busters (fresh project) so they read:

```html
<script src="assets/js/api-config.js"></script>
<script src="assets/js/config.js"></script>
<script src="assets/js/account-store.js"></script>
<script src="assets/js/auth.js"></script>
```

- [ ] **Step 3: Trim and adapt `login/frontend/assets/js/auth.js`**

The copy from Step 1 is gpt's 1150-line `AuthManager`. Apply these edits (line numbers refer to the gpt original):

Edit 1 — header comment: replace the file's opening doc block with:

```js
/**
 * Login-service authentication page logic. Ported from gpt's auth.js;
 * app-side session management (checkAuth, timers, authFetch) removed —
 * this file only serves the login/register pages. On success,
 * completeLogin() either redirects back to the calling app with the JWT
 * in the URL fragment (SSO mode) or shows a signed-in banner.
 */
```

Edit 2 — constructor (original lines 13–35): replace the whole constructor with:

```js
    constructor() {
        this.apiBaseUrl = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || '/login/backend/api/v1';
        window.accountStore.migrateLegacyUser();
        this.token = window.accountStore.getToken();
        this.user = window.accountStore.getActiveUser();
        // SSO context injected by index.php after server-side validation.
        var ds = (document.body && document.body.dataset) || {};
        this.sso = { appKey: ds.appKey || '', redirect: ds.redirect || '' };
        this.init();
    }
```

Edit 3 — `init()` (original lines 37–53): replace with:

```js
    init() {
        this.setupLoginPage();
    }
```

Edit 4 — delete these methods entirely: `applyEmbedMode`, `setupEmbedAuth`, `waitForEmbedToken`, `checkAuth`, `startTokenValidationTimer`, `stopTokenValidationTimer`, `logout`, `getToken`, `getUser`, `isAuthenticated`, `getAuthHeaders`, `authFetch`. Keep: `setupLoginPage`, `handleEmailLogin`, `handleForgotPassword`, `handleGoogleLogin`, `handleFacebookLogin`, `handleSocialLogin`, all phone methods, all WebAuthn methods, `base64UrlEncode/Decode`, `saveAuthData`, `isTokenExpired`, `clearAuthData`, `verifyToken`, `showError`.

Edit 5 — add `completeLogin` right after `saveAuthData`:

```js
    /**
     * Final step of every successful auth: persist the session, then either
     * hand the tokens back to the calling app (URL fragment — never hits
     * server logs) or show the standalone signed-in banner.
     */
    completeLogin(authData) {
        this.saveAuthData(authData);
        const redirectUrl = authData.redirect_url || this.sso.redirect;
        if (redirectUrl && this.sso.appKey) {
            const fragment = '#token=' + encodeURIComponent(authData.access_token)
                + '&refresh=' + encodeURIComponent(authData.refresh_token || '');
            window.location.replace(redirectUrl + fragment);
            return;
        }
        const form = document.getElementById('login-form');
        if (form) form.classList.add('hidden');
        const banner = document.getElementById('signed-in-banner');
        if (banner) banner.classList.remove('hidden');
    }
```

Edit 6 — `setupLoginPage()` already-logged-in branch (original lines 146–165): replace the `try { await this.verifyToken(); window.location.href = 'index.html'; } catch ...` block with:

```js
            try {
                await this.verifyToken();
                // Already signed in — complete the SSO handoff without re-prompting.
                this.completeLogin({
                    user: this.user,
                    access_token: this.token,
                    refresh_token: window.accountStore.getRefreshToken(),
                });
            } catch (error) {
                console.log('Token verification failed, clearing auth data');
                this.clearAuthData();
            }
```

Edit 7 — `handleEmailLogin` (original lines 221–245): add the SSO fields to BOTH fetch bodies. The firebase-path body becomes:

```js
                    body: JSON.stringify({
                        action: 'firebase',
                        provider: 'email',
                        idToken,
                        userData,
                        app_key: this.sso.appKey || undefined,
                        redirect: this.sso.redirect || undefined,
                    })
```
and the legacy-path body becomes:
```js
                    body: JSON.stringify({ action: 'login', email, password,
                        app_key: this.sso.appKey || undefined,
                        redirect: this.sso.redirect || undefined })
```
Then replace the success branch
```js
            if (data.success) {
                this.saveAuthData(data.data);
                sessionStorage.setItem('showSplash', 'true');
                window.location.href = 'index.html';
            } else {
```
with
```js
            if (data.success) {
                this.completeLogin(data.data);
            } else {
```

Edit 8 — `handleSocialLogin` (original lines 363–396): add the same two SSO fields to its JSON body:

```js
                body: JSON.stringify({
                    action: 'firebase',
                    provider,
                    idToken,
                    userData,
                    app_key: this.sso.appKey || undefined,
                    redirect: this.sso.redirect || undefined,
                })
```
and replace its success branch
```js
            if (data.success) {
                // Store token and user data
                this.saveAuthData(data.data);

                // Show splash screen on redirect
                sessionStorage.setItem('showSplash', 'true');

                // Redirect to main app
                window.location.href = 'index.html';
            } else {
```
with
```js
            if (data.success) {
                this.completeLogin(data.data);
            } else {
```
(The phone-code flow finishes through `handleSocialLogin`, so it needs no separate edit — verify with `grep -n "handleSocialLogin" auth.js` that `verifyPhoneLoginCode` calls it.)

Edit 9 — `handleWebAuthnLogin` (original lines 812–839): add the SSO fields to the `/webauthn/authenticate` body:

```js
                body: JSON.stringify({
                    credential_id: storedCredentialId,
                    client_data_json: this.base64UrlEncode(new Uint8Array(credential.response.clientDataJSON)),
                    authenticator_data: this.base64UrlEncode(new Uint8Array(credential.response.authenticatorData)),
                    signature: this.base64UrlEncode(new Uint8Array(credential.response.signature)),
                    app_key: this.sso.appKey || undefined,
                    redirect: this.sso.redirect || undefined,
                })
```
and replace its success branch
```js
            if (authData.success) {
                // Store token and user data (format from WebAuthn controller)
                this.saveAuthData({
                    access_token: authData.token,
                    user: authData.user
                });

                // Show splash screen on redirect
                sessionStorage.setItem('showSplash', 'true');

                // Redirect to main app
                window.location.href = 'index.html';
            } else {
```
with
```js
            if (authData.success) {
                this.completeLogin({
                    access_token: authData.token,
                    refresh_token: authData.refresh_token,
                    user: authData.user,
                    redirect_url: authData.redirect_url,
                });
            } else {
```

- [ ] **Step 4: Write `login/frontend/register.html`** (new, self-contained)

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Account</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center p-4">
    <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-8">
        <h2 class="text-xl font-semibold text-gray-700 text-center mb-6">Create Account</h2>

        <div id="error-message" class="hidden bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-md mb-6"></div>
        <div id="signed-in-banner" class="hidden bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-md mb-6">
            Account created and signed in. You can close this page.
        </div>

        <form id="register-form" class="space-y-4">
            <div class="grid grid-cols-2 gap-4">
                <div>
                    <label for="first_name" class="block text-sm font-medium text-gray-700 mb-1">First name</label>
                    <input id="first_name" type="text"
                           class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
                <div>
                    <label for="last_name" class="block text-sm font-medium text-gray-700 mb-1">Last name</label>
                    <input id="last_name" type="text"
                           class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
            </div>
            <div>
                <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email address</label>
                <input id="email" type="email" required
                       class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
            </div>
            <div>
                <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input id="password" type="password" required minlength="8"
                       class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
            </div>
            <button type="submit"
                    class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 cursor-pointer">
                Create Account
            </button>
        </form>

        <div class="text-center mt-4">
            <a id="signin-link" href="./" class="text-blue-600 hover:text-blue-500 font-semibold">Back to Sign In</a>
        </div>
    </div>

    <script src="assets/js/api-config.js"></script>
    <script src="assets/js/account-store.js"></script>
    <script>
    (function () {
        var qs = new URLSearchParams(location.search);
        var sso = { appKey: qs.get('app_key') || '', redirect: qs.get('redirect') || '' };
        if (sso.appKey) {
            document.getElementById('signin-link').href = './?' + qs.toString();
        }
        document.getElementById('register-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var errBox = document.getElementById('error-message');
            errBox.classList.add('hidden');
            var body = {
                email: document.getElementById('email').value,
                password: document.getElementById('password').value,
                first_name: document.getElementById('first_name').value,
                last_name: document.getElementById('last_name').value,
            };
            if (sso.appKey) { body.app_key = sso.appKey; body.redirect = sso.redirect; }
            try {
                var res = await fetch(window.apiUrl('/auth/register'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                var data = await res.json();
                if (!data.success) throw new Error(data.message || 'Registration failed');
                var d = data.data;
                window.accountStore.setActiveAccount(d.user, d.access_token, d.refresh_token);
                var redirectUrl = d.redirect_url || sso.redirect;
                if (redirectUrl && sso.appKey) {
                    location.replace(redirectUrl + '#token=' + encodeURIComponent(d.access_token)
                        + '&refresh=' + encodeURIComponent(d.refresh_token || ''));
                } else {
                    document.getElementById('register-form').classList.add('hidden');
                    document.getElementById('signed-in-banner').classList.remove('hidden');
                }
            } catch (err) {
                errBox.textContent = err.message;
                errBox.classList.remove('hidden');
            }
        });
    })();
    </script>
</body>
</html>
```

- [ ] **Step 5: Verify the pages render**

```bash
php -l /Applications/XAMPP/xamppfiles/htdocs/login/frontend/index.php
node --check /Applications/XAMPP/xamppfiles/htdocs/login/frontend/assets/js/auth.js
curl -s http://localhost/login/ | grep -o '<title>[^<]*</title>'          # → <title>Sign In</title>
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost/login/?app_key=lak_bogus000000000000000000000000000'   # → 400
# Mint a real key (Task 8 script) for entry point http://localhost/login/ and check the happy path:
curl -s "http://localhost/login/?app_key=<real key>" | grep -c 'to continue to'   # → 1
```

- [ ] **Step 6: Manual browser sanity check (quick)**

Open `http://localhost/login/` in a browser: form renders, email login with an imported account shows the green signed-in banner (standalone mode). Full flow matrix is Task 12.

- [ ] **Step 7: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: login/register frontend with server-validated SSO redirect"
```

### Task 11: login-client.js + README

**Files:**
- Create: `login/frontend/assets/js/login-client.js`, `login/README.md`

**Interfaces:**
- Produces: `window.loginClient` with `requireAuth({loginUrl, appKey, redirect?}): boolean` (captures `#token=…` fragment into localStorage, else redirects to the login service and returns false), `getToken()`, `getRefreshToken()`, `logout()`. Apps copy this file; it has zero dependencies.

- [ ] **Step 1: Write `login/frontend/assets/js/login-client.js`**

```js
/**
 * login-client.js — drop-in SSO client for apps using the login service.
 * Copy this file into your app (or reference it) and call requireAuth()
 * at the top of your entry page, before any authenticated API call.
 *
 *   <script src="login-client.js"></script>
 *   <script>
 *     loginClient.requireAuth({
 *       loginUrl: 'http://localhost/login/',
 *       appKey: 'lak_...',   // minted with backend/scripts/mint-app-key.php
 *     });
 *   </script>
 *
 * Then send loginClient.getToken() as "Authorization: Bearer <token>".
 * Tokens live in the app's own localStorage ('token' / 'refresh_token' —
 * same keys gpt uses, so same-origin apps share the session).
 */
(function (root) {
  'use strict';

  var TOKEN = 'token';
  var REFRESH = 'refresh_token';

  // Pull #token=…&refresh=… out of the URL fragment (the login service's
  // handoff) and strip it from the address bar.
  function captureFragment() {
    if (!location.hash || location.hash.indexOf('token=') === -1) return false;
    var params = new URLSearchParams(location.hash.slice(1));
    var token = params.get('token');
    if (!token) return false;
    localStorage.setItem(TOKEN, token);
    if (params.get('refresh')) localStorage.setItem(REFRESH, params.get('refresh'));
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  // Client-side expiry check (30s clock skew). Server still has final say.
  function isExpired(token) {
    try {
      var payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return !payload.exp || payload.exp * 1000 < Date.now() + 30000;
    } catch (e) {
      return true;
    }
  }

  function requireAuth(opts) {
    captureFragment();
    var token = localStorage.getItem(TOKEN);
    if (token && !isExpired(token)) return true;
    localStorage.removeItem(TOKEN);
    var target = opts.loginUrl
      + '?app_key=' + encodeURIComponent(opts.appKey)
      + '&redirect=' + encodeURIComponent(opts.redirect || (location.origin + location.pathname));
    location.replace(target);
    return false;
  }

  root.loginClient = {
    requireAuth: requireAuth,
    getToken: function () { return localStorage.getItem(TOKEN); },
    getRefreshToken: function () { return localStorage.getItem(REFRESH); },
    logout: function () { localStorage.removeItem(TOKEN); localStorage.removeItem(REFRESH); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: Write `login/README.md`**

```markdown
# Login Service

Standalone SSO-style login microservice for the local htdocs apps. One
login page, one user database (`netfo587_login`), JWT handoff back to the
calling app. Ported from gpt's auth stack; tokens are signed with the same
`JWT_SECRET`, so gpt's backend accepts them unchanged.

## How an app integrates

1. **Register the app** (once):
   ```bash
   cd backend && php scripts/mint-app-key.php myapp "My App" http://localhost/myapp/
   ```
   Save the printed `lak_…` key — it is shown exactly once. The entry point
   pins where the service may redirect to (same scheme/host/port, path
   under the entry path).

2. **Drop in the client** — copy `frontend/assets/js/login-client.js` into
   the app and call, at the top of the entry page:
   ```html
   <script src="login-client.js"></script>
   <script>
     loginClient.requireAuth({ loginUrl: 'http://localhost/login/', appKey: 'lak_…' });
   </script>
   ```
   Unauthenticated visitors bounce to the login page and come back to
   `…#token=<jwt>&refresh=<jwt>`; the client stores both in localStorage
   and strips the fragment.

3. **Authenticate API calls** with `Authorization: Bearer <token>`.
   Backends validate either locally (HS256 with the shared `JWT_SECRET`,
   claims: `sub` = user id, `type` = `access`) or by calling
   `GET /login/backend/api/v1/verify`.

4. **Refresh**: `POST /login/backend/api/v1/auth/refresh`
   `{"refresh_token": "…"}` → new access token. A 401 with
   `error: "refresh_expired"` means restart the redirect flow.

## API

Base: `/login/backend/api/v1`

| Endpoint | Purpose |
|---|---|
| `POST /auth/login` | email/password (bcrypt fallback path) |
| `POST /auth/register` | email/password signup |
| `POST /auth/firebase` | Firebase ID token → service JWTs (social + primary email path) |
| `POST /auth/refresh` | refresh JWT → new access JWT |
| `POST /auth/logout` | stateless no-op (client clears storage) |
| `GET /verify` | Bearer token → `{user_id, email, role}` |
| `POST /webauthn/challenge` / `register` / `authenticate` | passkeys |
| `GET /apps/whoami?app_key=…` | introspect a registered app key |

`login`, `register`, `firebase`, and `webauthn/authenticate` accept
optional `app_key` + `redirect`; when present the response includes the
validated `redirect_url` and the login page performs the fragment handoff.

## Operations

- Schema: `backend/schema/login.sql` (DB `netfo587_login`)
- Config: `backend/.env` (see `.env.example`; `JWT_SECRET` must equal gpt's)
- Import users from gpt: `php backend/scripts/import-users.php` (idempotent)
- Tests: `cd backend && vendor/bin/phpunit`
- Smoke: `backend/scripts/smoke.sh`
```

- [ ] **Step 3: Verify + commit**

```bash
node --check /Applications/XAMPP/xamppfiles/htdocs/login/frontend/assets/js/login-client.js
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "feat: login-client.js drop-in + README integration guide"
```

---

### Task 12: End-to-end smoke script + manual browser checklist

**Files:**
- Create: `login/backend/scripts/smoke.sh`

**Interfaces:**
- Consumes: everything. This is the release gate.

- [ ] **Step 1: Write `login/backend/scripts/smoke.sh`**

```bash
#!/bin/bash
# End-to-end smoke test for the login service.
# Requires: XAMPP Apache + MySQL running, schema applied, composer installed.
set -euo pipefail

BASE="http://localhost/login/backend/api/v1"
STAMP=$(date +%s)
EMAIL="smoke-$STAMP@test.local"
PASS="smoke-pass-123"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Extract a value from JSON on stdin, e.g. json "['data']['access_token']"
json() { php -r '$d=json_decode(stream_get_contents(STDIN),true); echo $d'"$1"' ?? "";'; }

echo "1. register"
REG=$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"first_name\":\"Smoke\",\"last_name\":\"Test\"}")
echo "$REG" | grep -q '"success":true' || { echo "FAIL register: $REG"; exit 1; }

echo "2. login"
LOGIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$LOGIN" | json "['data']['access_token']")
REFRESH=$(echo "$LOGIN" | json "['data']['refresh_token']")
[ -n "$TOKEN" ] || { echo "FAIL login: $LOGIN"; exit 1; }

echo "3. verify"
VERIFY=$(curl -s "$BASE/verify" -H "Authorization: Bearer $TOKEN")
echo "$VERIFY" | grep -q "$EMAIL" || { echo "FAIL verify: $VERIFY"; exit 1; }

echo "4. refresh"
NEW=$(curl -s -X POST "$BASE/auth/refresh" -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}")
echo "$NEW" | grep -q '"access_token"' || { echo "FAIL refresh: $NEW"; exit 1; }
BAD=$(curl -s -X POST "$BASE/auth/refresh" -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$TOKEN\"}")
echo "$BAD" | grep -q 'refresh_expired' || { echo "FAIL refresh should reject access token: $BAD"; exit 1; }

echo "5. gpt cross-validation (shared JWT_SECRET)"
GPT=$(curl -s -X POST "http://localhost/gpt/backend/api/v1/auth/verify" -H "Authorization: Bearer $TOKEN")
echo "$GPT" | grep -q '"success":true' || { echo "FAIL gpt rejected our token: $GPT"; exit 1; }

echo "6. app key: mint, whoami, SSO login, evil redirect"
MINT=$(php "$SCRIPT_DIR/mint-app-key.php" "smoke-$STAMP" "Smoke App" "http://localhost/smoke/")
KEY=$(echo "$MINT" | sed -n 's/.*app_key: *//p')
[ -n "$KEY" ] || { echo "FAIL mint: $MINT"; exit 1; }

WHO=$(curl -s "$BASE/apps/whoami?app_key=$KEY")
echo "$WHO" | grep -q '"success":true' || { echo "FAIL whoami: $WHO"; exit 1; }

SSO=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"app_key\":\"$KEY\",\"redirect\":\"http://localhost/smoke/app.html\"}")
echo "$SSO" | json "['data']['redirect_url']" | grep -q 'http://localhost/smoke/app.html' \
  || { echo "FAIL sso login: $SSO"; exit 1; }

EVIL=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"app_key\":\"$KEY\",\"redirect\":\"http://localhost/smoke.evil/\"}")
echo "$EVIL" | grep -q 'not allowed' || { echo "FAIL evil redirect accepted: $EVIL"; exit 1; }

echo "7. login page render (SSO + standalone + bad key)"
curl -s "http://localhost/login/?app_key=$KEY" | grep -q 'to continue to' || { echo "FAIL SSO page render"; exit 1; }
curl -s "http://localhost/login/" | grep -q 'login-form' || { echo "FAIL standalone page render"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost/login/?app_key=lak_bogus000000000000000000000000000")
[ "$CODE" = "400" ] || { echo "FAIL bad key should render 400, got $CODE"; exit 1; }

echo "ALL SMOKE TESTS PASSED"
```

- [ ] **Step 2: Run it**

```bash
chmod +x /Applications/XAMPP/xamppfiles/htdocs/login/backend/scripts/smoke.sh
/Applications/XAMPP/xamppfiles/htdocs/login/backend/scripts/smoke.sh
```
Expected: `ALL SMOKE TESTS PASSED`. Also run the unit suite one last time: `cd backend && vendor/bin/phpunit` → all green.

- [ ] **Step 3: Clean up smoke artifacts (optional but polite)**

```bash
# Read DB_USER/DB_PASS from backend/.env first
/Applications/XAMPP/xamppfiles/bin/mysql -u "$DB_USER" -p"$DB_PASS" netfo587_login \
  -e "DELETE FROM users WHERE email LIKE 'smoke-%@test.local' OR email='task6@test.local';
      DELETE FROM registered_apps WHERE app_id LIKE 'smoke-%';"
```

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/login
git add -A && git commit -m "test: end-to-end smoke script"
```

- [ ] **Step 5: Manual browser checklist (user-assisted — browser-only paths)**

Report these to the user as the remaining live verification; they need real Firebase/passkey interaction:

1. `http://localhost/login/` → email login with an imported account → green banner (standalone mode).
2. Mint a test key for an existing app, e.g. `php scripts/mint-app-key.php dialog-sso "AI Dialog" http://localhost/dialog/`, then open `http://localhost/login/?app_key=<key>&redirect=http://localhost/dialog/` → "to continue to AI Dialog" → login → lands on `http://localhost/dialog/#token=…`.
3. Google login (Firebase popup) both standalone and SSO.
4. "Forgot password?" sends the Firebase reset email.
5. Passkey login (if a credential was imported) — button appears and authenticates.
6. `register.html?app_key=…&redirect=…` → new account → redirected with fragment.

---

## Deviations & Notes for the Executor

- **Never edit gpt files.** Everything under `/Applications/XAMPP/xamppfiles/htdocs/gpt` is read-only source material for this plan.
- If Apache serves 404 for `/login/backend/api/v1/...`, confirm `AllowOverride All` applies to htdocs (it does for gpt, same tree) and that `login/backend/.htaccess` exists.
- If `composer install` warns about the platform, `composer.json` intentionally has no exotic deps; PHP 8.4 CLI is at `php` (8.4.8).
- Secrets (`JWT_SECRET`, DB creds) are copied from `gpt/backend/.env` at execution time — they are never written into this plan, the repo, or commits (`.env` is gitignored).






