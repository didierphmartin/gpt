<?php

/**
 * Check Existing Workflows
 *
 * Checks all existing workflows and their graph data status.
 */

require_once __DIR__ . '/../vendor/autoload.php';

$config = require __DIR__ . '/../config/ai_config.php';

try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    echo "Connected to database\n\n";
} catch (PDOException $e) {
    die("Database connection failed: " . $e->getMessage() . "\n");
}

// Get all workflows
$stmt = $pdo->query("SELECT id, name, created_at FROM agent_workflows ORDER BY id");
$workflows = $stmt->fetchAll();

echo "=== Existing Workflows ===\n\n";

foreach ($workflows as $wf) {
    echo "Workflow ID {$wf['id']}: {$wf['name']}\n";
    echo "  Created: {$wf['created_at']}\n";

    // Count nodes
    $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM workflow_nodes WHERE workflow_id = ?");
    $stmt->execute([$wf['id']]);
    $nodeCount = $stmt->fetch()['count'];

    // Count edges
    $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM workflow_edges WHERE workflow_id = ?");
    $stmt->execute([$wf['id']]);
    $edgeCount = $stmt->fetch()['count'];

    echo "  Nodes: $nodeCount, Edges: $edgeCount\n";

    if ($nodeCount == 0 && $edgeCount == 0) {
        echo "  ⚠️  NO GRAPH DATA - created before graph saving was implemented?\n";
    } else {
        echo "  ✓ Has graph data\n";
    }
    echo "\n";
}

echo "=== Summary ===\n";
echo "Total workflows: " . count($workflows) . "\n";
