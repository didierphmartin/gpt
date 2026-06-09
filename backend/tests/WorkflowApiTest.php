<?php

/**
 * Workflow API Test
 *
 * Simulates the exact API call that the frontend makes when saving a workflow.
 * This helps debug why graph data might not be getting saved through the API.
 *
 * Usage:
 *   php tests/WorkflowApiTest.php
 */

require_once __DIR__ . '/../vendor/autoload.php';

use AgentTeam\Controllers\WorkflowController;

echo "=== Workflow API Test ===\n";
echo "Testing: Simulate frontend workflow save request\n\n";

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
    echo "✓ Database connected\n\n";
} catch (PDOException $e) {
    die("✗ Database connection failed: " . $e->getMessage() . "\n");
}

// ============================================
// Step 1: Simulate frontend payload
// ============================================

echo "Step 1: Creating payload that matches frontend format...\n";

// This is EXACTLY what the frontend sends (from workflow-editor.js saveWorkflow method)
$frontendPayload = [
    'name' => 'API Test Workflow ' . date('Y-m-d H:i:s'),
    'description' => 'Created with visual workflow editor',
    'definition' => [
        'nodes' => [
            [
                'id' => '1',
                'node_type' => 'start',
                'type' => 'start',
                'agent_id' => null,
                'agent_name' => null,
                'config' => [
                    'agent_type' => null,
                    'type' => 'start',
                    'label' => 'Start'
                ],
                'position' => ['x' => 100, 'y' => 100],
                'pos_x' => 100,
                'pos_y' => 100
            ],
            [
                'id' => '2',
                'node_type' => 'agent',
                'type' => 'agent',
                'agent_id' => null,
                'agent_name' => 'Test Agent',
                'config' => [
                    'agent_type' => 'worker',
                    'type' => 'agent',
                    'label' => 'Process'
                ],
                'position' => ['x' => 300, 'y' => 100],
                'pos_x' => 300,
                'pos_y' => 100
            ],
            [
                'id' => '3',
                'node_type' => 'output',
                'type' => 'output',
                'agent_id' => null,
                'agent_name' => null,
                'config' => [
                    'agent_type' => null,
                    'type' => 'output',
                    'label' => 'Output'
                ],
                'position' => ['x' => 500, 'y' => 100],
                'pos_x' => 500,
                'pos_y' => 100
            ]
        ],
        'edges' => [
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
        ]
    ]
];

echo "  Payload created with " . count($frontendPayload['definition']['nodes']) . " nodes\n";
echo "  Payload created with " . count($frontendPayload['definition']['edges']) . " edges\n\n";

// ============================================
// Step 2: Simulate the API request
// ============================================

echo "Step 2: Simulating API request through WorkflowController...\n";

// This is what the backend receives as $request
$request = [
    'user_id' => 1,  // Simulated authenticated user
    'body' => $frontendPayload,
    'method' => 'POST',
    'uri' => '/api/v1/workflows'
];

echo "  Request user_id: {$request['user_id']}\n";
echo "  Request body keys: " . implode(', ', array_keys($request['body'])) . "\n";
echo "  Definition keys: " . implode(', ', array_keys($request['body']['definition'])) . "\n\n";

// ============================================
// Step 3: Check controller detection logic
// ============================================

echo "Step 3: Testing controller detection logic...\n";

$body = $request['body'];

$hasGraphViaDefinitionNodes = !empty($body['definition']['nodes']);
$hasGraphViaGraphNodes = !empty($body['graph']['nodes']);
$hasGraph = $hasGraphViaDefinitionNodes || $hasGraphViaGraphNodes;

echo "  body['definition']['nodes'] exists: " . ($hasGraphViaDefinitionNodes ? 'YES' : 'NO') . "\n";
echo "  body['graph']['nodes'] exists: " . ($hasGraphViaGraphNodes ? 'YES' : 'NO') . "\n";
echo "  hasGraph overall: " . ($hasGraph ? 'YES' : 'NO') . "\n\n";

// ============================================
// Step 4: Call the WorkflowController create method
// ============================================

echo "Step 4: Calling WorkflowController::create()...\n";

try {
    $controller = new WorkflowController($pdo, $config);
    $result = $controller->create($request);

    echo "  Response:\n";
    echo "    success: " . ($result['success'] ? 'true' : 'false') . "\n";

    if ($result['success']) {
        $workflowId = $result['data']['id'] ?? 'unknown';
        echo "    workflow_id: " . $workflowId . "\n";

        // Check if graph data was included in response
        if (isset($result['data']['graph'])) {
            echo "    graph nodes: " . count($result['data']['graph']['nodes']) . "\n";
            echo "    graph edges: " . count($result['data']['graph']['edges']) . "\n";
        } else {
            echo "    graph: NOT INCLUDED IN RESPONSE\n";
        }
    } else {
        echo "    error: " . ($result['error'] ?? 'unknown') . "\n";
    }

} catch (Exception $e) {
    echo "  ✗ Exception: " . $e->getMessage() . "\n";
    echo "    File: " . $e->getFile() . ":" . $e->getLine() . "\n";
}

echo "\n";

// ============================================
// Step 5: Verify database state
// ============================================

echo "Step 5: Verifying database state...\n";

if (isset($workflowId) && is_numeric($workflowId)) {
    // Check workflow_nodes
    $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM workflow_nodes WHERE workflow_id = ?");
    $stmt->execute([$workflowId]);
    $nodeCount = $stmt->fetch()['count'];
    echo "  workflow_nodes for workflow $workflowId: $nodeCount\n";

    // Check workflow_edges
    $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM workflow_edges WHERE workflow_id = ?");
    $stmt->execute([$workflowId]);
    $edgeCount = $stmt->fetch()['count'];
    echo "  workflow_edges for workflow $workflowId: $edgeCount\n";

    if ($nodeCount == 3 && $edgeCount == 2) {
        echo "  ✓ Graph data saved correctly!\n";
    } else {
        echo "  ✗ Graph data NOT saved! Expected 3 nodes and 2 edges.\n";
    }

    // Clean up
    echo "\nStep 6: Cleaning up test data...\n";
    $pdo->prepare("DELETE FROM agent_workflows WHERE id = ?")->execute([$workflowId]);
    echo "  ✓ Test workflow deleted\n";
}

echo "\n=== Test Complete ===\n";
