<?php
declare(strict_types=1);
/**
 * Live test for the sso_exchange auth action. Requires Apache + both DBs.
 * Run: php tests/sso-exchange-test.php
 * Mints login-service JWTs with the shared secret (read from the login
 * project's .env) and asserts every spec failure row plus the happy path.
 *
 * All fixtures are temporary rows created under unique example.invalid
 * emails and are ALWAYS deleted in the top-level finally block, even if an
 * assertion (or an unexpected exception) fails partway through. No
 * pre-existing/real user rows are ever read as fixtures or mutated.
 */

$loginEnvFile = '/Applications/XAMPP/xamppfiles/htdocs/login/backend/.env';
$env = [];
foreach (file($loginEnvFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $l) {
    if ($l === '' || $l[0] === '#' || !str_contains($l, '=')) continue;
    [$k, $v] = explode('=', $l, 2);
    $env[trim($k)] = trim($v, " \t\"");
}
$secret = $env['JWT_SECRET'] ?? '';
if ($secret === '') { fwrite(STDERR, "no JWT_SECRET in login .env\n"); exit(1); }

function b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function mint(string $secret, array $claims): string {
    $h = b64u(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));
    $p = b64u(json_encode($claims));
    return "$h.$p." . b64u(hash_hmac('sha256', "$h.$p", $secret, true));
}
function call(array $body, array $extraHeaders = []): array {
    $ch = curl_init('http://localhost/gpt/backend/api/v1/auth');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json'], $extraHeaders),
        CURLOPT_POSTFIELDS => json_encode($body),
    ]);
    $out = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$code, json_decode((string)$out, true) ?? []];
}
$fail = 0;
function check(string $name, bool $ok): void {
    global $fail;
    echo ($ok ? "PASS" : "FAIL"), "  $name\n";
    if (!$ok) $fail++;
}

