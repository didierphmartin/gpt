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
