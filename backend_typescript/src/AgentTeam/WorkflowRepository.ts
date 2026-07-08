import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Faithful mirror of:
 *  - src/AgentTeam/Models/Workflow.php                  (hydrate / toArray / toApiArray / detectRuntimeMode / isScheduleEnabled / validateSteps)
 *  - src/AgentTeam/Services/WorkflowRepository.php      (data access used by the ported endpoints)
 *  - src/AgentTeam/Services/WorkflowGraphRepository.php (ONLY the read/save methods the ported
 *      controller slice touches: findRealtimeWorkflowIds, getNodes, getEdges, getGraphForFrontend,
 *      saveGraph + createNode/createEdge/clearGraph). The runner/validation methods are NOT ported.)
 *  - the agent_workflow_executions DB read backing WorkflowRunner::getExecutionHistory (the runner
 *      itself — WorkflowRunner — is NOT ported; only its plain SELECT is mirrored here).
 *
 * Tables (all in the contexts DB pool): agent_workflows, workflow_nodes, workflow_edges,
 * agent_workflow_executions. Runtime DDL is NOT replicated — the schema already exists.
 *
 * The Workflow "model" is a mutable plain object (the PHP class has getters/setters the
 * controller mutates). Serialization helpers reproduce the PHP field maps exactly.
 */

export interface Workflow {
  id: number | null;
  userId: number;
  workspaceId: any; // ?int in PHP; hydrate casts, setters store raw
  name: string;
  description: string;
  steps: any; // array (or object) decoded from JSON
  triggers: any; // array (or object) decoded from JSON
  variables: any; // array (or object) decoded from JSON
  enabled: any; // bool after hydrate; setters may store raw
  createdAt: string | null;
  updatedAt: string | null;
  outputStorageEnabled: any;
  outputFolder: string | null;
  graph: any | null; // {nodes, edges} when loaded, else null
}

/** Mirrors PHP (int) cast (leading-integer parse, default 0). */
export function phpIntval(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Mirrors PHP empty() for the value kinds we deal with. */
export function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === 0) return true;
  if (v === '') return true;
  if (v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  // PHP empty() of an associative array is true only when it has no elements.
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

/** Mirrors PHP (bool) cast: false for false/0/0.0/''/'0'/[]/null; true otherwise. */
export function phpBool(v: any): boolean {
  if (v === undefined || v === null) return false;
  if (v === false) return false;
  if (v === 0) return false;
  if (v === '') return false;
  if (v === '0') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/** Mirrors PHP is_array() applied to a json_decode($input, true) body: JSON objects AND arrays both
 * become PHP arrays, so a JS plain object counts as "array" here too. */
export function phpIsArray(v: any): boolean {
  return v !== null && typeof v === 'object';
}

/** Mirrors PHP is_numeric() closely enough for agent_id validation. */
function phpIsNumeric(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return false;
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s);
}

/**
 * Mirrors Workflow::decodeJson() / WorkflowSchema::decodeJson(). PHP json_decode($s, true) maps
 * objects and arrays to PHP arrays; an empty object {} decodes to [] and re-encodes to [].
 */
export function decodeJson(value: any): any {
  if (typeof value === 'string') {
    if (value === '') return [];
    let decoded: any;
    try {
      decoded = JSON.parse(value);
    } catch {
      return [];
    }
    if (decoded === null || typeof decoded !== 'object') return [];
    if (!Array.isArray(decoded) && Object.keys(decoded).length === 0) return [];
    return decoded;
  }
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return value;
  return [];
}

/** Mirrors WorkflowGraphRepository's raw `$row['config'] ? json_decode($row['config'], true) : []`. */
function decodeNodeConfig(value: any): any {
  if (!value) return []; // PHP truthiness: '', '0', null, 0 → []
  // mysql2 auto-parses MySQL `json` columns into JS objects/arrays, whereas PHP/PDO hands
  // json_decode a raw string. Use the already-parsed value directly (parsing it again would throw).
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null; // PHP json_decode returns null on invalid; callers coalesce with ?? []
  }
}