$ldb = new PDO("mysql:host={$env['DB_HOST']};dbname={$env['DB_NAME']};charset=utf8mb4",
    $env['DB_USER'], $env['DB_PASS'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$genv = [];
foreach (file('/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $l) {
    if ($l === '' || $l[0] === '#' || !str_contains($l, '=')) continue;
    [$k, $v] = explode('=', $l, 2);
    $genv[trim($k)] = trim($v, " \t\"");
}
// index.php wires every controller's $this->db to $config['contexts_database']
// (falling back to $config['database'] only if that key were absent, which it
// never is — see backend/index.php:50), so the live endpoint's gpt-side user
// lookups run against CTX_DB_*, not DB_*. Fixtures must land in the same DB
// the running server actually queries, or "no admin account" 403s spuriously.
$gdb = new PDO("mysql:host={$genv['CTX_DB_HOST']};dbname={$genv['CTX_DB_NAME']};charset=utf8mb4",
    $genv['CTX_DB_USER'], $genv['CTX_DB_PASS'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$now = time();
$claims = fn(int $sub, array $o = []) => array_merge(
    ['iss' => 'login-service', 'iat' => $now, 'exp' => $now + 300,
     'sub' => $sub, 'type' => 'access'], $o);

// All fixtures share one random suffix so they're easy to spot/clean up by
// hand if the script ever dies before the finally block runs.
$rand = bin2hex(random_bytes(4));
$emailAdmin      = "sso-test-admin-$rand@example.invalid";
$emailUnverified = "sso-test-unverified-$rand@example.invalid";
$emailNoGptUser  = "sso-test-noaccount-$rand@example.invalid";
$emailNonAdmin   = "sso-test-nonadmin-$rand@example.invalid";

$loginIdAdmin = null;
$gptIdAdmin = null;
$loginIdUnverified = null;
$loginIdNoGptUser = null;
$loginIdNonAdmin = null;
$gptIdNonAdmin = null;

try {
    // Happy-path fixture: a fully temporary, verified login user + matching
    // gpt admin user (not a pre-existing/real account — avoids depending on
    // or mutating whatever admin rows happen to already exist in this DB).
    $ins = $ldb->prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)');
    $ins->execute([$emailAdmin]);
    $loginIdAdmin = (int) $ldb->lastInsertId();
    $ins = $gdb->prepare("INSERT INTO users (email, role) VALUES (?, 'admin')");
    $ins->execute([$emailAdmin]);
    $gptIdAdmin = (int) $gdb->lastInsertId();

    // 1. Garbage token → 401
    [$c, $r] = call(['action' => 'sso_exchange', 'login_token' => 'not.a.jwt']);
    check('garbage token rejected', $c === 401 && $r['success'] === false);

    // 2. Wrong secret → 401
    [$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint('wrong-secret', $claims($loginIdAdmin))]);
    check('wrong-secret token rejected', $c === 401);

    // 3. Expired → 401
    [$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdAdmin, ['exp' => $now - 10]))]);
    check('expired token rejected', $c === 401);

    // 4. Refresh-type token → 401
    [$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdAdmin, ['type' => 'refresh']))]);
    check('non-access token rejected', $c === 401);

    // 4b. Wrong issuer → 401 (Finding 1: login service was ported from gpt and
    // may share gpt's JWT_SECRET; a gpt-issued token must not be accepted as a
    // login token even though it would otherwise decode fine with that shared
    // secret).
    [$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdAdmin, ['iss' => 'gpt-chat']))]);
    check('wrong-issuer token rejected', $c === 401);

    // 5. Unknown login user id → 401
    [$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims(99999999))]);
    check('unknown login user rejected', $c === 401);

    // 6. Happy path → 200 + admin token
    [$c, $r] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdAdmin))]);
    check('admin exchange succeeds', $c === 200 && ($r['success'] ?? false) === true
        && ($r['data']['user']['role'] ?? '') === 'admin'
        && !empty($r['data']['access_token']));

    // 7. Issued token works against verify.
    // Adapted from the brief's original body-based check: AuthController::verify()
    // (backend/src/Controllers/AuthController.php:525-557) reads the token from the
    // Authorization header ("Bearer <token>"), not from the JSON body, so send it
    // that way. Assertion stays "exchanged token is accepted".
    if (!empty($r['data']['access_token'])) {
        [$c2, $r2] = call(
            ['action' => 'verify'],
            ['Authorization: Bearer ' . $r['data']['access_token']]
        );
        check('exchanged token verifies', $c2 === 200 && ($r2['success'] ?? false) === true);
    }

    // --- Finding 2 & 3: fixture-based checks for the two 403 branches ---

    // (a) Login user exists but email_verified = 0 → 403 "not verified"
    // (Finding 2: the login service allows registering without proving email
    // ownership, and ssoExchange uses email as its identity anchor into gpt's
    // user table — an unverified email must not be trusted for that.)
    $ins = $ldb->prepare('INSERT INTO users (email, email_verified) VALUES (?, 0)');
    $ins->execute([$emailUnverified]);
    $loginIdUnverified = (int) $ldb->lastInsertId();
    [$c, $r] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdUnverified))]);
    check('unverified login email rejected (403)', $c === 403 && ($r['success'] ?? true) === false);

    // (b) Login user verified, but no gpt user has that email → 403 "no admin account"
    $ins = $ldb->prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)');
    $ins->execute([$emailNoGptUser]);
    $loginIdNoGptUser = (int) $ldb->lastInsertId();
    [$c, $r] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdNoGptUser))]);
    check('no matching gpt account rejected (403)', $c === 403 && ($r['success'] ?? true) === false);

    // (c) Login user verified + a real (temporary) gpt user with the same
    // email but role 'user' (not admin) → 403 "not an admin". Minimal INSERT:
    // gpt.users (the contexts_database copy — see the $gdb comment above)
    // only requires email (NOT NULL, no default); role defaults to
    // 'prospect' but is set explicitly to 'user' here.
    $ins = $ldb->prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)');
    $ins->execute([$emailNonAdmin]);
    $loginIdNonAdmin = (int) $ldb->lastInsertId();
    $ins = $gdb->prepare("INSERT INTO users (email, role) VALUES (?, 'user')");
    $ins->execute([$emailNonAdmin]);
    $gptIdNonAdmin = (int) $gdb->lastInsertId();
    [$c, $r] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims($loginIdNonAdmin))]);
    check('non-admin gpt account rejected (403)', $c === 403 && ($r['success'] ?? true) === false);
} finally {
    // Unconditional cleanup — runs even if an assertion or exception above failed.
    if ($gptIdAdmin !== null) { $gdb->prepare('DELETE FROM users WHERE id = ?')->execute([$gptIdAdmin]); }
    if ($gptIdNonAdmin !== null) { $gdb->prepare('DELETE FROM users WHERE id = ?')->execute([$gptIdNonAdmin]); }
    if ($loginIdAdmin !== null) { $ldb->prepare('DELETE FROM users WHERE id = ?')->execute([$loginIdAdmin]); }
    if ($loginIdUnverified !== null) { $ldb->prepare('DELETE FROM users WHERE id = ?')->execute([$loginIdUnverified]); }
    if ($loginIdNoGptUser !== null) { $ldb->prepare('DELETE FROM users WHERE id = ?')->execute([$loginIdNoGptUser]); }
    if ($loginIdNonAdmin !== null) { $ldb->prepare('DELETE FROM users WHERE id = ?')->execute([$loginIdNonAdmin]); }
}

exit($fail === 0 ? 0 : 1);
