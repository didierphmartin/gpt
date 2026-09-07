"""Port of backend/src/AgentTeam/Services/WorkflowGraphRepository.php (524 lines).

Handles CRUD operations for workflow nodes and edges (graph structure).
Works alongside WorkflowRepository for the parent workflow entity.
"""
from __future__ import annotations

import time

import pymysql

from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_bool, php_empty, php_intval
from app.support.phpjson import php_json_decode, php_json_encode

_TRANSIENT_LOCK_CODES = (1205, 1213)


def _decode_config(raw) -> list | dict | None:
    """`$row['config'] ? json_decode($row['config'], true) : []` — mirrored at
    every getNodes/getNode/findStartNode/findOutputNodes/getNextNodes site."""
    if php_bool(raw):
        decoded = php_json_decode(raw)
        return decoded if decoded is not None else None
    return []


class WorkflowGraphRepository:
    def __init__(self, db):
        self.db = db

    def findRealtimeWorkflowIds(self, workflow_ids: list) -> list[int]:
        """PHP 32-45. Batch-detect which workflows contain realtime-* nodes."""
        if php_empty(workflow_ids):
            return []
        ids = [i for i in (php_intval(w) for w in workflow_ids) if not php_empty(i)]
        if php_empty(ids):
            return []
        placeholders = ','.join(['?'] * len(ids))
        sql = (
            "SELECT DISTINCT workflow_id FROM workflow_nodes\n"
            "             WHERE workflow_id IN ({placeholders})\n"
            "               AND node_type LIKE 'realtime-%'"
        ).format(placeholders=placeholders)
        rows = self.db.fetch_all(sql, ids)
        return [php_intval(row['workflow_id']) for row in rows]

    def getNodes(self, workflow_id: int) -> list[dict]:
        """PHP 50-61."""
        rows = self.db.fetch_all(
            "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id", [workflow_id]
        )
        result = []
        for row in rows:
            row = dict(row)
            row['config'] = _decode_config(row.get('config'))
            result.append(row)
        return result

    def getEdges(self, workflow_id: int) -> list[dict]:
        """PHP 66-73."""
        return self.db.fetch_all(
            "SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id", [workflow_id]
        )

    def getGraph(self, workflow_id: int) -> dict:
        """PHP 78-84."""
        return {
            'nodes': self.getNodes(workflow_id),
            'edges': self.getEdges(workflow_id),
        }

    def createNode(self, workflow_id: int, node_data: dict) -> int:
        """PHP 90-132."""
        # Get drawflow node ID (the frontend Drawflow ID)
        drawflow_node_id = node_data.get('id')
        if drawflow_node_id is None:
            drawflow_node_id = node_data.get('drawflow_node_id')

        # Determine node type - check multiple sources
        node_type = self._resolveNodeType(node_data)

        if node_type == 'condition' or node_type == 'switch':
            raise ValueError(
                f"Node type '{node_type}' is no longer supported. Use an agent with branching logic instead."
            )

        # Ensure type is also stored in config for redundancy
        config = self._resolveConfig(node_data, node_type)

        # Validate agent_id: must be null or a valid integer (foreign key constraint)
        # Strings like "node_3" are not valid - treat them as null
        agent_id = self._resolveAgentId(node_data)

        sql = (
            "INSERT INTO workflow_nodes\n"
            "                (workflow_id, node_type, agent_id, config, pos_x, pos_y, drawflow_node_id)\n"
            "                VALUES (:workflow_id, :node_type, :agent_id, :config, :pos_x, :pos_y, :drawflow_node_id)"
        )

        return self.db.insert(sql, {
            'workflow_id': workflow_id,
            'node_type': node_type,
            'agent_id': agent_id,
            'config': php_json_encode(config),
            'pos_x': self._resolvePos(node_data, 'pos_x', 'x'),
            'pos_y': self._resolvePos(node_data, 'pos_y', 'y'),
            'drawflow_node_id': drawflow_node_id,
        })

    def updateNode(self, node_id: int, node_data: dict) -> bool:
        """PHP 137-177."""
        node_type = self._resolveNodeType(node_data)

        if node_type == 'condition' or node_type == 'switch':
            raise ValueError(
                f"Node type '{node_type}' is no longer supported. Use an agent with branching logic instead."
            )

        config = self._resolveConfig(node_data, node_type)
        agent_id = self._resolveAgentId(node_data)

        sql = (
            "UPDATE workflow_nodes SET\n"
            "                node_type = :node_type,\n"
            "                agent_id = :agent_id,\n"
            "                config = :config,\n"
            "                pos_x = :pos_x,\n"
            "                pos_y = :pos_y\n"
            "                WHERE id = :id"
        )

        self.db.execute(sql, {
            'id': node_id,
            'node_type': node_type,
            'agent_id': agent_id,
            'config': php_json_encode(config),
            'pos_x': self._resolvePos(node_data, 'pos_x', 'x'),
            'pos_y': self._resolvePos(node_data, 'pos_y', 'y'),
        })
        return True

    @staticmethod
    def _resolveNodeType(node_data: dict) -> str:
        node_type = node_data.get('node_type')
        if node_type is None:
            node_type = node_data.get('type')
        if node_type is None:
            config = node_data.get('config')
            node_type = config.get('type') if isinstance(config, dict) else None
        return node_type if node_type is not None else 'agent'

    @staticmethod
    def _resolveConfig(node_data: dict, node_type: str) -> dict:
        config = node_data.get('config')
        if config is None:
            config = node_data.get('data')
        if config is None:
            config = {}
        if not isinstance(config, dict):
            config = {}
        if config.get('type') is None:
            config = dict(config)
            config['type'] = node_type
        return config

    @staticmethod
    def _resolveAgentId(node_data: dict) -> int | None:
        agent_id = node_data.get('agent_id')
        if agent_id is not None and not is_numeric(agent_id):
            agent_id = None  # Invalid agent_id, use null instead
        return php_intval(agent_id) if agent_id is not None else None

    @staticmethod
    def _resolvePos(node_data: dict, key: str, axis: str) -> int:
        value = node_data.get(key)
        if value is None:
            position = node_data.get('position')
            value = position.get(axis) if isinstance(position, dict) else None
        if value is None:
            value = 0
        return php_intval(value)

    def deleteNode(self, node_id: int) -> bool:
        """PHP 182-186."""
        self.db.execute("DELETE FROM workflow_nodes WHERE id = ?", [node_id])
        return True

    def createEdge(self, workflow_id: int, edge_data: dict) -> int:
        """PHP 191-208."""
        sql = (
            "INSERT INTO workflow_edges\n"
            "                (workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr)\n"
            "                VALUES (:workflow_id, :from_node_id, :to_node_id, :from_port, :to_port, :condition_expr)"
        )

        from_port = edge_data.get('from_port')
        to_port = edge_data.get('to_port')

        return self.db.insert(sql, {
            'workflow_id': workflow_id,
            'from_node_id': php_intval(edge_data['from_node_id']),
            'to_node_id': php_intval(edge_data['to_node_id']),
            'from_port': from_port if from_port is not None else 'output_1',
            'to_port': to_port if to_port is not None else 'input_1',
            'condition_expr': edge_data.get('condition_expr'),
        })

    def deleteEdge(self, edge_id: int) -> bool:
        """PHP 213-217."""
        self.db.execute("DELETE FROM workflow_edges WHERE id = ?", [edge_id])
        return True

    def clearGraph(self, workflow_id: int) -> bool:
        """PHP 222-228. Edges are also removed by CASCADE, but this is explicit."""
        self.db.execute("DELETE FROM workflow_edges WHERE workflow_id = ?", [workflow_id])
        self.db.execute("DELETE FROM workflow_nodes WHERE workflow_id = ?", [workflow_id])
        return True

    def saveGraph(self, workflow_id: int, nodes: list, edges: list) -> dict:
        """PHP 238-254. Retry on transient InnoDB lock errors (deadlock /
        lock-wait). Concurrent saves of the same workflow (manual Save + the
        debounced auto-save) can deadlock on the clearGraph DELETE + node
        INSERTs. These are transient by nature -- the loser retries."""
        attempt = 1
        while True:
            try:
                return self.saveGraphOnce(workflow_id, nodes, edges)
            except pymysql.err.OperationalError as e:
                if attempt < 5 and self._isTransientLockError(e):
                    time.sleep(0.05 * attempt)  # 50ms, 100ms, 150ms, 200ms backoff
                    attempt += 1
                    continue
                raise

    @staticmethod
    def _isTransientLockError(e: BaseException) -> bool:
        """PHP 257-265 (SQLSTATE 40001 = serialization failure / deadlock;
        1213 = deadlock; 1205 = lock-wait timeout). PyMySQL's OperationalError
        carries the MySQL error number as args[0] (constraints.md) rather than
        embedding it in a PDO-style message string, so the code is compared
        directly instead of via strpos() on the message."""
        code = e.args[0] if getattr(e, 'args', None) else None
        message = str(e.args[1]) if len(getattr(e, 'args', ()) or ()) > 1 else str(e)
        message_lower = message.lower()
        return (
            code in _TRANSIENT_LOCK_CODES
            or 'deadlock' in message_lower
            or 'lock wait timeout' in message_lower
        )

    def saveGraphOnce(self, workflow_id: int, nodes: list, edges: list) -> dict:
        """PHP 267-318."""
        # Start transaction
        self.db.begin()

        try:
            # Clear existing graph
            self.clearGraph(workflow_id)

            # Insert nodes and track ID mapping (temp_id => db_id)
            node_id_map: dict = {}

            for node in nodes:
                # The frontend uses string IDs like "1", "2", etc.
                temp_id = node.get('id')
                db_id = self.createNode(workflow_id, node)

                if temp_id is not None:
                    node_id_map[str(temp_id)] = db_id

            # Insert edges with mapped node IDs
            for edge in edges:
                from_val = edge.get('from')
                from_temp_id = str(from_val if from_val is not None else edge.get('from_node_id'))
                to_val = edge.get('to')
                to_temp_id = str(to_val if to_val is not None else edge.get('to_node_id'))

                # Map temp IDs to actual database IDs
                from_db_id = node_id_map.get(from_temp_id)
                to_db_id = node_id_map.get(to_temp_id)

                if from_db_id and to_db_id:
                    condition_expr = edge.get('condition_expr')
                    if condition_expr is None:
                        condition_expr = edge.get('condition')
                    from_port = edge.get('from_port')
                    to_port = edge.get('to_port')
                    self.createEdge(workflow_id, {
                        'from_node_id': from_db_id,
                        'to_node_id': to_db_id,
                        'from_port': from_port if from_port is not None else 'output_1',
                        'to_port': to_port if to_port is not None else 'input_1',
                        'condition_expr': condition_expr,
                    })

            self.db.commit()
            return node_id_map

        except Exception:
            self.db.rollback()
            raise

    def getGraphForFrontend(self, workflow_id: int) -> dict:
        """PHP 323-368. Convert to frontend (Drawflow-compatible) format."""
        nodes = self.getNodes(workflow_id)
        edges = self.getEdges(workflow_id)

        frontend_nodes = []
        for node in nodes:
            # Get type from node_type column, or from config, defaulting to 'agent'
            node_type = node.get('node_type')
            config = node.get('config') if node.get('config') is not None else {}
            if node_type is None:
                node_type = config.get('type') if isinstance(config, dict) else None
            if node_type is None:
                node_type = 'agent'

            # Ensure type is also in config for redundancy
            if isinstance(config, dict) and config.get('type') is None:
                config = dict(config)
                config['type'] = node_type

            frontend_nodes.append({
                'id': str(node['id']),
                'type': node_type,
                'agent_id': node.get('agent_id'),
                'config': config,
                'position': {
                    'x': php_intval(node.get('pos_x')),
                    'y': php_intval(node.get('pos_y')),
                },
            })

        frontend_edges = []
        for edge in edges:
            frontend_edges.append({
                'id': str(edge['id']),
                'from': str(edge['from_node_id']),
                'to': str(edge['to_node_id']),
                'from_port': edge.get('from_port'),
                'to_port': edge.get('to_port'),
                'condition': edge.get('condition_expr'),
            })

        return {
            'nodes': frontend_nodes,
            'edges': frontend_edges,
        }

    def findStartNode(self, workflow_id: int) -> dict | None:
        """PHP 373-386."""
        row = self.db.fetch_one(
            "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'start' LIMIT 1",
            [workflow_id],
        )
        if row:
            row = dict(row)
            row['config'] = _decode_config(row.get('config'))
        return row if row else None

    def findOutputNodes(self, workflow_id: int) -> list[dict]:
        """PHP 391-402."""
        rows = self.db.fetch_all(
            "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'output'",
            [workflow_id],
        )
        result = []
        for row in rows:
            row = dict(row)
            row['config'] = _decode_config(row.get('config'))
            result.append(row)
        return result

    def getOutgoingEdges(self, node_id: int) -> list[dict]:
        """PHP 407-414."""
        return self.db.fetch_all(
            "SELECT * FROM workflow_edges WHERE from_node_id = ?", [node_id]
        )

    def getIncomingEdges(self, node_id: int) -> list[dict]:
        """PHP 419-426."""
        return self.db.fetch_all(
            "SELECT * FROM workflow_edges WHERE to_node_id = ?", [node_id]
        )

    def getNode(self, node_id: int) -> dict | None:
        """PHP 431-442."""
        row = self.db.fetch_one("SELECT * FROM workflow_nodes WHERE id = ?", [node_id])
        if row:
            row = dict(row)
            row['config'] = _decode_config(row.get('config'))
        return row if row else None

    def getNextNodes(self, node_id: int) -> list[dict]:
        """PHP 447-462."""
        rows = self.db.fetch_all(
            "SELECT n.*, e.condition_expr, e.from_port, e.to_port\n"
            "             FROM workflow_nodes n\n"
            "             INNER JOIN workflow_edges e ON n.id = e.to_node_id\n"
            "             WHERE e.from_node_id = ?\n"
            "             ORDER BY n.id",
            [node_id],
        )
        result = []
        for row in rows:
            row = dict(row)
            row['config'] = _decode_config(row.get('config'))
            result.append(row)
        return result

    def validateGraph(self, workflow_id: int) -> list[str]:
        """PHP 467-523."""
        errors: list[str] = []
        nodes = self.getNodes(workflow_id)
        edges = self.getEdges(workflow_id)

        error_log(f"[validateGraph] Workflow {workflow_id}: {len(nodes)} nodes, {len(edges)} edges")
        error_log(
            "[validateGraph] Nodes: "
            + php_json_encode([{'id': n.get('id'), 'type': n.get('node_type')} for n in nodes])
        )
        error_log("[validateGraph] Edges: " + php_json_encode(edges))

        # Check for start node
        start_nodes = [n for n in nodes if n.get('node_type') == 'start']
        if len(start_nodes) == 0:
            errors.append('Workflow must have a Start node')
        elif len(start_nodes) > 1:
            errors.append('Workflow can only have one Start node')

        # Check for output node
        output_nodes = [n for n in nodes if n.get('node_type') == 'output']
        if len(output_nodes) == 0:
            errors.append('Workflow must have at least one Output node')

        # Check for disconnected nodes (no incoming or outgoing edges)
        connected_nodes: dict = {}
        for edge in edges:
            connected_nodes[edge['from_node_id']] = True
            connected_nodes[edge['to_node_id']] = True

        for node in nodes:
            node_id = node.get('id')

            # Start nodes don't need incoming edges
            if node.get('node_type') == 'start':
                has_outgoing = len([e for e in edges if e['from_node_id'] == node_id]) > 0
                if node_id not in connected_nodes or not has_outgoing:
                    errors.append('Start node must be connected to at least one other node')
                continue

            # Output nodes don't need outgoing edges
            if node.get('node_type') == 'output':
                has_incoming = len([e for e in edges if e['to_node_id'] == node_id]) > 0
                if node_id not in connected_nodes or not has_incoming:
                    errors.append('Output node must have at least one incoming connection')
                continue

            # Other nodes should have both
            if node_id not in connected_nodes:
                errors.append(f"Node '{node.get('node_type')}' (ID: {node_id}) is not connected")

        return errors