/** Mirrors Workflow::hydrate(). */
export function hydrateWorkflow(data: any): Workflow {
  return {
    id: data.id !== undefined && data.id !== null ? phpIntval(data.id) : null,
    userId: data.user_id !== undefined && data.user_id !== null ? phpIntval(data.user_id) : 0,
    workspaceId:
      data.workspace_id !== undefined && data.workspace_id !== null ? phpIntval(data.workspace_id) : null,
    name: data.name ?? '',
    description: data.description ?? '',
    steps: decodeJson(data.steps ?? []),
    triggers: decodeJson(data.triggers ?? []),
    variables: decodeJson(data.variables ?? []),
    enabled: phpBool(data.enabled ?? true),
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
    outputStorageEnabled: phpBool(data.output_storage_enabled ?? false),
    outputFolder: data.output_folder ?? null,
    graph: null,
  };
}

/** Mirrors Workflow::detectRuntimeMode(). */
function detectRuntimeMode(w: Workflow): string {
  const nodes: any[] = (w.graph && w.graph.nodes) || [];
  for (const n of nodes) {
    const type = n?.type ?? n?.node_type ?? n?.config?.type ?? '';
    if (typeof type === 'string' && type.indexOf('realtime-') === 0) {
      return 'realtime';
    }
    if (n?.config?.runtime_mode === 'realtime') {
      return 'realtime';
    }
  }
  return 'batch';
}

/** Mirrors Workflow::isScheduleEnabled(): !empty($this->triggers['schedule']['enabled']). */
function isScheduleEnabled(w: Workflow): boolean {
  const t = w.triggers;
  const v = t && typeof t === 'object' && !Array.isArray(t) ? t.schedule?.enabled : undefined;
  return !phpEmpty(v);
}

/** Mirrors Workflow::toArray(). */
export function workflowToArray(w: Workflow): Record<string, any> {
  const data: Record<string, any> = {
    id: w.id,
    user_id: w.userId,
    workspace_id: w.workspaceId,
    name: w.name,
    description: w.description,
    steps: w.steps,
    triggers: w.triggers,
    variables: w.variables,
    enabled: w.enabled,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
    output_storage_enabled: w.outputStorageEnabled,
    output_folder: w.outputFolder,
  };
  if (w.graph !== null) {
    data.graph = w.graph;
  }
  return data;
}

/** Mirrors Workflow::toApiArray(). */
export function workflowToApiArray(w: Workflow): Record<string, any> {
  const data: Record<string, any> = {
    id: w.id,
    name: w.name,
    description: w.description,
    steps: w.steps,
    triggers: w.triggers,
    variables: w.variables,
    enabled: w.enabled,
    created_at: w.createdAt,
    output_storage_enabled: w.outputStorageEnabled,
    output_folder: w.outputFolder,
    schedule_enabled: isScheduleEnabled(w),
    runtime_mode: detectRuntimeMode(w),
  };
  if (w.graph !== null) {
    data.graph = w.graph;
  }
  return data;
}

/** Mirrors Workflow::validateSteps(). Returns array of error strings (empty = valid). */
export function validateSteps(steps: any): string[] {
  const errors: string[] = [];

  if (phpEmpty(steps)) {
    errors.push('Workflow must have at least one step');
    return errors;
  }

  // PHP foreach over the steps array; for a list the key is the numeric index.
  const entries: [any, any][] = Array.isArray(steps)
    ? steps.map((s, i) => [i, s] as [any, any])
    : Object.entries(steps);

  for (const [index, step] of entries) {
    if (phpEmpty(step?.id)) {
      errors.push(`Step ${index}: missing 'id'`);
    }
    if (phpEmpty(step?.type)) {
      errors.push(`Step ${index}: missing 'type'`);
    }
    if (!['agent', 'condition', 'transform'].includes(step?.type ?? '')) {
      errors.push(`Step ${index}: invalid type '${step?.type ?? ''}'`);
    }
  }

  return errors;
}

// =========================================================================
// Graph repository (read + save methods used by the ported controller slice)
// =========================================================================

/** Mirrors isTransientLockError(): detect MySQL deadlock and lock-wait errors.
 * SQLSTATE 40001 = serialization failure (deadlock); 1213 = deadlock; 1205 = lock-wait timeout. */
