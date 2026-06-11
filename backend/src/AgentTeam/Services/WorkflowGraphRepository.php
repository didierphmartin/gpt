<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Workflow Graph Repository
 *
 * Handles CRUD operations for workflow nodes and edges (graph structure).
 * Works alongside WorkflowRepository for the parent workflow entity.
 */
class WorkflowGraphRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Batch-detect which of the given workflows contain realtime-* nodes,
     * in a single query. Used by WorkflowController::index() to set
     * runtime_mode for the sidebar list without round-tripping the full
     * graph per workflow (N+1 over remote DB latency is the slowness the
     * user reports). Returns workflow IDs that have at least one
     * realtime-* node; the rest are treated as 'batch'.
     */
    public function findRealtimeWorkflowIds(array $workflowIds): array
    {
        if (empty($workflowIds)) return [];
        $ids = array_values(array_filter(array_map('intval', $workflowIds)));
        if (empty($ids)) return [];
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->db->prepare(
            "SELECT DISTINCT workflow_id FROM workflow_nodes
             WHERE workflow_id IN ($placeholders)
               AND node_type LIKE 'realtime-%'"
        );
        $stmt->execute($ids);
        return array_map('intval', array_column($stmt->fetchAll(PDO::FETCH_ASSOC), 'workflow_id'));
    }

    /**
     * Get all nodes for a workflow
     */
    public function getNodes(int $workflowId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id"
        );
        $stmt->execute([$workflowId]);

        return array_map(function($row) {
            $row['config'] = $row['config'] ? json_decode($row['config'], true) : [];
            return $row;
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Get all edges for a workflow
     */
    public function getEdges(int $workflowId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id"
        );
        $stmt->execute([$workflowId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Get full graph (nodes + edges) for a workflow
     */
    public function getGraph(int $workflowId): array
    {
        return [
            'nodes' => $this->getNodes($workflowId),
            'edges' => $this->getEdges($workflowId)
        ];
    }

    /**
     * Save a node to the workflow
     * Returns the node ID
     */
    public function createNode(int $workflowId, array $nodeData): int
    {
        // Get drawflow node ID (the frontend Drawflow ID)
        $drawflowNodeId = $nodeData['id'] ?? $nodeData['drawflow_node_id'] ?? null;

        // Determine node type - check multiple sources
        $nodeType = $nodeData['node_type'] ?? $nodeData['type'] ?? $nodeData['config']['type'] ?? 'agent';

        if ($nodeType === 'condition' || $nodeType === 'switch') {
            throw new \InvalidArgumentException("Node type '{$nodeType}' is no longer supported. Use an agent with branching logic instead.");
        }

        // Ensure type is also stored in config for redundancy
        $config = $nodeData['config'] ?? $nodeData['data'] ?? [];
        if (!isset($config['type'])) {
            $config['type'] = $nodeType;
        }

        // Validate agent_id: must be null or a valid integer (foreign key constraint)
        // Strings like "node_3" are not valid - treat them as null
        $agentId = $nodeData['agent_id'] ?? null;
        if ($agentId !== null && !is_numeric($agentId)) {
            $agentId = null;  // Invalid agent_id, use null instead
        }
        $agentId = $agentId !== null ? (int) $agentId : null;

        $sql = "INSERT INTO workflow_nodes
                (workflow_id, node_type, agent_id, config, pos_x, pos_y, drawflow_node_id)
                VALUES (:workflow_id, :node_type, :agent_id, :config, :pos_x, :pos_y, :drawflow_node_id)";

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'workflow_id' => $workflowId,
            'node_type' => $nodeType,
            'agent_id' => $agentId,
            'config' => json_encode($config),
            'pos_x' => (int) ($nodeData['pos_x'] ?? $nodeData['position']['x'] ?? 0),
            'pos_y' => (int) ($nodeData['pos_y'] ?? $nodeData['position']['y'] ?? 0),
            'drawflow_node_id' => $drawflowNodeId
        ]);

        return (int) $this->db->lastInsertId();
    }

    /**
     * Update a node
     */
    public function updateNode(int $nodeId, array $nodeData): bool
    {
        // Determine node type - check multiple sources
        $nodeType = $nodeData['node_type'] ?? $nodeData['type'] ?? $nodeData['config']['type'] ?? 'agent';

        if ($nodeType === 'condition' || $nodeType === 'switch') {
            throw new \InvalidArgumentException("Node type '{$nodeType}' is no longer supported. Use an agent with branching logic instead.");
        }

        // Ensure type is also stored in config for redundancy
        $config = $nodeData['config'] ?? $nodeData['data'] ?? [];
        if (!isset($config['type'])) {
            $config['type'] = $nodeType;
        }

        // Validate agent_id: must be null or a valid integer (foreign key constraint)
        // Strings like "node_3" are not valid - treat them as null
        $agentId = $nodeData['agent_id'] ?? null;
        if ($agentId !== null && !is_numeric($agentId)) {
            $agentId = null;  // Invalid agent_id, use null instead
        }
        $agentId = $agentId !== null ? (int) $agentId : null;

        $sql = "UPDATE workflow_nodes SET
                node_type = :node_type,
                agent_id = :agent_id,
                config = :config,
                pos_x = :pos_x,
                pos_y = :pos_y
                WHERE id = :id";

        $stmt = $this->db->prepare($sql);
        return $stmt->execute([
            'id' => $nodeId,
            'node_type' => $nodeType,
            'agent_id' => $agentId,
            'config' => json_encode($config),
            'pos_x' => (int) ($nodeData['pos_x'] ?? $nodeData['position']['x'] ?? 0),
            'pos_y' => (int) ($nodeData['pos_y'] ?? $nodeData['position']['y'] ?? 0)
        ]);
    }

    /**
     * Delete a node
     */
    public function deleteNode(int $nodeId): bool
    {
        $stmt = $this->db->prepare("DELETE FROM workflow_nodes WHERE id = ?");
        return $stmt->execute([$nodeId]);
    }

    /**
     * Create an edge between nodes
     */
    public function createEdge(int $workflowId, array $edgeData): int
    {
        $sql = "INSERT INTO workflow_edges
                (workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr)
                VALUES (:workflow_id, :from_node_id, :to_node_id, :from_port, :to_port, :condition_expr)";

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            'workflow_id' => $workflowId,
            'from_node_id' => (int) $edgeData['from_node_id'],
            'to_node_id' => (int) $edgeData['to_node_id'],
            'from_port' => $edgeData['from_port'] ?? 'output_1',
            'to_port' => $edgeData['to_port'] ?? 'input_1',
            'condition_expr' => $edgeData['condition_expr'] ?? null
        ]);

        return (int) $this->db->lastInsertId();
    }

    /**
     * Delete an edge
     */
    public function deleteEdge(int $edgeId): bool
    {
        $stmt = $this->db->prepare("DELETE FROM workflow_edges WHERE id = ?");
        return $stmt->execute([$edgeId]);
    }

    /**
     * Delete all nodes and edges for a workflow
     */
    public function clearGraph(int $workflowId): bool
    {
        // Edges will be deleted by CASCADE, but let's be explicit
        $this->db->prepare("DELETE FROM workflow_edges WHERE workflow_id = ?")->execute([$workflowId]);
        $this->db->prepare("DELETE FROM workflow_nodes WHERE workflow_id = ?")->execute([$workflowId]);
        return true;
    }

    /**
     * Save complete graph (replaces all nodes and edges)
     *
     * @param int $workflowId The workflow ID
     * @param array $nodes Array of node data from frontend
     * @param array $edges Array of edge data from frontend
     * @return array Map of temporary IDs to database IDs
     */
    public function saveGraph(int $workflowId, array $nodes, array $edges): array
    {
        // Start transaction
        $this->db->beginTransaction();

        try {
            // Clear existing graph
            $this->clearGraph($workflowId);

            // Insert nodes and track ID mapping (temp_id => db_id)
            $nodeIdMap = [];

            foreach ($nodes as $node) {
                // The frontend uses string IDs like "1", "2", etc.
                $tempId = $node['id'] ?? null;
                $dbId = $this->createNode($workflowId, $node);

                if ($tempId !== null) {
                    $nodeIdMap[(string)$tempId] = $dbId;
                }
            }

            // Insert edges with mapped node IDs
            foreach ($edges as $edge) {
                $fromTempId = (string)($edge['from'] ?? $edge['from_node_id']);
                $toTempId = (string)($edge['to'] ?? $edge['to_node_id']);

                // Map temp IDs to actual database IDs
                $fromDbId = $nodeIdMap[$fromTempId] ?? null;
                $toDbId = $nodeIdMap[$toTempId] ?? null;

                if ($fromDbId && $toDbId) {
                    $this->createEdge($workflowId, [
                        'from_node_id' => $fromDbId,
                        'to_node_id' => $toDbId,
                        'from_port' => $edge['from_port'] ?? 'output_1',
                        'to_port' => $edge['to_port'] ?? 'input_1',
                        'condition_expr' => $edge['condition_expr'] ?? $edge['condition'] ?? null
                    ]);
                }
            }

            $this->db->commit();
            return $nodeIdMap;

        } catch (\Exception $e) {
            $this->db->rollBack();
            throw $e;
        }
    }

    /**
     * Get graph in frontend format (Drawflow compatible)
     */
    public function getGraphForFrontend(int $workflowId): array
    {
        $nodes = $this->getNodes($workflowId);
        $edges = $this->getEdges($workflowId);

        // Convert to frontend format
        $frontendNodes = [];
        foreach ($nodes as $node) {
            // Get type from node_type column, or from config, defaulting to 'agent'
            $nodeType = $node['node_type'] ?? $node['config']['type'] ?? 'agent';

            // Ensure type is also in config for redundancy
            $config = $node['config'] ?? [];
            if (!isset($config['type'])) {
                $config['type'] = $nodeType;
            }

            $frontendNodes[] = [
                'id' => (string) $node['id'],
                'type' => $nodeType,
                'agent_id' => $node['agent_id'],
                'config' => $config,
                'position' => [
                    'x' => (int) $node['pos_x'],
                    'y' => (int) $node['pos_y']
                ]
            ];
        }

        $frontendEdges = [];
        foreach ($edges as $edge) {
            $frontendEdges[] = [
                'id' => (string) $edge['id'],
                'from' => (string) $edge['from_node_id'],
                'to' => (string) $edge['to_node_id'],
                'from_port' => $edge['from_port'],
                'to_port' => $edge['to_port'],
                'condition' => $edge['condition_expr']
            ];
        }

        return [
            'nodes' => $frontendNodes,
            'edges' => $frontendEdges
        ];
    }

    /**
     * Find start node for a workflow
     */
    public function findStartNode(int $workflowId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'start' LIMIT 1"
        );
        $stmt->execute([$workflowId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            $row['config'] = $row['config'] ? json_decode($row['config'], true) : [];
        }

        return $row ?: null;
    }

    /**
     * Find output nodes for a workflow
     */
    public function findOutputNodes(int $workflowId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'output'"
        );
        $stmt->execute([$workflowId]);

        return array_map(function($row) {
            $row['config'] = $row['config'] ? json_decode($row['config'], true) : [];
            return $row;
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Get edges from a specific node
     */
    public function getOutgoingEdges(int $nodeId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_edges WHERE from_node_id = ?"
        );
        $stmt->execute([$nodeId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Get edges to a specific node
     */
    public function getIncomingEdges(int $nodeId): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM workflow_edges WHERE to_node_id = ?"
        );
        $stmt->execute([$nodeId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Get a node by ID
     */
    public function getNode(int $nodeId): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM workflow_nodes WHERE id = ?");
        $stmt->execute([$nodeId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row) {
            $row['config'] = $row['config'] ? json_decode($row['config'], true) : [];
        }

        return $row ?: null;
    }

    /**
     * Get next nodes (following outgoing edges)
     */
    public function getNextNodes(int $nodeId): array
    {
        $stmt = $this->db->prepare(
            "SELECT n.*, e.condition_expr, e.from_port, e.to_port
             FROM workflow_nodes n
             INNER JOIN workflow_edges e ON n.id = e.to_node_id
             WHERE e.from_node_id = ?
             ORDER BY n.id"
        );
        $stmt->execute([$nodeId]);

        return array_map(function($row) {
            $row['config'] = $row['config'] ? json_decode($row['config'], true) : [];
            return $row;
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Validate graph structure
     */
    public function validateGraph(int $workflowId): array
    {
        $errors = [];
        $nodes = $this->getNodes($workflowId);
        $edges = $this->getEdges($workflowId);

        error_log("[validateGraph] Workflow $workflowId: " . count($nodes) . " nodes, " . count($edges) . " edges");
        error_log("[validateGraph] Nodes: " . json_encode(array_map(fn($n) => ['id' => $n['id'], 'type' => $n['node_type']], $nodes)));
        error_log("[validateGraph] Edges: " . json_encode($edges));

        // Check for start node
        $startNodes = array_filter($nodes, fn($n) => $n['node_type'] === 'start');
        if (count($startNodes) === 0) {
            $errors[] = 'Workflow must have a Start node';
        } elseif (count($startNodes) > 1) {
            $errors[] = 'Workflow can only have one Start node';
        }

        // Check for output node
        $outputNodes = array_filter($nodes, fn($n) => $n['node_type'] === 'output');
        if (count($outputNodes) === 0) {
            $errors[] = 'Workflow must have at least one Output node';
        }

        // Check for disconnected nodes (no incoming or outgoing edges)
        $nodeIds = array_column($nodes, 'id');
        $connectedNodes = [];
        foreach ($edges as $edge) {
            $connectedNodes[$edge['from_node_id']] = true;
            $connectedNodes[$edge['to_node_id']] = true;
        }

        foreach ($nodes as $node) {
            // Start nodes don't need incoming edges
            if ($node['node_type'] === 'start') {
                if (!isset($connectedNodes[$node['id']]) || count(array_filter($edges, fn($e) => $e['from_node_id'] == $node['id'])) === 0) {
                    $errors[] = 'Start node must be connected to at least one other node';
                }
                continue;
            }

            // Output nodes don't need outgoing edges
            if ($node['node_type'] === 'output') {
                if (!isset($connectedNodes[$node['id']]) || count(array_filter($edges, fn($e) => $e['to_node_id'] == $node['id'])) === 0) {
                    $errors[] = 'Output node must have at least one incoming connection';
                }
                continue;
            }

            // Other nodes should have both
            if (!isset($connectedNodes[$node['id']])) {
                $errors[] = "Node '{$node['node_type']}' (ID: {$node['id']}) is not connected";
            }
        }

        return $errors;
    }
}
