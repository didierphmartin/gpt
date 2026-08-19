<?php
declare(strict_types=1);
/**
 * Live test for the sso_exchange auth action. Requires Apache + both DBs.
 * Run: php tests/sso-exchange-test.php
 * Mints login-service JWTs with the shared secret (read from the login
 * project's .env) and asserts every spec failure row plus the happy path.
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

// Pick a login user whose email is a gpt admin (happy path fixture).
$ldb = new PDO("mysql:host={$env['DB_HOST']};dbname={$env['DB_NAME']};charset=utf8mb4",
    $env['DB_USER'], $env['DB_PASS'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$genv = [];
foreach (file('/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $l) {
    if ($l === '' || $l[0] === '#' || !str_contains($l, '=')) continue;
    [$k, $v] = explode('=', $l, 2);
    $genv[trim($k)] = trim($v, " \t\"");
}
$gdb = new PDO("mysql:host={$genv['DB_HOST']};dbname={$genv['DB_NAME']};charset=utf8mb4",
    $genv['DB_USER'], $genv['DB_PASS'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$adminRow = null;
foreach ($ldb->query('SELECT id, email FROM users') as $lu) {
    $s = $gdb->prepare("SELECT role FROM users WHERE email = ?");
    $s->execute([strtolower(trim($lu['email']))]);
    if (($s->fetchColumn() ?: '') === 'admin') { $adminRow = $lu; break; }
}
if (!$adminRow) { fwrite(STDERR, "no login user maps to a gpt admin — create one first\n"); exit(1); }
$now = time();
$claims = fn(array $o = []) => array_merge(
    ['iss' => 'login-service', 'iat' => $now, 'exp' => $now + 300,
     'sub' => (int)$adminRow['id'], 'type' => 'access'], $o);

// 1. Garbage token → 401
[$c, $r] = call(['action' => 'sso_exchange', 'login_token' => 'not.a.jwt']);
check('garbage token rejected', $c === 401 && $r['success'] === false);

// 2. Wrong secret → 401
[$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint('wrong-secret', $claims())]);
check('wrong-secret token rejected', $c === 401);

// 3. Expired → 401
[$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims(['exp' => $now - 10]))]);
check('expired token rejected', $c === 401);

// 4. Refresh-type token → 401
[$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims(['type' => 'refresh']))]);
check('non-access token rejected', $c === 401);

// 5. Unknown login user id → 401
[$c, ] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims(['sub' => 99999999]))]);
check('unknown login user rejected', $c === 401);

// 6. Happy path → 200 + admin token
[$c, $r] = call(['action' => 'sso_exchange', 'login_token' => mint($secret, $claims())]);
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

exit($fail === 0 ? 0 : 1);