function isTransientLockError(err: Error): boolean {
  const msg = err.message ?? '';
  const code = (err as any).code ?? '';
  const errno = (err as any).errno ?? '';
  return (
    code === '40001' ||
    errno === 40001 ||
    msg.toLowerCase().includes('deadlock') ||
    msg.toLowerCase().includes('lock wait timeout') ||
    msg.includes('1213') ||
    msg.includes('1205')
  );
}

export class WorkflowGraphRepository {
  /** Mirrors findRealtimeWorkflowIds(): which of these workflows have a realtime-* node. */
  async findRealtimeWorkflowIds(workflowIds: number[]): Promise<number[]> {
    if (!workflowIds || workflowIds.length === 0) return [];
    const ids = workflowIds.map((v) => phpIntval(v)).filter((v) => v !== 0);
    if (ids.length === 0) return [];
    const rows = (
      await sql<{ workflow_id: any }>`
        SELECT DISTINCT workflow_id FROM workflow_nodes
        WHERE workflow_id IN (${sql.join(ids)})
          AND node_type LIKE 'realtime-%'`.execute(db)
    ).rows;
    return rows.map((r) => phpIntval(r.workflow_id));
  }

  /** Mirrors getNodes(): raw rows with `config` json-decoded. */
  async getNodes(workflowId: number): Promise<any[]> {
    const rows = (
      await sql<any>`SELECT * FROM workflow_nodes WHERE workflow_id = ${workflowId} ORDER BY id`.execute(db)
    ).rows;
    return rows.map((row) => {
      row.config = decodeNodeConfig(row.config);
      return row;
    });
  }

  /** Mirrors getNode(): a single node by id with `config` decoded (or [] when empty), else null. */
  async getNode(nodeId: number): Promise<any | null> {
    const row = (await sql<any>`SELECT * FROM workflow_nodes WHERE id = ${nodeId}`.execute(db)).rows[0];
    if (!row) return null;
    // mysql2 returns the json `config` column already parsed; PHP json_decodes it. `?: []` on empty.
    row.config = row.config ? decodeNodeConfig(row.config) : [];
    return row;
  }

  /** Mirrors updateNode(): rewrites node_type/agent_id/config/pos. Returns true on success. */
  async updateNode(nodeId: number, nodeData: any): Promise<boolean> {
    const nodeType = nodeData.node_type ?? nodeData.type ?? nodeData.config?.type ?? 'agent';
    if (nodeType === 'condition' || nodeType === 'switch') {
      throw new Error(`Node type '${nodeType}' is no longer supported. Use an agent with branching logic instead.`);
    }
    // Ensure type is stored in config too (redundancy), matching PHP.
    const config: any = nodeData.config ?? nodeData.data ?? {};
    if (config.type === undefined || config.type === null) config.type = nodeType;
    // agent_id must be null or a valid integer (FK); non-numeric strings like "node_3" → null.
    let agentId: any = nodeData.agent_id ?? null;
    if (agentId !== null && !phpIsNumeric(agentId)) agentId = null;
    agentId = agentId !== null ? phpIntval(agentId) : null;
    const res = await sql`
      UPDATE workflow_nodes SET node_type = ${nodeType}, agent_id = ${agentId}, config = ${JSON.stringify(config)},
             pos_x = ${phpIntval(nodeData.pos_x ?? nodeData.position?.x ?? 0)},
             pos_y = ${phpIntval(nodeData.pos_y ?? nodeData.position?.y ?? 0)}
      WHERE id = ${nodeId}`.execute(db);
    return Number(res.numAffectedRows ?? 0) >= 0;
  }

  /** Mirrors findStartNode(): the workflow's single start node (config decoded), or null. */
  async findStartNode(workflowId: number): Promise<any | null> {
    const row = (
      await sql<any>`SELECT * FROM workflow_nodes WHERE workflow_id = ${workflowId} AND node_type = 'start' LIMIT 1`.execute(
        db
      )
    ).rows[0];
    if (!row) return null;
    row.config = decodeNodeConfig(row.config);
    return row;
  }

