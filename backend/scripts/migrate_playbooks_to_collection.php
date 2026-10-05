<?php
// php backend/scripts/migrate_playbooks_to_collection.php [--write]
// Moves playbook text from playbook agents and playbook nodes into the playbook collection.
// Without --write it is a dry run: it prints the report and changes nothing.
declare(strict_types=1);
require __DIR__ . '/../vendor/autoload.php';
Dotenv\Dotenv::createImmutable(dirname(__DIR__))->safeLoad();
$c = require __DIR__ . '/../config/ai_config.php';
$d = $c['contexts_database'];
$pdo = new PDO("mysql:host={$d['host']};dbname={$d['database']};charset=utf8mb4", $d['username'], $d['password'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$write = in_array('--write', $argv, true);
$report = (new Quantis\AIPortfolioAssistant\Playbook\PlaybookMigration($pdo))->run($write);
echo ($write ? "WRITTEN\n" : "DRY RUN (nothing written; add --write)\n"), json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
