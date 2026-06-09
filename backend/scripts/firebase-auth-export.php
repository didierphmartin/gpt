<?php
/**
 * Firebase Auth Export — local bcrypt → Firebase Auth migration helper.
 *
 * What it does
 *   1. Scans the `users` table for email/password accounts that haven't yet
 *      been migrated to Firebase (provider='email', password set, no
 *      firebase_uid).
 *   2. By default, prints a dry-run report: total candidates, sample masked
 *      emails, and how many rows are skipped per reason.
 *   3. With --write, also emits a JSON file that `firebase auth:import`
 *      accepts (BCRYPT algorithm). The DB is NOT modified.
 *
 * Usage
 *   # Dry run (read-only, just prints stats):
 *   php backend/scripts/firebase-auth-export.php
 *
 *   # Same plus write the import file:
 *   php backend/scripts/firebase-auth-export.php --write
 *
 *   # Custom output location:
 *   php backend/scripts/firebase-auth-export.php --write --out=/tmp/users.json
 *
 * After running with --write
 *   Inspect the JSON, then run from your project's Firebase CLI workspace:
 *     firebase auth:import /tmp/firebase-auth-export.json \
 *       --hash-algo=BCRYPT --project=transledgersite
 *
 *   Existing users sign in afterward with their previous password — Firebase
 *   recognizes the hash on first login and rehashes internally. No reset
 *   email, no disruption.
 *
 * Safety
 *   - Read-only on the DB. The `password` column is NOT touched.
 *   - The login flow already prefers Firebase and falls back to local on
 *     credential failure, so partial imports are safe — accounts already in
 *     Firebase use the new path, the rest keep working on local until you
 *     re-run with the same JSON.
 */

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    echo "This script is CLI-only.\n";
    exit(1);
}

// --- Args ---------------------------------------------------------------
$opts = getopt('', ['write', 'out::', 'help']);
if (isset($opts['help'])) {
    echo file_get_contents(__FILE__, false, null, 0, 2000);
    exit(0);
}
$write = isset($opts['write']);
$outPath = $opts['out'] ?? sys_get_temp_dir() . '/firebase-auth-export.json';

// --- Bootstrap ----------------------------------------------------------
$configPath = __DIR__ . '/../config/ai_config.php';
if (!file_exists($configPath)) {
    fwrite(STDERR, "Config not found at $configPath\n");
    exit(1);
}
$config = require $configPath;

try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
} catch (PDOException $e) {
    fwrite(STDERR, "DB connection failed: {$e->getMessage()}\n");
    exit(1);
}

// --- Scan ---------------------------------------------------------------
$rows = $pdo->query("
    SELECT id, email, first_name, last_name, password, provider,
           firebase_uid, email_verified, last_login, created_at
    FROM users
    ORDER BY id ASC
")->fetchAll();

$candidates = [];
$skipped = ['social' => 0, 'no_password' => 0, 'already_migrated' => 0, 'invalid_email' => 0];

foreach ($rows as $r) {
    // Order matters for clean reporting: a Firebase-registered user has
    // provider='email' but no local bcrypt — call them "already migrated"
    // rather than "no password".
    if (!empty($r['firebase_uid']))               { $skipped['already_migrated']++; continue; }
    if (($r['provider'] ?? 'email') !== 'email') { $skipped['social']++; continue; }
    if (empty($r['password']))                    { $skipped['no_password']++; continue; }
    if (!filter_var($r['email'], FILTER_VALIDATE_EMAIL)) { $skipped['invalid_email']++; continue; }
    $candidates[] = $r;
}

// --- Report -------------------------------------------------------------
$mask = function (string $email): string {
    [$user, $domain] = array_pad(explode('@', $email, 2), 2, '');
    if ($user === '' || $domain === '') return '???';
    $userMasked = strlen($user) <= 2 ? str_repeat('*', strlen($user))
                                     : substr($user, 0, 1) . str_repeat('*', max(0, strlen($user) - 2)) . substr($user, -1);
    return "$userMasked@$domain";
};

echo "\n";
echo "Firebase Auth Export — dry run\n";
echo str_repeat('=', 50) . "\n";
echo "Total rows scanned     : " . count($rows) . "\n";
echo "Candidates to import   : " . count($candidates) . "\n";
echo "Skipped (social login) : " . $skipped['social'] . "\n";
echo "Skipped (no password)  : " . $skipped['no_password'] . "\n";
echo "Skipped (already done) : " . $skipped['already_migrated'] . "\n";
echo "Skipped (bad email)    : " . $skipped['invalid_email'] . "\n";
echo "\n";

if (count($candidates) === 0) {
    echo "Nothing to import.\n";
    exit(0);
}

echo "Sample (first 10, masked):\n";
foreach (array_slice($candidates, 0, 10) as $c) {
    echo "  - id=" . $c['id'] . "  " . $mask($c['email'])
       . "  hash=" . substr($c['password'], 0, 7) . "..."
       . "  verified=" . ($c['email_verified'] ? 'yes' : 'no') . "\n";
}
echo "\n";

// --- Write JSON ---------------------------------------------------------
if (!$write) {
    echo "Re-run with --write to emit the import file.\n";
    echo "  php " . basename(__FILE__) . " --write\n\n";
    exit(0);
}

$toMs = function ($s): int {
    if (!$s) return (int)(microtime(true) * 1000);
    $t = strtotime((string)$s);
    return $t ? $t * 1000 : (int)(microtime(true) * 1000);
};

$users = [];
foreach ($candidates as $c) {
    // Firebase auth:import with --hash-algo=BCRYPT expects the bcrypt hash
    // bytes to be base64-url encoded. Standard PHP bcrypt strings ($2y$...)
    // pass straight through as bytes — we only encode them.
    $passwordHashB64 = rtrim(strtr(base64_encode($c['password']), '+/', '-_'), '=');

    $name = trim(($c['first_name'] ?? '') . ' ' . ($c['last_name'] ?? ''));

    $entry = [
        // Use the DB id as the Firebase localId so the round-trip back to
        // our `users` row stays trivial. Must be a string.
        'localId'       => 'local-' . (string)$c['id'],
        'email'         => strtolower(trim($c['email'])),
        'emailVerified' => (bool)($c['email_verified'] ?? false),
        'passwordHash'  => $passwordHashB64,
        'createdAt'     => $toMs($c['created_at']),
        'lastLoginAt'   => $toMs($c['last_login']),
    ];
    if ($name !== '') $entry['displayName'] = $name;
    $users[] = $entry;
}

$payload = ['users' => $users];
file_put_contents($outPath, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

echo "Wrote " . count($users) . " user(s) to: $outPath\n\n";
echo "Next step (run from your Firebase CLI workspace):\n";
echo "  firebase auth:import $outPath \\\n";
echo "    --hash-algo=BCRYPT \\\n";
echo "    --project=transledgersite\n\n";
echo "After import, on each user's first sign-in via the new Firebase path,\n";
echo "the existing firebaseAuth() endpoint will populate firebase_uid in the\n";
echo "users row by email match — no further script needed.\n";