  /**
   * Mirrors validateGraph(): structural validation run before a graph workflow executes.
   * Returns an array of error strings (empty = valid). The error-message wording matches PHP.
   */
  async validateGraph(workflowId: number): Promise<string[]> {
    const errors: string[] = [];
    const nodes = await this.getNodes(workflowId);
    const edges = await this.getEdges(workflowId);

    // Start node count
    const startNodes = nodes.filter((n) => n.node_type === 'start');
    if (startNodes.length === 0) {
      errors.push('Workflow must have a Start node');
    } else if (startNodes.length > 1) {
      errors.push('Workflow can only have one Start node');
    }

    // Output node presence
    const outputNodes = nodes.filter((n) => n.node_type === 'output');
    if (outputNodes.length === 0) {
      errors.push('Workflow must have at least one Output node');
    }

    // Disconnected-node checks. PHP uses loose `==` on from/to ids — replicate with phpIntval.
    const connectedNodes: Record<string, boolean> = {};
    for (const edge of edges) {
      connectedNodes[String(edge.from_node_id)] = true;
      connectedNodes[String(edge.to_node_id)] = true;
    }

    for (const node of nodes) {
      const nid = phpIntval(node.id);

      if (node.node_type === 'start') {
        const hasOutgoing = edges.some((e) => phpIntval(e.from_node_id) === nid);
        if (connectedNodes[String(node.id)] === undefined || !hasOutgoing) {
          errors.push('Start node must be connected to at least one other node');
        }
        continue;
      }

      if (node.node_type === 'output') {
        const hasIncoming = edges.some((e) => phpIntval(e.to_node_id) === nid);
        if (connectedNodes[String(node.id)] === undefined || !hasIncoming) {
          errors.push('Output node must have at least one incoming connection');
        }
        continue;
      }

      if (connectedNodes[String(node.id)] === undefined) {
        errors.push(`Node '${node.node_type}' (ID: ${node.id}) is not connected`);
      }
    }

    return errors;
  }

  /** Mirrors getEdges(): raw rows. */
  async getEdges(workflowId: number): Promise<any[]> {
    return (
      await sql<any>`SELECT * FROM workflow_edges WHERE workflow_id = ${workflowId} ORDER BY id`.execute(db)
    ).rows;
  }

  /** Mirrors getGraph(): raw nodes (config decoded) + raw edges. Used by LangGraphGenerator. */
  async getGraph(workflowId: number): Promise<{ nodes: any[]; edges: any[] }> {
    return {
      nodes: await this.getNodes(workflowId),
      edges: await this.getEdges(workflowId),
    };
  }

  /** Mirrors getGraphForFrontend(): Drawflow-compatible nodes/edges. */
  async getGraphForFrontend(workflowId: number): Promise<{ nodes: any[]; edges: any[] }> {
    const nodes = await this.getNodes(workflowId);
    const edges = await this.getEdges(workflowId);

    const frontendNodes: any[] = [];
    for (const node of nodes) {
      const nodeType = node.node_type ?? node.config?.type ?? 'agent';

      let config: any = node.config ?? [];
      if (config === null || typeof config !== 'object') config = [];
      if (config.type === undefined || config.type === null) {
        config.type = nodeType;
      }

      frontendNodes.push({
        id: String(node.id),
        type: nodeType,
        agent_id: node.agent_id,
        config,
        position: {
          x: phpIntval(node.pos_x),
          y: phpIntval(node.pos_y),
        },
      });
    }

    const frontendEdges: any[] = [];
    for (const edge of edges) {
      frontendEdges.push({
        id: String(edge.id),
        from: String(edge.from_node_id),
        to: String(edge.to_node_id),
        from_port: edge.from_port,
        to_port: edge.to_port,
        condition: edge.condition_expr,
      });
    }

    return { nodes: frontendNodes, edges: frontendEdges };
  }

