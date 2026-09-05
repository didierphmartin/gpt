<?php

declare(strict_types=1);

/**
 * Registers the mock Okta MCP server (Task 9, htdocs/mockokta/) in the
 * mcp_servers / mcp_server_tools tables so the real MCPToolsLoader plumbing
 * (and, via LoaderMcpExecutor, the playbook interpreter) can call it.
 *
 * Idempotent: upserts the `mcp_servers` row by (user_id, name) — the schema's
 * own unique key — then DELETEs and re-INSERTs its `mcp_server_tools` rows
 * from a live `tools/list` call, so re-running (including with a different
 * user id) is always safe.
 *
 * Usage:
 *   php scripts/register_mock_okta.php [user_id]
 *
 * When user_id is omitted, the first row of `users` (ORDER BY id LIMIT 1) in
 * the CONTEXTS database is used, and the script prints which id it picked.
 *
 * Uses the same `contexts_database` config block as MCPServerController /
 * MCPToolsLoader — NOT $config['database'], which points at a different DB
 * (see MEMORY: "Backend DB topology").
 */

const MOCK_OKTA_URL = 'http://localhost/mockokta/';
const MOCK_OKTA_NAME = 'Okta';

// -------- config + DB --------------------------------------------------------
$config = require __DIR__ . '/../config/ai_config.php';
$dbConfig = $config['contexts_database'] ?? null;
if (!$dbConfig || empty($dbConfig['database'])) {
    fwrite(STDERR, "ERROR: no usable 'contexts_database' section in config/ai_config.php\n");
    exit(1);
}

$dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
$pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);

// -------- resolve user id -----------------------------------------------------
$userId = $argv[1] ?? null;
if ($userId === null || $userId === '') {
    $row = $pdo->query('SELECT id FROM users ORDER BY id LIMIT 1')->fetch();
    if (!$row) {
        fwrite(STDERR, "ERROR: no user_id given and no rows in `users` to default to\n");
        exit(1);
    }
    $userId = (string) $row['id'];
    fwrite(STDOUT, "No user id given — defaulting to first user in `users`: {$userId}\n");
} else {
    fwrite(STDOUT, "Using user id: {$userId}\n");
}

// -------- fetch live tool list from the mock Okta MCP server -----------------
$request = [
    'jsonrpc' => '2.0',
    'id' => 1,
    'method' => 'tools/list',
    'params' => new stdClass(),
];

$ch = curl_init(MOCK_OKTA_URL);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($request),
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
]);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($response === false || $curlError) {
    fwrite(STDERR, "ERROR: could not reach " . MOCK_OKTA_URL . ": {$curlError}\n");
    exit(1);
}
if ($httpCode >= 400) {
    fwrite(STDERR, "ERROR: mock Okta server returned HTTP {$httpCode}: {$response}\n");
    exit(1);
}

$decoded = json_decode($response, true);
$tools = $decoded['result']['tools'] ?? null;
if (!is_array($tools) || $tools === []) {
    fwrite(STDERR, "ERROR: tools/list returned no tools. Raw response:\n{$response}\n");
    exit(1);
}
fwrite(STDOUT, 'Fetched ' . count($tools) . " tools from mock Okta server\n");

// -------- upsert mcp_servers row ---------------------------------------------
$stmt = $pdo->prepare('
    INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled, is_mock)
    VALUES (:user_id, :name, :url, :description, NULL, 1, 1)
    ON DUPLICATE KEY UPDATE url = VALUES(url), description = VALUES(description), enabled = 1, is_mock = 1
');
$stmt->execute([
    ':user_id' => $userId,
    ':name' => MOCK_OKTA_NAME,
    ':url' => MOCK_OKTA_URL,
    ':description' => 'Mock Okta identity/MFA server (Task 9 fixture) for playbook interpreter testing.',
]);

$stmt = $pdo->prepare('SELECT id FROM mcp_servers WHERE user_id = :user_id AND name = :name');
$stmt->execute([':user_id' => $userId, ':name' => MOCK_OKTA_NAME]);
$serverRow = $stmt->fetch();
if (!$serverRow) {
    fwrite(STDERR, "ERROR: failed to upsert/find mcp_servers row for Okta\n");
    exit(1);
}
$serverId = (int) $serverRow['id'];
fwrite(STDOUT, "Upserted mcp_servers row id={$serverId} (user_id={$userId}, url=" . MOCK_OKTA_URL . ")\n");

// -------- replace mcp_server_tools rows ---------------------------------------
$pdo->prepare('DELETE FROM mcp_server_tools WHERE server_id = :server_id')
    ->execute([':server_id' => $serverId]);

$insert = $pdo->prepare('
    INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)
    VALUES (:server_id, :tool_name, :tool_description, :input_schema, 0, NULL)
');

foreach ($tools as $tool) {
    // Field-name mapping: live server uses camelCase (name/description/inputSchema),
    // the cache table uses tool_name/tool_description/input_schema.
    $insert->execute([
        ':server_id' => $serverId,
        ':tool_name' => $tool['name'],
        ':tool_description' => $tool['description'] ?? '',
        ':input_schema' => json_encode($tool['inputSchema'] ?? ['type' => 'object', 'properties' => new stdClass()]),
    ]);
}

fwrite(STDOUT, 'Inserted ' . count($tools) . " rows into mcp_server_tools for server id={$serverId}\n");
fwrite(STDOUT, "Done.\n");
