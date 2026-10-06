<?php
declare(strict_types=1);
// Loads backend/.env once into $_ENV and validates required keys.
// Required at the top of every ai_config.php so all consumers get secrets from one file.
if (defined('GPT_ENV_LOADED')) { return; }

$backendRoot = dirname(__DIR__); // .../backend/config -> .../backend
require_once $backendRoot . '/vendor/autoload.php';

// Under PHPUnit no test may reach a real database: backend/.env points at the
// production one. Every DB setting is pinned to a host that cannot resolve
// BEFORE .env is read (the immutable loader then keeps these), so any MySQL
// connect fails at once with this host name in the error. The phpunit binary
// defines PHPUNIT_COMPOSER_INSTALL however it is invoked (with or without a
// --bootstrap), which is why the guard lives here and not in a bootstrap file.
if (defined('PHPUNIT_COMPOSER_INSTALL') || defined('__PHPUNIT_PHAR__')) {
    foreach (['DB', 'CTX_DB', 'LOGIN_DB', 'VE_DB'] as $prefix) {
        foreach (['HOST' => 'unit-tests-must-not-use-a-real-db.invalid', 'NAME' => 'no_real_db_in_tests',
                  'USER' => 'no_real_db_in_tests', 'PASS' => 'no_real_db_in_tests'] as $suffix => $value) {
            $_ENV["{$prefix}_{$suffix}"] = $_SERVER["{$prefix}_{$suffix}"] = $value;
            putenv("{$prefix}_{$suffix}={$value}");
        }
    }
}

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
