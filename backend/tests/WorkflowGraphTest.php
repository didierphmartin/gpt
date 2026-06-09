<?php

/**
 * Workflow Graph Test
 *
 * Tests the workflow graph functionality:
 * 1. Check if workflow_nodes and workflow_edges tables exist
 * 2. Create a workflow with graph data
 * 3. Retrieve and verify graph data was saved
 *
 * Usage:
 *   php tests/WorkflowGraphTest.php
 */

require_once __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Models\Workflow;
use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\WorkflowGraphRepository;

echo "=== Workflow Graph Test ===\n";
echo "Testing: Create workflow with graph data and retrieve it\n\n";

// ============================================
// Configuration
// ============================================

$config = require __DIR__ . '/../config/ai_config.php';

// Database connection
try {
    $dbConfig = $config['contexts_database'] ?? $config['database'];
    $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    echo "✓ Database connected to {$dbConfig['database']}\n\n";
} catch (PDOException $e) {
    die("✗ Database connection failed: " . $e->getMessage() . "\n");
}

// ============================================
// Step 1: Check if tables exist
// ============================================

echo "Step 1: Checking tables...\n";

// Check agent_workflows
$stmt = $pdo->query("SHOW TABLES LIKE 'agent_workflows'");
if ($stmt->fetch()) {
    echo "  ✓ agent_workflows table exists\n";
    $stmt = $pdo->query("SELECT COUNT(*) as count FROM agent_workflows");
    $count = $stmt->fetch()['count'];
    echo "    → Contains {$count} workflows\n";
} else {
    die("  ✗ agent_workflows table does NOT exist\n");
}

// Check workflow_nodes
$stmt = $pdo->query("SHOW TABLES LIKE 'workflow_nodes'");
if ($stmt->fetch()) {
    echo "  ✓ workflow_nodes table exists\n";
    $stmt = $pdo->query("SELECT COUNT(*) as count FROM workflow_nodes");
    $count = $stmt->fetch()['count'];
    echo "    → Contains {$count} nodes\n";
} else {
    echo "  ✗ workflow_nodes table does NOT exist\n";
    echo "    Creating workflow_nodes table...\n";

    $sql = "CREATE TABLE workflow_nodes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workflow_id INT NOT NULL,
        node_type VARCHAR(50) NOT NULL DEFAULT 'agent',
        agent_id INT NULL,
        config JSON,
        pos_x INT DEFAULT 0,
        pos_y INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
        INDEX idx_workflow (workflow_id)
    )";

    try {
        $pdo->exec($sql);
        echo "  ✓ workflow_nodes table created\n";
    } catch (PDOException $e) {
        echo "  ✗ Failed to create workflow_nodes: " . $e->getMessage() . "\n";
    }
}

