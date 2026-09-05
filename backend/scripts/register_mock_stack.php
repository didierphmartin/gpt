<?php

declare(strict_types=1);

/**
 * Registers the full mock MCP stack for the New Hire Provisioning playbook:
 * the (extended) mock Okta plus the seven mockstack services — each as its
 * own mcp_servers row so playbook auto-binding sees distinct server slugs
 * (okta.create_user, github.invite_user_to_org, aws.iam_..., etc.).
 *
 * Idempotent, same mechanics as register_mock_okta.php: upsert by
 * (user_id, name), then DELETE + re-INSERT the tool cache from a live
 * tools/list. Uses the CONTEXTS database config (never $config['database']).
 *
 * Usage: php scripts/register_mock_stack.php [user_id]
 */

$servers = [
    ['name' => 'Okta',             'url' => 'http://localhost/mockokta/',                      'desc' => 'Mock Okta identity server (extended: lookup/create/activate/groups).'],
    ['name' => 'Google Workspace', 'url' => 'http://localhost/mockstack/index.php/google_workspace', 'desc' => 'Mock Google Workspace groups.'],
    ['name' => 'Google Calendar',  'url' => 'http://localhost/mockstack/index.php/google_calendar',  'desc' => 'Mock Google Calendar (list/create events).'],
    ['name' => 'Slack',            'url' => 'http://localhost/mockstack/index.php/slack',            'desc' => 'Mock Slack channel invites.'],
    ['name' => 'Kandji',           'url' => 'http://localhost/mockstack/index.php/kandji',           'desc' => 'Mock Kandji ADE device assignment.'],
    ['name' => 'GitHub',           'url' => 'http://localhost/mockstack/index.php/github',           'desc' => 'Mock GitHub org/team management.'],
    ['name' => 'Datadog',          'url' => 'http://localhost/mockstack/index.php/datadog',          'desc' => 'Mock Datadog user invites.'],
    ['name' => 'AWS',              'url' => 'http://localhost/mockstack/index.php/aws',              'desc' => 'Mock AWS IAM (sandbox).'],
    ['name' => 'Workday',          'url' => 'http://localhost/mockstack/index.php/workday',          'desc' => 'Mock Workday time-off (balances, blackout, team calendar, submit).'],
];

$config = require __DIR__ . '/../config/ai_config.php';
$dbConfig = $config['contexts_database'] ?? null;
if (!$dbConfig || empty($dbConfig['database'])) {
    fwrite(STDERR, "ERROR: no usable 'contexts_database' config\n");
    exit(1);
}
$pdo = new PDO(
    "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}",
    $dbConfig['username'],
    $dbConfig['password'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
);

$userId = $argv[1] ?? null;
if ($userId === null || $userId === '') {
    $row = $pdo->query('SELECT id FROM users ORDER BY id LIMIT 1')->fetch();
    if (!$row) { fwrite(STDERR, "ERROR: no user_id and no users\n"); exit(1); }
    $userId = (string)$row['id'];
    fwrite(STDOUT, "No user id given — defaulting to first user: {$userId}\n");
}

function stack_fetch_tools(string $url): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list', 'params' => new stdClass()]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $resp = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);
    if ($resp === false || $err) throw new RuntimeException("unreachable ({$err})");
    $tools = json_decode($resp, true)['result']['tools'] ?? null;
    if (!is_array($tools) || $tools === []) throw new RuntimeException("no tools in response: {$resp}");
    return $tools;
}

$upsert = $pdo->prepare('INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled, is_mock)
    VALUES (:u, :n, :url, :d, NULL, 1, 1)
    ON DUPLICATE KEY UPDATE url = VALUES(url), description = VALUES(description), enabled = 1, is_mock = 1');
$findId = $pdo->prepare('SELECT id FROM mcp_servers WHERE user_id = :u AND name = :n');
$clear  = $pdo->prepare('DELETE FROM mcp_server_tools WHERE server_id = :s');
$ins    = $pdo->prepare('INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)
    VALUES (:s, :tn, :td, :sc, 0, NULL)');

foreach ($servers as $srv) {
    try {
        $tools = stack_fetch_tools($srv['url']);
    } catch (Throwable $e) {
        fwrite(STDERR, "SKIP {$srv['name']}: {$e->getMessage()}\n");
        continue;
    }
    $upsert->execute([':u' => $userId, ':n' => $srv['name'], ':url' => $srv['url'], ':d' => $srv['desc']]);
    $findId->execute([':u' => $userId, ':n' => $srv['name']]);
    $serverId = (int)$findId->fetch()['id'];
    $clear->execute([':s' => $serverId]);
    foreach ($tools as $t) {
        $ins->execute([':s' => $serverId, ':tn' => $t['name'], ':td' => $t['description'] ?? '',
            ':sc' => json_encode($t['inputSchema'] ?? ['type' => 'object', 'properties' => new stdClass()])]);
    }
    fwrite(STDOUT, sprintf("%-17s server id=%d — %d tools\n", $srv['name'], $serverId, count($tools)));
}
fwrite(STDOUT, "Done.\n");
