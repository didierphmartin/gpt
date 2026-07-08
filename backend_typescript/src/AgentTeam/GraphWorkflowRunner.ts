import { randomBytes } from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Workflow } from './WorkflowRepository';
import { WorkflowGraphRepository } from './WorkflowRepository';
import { Agent, AgentRepository } from './AgentRepository';
import { AgentRunner } from './AgentRunner';
import { StreamContext } from './StreamContext';
import { PromptTemplateProcessor } from './PromptTemplateProcessor';
import { WorkflowSchemaRepository } from './WorkflowSchemaRepository';
import { SkillToolBridge } from './SkillToolBridge';
import { SkillToolChoice } from './SkillToolChoice';
import { WorkflowRunLog } from './WorkflowRunLog';
import { WorkflowOutputStorage } from './WorkflowOutputStorage';

/**
 * Faithful port of the start/agent/output execution paths of
 * src/AgentTeam/Services/GraphWorkflowRunner.php (the run() orchestration loop, sequential AND
 * implicit-parallel flow, prompt/variable templating, execution recording, and the SSE event
 * emission). Covers essentially all real workflows.
 *
 * Provider invocation reuses the already-ported AgentRunner (run(), non-streaming). The workflow's
 * AgentRunner has NO StreamContext set, so the agent does NOT emit its own agent_start/agent_complete
 * frames inside a workflow run — matching the captured PHP wire sequence (NONE). The agent's final
 * text becomes the node output and node_trace.final_text.
 *
 * DEFERRED / STUBBED (see inline comments + report):
 *  - SkillToolBridge / folder-backed skill agents / client-tool round-trip: deferred. node_trace
 *    still emits with PHP's default skill_* values (all null for non-skill agents).
 *  - WorkflowOutputStorage: IMPLEMENTED (see WorkflowOutputStorage.ts) — saveOutput() is called after
 *    every run exactly like PHP (best-effort, errors swallowed). The universalFS provider path is a
 *    documented no-op stub (PHP's universalFS is an in-process PHP library, not network-reachable
 *    from Node — see that file's class doc); the LOCAL-FILESYSTEM fallback, which is what every known
 *    deployment actually exercises today, is fully ported.
 *  - ExecutionTraceStore DB persistence: stubbed — the node_trace SSE WIRE event still emits.
 *  - archiveRunToConversationContexts: stubbed.
 *  - WorkflowRunLog JSONL persistence: IMPLEMENTED (see WorkflowRunLog.ts) — every node/workflow event
 *    is appended to storage/workflow-runs/{runId}.jsonl BEFORE the SSE emit, exactly like PHP's
 *    GraphWorkflowRunner::emitNodeEvent/emitWorkflowEvent (lines ~194/236). Read back via
 *    WorkflowController.runEvents / GET /api/v1/workflows/runs/{runId}/events.
 *  - Node types other than start/agent/output: handled exactly as PHP (default branch → {type,output:null});
 *    agent-template throws the same message.
 *  - Attached documents (buildDocumentsContext): no-document path is exact ('' returned). The
 *    document-reading path is stubbed (returns '' + logs), since inline_documents are ignored for 2a.
 *  - Output-schema CONSTRAINED decoding: AgentRunner has no schema carrier, so the LLM is not actually
 *    constrained; the post-hoc JSON parse of the output is still reproduced.
 *  - True curl_multi parallelism: parallel agent nodes are dispatched concurrently via Promise.all then
 *    their completion events are emitted in node-list order (deterministic), reproducing PHP's per-node
 *    emission pattern (node_start upfront, then node_log/node_complete/node_trace).
 *  - Parallel client-side skill (run_skill_script) round-trip: IMPLEMENTED. executeAgentsInParallel now
 *    runs a bounded (10-round, ~120s) tool loop that forces run_skill_script on each skill-bound agent's
 *    FIRST round (SkillToolChoice.forProvider) and uses the emit-ALL-then-await-ALL pattern
 *    (SkillToolBridge) so every parallel agent's browser skill is dispatched before any awaitResult —
 *    the browser worker pool runs them concurrently. Mirrors PHP executeAgentsInParallel /
 *    makeParallelLLMCalls / emitClientToolCallInParallel / awaitClientToolResultInParallel. Non-skill
 *    parallel agents settle in round 0 exactly as before.
 */

/** Pure formatters mirroring NodeLogFormat.php (the node_log `message`). */
const NodeLogFormat = {
  callingProvider(provider: string, model: string | null): string {
    return model !== null && model !== '' ? `calling ${provider} (${model})` : `calling ${provider}`;
  },
  modelRespondedText(): string {
    return 'model responded with text';
  },
  modelRequestedTool(tool: string): string {
    return `model requested ${tool}`;
  },
  completed(tokens: number, costUsd: number | null): string {
    return costUsd !== null
      ? `completed (${tokens} tok, $${costUsd.toFixed(4)})`
      : `completed (${tokens} tok)`;
  },
  runningSkill(dir: string): string {
    return `running skill ${dir}`;
  },
  skillFinished(exitCode: number | null, bytes: number): string {
    return `skill finished (exit ${exitCode === null ? 'unknown' : exitCode}, ${bytes} bytes)`;
  },
  skillTimedOut(seconds: number): string {
    return `skill timed out after ${seconds}s`;
  },
};

/** PHP empty() for the value kinds the runner deals with. */
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && Object.keys(v).length === 0) return true;
  return false;
}