  /** Mirrors createNode(). Returns the new node ID. Throws on condition/switch types. */
  private async createNode(trx: any, workflowId: number, nodeData: any): Promise<number> {
    const drawflowNodeId = nodeData.id ?? nodeData.drawflow_node_id ?? null;

    const nodeType = nodeData.node_type ?? nodeData.type ?? nodeData.config?.type ?? 'agent';
    if (nodeType === 'condition' || nodeType === 'switch') {
      throw new Error(
        `Node type '${nodeType}' is no longer supported. Use an agent with branching logic instead.`
      );
    }

    let config: any = nodeData.config ?? nodeData.data ?? {};
    if (config === null || typeof config !== 'object') config = {};
    if (config.type === undefined || config.type === null) {
      config.type = nodeType;
    }

    let agentId: any = nodeData.agent_id ?? null;
    if (agentId !== null && !phpIsNumeric(agentId)) {
      agentId = null;
    }
    agentId = agentId !== null ? phpIntval(agentId) : null;

    const posX = phpIntval(nodeData.pos_x ?? nodeData.position?.x ?? 0);
    const posY = phpIntval(nodeData.pos_y ?? nodeData.position?.y ?? 0);

    const res = await sql`
      INSERT INTO workflow_nodes
        (workflow_id, node_type, agent_id, config, pos_x, pos_y, drawflow_node_id)
      VALUES
        (${workflowId}, ${nodeType}, ${agentId}, ${JSON.stringify(config)}, ${posX}, ${posY}, ${drawflowNodeId})
    `.execute(trx);

    return Number(res.insertId);
  }

  /** Mirrors createEdge(). */
  private async createEdge(trx: any, workflowId: number, edgeData: any): Promise<void> {
    await sql`
      INSERT INTO workflow_edges
        (workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr)
      VALUES
        (${workflowId}, ${phpIntval(edgeData.from_node_id)}, ${phpIntval(edgeData.to_node_id)},
         ${edgeData.from_port ?? 'output_1'}, ${edgeData.to_port ?? 'input_1'}, ${edgeData.condition_expr ?? null})
    `.execute(trx);
  }

  /** Mirrors saveGraph(): replace all nodes/edges in a transaction.
   * Retries on transient InnoDB lock errors (deadlock / lock-wait) with backoff. */
  async saveGraph(workflowId: number, nodes: any[], edges: any[]): Promise<Record<string, number>> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await db.transaction().execute(async (trx) => {
          // clearGraph: edges then nodes
          await sql`DELETE FROM workflow_edges WHERE workflow_id = ${workflowId}`.execute(trx);
          await sql`DELETE FROM workflow_nodes WHERE workflow_id = ${workflowId}`.execute(trx);

          const nodeIdMap: Record<string, number> = {};

          for (const node of nodes ?? []) {
            const tempId = node?.id ?? null;
            const dbId = await this.createNode(trx, workflowId, node);
            if (tempId !== null) {
              nodeIdMap[String(tempId)] = dbId;
            }
          }

          for (const edge of edges ?? []) {
            const fromTempId = String(edge?.from ?? edge?.from_node_id);
            const toTempId = String(edge?.to ?? edge?.to_node_id);

            const fromDbId = nodeIdMap[fromTempId] ?? null;
            const toDbId = nodeIdMap[toTempId] ?? null;

            if (fromDbId && toDbId) {
              await this.createEdge(trx, workflowId, {
                from_node_id: fromDbId,
                to_node_id: toDbId,
                from_port: edge?.from_port ?? 'output_1',
                to_port: edge?.to_port ?? 'input_1',
                condition_expr: edge?.condition_expr ?? edge?.condition ?? null,
              });
            }
          }

          return nodeIdMap;
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 5 && isTransientLockError(lastError)) {
          // Backoff: 50ms, 100ms, 150ms, 200ms (matching PHP usleep(50000 * $attempt))
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error('saveGraph: exhausted retry attempts');
  }
}

// =========================================================================
// Workflow repository
// =========================================================================

export class WorkflowRepository {
  readonly graphRepository = new WorkflowGraphRepository();

  /** Find a workflow by ID, optionally loading graph data. */
  async findById(id: number, includeGraph = false): Promise<Workflow | null> {
    const row = (await sql<any>`SELECT * FROM agent_workflows WHERE id = ${id}`.execute(db)).rows[0];
    if (!row) return null;

    const workflow = hydrateWorkflow(row);
    if (includeGraph) {
      workflow.graph = await this.graphRepository.getGraphForFrontend(id);
    }
    return workflow;
  }

  /** Find all workflows for a user, optionally loading graph data per workflow. */
  async findByUser(userId: number, includeGraph = false): Promise<Workflow[]> {
    const rows = (
      await sql<any>`SELECT * FROM agent_workflows WHERE user_id = ${userId} ORDER BY name ASC`.execute(db)
    ).rows;

    const result: Workflow[] = [];
    for (const row of rows) {
      const workflow = hydrateWorkflow(row);
      if (includeGraph) {
        workflow.graph = await this.graphRepository.getGraphForFrontend(workflow.id as number);
      }
      result.push(workflow);
    }
    return result;
  }