// Check workflow_edges
$stmt = $pdo->query("SHOW TABLES LIKE 'workflow_edges'");
if ($stmt->fetch()) {
    echo "  ✓ workflow_edges table exists\n";
    $stmt = $pdo->query("SELECT COUNT(*) as count FROM workflow_edges");
    $count = $stmt->fetch()['count'];
    echo "    → Contains {$count} edges\n";
} else {
    echo "  ✗ workflow_edges table does NOT exist\n";
    echo "    Creating workflow_edges table...\n";

    $sql = "CREATE TABLE workflow_edges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workflow_id INT NOT NULL,
        from_node_id INT NOT NULL,
        to_node_id INT NOT NULL,
        from_port VARCHAR(50) DEFAULT 'output_1',
        to_port VARCHAR(50) DEFAULT 'input_1',
        condition_expr TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE,
        FOREIGN KEY (from_node_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (to_node_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE,
        INDEX idx_workflow (workflow_id),
        INDEX idx_from_node (from_node_id),
        INDEX idx_to_node (to_node_id)
    )";

    try {
        $pdo->exec($sql);
        echo "  ✓ workflow_edges table created\n";
    } catch (PDOException $e) {
        echo "  ✗ Failed to create workflow_edges: " . $e->getMessage() . "\n";
    }
}

echo "\n";

// ============================================
// Step 2: Create a test workflow with graph data
// ============================================

echo "Step 2: Creating test workflow with graph data...\n";

$workflowRepo = new WorkflowRepository($pdo);
$graphRepo = new WorkflowGraphRepository($pdo);

// Create workflow
$workflow = new Workflow();
$workflow->setUserId(1)
    ->setName('Test Visual Workflow ' . date('Y-m-d H:i:s'))
    ->setDescription('Created by WorkflowGraphTest.php')
    ->setSteps([])
    ->setEnabled(true);

try {
    $workflow = $workflowRepo->create($workflow);
    echo "  ✓ Workflow created: ID={$workflow->getId()}\n";
} catch (Exception $e) {
    die("  ✗ Failed to create workflow: " . $e->getMessage() . "\n");
}

// ============================================
// Step 3: Add graph data (nodes and edges)
// ============================================

echo "Step 3: Adding graph data...\n";

$nodes = [
    [
        'id' => '1',  // Temporary frontend ID
        'node_type' => 'start',
        'config' => ['label' => 'Start'],
        'pos_x' => 100,
        'pos_y' => 100
    ],
    [
        'id' => '2',
        'node_type' => 'agent',
        'agent_id' => null, // No specific agent for test
        'config' => ['label' => 'Process Data'],
        'pos_x' => 300,
        'pos_y' => 100
    ],
    [
        'id' => '3',
        'node_type' => 'output',
        'config' => ['label' => 'Output'],
        'pos_x' => 500,
        'pos_y' => 100
    ]
];

$edges = [
    [
        'from' => '1',
        'to' => '2',
        'from_port' => 'output_1',
        'to_port' => 'input_1'
    ],
    [
        'from' => '2',
        'to' => '3',
        'from_port' => 'output_1',
        'to_port' => 'input_1'
    ]
];

try {
    $nodeIdMap = $graphRepo->saveGraph($workflow->getId(), $nodes, $edges);
    echo "  ✓ Graph saved successfully\n";
    echo "    Node ID mapping:\n";
    foreach ($nodeIdMap as $tempId => $dbId) {
        echo "      Frontend ID '{$tempId}' → Database ID {$dbId}\n";
    }
} catch (Exception $e) {
    die("  ✗ Failed to save graph: " . $e->getMessage() . "\n");
}

echo "\n";

// ============================================
// Step 4: Retrieve and verify graph data
// ============================================

echo "Step 4: Retrieving and verifying graph data...\n";

// Get nodes
$savedNodes = $graphRepo->getNodes($workflow->getId());
echo "  Retrieved " . count($savedNodes) . " nodes:\n";
foreach ($savedNodes as $node) {
    echo "    - ID={$node['id']}, type={$node['node_type']}, pos=({$node['pos_x']},{$node['pos_y']})\n";
}

// Get edges
$savedEdges = $graphRepo->getEdges($workflow->getId());
echo "  Retrieved " . count($savedEdges) . " edges:\n";
foreach ($savedEdges as $edge) {
    echo "    - ID={$edge['id']}, from={$edge['from_node_id']} → to={$edge['to_node_id']}\n";
}

// Verify counts
if (count($savedNodes) === 3 && count($savedEdges) === 2) {
    echo "  ✓ Graph data verified successfully!\n";
} else {
    echo "  ✗ Graph data mismatch! Expected 3 nodes and 2 edges.\n";
}

echo "\n";

// ============================================
// Step 5: Test full workflow retrieval with graph
// ============================================

echo "Step 5: Testing full workflow retrieval with graph...\n";

$fullWorkflow = $workflowRepo->findById($workflow->getId(), true);
$graph = $fullWorkflow->getGraph();

if ($graph !== null) {
    echo "  ✓ Workflow graph retrieved via repository\n";
    echo "    Nodes: " . count($graph['nodes']) . "\n";
    echo "    Edges: " . count($graph['edges']) . "\n";
} else {
    echo "  ✗ Workflow graph is NULL\n";
}

// Test API array output
$apiArray = $fullWorkflow->toApiArray();
echo "  API array keys: " . implode(', ', array_keys($apiArray)) . "\n";

if (isset($apiArray['graph'])) {
    echo "  ✓ Graph included in API response\n";
    echo "    Graph nodes: " . count($apiArray['graph']['nodes']) . "\n";
    echo "    Graph edges: " . count($apiArray['graph']['edges']) . "\n";
} else {
    echo "  ✗ Graph NOT included in API response\n";
}

echo "\n";

// ============================================
// Step 6: Clean up test data
// ============================================

echo "Step 6: Cleaning up test data...\n";

try {
    $workflowRepo->delete($workflow->getId());
    echo "  ✓ Test workflow deleted\n";
} catch (Exception $e) {
    echo "  ! Failed to delete test workflow: " . $e->getMessage() . "\n";
}

echo "\n=== Test Complete ===\n";
