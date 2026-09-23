<?php
declare(strict_types=1);

/**
 * Seeds the first admin account.
 *
 * Not a convenience. AuthController::register is hard-gated on ledger_user_id
 * and tells a new user to register at synergyaichat.com, and the LLM-settings
 * pane is gated on role === 'admin'. Without this, a fresh container boots into
 * a locked door with no way to add the key that would make it useful.
 *
 * Idempotent: does nothing once `users` is non-empty.
 */

$app = dirname(__DIR__);
require $app . '/backend/vendor/autoload.php';

$config = require $app . '/backend/config/ai_config.php';
$db = $config['contexts_database'];

try {
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['database']};charset=utf8mb4",
        $db['username'],
        $db['password'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 10]
    );
} catch (Throwable $e) {
    fwrite(STDERR, '[gpt] admin bootstrap: database unreachable: ' . $e->getMessage() . "\n");
    exit(0);   // never block Apache from starting
}

try {
    if ((int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
        echo "[gpt] users table is not empty -- leaving it alone\n";
        exit(0);
    }
} catch (Throwable $e) {
    fwrite(STDERR, "[gpt] admin bootstrap: schema not ready ({$e->getMessage()}) -- skipping\n");
    exit(0);   // never block Apache from starting
}

$email = getenv('GPT_ADMIN_EMAIL') ?: 'admin@localhost';
$password = getenv('GPT_ADMIN_PASSWORD') ?: bin2hex(random_bytes(9));
$generated = getenv('GPT_ADMIN_PASSWORD') === false || getenv('GPT_ADMIN_PASSWORD') === '';

try {
    $stmt = $pdo->prepare(
        'INSERT INTO users
           (email, password, first_name, last_name, role, plan, provider,
            email_verified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())'
    );
    $stmt->execute([
        $email,
        password_hash($password, PASSWORD_BCRYPT),
        'Admin',
        'User',
        'admin',     // required: the LLM-settings pane checks for exactly this
        'free',      // admins bypass the plan gate (settings-panel.js:2221)
        'email',
        1,
    ]);
} catch (Throwable $e) {
    fwrite(STDERR, '[gpt] admin bootstrap: could not create admin: ' . $e->getMessage() . "\n");
    exit(0);   // never block Apache from starting
}

$line = str_repeat('=', 62);
echo "\n$line\n";
echo "  gpt is ready:  http://localhost:" . (getenv('GPT_PORT') ?: '8080') . "/gpt/\n\n";
echo "  email:     $email\n";
echo "  password:  $password\n";
if ($generated) {
    echo "\n  Generated for this install. Copy it now -- it is not stored\n";
    echo "  anywhere else. Set GPT_ADMIN_PASSWORD in .env to choose your own.\n";
}
echo "\n  No LLM keys are configured. Add your own under\n";
echo "  Settings -> Admin -> LLM settings before chatting.\n";
echo "$line\n\n";