  /** Create a new workflow (metadata only). */
  async create(workflow: Workflow): Promise<Workflow> {
    const data = workflowToArray(workflow);
    const res = await sql`
      INSERT INTO agent_workflows
        (user_id, workspace_id, name, description, steps, triggers, variables, enabled, output_storage_enabled, output_folder)
      VALUES
        (${data.user_id}, ${data.workspace_id}, ${data.name}, ${data.description},
         ${JSON.stringify(data.steps)}, ${JSON.stringify(data.triggers)}, ${JSON.stringify(data.variables)},
         ${data.enabled ? 1 : 0}, ${data.output_storage_enabled ? 1 : 0}, ${data.output_folder})
    `.execute(db);

    const id = Number(res.insertId);
    return (await this.findById(id))!;
  }

  /** Update an existing workflow (metadata only). */
  async update(workflow: Workflow): Promise<Workflow> {
    const data = workflowToArray(workflow);
    await sql`
      UPDATE agent_workflows SET
        name = ${data.name},
        description = ${data.description},
        steps = ${JSON.stringify(data.steps)},
        triggers = ${JSON.stringify(data.triggers)},
        variables = ${JSON.stringify(data.variables)},
        enabled = ${data.enabled ? 1 : 0},
        workspace_id = ${data.workspace_id},
        output_storage_enabled = ${data.output_storage_enabled ? 1 : 0},
        output_folder = ${data.output_folder}
      WHERE id = ${data.id}
    `.execute(db);

    return (await this.findById(workflow.id as number))!;
  }

  /** Delete a workflow. */
  async delete(id: number): Promise<void> {
    await sql`DELETE FROM agent_workflows WHERE id = ${id}`.execute(db);
  }

  /** Whether a user can access a workflow (owner only). */
  async canUserAccess(userId: number, workflowId: number): Promise<boolean> {
    const workflow = await this.findById(workflowId);
    if (!workflow) return false;
    return workflow.userId === userId;
  }

  /** Whether a user owns a workflow. */
  async isOwner(userId: number, workflowId: number): Promise<boolean> {
    const workflow = await this.findById(workflowId);
    return !!workflow && workflow.userId === userId;
  }

  /** Toggle the enabled flag. */
  async toggleEnabled(id: number): Promise<void> {
    await sql`UPDATE agent_workflows SET enabled = NOT enabled WHERE id = ${id}`.execute(db);
  }

  /** Duplicate a workflow (metadata only — graph is NOT copied, mirroring PHP). */
  async duplicate(workflowId: number, newUserId: number, newName: string | null = null): Promise<Workflow | null> {
    const original = await this.findById(workflowId);
    if (!original) return null;

    const copy = hydrateWorkflow(workflowToArray(original));
    copy.userId = newUserId;
    copy.name = newName ?? original.name + ' (Copy)';

    return this.create(copy);
  }

  /**
   * Mirrors WorkflowRunner::getExecutionHistory() — the plain SELECT only. The runner is NOT ported.
   * Reads raw rows from agent_workflow_executions.
   */
  async getExecutionHistory(workflowId: number, limit = 50, offset = 0): Promise<any[]> {
    // input_variables/output are MySQL `json` columns; mysql2 would auto-parse them into objects,
    // but PHP/PDO returns the raw JSON string here (the runner does not json_decode them). CAST the
    // two to CHAR so they come back as the original JSON text, byte-identical to PHP.
    return (
      await sql<any>`
        SELECT id, workflow_id, user_id,
               CAST(input_variables AS CHAR) AS input_variables,
               CAST(output AS CHAR) AS output,
               status, error_message, response_time_ms, started_at, completed_at
        FROM agent_workflow_executions
        WHERE workflow_id = ${workflowId}
        ORDER BY started_at DESC
        LIMIT ${sql.lit(phpIntval(limit))} OFFSET ${sql.lit(phpIntval(offset))}`.execute(db)
    ).rows;
  }
}
