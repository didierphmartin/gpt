<?php
declare(strict_types=1);

/**
 * Brings an existing database up to backend/schema/chatbot.sql.
 *
 * MySQL runs chatbot.sql only on an EMPTY volume, so a volume created by an
 * older image keeps its old schema forever. The app then fails on the first
 * column it doesn't have (e.g. "Unknown column 'mlflow_tracing'").
 *
 * chatbot.sql is the source of truth: it is updated with every schema change.
 * This compares it with the live database and adds what is missing:
 * tables, columns, keys, AUTO_INCREMENT and foreign keys.
 * It never drops or changes anything that exists, and it moves no data.
 *
 * Runs on every container start. It does nothing once the schema matches.
 * Every change is logged. A failed change is logged and skipped.
 * It never blocks Apache from starting.
 *
 * Usage: php schema-sync.php [path/to/chatbot.sql]
 * Reads MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER and MYSQL_PASSWORD.
 */

function out(string $msg): void { echo "[gpt] schema: $msg\n"; }

$schemaFile = $argv[1] ?? dirname(__DIR__) . '/backend/schema/chatbot.sql';
$dbName = getenv('MYSQL_DATABASE') ?: 'gpt_chatbot';

try {
    $pdo = new PDO(
        'mysql:host=' . (getenv('MYSQL_HOST') ?: 'db') . ";dbname=$dbName;charset=utf8mb4",
        getenv('MYSQL_USER') ?: 'gpt',
        getenv('MYSQL_PASSWORD') ?: '',
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 10]
    );
} catch (Throwable $e) {
    fwrite(STDERR, '[gpt] schema: database unreachable, not checked: ' . $e->getMessage() . "\n");
    exit(0);
}

// --- parse the dump (phpMyAdmin format: CREATE TABLE has only the columns;
// keys, AUTO_INCREMENT and constraints come later as ALTER TABLE statements).
$sql = preg_replace('~^\s*(--.*|/\*!.*\*/;)\s*$~m', '', (string) file_get_contents($schemaFile));
$creates = [];   // table => CREATE statement
$columns = [];   // table => [column => definition]
$alters  = [];   // [table, clause] in file order
foreach (preg_split('~;\s*\n~', $sql) as $stmt) {
    $stmt = trim($stmt);
    if (preg_match('~^CREATE TABLE `([^`]+)`~', $stmt, $m)) {
        $creates[$m[1]] = $stmt;
        preg_match_all('~^\s*`([^`]+)`\s+(.+?),?\s*$~m', $stmt, $cols, PREG_SET_ORDER);
        foreach ($cols as $c) { $columns[$m[1]][$c[1]] = $c[2]; }
    } elseif (preg_match('~^ALTER TABLE `([^`]+)`\s+(.*)$~s', $stmt, $m)) {
        foreach (preg_split('~,\s*\n~', $m[2]) as $clause) {
            $alters[] = [$m[1], trim($clause)];
        }
    }
}
if (!$creates) {
    fwrite(STDERR, "[gpt] schema: no CREATE TABLE in $schemaFile, not checked\n");
    exit(0);
}

// --- what the live database has
$live = function (string $query) use ($pdo, $dbName): array {
    $st = $pdo->prepare($query);
    $st->execute([$dbName]);
    return $st->fetchAll(PDO::FETCH_NUM);
};
$haveTable = $haveColumn = $haveIndex = $haveConstraint = $autoInc = [];
foreach ($live('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?') as [$t]) {
    $haveTable[$t] = true;
}
foreach ($live('SELECT TABLE_NAME, COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?') as [$t, $c, $x]) {
    $haveColumn["$t.$c"] = true;
    if (stripos((string) $x, 'auto_increment') !== false) { $autoInc["$t.$c"] = true; }
}
foreach ($live('SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?') as [$t, $i]) {
    $haveIndex["$t.$i"] = true;
}
foreach ($live('SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ?') as [$t, $k]) {
    $haveConstraint["$t.$k"] = true;
}

$changes = 0;
$run = function (string $ddl, string $what) use ($pdo, &$changes): void {
    try {
        $pdo->exec($ddl);
        $changes++;
        out("added $what");
    } catch (Throwable $e) {
        fwrite(STDERR, "[gpt] schema: could not add $what: " . $e->getMessage() . "\n");
    }
};

// --- tables, then columns
$pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
foreach ($creates as $table => $create) {
    if (!isset($haveTable[$table])) {
        $run($create, "table $table");
        continue;
    }
    foreach ($columns[$table] ?? [] as $col => $def) {
        if (!isset($haveColumn["$table.$col"])) {
            $run("ALTER TABLE `$table` ADD COLUMN `$col` $def", "column $table.$col");
        }
    }
}

// --- keys, AUTO_INCREMENT, foreign keys (in file order: keys before constraints)
foreach ($alters as [$table, $clause]) {
    if (preg_match('~^ADD PRIMARY KEY~', $clause)) {
        $missing = !isset($haveIndex["$table.PRIMARY"]);
        $what = "primary key on $table";
    } elseif (preg_match('~^ADD (?:UNIQUE |FULLTEXT |SPATIAL )?KEY `([^`]+)`~', $clause, $m)) {
        $missing = !isset($haveIndex["$table.{$m[1]}"]);
        $what = "key $table.{$m[1]}";
    } elseif (preg_match('~^MODIFY `([^`]+)`.*AUTO_INCREMENT$~', $clause, $m)) {
        $missing = !isset($autoInc["$table.{$m[1]}"]);
        $what = "AUTO_INCREMENT on $table.{$m[1]}";
    } elseif (preg_match('~^ADD CONSTRAINT `([^`]+)`~', $clause, $m)) {
        $missing = !isset($haveConstraint["$table.{$m[1]}"]);
        $what = "constraint $table.{$m[1]}";
    } else {
        continue;   // e.g. the AUTO_INCREMENT=N table option
    }
    if ($missing) {
        $run("ALTER TABLE `$table` $clause", $what);
    }
}
$pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

out($changes ? "$changes change(s) applied" : 'up to date');
