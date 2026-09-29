<?php
// Creates the login service's tables on first boot of a corporate install.
// Idempotent: does nothing once the users table exists. Non-fatal on error,
// like bootstrap-admin.php, so a slow database never crash-loops the container.
$host = getenv('MYSQL_HOST') ?: 'db';
$name = getenv('LOGIN_DB_NAME') ?: 'gpt_login';
$user = getenv('MYSQL_USER') ?: 'gpt';
$pass = getenv('MYSQL_PASSWORD') ?: '';
$schema = '/var/www/html/login/backend/schema/login.sql';

try {
    $pdo = new PDO("mysql:host={$host};dbname={$name};charset=utf8mb4", $user, $pass,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 10]);
    if ($pdo->query("SHOW TABLES LIKE 'users'")->fetchColumn() !== false) {
        echo "[gpt] login schema present -- leaving it alone\n";
        exit(0);
    }
    $sql = file_get_contents($schema);
    // The schema must land in THIS database: drop any CREATE DATABASE / USE lines.
    $sql = preg_replace('/^\s*(CREATE\s+DATABASE|USE)\b[^;]*;\s*$/mi', '', (string) $sql);
    $pdo->exec($sql);
    echo "[gpt] login schema created in {$name}\n";
} catch (Throwable $e) {
    fwrite(STDERR, '[gpt] login schema skipped: ' . $e->getMessage() . "\n");
}