function phpIntval(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** Mirrors PHP date('c') (ISO 8601 with local UTC offset) — used for the saveOutput() payload. */
function phpDateC(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ParallelState {
  node: any;
  agent: Agent;
  input: string;
  agentId: number | null;
  output?: any;
  success?: boolean;
  usage?: any;
  // Client-skill tool-round bookkeeping (parallel path only).
  history?: any[];
  currentInput?: string;
  completed?: boolean;
  toolsFilter?: string[] | null;
  skillMetadata?: any;
  extraTools?: any[];
  forceSkill?: boolean;
  skillRan?: boolean;
}

export class GraphWorkflowRunner {
  private agentRepository = new AgentRepository();
  private agentRunner = new AgentRunner();
  private graphRepository = new WorkflowGraphRepository();
  private schemaRepository = new WorkflowSchemaRepository();

  private nodeOutputs: Record<number, any> = {};
  private executionId: number | null = null;
  private streamContext: StreamContext | null = null;
  private currentUserId: number | null = null;

  private clientSkills: Record<string, any> = {};
  private inlineDocuments: Record<string, any> = {};
  private scratchFilesByDocId: Record<string, any> = {};
  private skillResultByNode: Record<number, any> = {};

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private pricingCache: Record<string, [number | null, number | null]> = {};

  private runId = '';
  private currentWorkflowId: number | null = null;
  private parallelEmitted: Record<number, boolean> = {};

  private templateProcessor: PromptTemplateProcessor | null = null;
  private workflowContext: Record<string, any> = {};
  private config: Record<string, any>;
  private runLog: WorkflowRunLog;
  private outputStorage: WorkflowOutputStorage;

  constructor(config: Record<string, any> = {}) {
    this.config = config;
    this.runLog = new WorkflowRunLog(WorkflowRunLog.defaultDir(config));
    this.outputStorage = new WorkflowOutputStorage(config);
  }

  setStreamContext(context: StreamContext | null): this {
    this.streamContext = context;
    return this;
  }

  // ---- template processing ----

  private async initTemplateProcessor(workflow: Workflow, userId: number, userPrompt: string): Promise<void> {
    this.templateProcessor = new PromptTemplateProcessor();
    const userInfo = await this.getUserInfo(userId);

    this.workflowContext = {
      user_id: userId,
      username: userInfo.name ?? userInfo.username ?? 'User',
      user_email: userInfo.email ?? '',
      user_locale: userInfo.locale ?? 'en-US',
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      user_prompt: userPrompt,
      app_name: this.config.app_name ?? 'AI Assistant',
      app_version: this.config.app_version ?? '1.0',
      custom_vars: {},
    };

    this.templateProcessor.setContext(this.workflowContext);
    if (!phpEmpty(this.config.timezone)) {
      this.templateProcessor.setTimezone(this.config.timezone);
    }
  }

  private processPromptTemplate(prompt: string, additionalContext: Record<string, any> = {}): string {
    if (!this.templateProcessor) return prompt;
    if (Object.keys(additionalContext).length > 0) {
      this.templateProcessor.setContext(additionalContext);
    }
    return this.templateProcessor.process(prompt);
  }

  private async getUserInfo(userId: number): Promise<Record<string, any>> {
    try {
      const row = (
        await sql<any>`SELECT id, username, email, name FROM users WHERE id = ${userId}`.execute(db)
      ).rows[0];
      return row ?? {};
    } catch {
      return {};
    }
  }

  // ---- event emission: persist to the per-run JSONL BEFORE the SSE emit, mirroring PHP
  // GraphWorkflowRunner::emitNodeEvent/emitWorkflowEvent (lines ~194/236). The data dict is built
  // here (not delegated to StreamContext's higher-level helpers) so the EXACT SAME object that gets
  // logged also gets emitted, and persistence still happens even with no StreamContext attached
  // (e.g. non-streaming `run`). Field construction mirrors StreamContext.emitNodeEvent/emitWorkflowEvent.

  private emitNodeEvent(type: string, node: any, extra: Record<string, any> = {}): void {
    const data: Record<string, any> = {
      type,
      node_id: node.id,
      node_type: node.node_type,
      drawflow_id: node.drawflow_node_id ?? null,
      agent_id: node.agent_id ?? null,
      agent_name: extra.agent_name ?? null,
      timestamp: Date.now() / 1000,
    };
    for (const k of Object.keys(extra)) data[k] = extra[k];

    // Persist first so the event survives even with no SSE / a dead run.
    if (this.runId !== '') {
      this.runLog.append(this.runId, data);
    }

    if (this.streamContext) this.streamContext.emit(data);
  }

  private nodeLog(node: any, level: string, phase: string, message: string, data: Record<string, any> = {}): void {
    this.emitNodeEvent('node_log', node, { level, phase, message, data });
  }

  private emitWorkflowEvent(type: string, workflow: Workflow, extra: Record<string, any> = {}): void {
    const data: Record<string, any> = {
      type,
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      timestamp: Date.now() / 1000,
    };
    for (const k of Object.keys(extra)) data[k] = extra[k];

    if (this.runId !== '') {
      this.runLog.append(this.runId, data);
    }

    if (this.streamContext) this.streamContext.emit(data);
  }

  // ========================================================================
  // run()
  // ========================================================================

  async run(
    workflow: Workflow,
    userId: number,
    inputVariables: Record<string, any> = {},
    clientSkills: Record<string, any> = {},
    inlineDocuments: Record<string, any> = {},
    scratchFiles: any[] = []
  ): Promise<Record<string, any>> {
    this.nodeOutputs = {};
    this.runId = randomBytes(16).toString('hex');
    this.currentWorkflowId = workflow.id ?? null;
    this.parallelEmitted = {};
    this.currentUserId = userId;
    this.clientSkills = clientSkills;
    this.inlineDocuments = inlineDocuments;
    this.scratchFilesByDocId = {};
    for (const sf of scratchFiles ?? []) {
      if (!sf || typeof sf !== 'object') continue;
      const id = sf.doc_id ?? null;
      if (typeof id === 'string' && id !== '') this.scratchFilesByDocId[id] = sf;
    }
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    const startTime = Date.now();

    const userPrompt: string = inputVariables.prompt ?? inputVariables.input ?? '';

    await this.initTemplateProcessor(workflow, userId, userPrompt);

    this.executionId = await this.createExecution(workflow, userId, inputVariables);

    try {
      const startNode = await this.graphRepository.findStartNode(workflow.id as number);
      if (!startNode) {
        throw new Error('Workflow has no Start node');
      }

      if ((startNode.config?.runtime_mode ?? 'batch') === 'realtime') {
        throw new Error(
          'This workflow is configured for realtime audio. Use the browser-based realtime runner instead.'
        );
      }

      // Build start node output: user prompt + (deferred) attached documents.
      let startOutput = userPrompt;
      const startDocumentsContext = this.buildDocumentsContext(startNode);
      if (!phpEmpty(startDocumentsContext)) {
        startOutput = startDocumentsContext + '\n\n---\n\n' + userPrompt;
      }

      this.nodeOutputs[startNode.id] = {
        type: 'start',
        output: startOutput,
        documents: startNode.config?.documents ?? [],
      };

      const graph = await this.graphRepository.getGraph(workflow.id as number);
      const nodes = this.indexNodesById(graph.nodes);
      const edges = graph.edges;

      this.emitWorkflowEvent('workflow_start', workflow, {
        run_id: this.runId,
        execution_id: this.executionId,
        total_nodes: Object.keys(nodes).length,
      });

      // Start node events: node_start (active glow), 300ms, node_complete.
      this.emitNodeEvent('node_start', startNode, { input: userPrompt });
      await sleep(300);
      this.emitNodeEvent('node_complete', startNode, { success: true });

      const executedNodes: number[] = [phpIntval(startNode.id)];
      let queue: number[] = this.getNextNodeIds(phpIntval(startNode.id), edges);
      let finalOutput: string | null = null;

      // Implicit parallelism right after Start.
      const startParallelAgents = this.findAgentNodesInList(queue, nodes, executedNodes);
      if (startParallelAgents.length > 1) {
        const parallelResults = await this.executeAgentsInParallel(
          startParallelAgents,
          userId,
          userPrompt,
          edges,
          executedNodes
        );
        queue = [];
        for (const nodeId of Object.keys(parallelResults).map(Number)) {
          this.nodeOutputs[nodeId] = parallelResults[nodeId];
          executedNodes.push(nodeId);
          const agentNextIds = this.getNextNodeIds(nodeId, edges);
          for (const nextId of agentNextIds) {
            if (!queue.includes(nextId) && !executedNodes.includes(nextId)) queue.push(nextId);
          }
        }
      }

      while (queue.length > 0) {
        const currentNodeId = queue.shift() as number;

        if (executedNodes.includes(currentNodeId)) continue;

        const node = nodes[currentNodeId] ?? null;
        if (!node) continue;

        if (!this.canExecuteNode(currentNodeId, edges, executedNodes)) {
          queue.push(currentNodeId); // re-queue for later (merge node not ready)
          continue;
        }

        // Build agent input context BEFORE node_start (so node_start carries `input`).
        let nodeInput: string | null = null;
        if (node.node_type === 'agent') {
          const config = node.config ?? {};
          const mergeStrategy = config.merge_strategy ?? 'labeled';
          const context = this.buildContextForNode(node.id, edges, executedNodes, mergeStrategy);
          nodeInput = !phpEmpty(context) ? `Do your job on the following input:\n\n${context}` : userPrompt;
        }

        this.emitNodeEvent('node_start', node, { input: nodeInput });

        const output = await this.executeNode(node, userId, userPrompt, edges, executedNodes);

        this.nodeOutputs[currentNodeId] = output;
        executedNodes.push(currentNodeId);

        const usage = output.usage ?? null;
        const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
        if (node.node_type === 'agent') {
          this.totalInputTokens += inputTokens;
          this.totalOutputTokens += outputTokens;
        }

        const nodeSuccess = Object.prototype.hasOwnProperty.call(output, 'success')
          ? Boolean(output.success)
          : (output.type ?? '') !== 'error';

        this.emitNodeEvent('node_complete', node, {
          agent_name: output.agent_name ?? null,
          server_name: output.server_name ?? null,
          success: nodeSuccess,
          output: output.output ?? null,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: await this.computeNodeCost(output.provider ?? null, inputTokens, outputTokens),
        });

        if ((output.type ?? '') === 'agent') {
          await this.recordExecutionTrace(
            node,
            output.provider ?? null,
            output.model ?? null,
            nodeSuccess,
            output.output ?? null,
            inputTokens,
            outputTokens
          );
        }

        if (node.node_type === 'output') {
          finalOutput = this.collectFinalOutput(currentNodeId);
          continue; // don't queue nodes after output
        }

        // Implicit parallelism: multiple outgoing edges to agent nodes.
        let nextNodeIds = this.getNextNodeIds(currentNodeId, edges);
        const parallelAgents = this.findAgentNodesInList(nextNodeIds, nodes, executedNodes);

        if (parallelAgents.length > 1) {
          const parallelResults = await this.executeAgentsInParallel(
            parallelAgents,
            userId,
            userPrompt,
            edges,
            executedNodes
          );
          for (const nodeId of Object.keys(parallelResults).map(Number)) {
            this.nodeOutputs[nodeId] = parallelResults[nodeId];
            executedNodes.push(nodeId);
            const agentNextIds = this.getNextNodeIds(nodeId, edges);
            for (const nextId of agentNextIds) {
              if (!queue.includes(nextId) && !executedNodes.includes(nextId)) queue.push(nextId);
            }
          }
          for (const nextId of nextNodeIds) {
            const nextNode = nodes[nextId] ?? null;
            if (
              nextNode &&
              nextNode.node_type !== 'agent' &&
              !executedNodes.includes(nextId) &&
              !queue.includes(nextId)
            ) {
              queue.push(nextId);
            }
          }
          continue;
        }

        // Normal sequential flow.
        nextNodeIds = this.getNextNodeIds(currentNodeId, edges);
        for (const nextId of nextNodeIds) {
          if (!queue.includes(nextId) && !executedNodes.includes(nextId)) queue.push(nextId);
        }
      }

      const responseTime = Date.now() - startTime;

      await this.completeExecution(this.executionId, this.nodeOutputs, responseTime);

      this.emitWorkflowEvent('workflow_complete', workflow, {
        execution_id: this.executionId,
        success: true,
        nodes_executed: executedNodes.length,
        response_time_ms: round2(responseTime),
        output: finalOutput,
        node_outputs: this.nodeOutputs,
        total_input_tokens: this.totalInputTokens,
        total_output_tokens: this.totalOutputTokens,
        total_tokens: this.totalInputTokens + this.totalOutputTokens,
      });

      // Save output to storage if enabled. WorkflowOutputStorage.saveOutput() itself re-checks
      // workflow.output_storage_enabled (via a fresh DB read), so — mirroring PHP exactly — this is
      // called unconditionally here and is best-effort (errors are swallowed, never fail the run).
      // archiveRunToConversationContexts (no conversation archive) remains STUBBED.
      let storageSaveResult: Record<string, any> | null = null;
      try {
        storageSaveResult = await this.outputStorage.saveOutput(workflow.id as number, userId, {
          execution_id: this.executionId,
          workflow_id: workflow.id,
          workflow_name: workflow.name,
          timestamp: phpDateC(new Date()),
          response_time_ms: round2(responseTime),
          nodes_executed: executedNodes.length,
          output: finalOutput,
          node_outputs: this.nodeOutputs,
          input_variables: inputVariables,
        });

        if (storageSaveResult?.success) {
          console.error('[GraphWorkflowRunner] Output saved to storage: ' + (storageSaveResult.path ?? 'unknown'));
        }
      } catch (e: any) {
        console.error('[GraphWorkflowRunner] Failed to save output to storage: ' + (e?.message ?? String(e)));
      }

      return {
        success: true,
        execution_id: this.executionId,
        workflow: { id: workflow.id, name: workflow.name },
        output: finalOutput,
        node_outputs: this.nodeOutputs,
        nodes_executed: executedNodes.length,
        response_time_ms: round2(responseTime),
        storage: storageSaveResult,
      };
    } catch (e: any) {
      const msg = e?.message ?? 'Unknown error';
      this.emitWorkflowEvent('workflow_error', workflow, {
        execution_id: this.executionId,
        error: msg,
      });

      await this.failExecution(this.executionId, msg);

      return {
        success: false,
        error: msg,
        execution_id: this.executionId,
        workflow: { id: workflow.id, name: workflow.name },
        partial_outputs: this.nodeOutputs,
      };
    }
  }

  // ========================================================================
  // graph helpers
  // ========================================================================

  private indexNodesById(nodes: any[]): Record<number, any> {
    const indexed: Record<number, any> = {};
    for (const node of nodes) indexed[node.id] = node;
    return indexed;
  }

  private getNextNodeIds(nodeId: number, edges: any[]): number[] {
    const nextIds: number[] = [];
    for (const edge of edges) {
      if (phpIntval(edge.from_node_id) === nodeId) nextIds.push(phpIntval(edge.to_node_id));
    }
    return nextIds;
  }

  private canExecuteNode(nodeId: number, edges: any[], executedNodes: number[]): boolean {
    for (const edge of edges) {
      if (phpIntval(edge.to_node_id) === nodeId) {
        if (!executedNodes.includes(phpIntval(edge.from_node_id))) return false;
      }
    }
    return true;
  }

  private findAgentNodesInList(nodeIds: number[], nodes: Record<number, any>, executedNodes: number[]): any[] {
    const agentNodes: any[] = [];
    for (const nodeId of nodeIds) {
      if (executedNodes.includes(nodeId)) continue;
      const node = nodes[nodeId] ?? null;
      if (node && node.node_type === 'agent') agentNodes.push(node);
    }
    return agentNodes;
  }

  // ========================================================================
  // node execution
  // ========================================================================

  private async executeNode(
    node: any,
    userId: number,
    userPrompt: string,
    edges: any[],
    executedNodes: number[]
  ): Promise<any> {
    const nodeType = node.node_type;

    if (!phpEmpty(node.config?.disabled)) {
      this.nodeLog(node, 'info', 'done', 'disabled node — skipped');
      return { type: nodeType, output: 'disabled node', success: true };
    }

    switch (nodeType) {
      case 'agent':
        return this.executeAgentNode(node, userId, userPrompt, edges, executedNodes);
      case 'agent-template':
        throw new Error(
          'Unconfigured agent template node found. Please configure all agent nodes before running the workflow.'
        );
      case 'output':
        return this.executeOutputNode(node, edges);
      default:
        return { type: nodeType, output: null };
    }
  }

  private async executeAgentNode(
    node: any,
    userId: number,
    userPrompt: string,
    edges: any[],
    executedNodes: number[]
  ): Promise<any> {
    const agentId = node.agent_id ?? null;
    const config = node.config ?? {};

    let agent: Agent | null = null;

    const agentContext: Record<string, any> = {
      agent_name: config.agent_name ?? config.name ?? '',
      node_id: node.id,
      node_name: config.name ?? `Node ${node.id}`,
    };

    // Node-level skill content. Folder-backed (bound_skill) resolution depends on the inline
    // clientSkills bundle (always empty for 2a). Inline skill_content is honored.
    let skillContent = '';
    if (!phpEmpty(config.bound_skill) && typeof config.bound_skill === 'object') {
      const dirName = String(config.bound_skill.dir_name ?? '');
      if (dirName !== '' && this.clientSkills[dirName] && typeof this.clientSkills[dirName] === 'object') {
        skillContent = String(this.clientSkills[dirName].skill_content ?? '');
      }
    }
    if (skillContent === '') {
      skillContent = String(config.skill_content ?? '').trim();
    }

    // Workflows run memory-free (conversation-only feature) — both blocks empty.
    const userMemoryBlock = '';
    const userProfileBlock = '';

    if (agentId) {
      const base = await this.agentRepository.findById(agentId);
      if (!base) throw new Error(`Agent not found: ${agentId}`);

      agentContext.agent_name = base.name;
      let processedInstructions = this.processPromptTemplate(base.instructions, agentContext);
      const processedDescription = this.processPromptTemplate(base.description, agentContext);

      if (skillContent !== '') {
        const processedSkill = this.processPromptTemplate(skillContent, agentContext);
        processedInstructions = rtrim(processedInstructions) + '\n\n## Skill\n' + processedSkill;
      }
      if (userMemoryBlock !== '') processedInstructions = rtrim(processedInstructions) + '\n\n## Memory\n' + userMemoryBlock;
      if (userProfileBlock !== '') processedInstructions = rtrim(processedInstructions) + '\n\n## User\n' + userProfileBlock;

      agent = { ...base, description: processedDescription, instructions: processedInstructions };
    } else if (!phpEmpty(config.agent_name) || !phpEmpty(config.instructions) || skillContent !== '') {
      const agentName = config.agent_name ?? config.name ?? 'Inline Agent';
      agentContext.agent_name = agentName;

      let processedInstructions = this.processPromptTemplate(config.instructions ?? '', agentContext);
      const processedDescription = this.processPromptTemplate(config.description ?? '', agentContext);

      if (skillContent !== '') {
        const processedSkill = this.processPromptTemplate(skillContent, agentContext);
        processedInstructions = rtrim(processedInstructions) + '\n\n## Skill\n' + processedSkill;
      }
      if (userMemoryBlock !== '') processedInstructions = rtrim(processedInstructions) + '\n\n## Memory\n' + userMemoryBlock;
      if (userProfileBlock !== '') processedInstructions = rtrim(processedInstructions) + '\n\n## User\n' + userProfileBlock;

      agent = this.makeInlineAgent(userId, agentName, processedDescription, processedInstructions, config);
    } else {
      throw new Error('Agent node has no agent_id and no inline configuration');
    }

    const mergeStrategy = config.merge_strategy ?? 'labeled';
    let context = this.buildContextForNode(node.id, edges, executedNodes, mergeStrategy);

    const documentsContext = this.buildDocumentsContext(node);
    if (!phpEmpty(documentsContext)) {
      context = documentsContext + '\n\n' + context;
    }

    const task = !phpEmpty(context) ? `Do your job on the following input:\n\n${context}` : userPrompt;

    let toolsFilter: string[] | null = null;
    if (!phpEmpty(config.tools) && Array.isArray(config.tools)) {
      toolsFilter = config.tools;
    }

    const outputSchema = await this.resolveOutputSchema(config, userId);

    // If the node is bound to a folder-backed skill that has executable scripts (and the browser
    // shipped them inline at run start), declare run_skill_script so the LLM can invoke them. The
    // actual execution lives in the user's browser via Pyodide; the runner bridges results back over
    // SSE + /workflows/tool-result. Mirrors GraphWorkflowRunner.php ~lines 856-900.
    const skillScripts = this.getBoundSkillScripts(config);
    const skillDirName = config.bound_skill?.dir_name ?? null;
    let skillMetadata: any = null;
    const extraTools: any[] = [];
    if (skillScripts.length && typeof skillDirName === 'string' && skillDirName !== '') {
      skillMetadata = { dir_name: skillDirName, scripts: skillScripts };
      extraTools.push(this.buildRunSkillScriptTool(skillMetadata));
    }

    const runContext: Record<string, any> = {
      workflow_execution_id: this.executionId,
      node_id: node.id,
      tools_filter: toolsFilter,
      output_schema: outputSchema,
      extra_tools: extraTools,
      skill_metadata: skillMetadata,
    };

    // Force run_skill_script on the FIRST agent turn when the node has a bound folder-backed skill
    // with executable scripts. The bridge loop in runAgentWithClientToolBridge clears this on
    // subsequent rounds so the model can summarize freely after the tool result. OpenAI-form shape;
    // ClaudeProvider translates it, OpenAI/Grok/Kimi consume natively, Gemini ignores tool_choice
    // (uses its own function_calling_config) — the prompt instructions are the soft fallback there.
    if (skillScripts.length && typeof skillDirName === 'string' && skillDirName !== '') {
      runContext.tool_choice = { type: 'function', function: { name: 'run_skill_script' } };
    }

    this.nodeLog(node, 'info', 'llm', NodeLogFormat.callingProvider(agent.provider, agent.model));
    const result = await this.runAgentWithClientToolBridge(agent, task, [], userId, runContext, node);

    const rawOutput = result.text ?? result.output ?? '';
    this.nodeLog(node, 'info', 'analysis', 'generating final output');

    let structured: any = null;
    if (outputSchema !== null && typeof rawOutput === 'string' && rawOutput !== '') {
      try {
        const decoded = JSON.parse(rawOutput);
        if (decoded !== null && typeof decoded === 'object') structured = decoded;
      } catch {
        /* not valid JSON — leave structured null, matching PHP */
      }
    }

    return {
      type: 'agent',
      agent_id: agentId,
      agent_name: agent.name,
      input: task,
      output: rawOutput,
      structured,
      schema_name: outputSchema?.name ?? null,
      success: result.success ?? true,
      usage: result.usage ?? null,
      provider: agent.provider,
    };
  }

  /**
   * Faithful port of GraphWorkflowRunner.php::runAgentWithClientToolBridge. Runs the agent; when it
   * returns a pending client-side tool call (run_skill_script), emits a `client_tool_call` SSE event
   * with a bridge-correlatable tool_call_id, blocks on SkillToolBridge.awaitResult until the browser
   * POSTs the result to /api/v1/workflows/tool-result, then rebuilds the continuation history and
   * resumes the agent. Bounded to MAX_ROUNDS tool rounds.
   */
  private async runAgentWithClientToolBridge(
    agent: Agent,
    task: string,
    conversationHistory: any[],
    userId: number,
    runContext: Record<string, any>,
    node: any
  ): Promise<Record<string, any>> {
    const MAX_ROUNDS = 3;
    let history = [...conversationHistory];
    let currentTask = task;
    let result: Record<string, any> | undefined;

    for (let round = 0; round < MAX_ROUNDS + 1; round++) {
      result = await this.agentRunner.run(agent, currentTask, history, userId, runContext);

      if (!result.pending_client_tool_call) {
        return result;
      }

      const pending = result.pending_tool_calls ?? [];
      if (!pending.length || typeof pending[0] !== 'object') {
        // pending_client_tool_call set but no usable tool_calls payload — abort round-trip.
        return result;
      }
      if (round === MAX_ROUNDS) {
        // client-tool round limit hit — return last assistant text.
        return result;
      }

      // Stamp the pending call with a bridge-correlatable hex id (the provider may have generated its
      // own; we replace it so the result endpoint's regex accepts it). The frontend dispatcher gets
      // this id and posts the result back keyed on it.
      const call: any = pending[0];
      const toolCallId = SkillToolBridge.generateToolCallId();
      const callForFrontend = {
        id: toolCallId,
        name: call.name ?? 'run_skill_script',
        input: call.input ?? {},
      };
      const assistantText = result.pending_assistant_text ?? '';

      this.nodeLog(
        node,
        'info',
        'skill',
        NodeLogFormat.runningSkill(runContext?.skill_metadata?.dir_name ?? 'skill')
      );
      this.emitNodeEvent('client_tool_call', node, {
        tool_call_id: toolCallId,
        tool_calls: [callForFrontend],
        assistant_text: assistantText,
        dir_name: runContext?.skill_metadata?.dir_name ?? null,
      });

      // Same cap as the parallel path: don't let a stuck browser skill hang this node for the full
      // 5-minute default.
      const seqTimeoutMs = Number(this.config?.parallel_skill_timeout_ms ?? 60000);
      const bridgeResult = await SkillToolBridge.awaitResult(toolCallId, seqTimeoutMs);
      if (bridgeResult === null) {
        const secs = Math.round(seqTimeoutMs / 1000);
        this.nodeLog(node, 'error', 'skill', NodeLogFormat.skillTimedOut(secs));
        throw new Error(
          `Skill did not return within ${secs}s — it may be unable to run in the browser (e.g. heavy/blocked network fetches). Check the editor console.`
        );
      }

      // PHP uses strlen (BYTE length) on the stdout string.
      const stdoutBytes =
        typeof bridgeResult?.output?.stdout === 'string'
          ? Buffer.byteLength(bridgeResult.output.stdout, 'utf8')
          : 0;
      this.nodeLog(
        node,
        'info',
        'skill',
        NodeLogFormat.skillFinished(bridgeResult?.output?.exit_code ?? null, stdoutBytes)
      );

      // Phase 0: stash the skill stdout/script/argv for the execution trace.
      this.skillResultByNode[phpIntval(node.id ?? 0)] = {
        output: bridgeResult?.output && typeof bridgeResult.output === 'object' ? bridgeResult.output : {},
        script: callForFrontend.input?.script ?? null,
        argv: callForFrontend.input?.argv ?? [],
      };

      // Build the continuation: assistant turn that called the tool, followed by the tool result.
      // Providers' buildMessages convert these to native shape.
      const assistantToolCall: any = {
        id: toolCallId,
        type: 'function',
        function: {
          name: callForFrontend.name,
          arguments: JSON.stringify(callForFrontend.input ?? {}),
        },
      };
      // Gemini 2.5+/3 require the thoughtSignature from the original functionCall to be echoed back on
      // the continuation turn, or the follow-up request 400s. Carry it through; no-op for providers
      // that don't set it.
      if (call.thought_signature) {
        assistantToolCall.thought_signature = call.thought_signature;
      }
      history.push({ role: 'user', content: currentTask });
      history.push({ role: 'assistant', content: assistantText, tool_calls: [assistantToolCall] });
      history.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: callForFrontend.name,
        content: JSON.stringify(bridgeResult),
      });

      // After the first tool round, drop any forced tool_choice so the model can summarize freely on
      // the continuation turn.
      delete runContext.tool_choice;
      // Empty next-turn input: the tool_result tail is what the model needs to keep going.
      currentTask = '';
    }

    return result ?? { success: false, text: '' };
  }

  private makeInlineAgent(
    userId: number,
    name: string,
    description: string,
    instructions: string,
    config: any
  ): Agent {
    return {
      id: null,
      userId,
      teamId: null,
      category: null,
      name,
      description,
      agentType: config.agent_type ?? 'worker',
      parentAgentId: null,
      canDelegateTo: [],
      displayOrder: 0,
      provider: config.agent_provider ?? config.provider ?? 'openai',
      model: config.model ?? null,
      instructions,
      tools: config.tools ?? [],
      visibility: 'personal',
      enabled: true,
      settings: config.settings ?? [],
      createdAt: null,
      updatedAt: null,
    };
  }

  private executeOutputNode(node: any, edges: any[]): any {
    const inputs: { source: any; output: any; node_id: number }[] = [];
    const inputSources: any[] = [];

    for (const edge of edges) {
      if (phpIntval(edge.to_node_id) === phpIntval(node.id)) {
        const fromNodeId = phpIntval(edge.from_node_id);
        if (this.nodeOutputs[fromNodeId] !== undefined) {
          const output = this.nodeOutputs[fromNodeId].output ?? '';
          const sourceName =
            this.nodeOutputs[fromNodeId].agent_name ??
            this.nodeOutputs[fromNodeId].type ??
            `Node ${fromNodeId}`;
          inputs.push({ source: sourceName, output, node_id: fromNodeId });
          inputSources.push(sourceName);
        }
      }
    }

    if (inputs.length === 1) {
      return { type: 'output', output: inputs[0].output };
    }

    const combined = inputs.map((input) => `## 📄 ${input.source}\n\n${input.output}`);

    return {
      type: 'output',
      inputs_count: inputs.length,
      input_sources: inputSources,
      output: combined.join('\n\n---\n\n'),
    };
  }

  private buildContextForNode(nodeId: number, edges: any[], _executedNodes: number[], mergeStrategy = 'labeled'): string {
    const inputs: { source: any; port: any; content: string; from_node_id: number; structured: boolean }[] = [];

    for (const edge of edges) {
      if (phpIntval(edge.to_node_id) === nodeId) {
        const fromNodeId = phpIntval(edge.from_node_id);
        const toPort = edge.to_port ?? 'input_1';

        if (this.nodeOutputs[fromNodeId] !== undefined) {
          const output = this.nodeOutputs[fromNodeId];
          const agentName = output.agent_name ?? output.type ?? 'Unknown';

          if (!phpEmpty(output.output)) {
            let content = output.output;
            const isStructured = !phpEmpty(output.structured);
            if (isStructured) {
              const schemaName = output.schema_name ?? 'output';
              content = '```json schema="' + schemaName + '"\n' + output.output + '\n```';
            }
            inputs.push({
              source: agentName,
              port: toPort,
              content,
              from_node_id: fromNodeId,
              structured: isStructured,
            });
          }
        }
      }
    }

    if (inputs.length === 0) return '';
    if (inputs.length === 1) return inputs[0].content;
    return this.applyMergeStrategy(inputs, mergeStrategy);
  }

  private applyMergeStrategy(inputs: { source: any; content: string }[], strategy: string): string {
    switch (strategy) {
      case 'concatenate':
        return inputs.map((i) => i.content).join('\n\n');
      case 'json':
        return JSON.stringify(
          inputs.map((i) => ({ source: i.source, content: i.content })),
          null,
          4
        );
      case 'numbered':
        return inputs.map((i, idx) => `[Input ${idx + 1} - ${i.source}]\n${i.content}`).join('\n\n');
      case 'xml':
        return inputs
          .map((i, idx) => `<input source="${i.source}" index="${idx + 1}">\n${i.content}\n</input>`)
          .join('\n\n');
      case 'labeled':
      default:
        return inputs.map((i) => `[${i.source}]:\n${i.content}`).join('\n\n');
    }
  }

  private collectFinalOutput(outputNodeId: number): string {
    return this.nodeOutputs[outputNodeId]?.output ?? '';
  }

  /**
   * STUBBED document reading. The no-document path is exact ('' returned). When documents are
   * present, reading them (cloud/local storage) is deferred for 2a — returns '' and logs.
   */
  private buildDocumentsContext(node: any): string {
    const documents = node.config?.documents ?? [];
    if (phpEmpty(documents)) return '';
    console.warn(
      `[GraphWorkflowRunner] Node ${node.id} has attached documents — document reading is DEFERRED (2a), returning empty context.`
    );
    return '';
  }

  // ========================================================================
  // parallel execution (Promise.all dispatch; emission order = node-list order)
  // ========================================================================

  private async executeAgentsInParallel(
    agentNodes: any[],
    userId: number,
    userPrompt: string,
    edges: any[],
    executedNodes: number[]
  ): Promise<Record<number, any>> {
    const results: Record<number, any> = {};
    const states: ParallelState[] = [];
    const initializedNodes: number[] = [];

    for (const node of agentNodes) {
      if (initializedNodes.includes(node.id)) continue;
      initializedNodes.push(node.id);
      const nodeId = phpIntval(node.id);

      const agentId = node.agent_id ?? null;
      const config = node.config ?? {};

      if (!phpEmpty(config.disabled)) {
        const label = config.agent_name ?? config.name ?? 'Disabled';
        this.emitNodeEvent('node_start', node, { input: '' });
        this.nodeLog(node, 'info', 'done', 'disabled node — skipped');
        results[nodeId] = {
          type: 'agent',
          agent_id: agentId,
          agent_name: label,
          input: '',
          output: 'disabled node',
          success: true,
          usage: null,
        };
        this.emitNodeEvent('node_complete', node, {
          agent_name: label,
          success: true,
          output: 'disabled node',
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
        });
        this.parallelEmitted[nodeId] = true;
        continue;
      }

      const mergeStrategy = config.merge_strategy ?? 'labeled';
      const context = this.buildContextForNode(nodeId, edges, executedNodes, mergeStrategy);
      const task = !phpEmpty(context) ? `Do your job on the following input:\n\n${context}` : userPrompt;

      this.emitNodeEvent('node_start', node, { input: task });

      const agentContext: Record<string, any> = {
        agent_name: config.agent_name ?? config.name ?? '',
        node_id: node.id,
        node_name: config.name ?? `Node ${node.id}`,
      };

      let agent: Agent | null = null;
      if (agentId) {
        const base = await this.agentRepository.findById(agentId);
        if (base) {
          agentContext.agent_name = base.name;
          const processedInstructions = this.processPromptTemplate(base.instructions, agentContext);
          const processedDescription = this.processPromptTemplate(base.description, agentContext);
          agent = { ...base, description: processedDescription, instructions: processedInstructions };
        }
      } else if (!phpEmpty(config.agent_name) || !phpEmpty(config.instructions)) {
        const agentName = config.agent_name ?? config.name ?? 'Inline Agent';
        agentContext.agent_name = agentName;
        const processedInstructions = this.processPromptTemplate(config.instructions ?? '', agentContext);
        const processedDescription = this.processPromptTemplate(config.description ?? '', agentContext);
        agent = this.makeInlineAgent(userId, agentName, processedDescription, processedInstructions, config);
      }

      if (!agent) {
        results[nodeId] = {
          type: 'agent',
          agent_id: null,
          agent_name: 'Unknown',
          output: 'Error: No agent configuration',
          success: false,
        };
        this.emitNodeEvent('node_complete', node, {
          success: false,
          output: 'Error: No agent configuration',
          input_tokens: 0,
          output_tokens: 0,
        });
        this.parallelEmitted[nodeId] = true;
        continue;
      }

      states.push({ node, agent, input: task, agentId });
    }

    // Per-agent tools filter (config.tools overrides the agent's own tools list).
    const toolsFilterFor = (state: ParallelState): string[] | null => {
      const config = state.node.config ?? {};
      if (!phpEmpty(config.tools) && Array.isArray(config.tools)) return config.tools;
      const at = state.agent.tools;
      return Array.isArray(at) && at.length > 0 ? at : null;
    };

    // Initialize per-agent round-loop bookkeeping (mirrors PHP $agentStates init: messages/tools/
    // force_skill). A node bound to a folder-backed skill gets run_skill_script declared + forced on
    // its first round (see makeParallelLLMCalls ~2074). Non-skill agents leave forceSkill=false and
    // therefore finish in round 0 exactly as before.
    for (const state of states) {
      const config = state.node.config ?? {};
      state.history = [];
      state.currentInput = state.input;
      state.completed = false;
      state.skillRan = false;
      state.toolsFilter = toolsFilterFor(state);

      const skillScripts = this.getBoundSkillScripts(config);
      const skillDirName = config.bound_skill?.dir_name ?? null;
      if (skillScripts.length && typeof skillDirName === 'string' && skillDirName !== '') {
        state.skillMetadata = { dir_name: skillDirName, scripts: skillScripts };
        state.extraTools = [this.buildRunSkillScriptTool(state.skillMetadata)];
        state.forceSkill = true;
      } else {
        state.skillMetadata = null;
        state.extraTools = [];
        state.forceSkill = false;
      }
    }

    // Round loop with the client-skill tool round-trip. Semantic port of PHP
    // executeAgentsInParallel: dispatch every still-active agent concurrently, then EMIT every
    // agent's client_tool_call FIRST and AWAIT them all afterwards so the browser worker pool runs
    // the parallel skills concurrently (~max(skill) not sum). Bounded to MAX_ROUNDS and an overall
    // ~120s wall-clock cap; each per-skill bridge wait is capped at parallel_skill_timeout_ms (~60s),
    // itself clamped by whatever remains of the overall deadline.
    const MAX_ROUNDS = 10;
    const OVERALL_CAP_MS = 120_000;
    const perSkillTimeoutMs = Number(this.config?.parallel_skill_timeout_ms ?? 60000);
    const overallDeadline = Date.now() + OVERALL_CAP_MS;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const active = states.filter((s) => !s.completed && !this.parallelEmitted[phpIntval(s.node.id)]);
      if (active.length === 0) break;
      if (Date.now() >= overallDeadline) break; // overall cap hit — leftovers swept below.

      // (1) Dispatch each active agent's next round concurrently (curl_multi analog). Attach the
      // rejection handler IMMEDIATELY so a branch that rejects before we read it can't become an
      // unhandled rejection (which would crash the single Node process, unlike PHP's per-request
      // isolation). Each branch settles to a tagged result.
      const settledList = await Promise.all(
        active.map((state) => {
          const runContext: Record<string, any> = {
            workflow_execution_id: this.executionId,
            node_id: state.node.id,
            tools_filter: state.toolsFilter ?? null,
            extra_tools: state.extraTools ?? [],
            skill_metadata: state.skillMetadata ?? null,
          };
          // Force run_skill_script until it has run once (PHP forces via SkillToolChoice::forProvider;
          // null for Gemini/unknown, which fall back to the prompt instruction).
          if (state.forceSkill && !state.skillRan) {
            const tc = SkillToolChoice.forProvider(state.agent.provider);
            if (tc) runContext.tool_choice = tc;
          }
          return this.agentRunner
            .run(state.agent, state.currentInput ?? '', state.history ?? [], userId, runContext)
            .then(
              (value: Record<string, any>) => ({ ok: true as const, value }),
              (error: any) => ({ ok: false as const, error })
            );
        })
      );

      // (2) Process responses. EMIT every pending skill's client_tool_call here (do NOT await yet),
      // and collect them so the whole batch can be awaited concurrently afterwards.
      const pendingAwaits: Array<{
        state: ParallelState;
        toolCallId: string;
        callForFrontend: { id: string; name: string; input: any };
      }> = [];

      for (let j = 0; j < active.length; j++) {
        const state = active[j];
        const nodeId = phpIntval(state.node.id);
        const settled = settledList[j];
        const result: Record<string, any> = settled.ok
          ? settled.value
          : { success: false, error: settled.error?.message ?? 'Unknown error' };

        if (result.success === false) {
          state.completed = true;
          state.success = false;
          state.output = 'Error: ' + (result.error ?? 'Unknown error');
          state.usage = null;
          this.nodeLog(state.node, 'error', 'error', result.error ?? 'Unknown error');
          await this.finalizeParallelNode(nodeId, state, results);
          continue;
        }

        if (result.pending_client_tool_call) {
          const pending = result.pending_tool_calls ?? [];
          if (!pending.length || typeof pending[0] !== 'object') {
            // pending flagged but no usable tool_calls payload — treat the assistant text as final.
            state.completed = true;
            state.success = true;
            state.output = result.text ?? '';
            state.usage = result.usage ?? null;
            this.nodeLog(state.node, 'info', 'llm', NodeLogFormat.modelRespondedText());
            await this.finalizeParallelNode(nodeId, state, results);
            continue;
          }

          const call: any = pending[0];
          const fnName = call.name ?? 'run_skill_script';
          const assistantText = result.pending_assistant_text ?? '';
          this.nodeLog(state.node, 'info', 'llm', NodeLogFormat.modelRequestedTool(fnName));

          const toolCallId = SkillToolBridge.generateToolCallId();
          const assistantToolCall: any = {
            id: toolCallId,
            type: 'function',
            function: { name: fnName, arguments: JSON.stringify(call.input ?? {}) },
          };
          // Gemini 2.5+/3 require the original functionCall's thoughtSignature echoed back on the
          // continuation turn (no-op for other providers).
          if (call.thought_signature) assistantToolCall.thought_signature = call.thought_signature;

          if (state.skillRan) {
            // Run-once (PHP $state['skill_ran']): the model already executed this node's skill. Feed
            // a nudge tool result instead of re-emitting run_skill_script, so it summarizes next round.
            state.history!.push({ role: 'user', content: state.currentInput ?? '' });
            state.history!.push({ role: 'assistant', content: assistantText, tool_calls: [assistantToolCall] });
            state.history!.push({
              role: 'tool',
              tool_call_id: toolCallId,
              name: fnName,
              content: JSON.stringify({
                note: 'You have already run this skill — its output is in the previous tool result. Do NOT call run_skill_script again. Write your final analysis now using that output.',
              }),
            });
            state.currentInput = '';
            continue;
          }

          // First skill run: EMIT the client_tool_call now; the tool result is filled in during the
          // concurrent await pass below (emit-all then await-all).
          const callForFrontend = { id: toolCallId, name: fnName, input: call.input ?? {} };
          this.nodeLog(state.node, 'info', 'skill', NodeLogFormat.runningSkill(state.skillMetadata?.dir_name ?? 'skill'));
          this.emitNodeEvent('client_tool_call', state.node, {
            tool_call_id: toolCallId,
            tool_calls: [callForFrontend],
            assistant_text: assistantText,
            dir_name: state.skillMetadata?.dir_name ?? null,
          });
          state.skillRan = true;
          state.history!.push({ role: 'user', content: state.currentInput ?? '' });
          state.history!.push({ role: 'assistant', content: assistantText, tool_calls: [assistantToolCall] });
          pendingAwaits.push({ state, toolCallId, callForFrontend });
          continue;
        }

        // No tool call — the agent produced its final answer.
        state.completed = true;
        state.success = true;
        state.output = result.text ?? '';
        state.usage = result.usage ?? null;
        this.nodeLog(state.node, 'info', 'llm', NodeLogFormat.modelRespondedText());
        await this.finalizeParallelNode(nodeId, state, results);
      }

      // (3) AWAIT-ALL: every skill in this round was already emitted, so the browser pool ran them
      // concurrently; awaiting them together costs ~max(skill) not sum. Per-skill cap is clamped by
      // the remaining overall deadline.
      if (pendingAwaits.length) {
        const remaining = Math.max(0, overallDeadline - Date.now());
        const skillTimeout = remaining > 0 ? Math.min(perSkillTimeoutMs, remaining) : perSkillTimeoutMs;
        const bridgeResults = await Promise.all(
          pendingAwaits.map((p) => SkillToolBridge.awaitResult(p.toolCallId, skillTimeout))
        );
        for (let k = 0; k < pendingAwaits.length; k++) {
          const p = pendingAwaits[k];
          const state = p.state;
          const bridgeResult = bridgeResults[k];
          let toolContent: string;
          if (bridgeResult === null) {
            const secs = Math.round(skillTimeout / 1000);
            this.nodeLog(state.node, 'error', 'skill', NodeLogFormat.skillTimedOut(secs));
            // Unlike the sequential bridge (which throws), the parallel path feeds an error tool
            // result back and continues, so one stuck skill can't fail its siblings. Mirrors PHP
            // awaitClientToolResultInParallel.
            toolContent = JSON.stringify({
              error: `Skill did not return within ${secs}s — check the editor console for a worker/Pyodide error.`,
            });
          } else {
            const stdoutBytes =
              typeof bridgeResult?.output?.stdout === 'string'
                ? Buffer.byteLength(bridgeResult.output.stdout, 'utf8')
                : 0;
            this.nodeLog(
              state.node,
              'info',
              'skill',
              NodeLogFormat.skillFinished(bridgeResult?.output?.exit_code ?? null, stdoutBytes)
            );
            // Phase 0: stash the skill stdout/script/argv for the execution trace.
            this.skillResultByNode[phpIntval(state.node.id ?? 0)] = {
              output: bridgeResult?.output && typeof bridgeResult.output === 'object' ? bridgeResult.output : {},
              script: p.callForFrontend.input?.script ?? null,
              argv: p.callForFrontend.input?.argv ?? [],
            };
            toolContent = JSON.stringify(bridgeResult);
          }
          state.history!.push({
            role: 'tool',
            tool_call_id: p.toolCallId,
            name: p.callForFrontend.name,
            content: toolContent,
          });
          state.currentInput = '';
        }
      }
    }

    // Final sweep: any node not finalized inside the loop (still pending at the round/overall cap)
    // still reports an outcome. Surface the last assistant text (or an explicit message), mark failed.
    for (const state of states) {
      const nodeId = phpIntval(state.node.id);
      if (this.parallelEmitted[nodeId]) continue;
      if (!state.completed) {
        let lastText = '';
        const hist = state.history ?? [];
        for (let m = hist.length - 1; m >= 0; m--) {
          const msg = hist[m];
          if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content !== '') {
            lastText = msg.content;
            break;
          }
        }
        state.output =
          lastText !== ''
            ? lastText
            : 'Agent did not finish within the tool-round limit (likely stuck calling its skill).';
        state.success = false;
        this.nodeLog(state.node, 'error', 'error', 'did not finish within the tool-round limit');
      }
      await this.finalizeParallelNode(nodeId, state, results);
    }

    return results;
  }

  private async finalizeParallelNode(nodeId: number, state: ParallelState, results: Record<number, any>): Promise<void> {
    if (this.parallelEmitted[nodeId]) return;
    this.parallelEmitted[nodeId] = true;

    const agent = state.agent;
    const usage = state.usage ?? null;
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;

    const success = Boolean(state.success ?? false);
    const output = state.output ?? null;

    const cost = await this.computeNodeCost(agent.provider, inputTokens, outputTokens);

    results[nodeId] = {
      type: 'agent',
      agent_id: agent.id,
      agent_name: agent.name,
      input: state.input ?? '',
      output,
      success,
      usage,
    };

    if (success) {
      this.nodeLog(state.node, 'info', 'done', NodeLogFormat.completed(inputTokens + outputTokens, cost));
    }

    this.emitNodeEvent('node_complete', state.node, {
      agent_name: agent.name,
      success,
      output,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    });

    // node_trace (recordExecutionTrace) — DB persistence stubbed; wire event emitted.
    this.emitNodeTraceEvent(state.node, agent.provider, success, output);
  }

  // ========================================================================
  // pricing / cost / trace
  // ========================================================================

  private async getProviderPricing(provider: string): Promise<[number | null, number | null]> {
    const lc = String(provider).toLowerCase();
    const aliases: Record<string, string> = { anthropic: 'claude', google: 'gemini' };
    const key = aliases[lc] ?? lc;

    if (this.pricingCache[key]) return this.pricingCache[key];

    const defaults: Record<string, [number, number]> = {
      claude: [3.0, 15.0],
      openai: [2.5, 10.0],
      gemini: [0.3, 2.5],
      grok: [0.2, 0.5],
      deepseek: [0.28, 0.42],
      kimi: [0.55, 2.2],
    };
    let priceIn: number | null = defaults[key] ? defaults[key][0] : null;
    let priceOut: number | null = defaults[key] ? defaults[key][1] : null;

    try {
      const row = (
        await sql<any>`
          SELECT price_input_per_1m, price_output_per_1m
          FROM system_llm_settings WHERE provider_key = ${key} LIMIT 1`.execute(db)
      ).rows[0];
      if (row) {
        if (row.price_input_per_1m !== null && row.price_input_per_1m !== undefined) priceIn = parseFloat(String(row.price_input_per_1m));
        if (row.price_output_per_1m !== null && row.price_output_per_1m !== undefined) priceOut = parseFloat(String(row.price_output_per_1m));
      }
    } catch {
      /* table/column may not exist — defaults already applied */
    }

    this.pricingCache[key] = [priceIn, priceOut];
    return this.pricingCache[key];
  }

  private async computeNodeCost(provider: string | null, inputTokens: number, outputTokens: number): Promise<number | null> {
    if (!provider) return null;
    const [priceIn, priceOut] = await this.getProviderPricing(provider);
    if (priceIn === null && priceOut === null) return null;
    return (inputTokens * (priceIn ?? 0) + outputTokens * (priceOut ?? 0)) / 1_000_000;
  }

  // ========================================================================
  // bound-skill run_skill_script wiring (mirrors GraphWorkflowRunner.php)
  // ========================================================================

  /**
   * Pull the executable script list for a node's bound folder-backed skill out of the inline
   * `client_skills` bundle the browser sent. Returns [] when the skill is DB-backed, missing from the
   * bundle, or has no scripts. Server-side resolution of folder-backed scripts isn't possible — they
   * live on the user's local FS. Mirrors GraphWorkflowRunner.php::getBoundSkillScripts.
   */
  private getBoundSkillScripts(config: Record<string, any>): string[] {
    const bs = config.bound_skill;
    if (!bs || typeof bs !== 'object' || (bs.source ?? '') !== 'local') return [];
    const dir = bs.dir_name;
    if (typeof dir !== 'string' || dir === '') return [];
    const entry = this.clientSkills[dir];
    if (!entry || typeof entry !== 'object') return [];
    const scripts = entry.scripts;
    if (!Array.isArray(scripts)) return [];
    const out: string[] = [];
    for (const s of scripts) {
      if (typeof s !== 'string') continue;
      const t = s.trim();
      if (t === '' || t.startsWith('/') || t.includes('..')) continue;
      out.push(t);
    }
    return [...new Set(out)]; // array_values(array_unique(...)) — first occurrence, order preserved
  }

  /**
   * Build the run_skill_script tool definition for a node. Copied VERBATIM from
   * GraphWorkflowRunner.php::buildRunSkillScriptTool (the runner's own version — which has a SHORTER
   * description/schema than ChatController::buildRunSkillScriptTool; copied here to avoid divergence
   * and any circular import on ChatController).
   */
  private buildRunSkillScriptTool(metadata: any): any {
    const dirName = metadata.dir_name;
    const scripts: string[] = metadata.scripts;

    const description =
      `Execute one of the Python scripts bundled with the active skill "${dirName}". ` +
      'This tool IS available to you and you should call it whenever the workflow input ' +
      'maps to one of the skill\'s scripts — do not attempt the transformation manually if a ' +
      'script can do it. Available scripts: ' + scripts.join(', ') + '. ' +
      'OUTPUT: files MUST be written to absolute paths under /outputs/ ' +
      '(e.g. -o /outputs/foo.html in argv) AND listed in read_outputs.';

    return {
      name: 'run_skill_script',
      description,
      input_schema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'Path to the script within the skill folder. Must be one of the listed scripts.',
            enum: scripts,
          },
          argv: {
            type: 'array',
            description:
              'Command-line arguments passed to the script (sys.argv[1:]). Output paths (e.g. -o, --output) MUST start with /outputs/.',
            items: { type: 'string' },
          },
          input_files: {
            type: 'object',
            description:
              'OPTIONAL — small synthesized files to write before running the script. Keys are absolute paths, values are file contents.',
            additionalProperties: { type: 'string' },
          },
          read_outputs: {
            type: 'array',
            description:
              'Paths whose contents should be returned to you after the script finishes. Use absolute /outputs/<filename> paths.',
            items: { type: 'string' },
          },
        },
        required: ['script'],
      },
    };
  }

  /**
   * Emit the node_trace wire event (recordExecutionTrace). DB persistence (ExecutionTraceStore) is
   * STUBBED. For non-skill agents the skill_* fields take PHP's default values: all null.
   */
  private emitNodeTraceEvent(node: any, _provider: string | null, success: boolean, outputText: any): void {
    const config = node.config ?? {};
    this.emitNodeEvent('node_trace', node, {
      skill_dir: config.bound_skill?.dir_name ?? null,
      skill_exit_code: null,
      skill_stdout: null,
      skill_log_messages: null,
      final_text: outputText,
      success,
      error_text: success ? null : outputText,
    });
  }

  private async recordExecutionTrace(
    node: any,
    provider: string | null,
    _model: string | null,
    success: boolean,
    outputText: any,
    _inTok: number,
    _outTok: number
  ): Promise<void> {
    // ExecutionTraceStore.insert is STUBBED. Still emit the node_trace SSE event.
    this.emitNodeTraceEvent(node, provider, success, outputText);
  }

  // ========================================================================
  // output schema
  // ========================================================================

  private async resolveOutputSchema(config: any, userId: number): Promise<Record<string, any> | null> {
    if (!phpEmpty(config.output_schema) && typeof config.output_schema === 'object') {
      const inline = config.output_schema;
      if (inline.schema !== undefined) {
        return {
          name: inline.name ?? 'output',
          description: inline.description ?? '',
          strict: Boolean(inline.strict ?? true),
          schema: inline.schema,
        };
      }
      if (inline.type !== undefined || inline.properties !== undefined) {
        return { name: 'output', description: '', strict: true, schema: inline };
      }
    }

    if (!phpEmpty(config.output_schema_id)) {
      const schemaId = phpIntval(config.output_schema_id);
      const schema = await this.schemaRepository.findById(schemaId);
      if (schema && schema.userId === userId) {
        return {
          name: schema.name,
          description: schema.description,
          strict: schema.strict,
          schema: schema.schemaJson,
        };
      }
    }

    return null;
  }

  // ========================================================================
  // execution records (agent_workflow_executions)
  // ========================================================================

  private async createExecution(workflow: Workflow, userId: number, inputVariables: Record<string, any>): Promise<number> {
    const res = await sql`
      INSERT INTO agent_workflow_executions (workflow_id, user_id, input_variables, status, started_at)
      VALUES (${workflow.id}, ${userId}, ${JSON.stringify(inputVariables)}, 'running', NOW())
    `.execute(db);
    return Number((res as any).insertId ?? 0);
  }

  private async completeExecution(executionId: number | null, outputs: Record<number, any>, responseTime: number): Promise<void> {
    await sql`
      UPDATE agent_workflow_executions
      SET status = 'completed', output = ${JSON.stringify(outputs)}, response_time_ms = ${Math.trunc(responseTime)}, completed_at = NOW()
      WHERE id = ${executionId}
    `.execute(db);
  }

  private async failExecution(executionId: number | null, error: string): Promise<void> {
    await sql`
      UPDATE agent_workflow_executions
      SET status = 'failed', error_message = ${error}, completed_at = NOW()
      WHERE id = ${executionId}
    `.execute(db);
  }
}

function rtrim(s: string): string {
  return s.replace(/\s+$/, '');
}
