import { Request, Response } from 'express';
import { Ctx, ControllerResult, buildCtx } from '../Support/Http';
import {
  WorkflowRepository,
  Workflow,
  hydrateWorkflow,
  workflowToArray,
  workflowToApiArray,
  validateSteps,
  phpEmpty,
  phpBool,
  phpIsArray,
  phpIntval,
} from '../AgentTeam/WorkflowRepository';
import { AgentRepository } from '../AgentTeam/AgentRepository';
import { LangGraphGenerator } from '../AgentTeam/LangGraphGenerator';
import { ADKGenerator } from '../AgentTeam/ADKGenerator';
import { MAFGenerator } from '../AgentTeam/MAFGenerator';
import { GraphWorkflowRunner } from '../AgentTeam/GraphWorkflowRunner';
import { WorkflowRunner } from '../AgentTeam/WorkflowRunner';
import { StreamContext } from '../AgentTeam/StreamContext';
import { SkillToolBridge } from '../AgentTeam/SkillToolBridge';
import { WorkflowRunLog } from '../AgentTeam/WorkflowRunLog';
import { WorkflowOutputStorage } from '../AgentTeam/WorkflowOutputStorage';

/**
 * Mirrors src/AgentTeam/Controllers/WorkflowController.php — the management CRUD slice plus the
 *   start/agent/output execution endpoints:
 *   index, create, show, update, destroy, toggle, duplicate, executions, generatePython, generateAdk, run, runStream,
 *   listOutputs, getOutput (WorkflowOutputStorage — see that file's class doc for the
 *   universalFS-vs-local-fallback porting decision), saveDocumentMetadata, listNodeDocuments,
 *   deleteNodeDocument.
 *
 * DEFERRED (NOT ported / NOT routed): runByName, uploadNodeDocument (multipart file upload handling).
 *
 * `executions` only needs a plain SELECT from agent_workflow_executions (mirrored in
 * WorkflowRepository.getExecutionHistory) — the WorkflowRunner is NOT pulled in.
 */
export class WorkflowController {
  private workflowRepository = new WorkflowRepository();
  private graphRepository = this.workflowRepository.graphRepository;

  private getUserId(ctx: Ctx): number {
    return Number(ctx.user_id ?? 0);
  }

  private getWorkflowId(ctx: Ctx): number {
    return phpIntval(ctx.params?.id ?? 0);
  }

  /** GET /api/v1/workflows */
  async index(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const workflows = await this.workflowRepository.findByUser(userId, false);

      const ids = workflows.map((w) => w.id as number);
      const realtimeIds = await this.graphRepository.findRealtimeWorkflowIds(ids);
      const realtimeSet = new Set(realtimeIds);

      return {
        success: true,
        data: workflows.map((workflow) => {
          const arr = workflowToApiArray(workflow);
          arr.runtime_mode = realtimeSet.has(workflow.id as number) ? 'realtime' : 'batch';
          return arr;
        }),
        count: workflows.length,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/workflows */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (phpEmpty(body.name)) {
      return { success: false, error: 'Workflow name is required', status_code: 400 };
    }

    const hasGraph = !phpEmpty(body.definition?.nodes) || !phpEmpty(body.graph?.nodes);
    const hasSteps = !phpEmpty(body.steps) && phpIsArray(body.steps);

    try {
      const workflow = hydrateWorkflow({});
      workflow.userId = userId;
      workflow.name = body.name;
      workflow.description = body.description ?? '';
      workflow.triggers = body.triggers ?? [];
      workflow.variables = body.variables ?? [];
      workflow.enabled = body.enabled ?? true;
      workflow.workspaceId = body.workspace_id ?? null;
      workflow.outputStorageEnabled = phpBool(body.output_storage_enabled ?? false);
      workflow.outputFolder = body.output_folder ?? null;

      if (hasSteps) {
        workflow.steps = body.steps;

        const errors = validateSteps(workflow.steps);
        if (errors.length > 0) {
          return {
            success: false,
            error: 'Invalid workflow steps',
            validation_errors: errors,
            status_code: 400,
          };
        }
      } else {
        workflow.steps = [];
      }

      let created = await this.workflowRepository.create(workflow);

      if (hasGraph) {
        const graphData = body.definition ?? body.graph ?? {};
        const nodes = graphData.nodes ?? graphData.steps ?? [];
        const edges = graphData.edges ?? [];

        await this.graphRepository.saveGraph(created.id as number, nodes, edges);

        created = (await this.workflowRepository.findById(created.id as number, true))!;
      }

      return {
        success: true,
        data: workflowToArray(created),
        message: 'Workflow created successfully',
        status_code: 201,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * GET /api/v1/workflows/{id}/generate-python
   * Generate a standalone LangGraph Python script from the workflow.
   *
   * The route decides raw-vs-JSON: on download success this returns a `raw_body` (Buffer) +
   * `headers`; otherwise the JSON `{success, data:{filename, code}}` shape. Auth/validation/error
   * order and messages mirror the PHP method exactly.
   */
  async generatePython(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const download = ((ctx.query as any)?.download ?? '0') === '1';

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const agentRepo = new AgentRepository();
      const gen = new LangGraphGenerator(this.workflowRepository, this.graphRepository, agentRepo);
      const result = await gen.generate(workflowId, String(userId));

      if (download) {
        return {
          success: true,
          raw_body: result.code, // Buffer — streamed raw by the route
          headers: {
            'Content-Type': 'text/x-python; charset=utf-8',
            'Content-Disposition': 'attachment; filename="' + result.filename + '"',
          },
          status_code: 200,
        };
      }

      return {
        success: true,
        data: { filename: result.filename, code: result.code.toString('utf8') },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * GET /api/v1/workflows/{id}/generate-adk
   * Generate a standalone Google ADK Python script from the workflow.
   *
   * The route decides raw-vs-JSON: on download success this returns a `raw_body` +
   * `headers`; otherwise the JSON `{success, data:{filename, code}}` shape. Auth/validation/error
   * order and messages mirror the PHP method (WorkflowController::generateAdk) exactly.
   */
  async generateAdk(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const download = ((ctx.query as any)?.download ?? '0') === '1';

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const agentRepo = new AgentRepository();
      const gen = new ADKGenerator(this.workflowRepository, this.graphRepository, agentRepo);
      const result = await gen.generate(workflowId, String(userId));

      if (download) {
        return {
          success: true,
          raw_body: result.code, // string — streamed raw by the route
          headers: {
            'Content-Type': 'text/x-python; charset=utf-8',
            'Content-Disposition': 'attachment; filename="' + result.filename + '"',
          },
          status_code: 200,
        };
      }

      return {
        success: true,
        data: { filename: result.filename, code: result.code },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * GET /api/v1/workflows/{id}/generate-maf
   * Generate a standalone Microsoft Agent Framework Python script from the workflow.
   *
   * The route decides raw-vs-JSON: on download success this returns a `raw_body` +
   * `headers`; otherwise the JSON `{success, data:{filename, code}}` shape. Auth/validation/error
   * order and messages mirror the PHP method (WorkflowController::generateMaf) exactly.
   */
  async generateMaf(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const download = ((ctx.query as any)?.download ?? '0') === '1';

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const agentRepo = new AgentRepository();
      const gen = new MAFGenerator(this.workflowRepository, this.graphRepository, agentRepo);
      const result = await gen.generate(workflowId, String(userId));

      if (download) {
        return {
          success: true,
          raw_body: result.code, // string — streamed raw by the route
          headers: {
            'Content-Type': 'text/x-python; charset=utf-8',
            'Content-Disposition': 'attachment; filename="' + result.filename + '"',
          },
          status_code: 200,
        };
      }

      return {
        success: true,
        data: { filename: result.filename, code: result.code },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/workflows/{id} */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const query: any = ctx.query ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const includeGraph = (query.include_graph ?? 'true') !== 'false';
      const workflow = await this.workflowRepository.findById(workflowId, includeGraph);

      if (!workflow) {
        return { success: false, error: 'Workflow not found', status_code: 404 };
      }

      return { success: true, data: workflowToArray(workflow), status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** PUT /api/v1/workflows/{id} */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.isOwner(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const workflow = await this.workflowRepository.findById(workflowId);

      if (!workflow) {
        return { success: false, error: 'Workflow not found', status_code: 404 };
      }

      // PHP isset() == present AND not null.
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
      const isset = (k: string) => has(k) && body[k] !== null;

      if (isset('name')) workflow.name = body.name;
      if (isset('description')) workflow.description = body.description;
      if (isset('steps')) workflow.steps = body.steps;
      if (isset('triggers')) workflow.triggers = body.triggers;
      if (isset('variables')) workflow.variables = body.variables;
      if (isset('enabled')) workflow.enabled = phpBool(body.enabled);
      if (isset('workspace_id')) workflow.workspaceId = body.workspace_id;
      if (isset('output_storage_enabled')) workflow.outputStorageEnabled = phpBool(body.output_storage_enabled);
      if (has('output_folder')) workflow.outputFolder = body.output_folder; // array_key_exists — null allowed

      const hasGraph = !phpEmpty(body.definition?.nodes) || !phpEmpty(body.graph?.nodes);

      if (isset('steps') && !hasGraph) {
        const errors = validateSteps(workflow.steps);
        if (errors.length > 0) {
          return {
            success: false,
            error: 'Invalid workflow steps',
            validation_errors: errors,
            status_code: 400,
          };
        }
      }

      let updated = await this.workflowRepository.update(workflow);

      if (hasGraph) {
        const graphData = body.definition ?? body.graph ?? {};
        const nodes = graphData.nodes ?? graphData.steps ?? [];
        const edges = graphData.edges ?? [];

        await this.graphRepository.saveGraph(workflowId, nodes, edges);

        updated = (await this.workflowRepository.findById(workflowId, true))!;
      }

      return {
        success: true,
        data: workflowToArray(updated),
        message: 'Workflow updated successfully',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** DELETE /api/v1/workflows/{id} */
  async destroy(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.isOwner(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      await this.workflowRepository.delete(workflowId);

      return { success: true, message: 'Workflow deleted successfully', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/workflows/{id}/toggle */
  async toggle(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.isOwner(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      await this.workflowRepository.toggleEnabled(workflowId);
      const workflow = (await this.workflowRepository.findById(workflowId))!;

      return {
        success: true,
        data: workflowToApiArray(workflow),
        message: workflow.enabled ? 'Workflow enabled' : 'Workflow disabled',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/workflows/{id}/duplicate */
  async duplicate(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const newName = body.name ?? null;
      const duplicated = await this.workflowRepository.duplicate(workflowId, userId, newName);

      if (!duplicated) {
        return { success: false, error: 'Failed to duplicate workflow', status_code: 500 };
      }

      return {
        success: true,
        data: workflowToArray(duplicated),
        message: 'Workflow duplicated successfully',
        status_code: 201,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/workflows/{id}/executions */
  async executions(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const query: any = ctx.query ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const limit = query.limit !== undefined && query.limit !== null ? phpIntval(query.limit) : 50;
      const offset = query.offset !== undefined && query.offset !== null ? phpIntval(query.offset) : 0;

      // WorkflowRunner not ported — plain DB read of agent_workflow_executions only.
      const executions = await this.workflowRepository.getExecutionHistory(workflowId, limit, offset);

      return {
        success: true,
        data: executions,
        count: executions.length,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/workflows/{id}/outputs — list all stored outputs for a workflow. */
  async listOutputs(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const outputStorage = new WorkflowOutputStorage();
      const result = await outputStorage.listOutputs(workflowId, userId);

      return { ...result, status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/workflows/{id}/outputs/{filename} — get a specific workflow output file. */
  async getOutput(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const filename = ctx.params.filename ?? '';

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!workflowId || phpEmpty(filename)) {
      return { success: false, error: 'Workflow ID and filename are required', status_code: 400 };
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const outputStorage = new WorkflowOutputStorage();
      const result = await outputStorage.getOutput(workflowId, userId, filename);

      return { ...result, status_code: result.success ? 200 : 404 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * GET /api/v1/workflows/runs/{runId}/events — read back the persisted JSONL for a workflow run
   * (written by WorkflowRunLog during GraphWorkflowRunner.run/run-stream). Mirrors
   * WorkflowController::runEvents(): auth gate, 32-hex runId validation (also enforced by the route's
   * param regex), 404 when the log file doesn't exist.
   */
  async runEvents(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    if (!userId) {
      return { error: 'Authentication required', status_code: 401 };
    }

    const runId = String(ctx.params?.runId ?? '');
    if (!/^[a-f0-9]{32}$/.test(runId)) {
      return { error: 'Invalid runId', status_code: 400 };
    }

    const log = new WorkflowRunLog(WorkflowRunLog.defaultDir({}));
    const events = log.read(runId);
    if (events === null) {
      return { error: 'Run not found', status_code: 404 };
    }

    return { run_id: runId, events, status_code: 200 };
  }

  /**
   * POST /api/v1/workflows/tool-result — browser posts a client-side skill result back.
   * Mirrors WorkflowController::toolResult(): auth gate, 32-char-hex tool_call_id validation, then
   * SkillToolBridge.writeResult(id, WHOLE body). No DB, no per-user check beyond auth — the
   * tool_call_id is 32-char random hex (~128 bits) so a forged POST can't collide with a real
   * pending call.
   */
  async toolResult(ctx: Ctx): Promise<ControllerResult> {
    // NB: PHP toolResult calls http_response_code(401/400) then returns an array WITHOUT a
    // 'status_code' key — so index.php's dispatcher resets the code to `$result['status_code'] ?? 200`
    // = 200. The 401/400 are therefore dead; the observable status is 200 with the error body. We mirror
    // that (no status_code on the error returns). Auth is really enforced by the global middleware anyway.
    const userId = this.getUserId(ctx);
    if (!userId) {
      return { error: 'Authentication required' };
    }

    const body: any = ctx.body ?? {};
    const toolCallId = String(body.tool_call_id ?? '');
    if (toolCallId === '' || !/^[a-f0-9]{32}$/.test(toolCallId)) {
      return { error: 'Invalid tool_call_id' };
    }

    // Pass the WHOLE body — it carries { tool_call_id, success, output, log_messages?, outputs?, error? }.
    SkillToolBridge.writeResult(toolCallId, body);
    return { success: true };
  }

  /**
   * POST /api/v1/workflows/{id}/run — execute a workflow (JSON, non-streaming).
   * Mirrors WorkflowController::run(): validation order, app-key scope gate, graph-vs-steps branch,
   * and the status_code = success ? 200 : 500 convention.
   */
  async run(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    // App-key auth is scope-gated (inert under the TS middleware, which never sets auth_type=app_key).
    if (ctx.auth_type === 'app_key') {
      const scopes: any[] = (ctx as any).app_key_scopes ?? [];
      const scopeAllowed = scopes.includes('workflows:run') || scopes.includes(`workflows:run:${workflowId}`);
      if (!scopeAllowed) {
        return {
          success: false,
          error: 'App key not authorized for this workflow (missing scope workflows:run)',
          status_code: 403,
        };
      }
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
      }

      const workflow = await this.workflowRepository.findById(workflowId);
      if (!workflow) {
        return { success: false, error: 'Workflow not found', status_code: 404 };
      }
      if (!workflow.enabled) {
        return { success: false, error: 'Workflow is disabled', status_code: 400 };
      }

      const inputVariables = body.variables ?? body.inputs ?? {};

      const hasGraphNodes = await this.graphRepository.getNodes(workflowId);
      const isGraphWorkflow = hasGraphNodes.length > 0;

      let result: Record<string, any>;
      if (isGraphWorkflow) {
        result = await new GraphWorkflowRunner().run(workflow, userId, inputVariables);
      } else {
        result = await new WorkflowRunner().run(workflow, userId, inputVariables);
      }

      result.status_code = result.success ? 200 : 500;
      return result as ControllerResult;
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/workflows/{id}/run-stream — execute a workflow with SSE streaming.
   * Raw Express handler (mirrors WorkflowController::runStream). Sets SSE headers, emits node/workflow
   * frames through a StreamContext whose callback writes plain `data: <json>\n\n`, and terminates with
   * `data: [DONE]\n\n`. Validation failures are emitted as SSE `{type:'error'}` frames (NOT HTTP
   * status codes), exactly as PHP does after the headers are already sent.
   */
  async runStream(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const userId = this.getUserId(ctx);
    const workflowId = this.getWorkflowId(ctx);
    const body: any = ctx.body ?? {};

    // SSE headers (mirror PHP runStream).
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

    const sseCallback = (event: Record<string, any>) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n');
    };
    const done = () => {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };

    if (!userId) {
      sseCallback({ type: 'error', error: 'Authentication required' });
      done();
      return;
    }
    if (!workflowId) {
      sseCallback({ type: 'error', error: 'Workflow ID is required' });
      done();
      return;
    }

    try {
      if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
        sseCallback({ type: 'error', error: 'Workflow not found or access denied' });
        done();
        return;
      }

      const workflow = await this.workflowRepository.findById(workflowId);
      if (!workflow) {
        sseCallback({ type: 'error', error: 'Workflow not found' });
        done();
        return;
      }
      if (!workflow.enabled) {
        sseCallback({ type: 'error', error: 'Workflow is disabled' });
        done();
        return;
      }

      const inputVariables = body.variables ?? body.inputs ?? {};

      // Inline browser-shipped skill/document bundles. Accepted for contract parity; their CONTENT is
      // ignored for 2a (no skill agents — see GraphWorkflowRunner deferrals).
      const clientSkills = body.client_skills && typeof body.client_skills === 'object' ? body.client_skills : {};
      const inlineDocuments = body.inline_documents && typeof body.inline_documents === 'object' ? body.inline_documents : {};
      const scratchFiles = Array.isArray(body.scratch_files) ? body.scratch_files : [];

      const hasGraphNodes = await this.graphRepository.getNodes(workflowId);
      const isGraphWorkflow = hasGraphNodes.length > 0;

      if (isGraphWorkflow) {
        const validationErrors = await this.graphRepository.validateGraph(workflowId);
        if (validationErrors.length > 0) {
          sseCallback({ type: 'error', error: 'Invalid workflow: ' + validationErrors.join(', ') });
          done();
          return;
        }

        const streamContext = new StreamContext(sseCallback, userId);
        const runner = new GraphWorkflowRunner().setStreamContext(streamContext);
        await runner.run(workflow, userId, inputVariables, clientSkills, inlineDocuments, scratchFiles);
      } else {
        // Old-style (steps) workflow — no streaming support.
        sseCallback({ type: 'info', message: 'Step-based workflow - running without streaming' });
        const result = await new WorkflowRunner().run(workflow, userId, inputVariables);
        sseCallback({
          type: 'workflow_complete',
          success: result.success ?? false,
          output: result.output ?? null,
          node_outputs: result.node_outputs ?? [],
        });
      }
    } catch (e: any) {
      sseCallback({ type: 'error', error: e?.message ?? 'Unknown error' });
    }

    done();
  }

  // ---- Node documents (attached to workflow_nodes.config['documents']) --------------------
  // Faithful mirror of WorkflowController.php saveDocumentMetadata / listNodeDocuments /
  // deleteNodeDocument. Files themselves live in the browser's local FS (storage:'local'); the
  // backend only stores the metadata inside the node's config. The remote/universalFS delete branch
  // is NOT ported (documents are saved storage:'local'; deletion of local files is the browser's job).

  /** POST /api/v1/workflows/:id/nodes/:nodeId/documents/metadata */
  async saveDocumentMetadata(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = phpIntval(ctx.params.id);
    const nodeId = phpIntval(ctx.params.nodeId);
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };
    if (!workflowId || !nodeId) return { status_code: 400, success: false, error: 'Workflow ID and Node ID are required' };
    if (!(await this.workflowRepository.isOwner(userId, workflowId))) {
      return { status_code: 404, success: false, error: 'Workflow not found or access denied' };
    }
    const node = await this.graphRepository.getNode(nodeId);
    if (!node || phpIntval(node.workflow_id) !== workflowId) return { status_code: 404, success: false, error: 'Node not found' };

    const docData = ctx.body?.document ?? null;
    if (!docData || phpEmpty(docData.id) || phpEmpty(docData.name)) {
      return { status_code: 400, success: false, error: 'Document metadata required (id, name)' };
    }
    const document = {
      id: docData.id,
      name: docData.name,
      path: docData.path ?? null,
      localUri: docData.localUri ?? null,
      mimeType: docData.mimeType ?? 'application/octet-stream',
      size: docData.size ?? 0,
      storage: 'local',
      addedAt: docData.addedAt ?? new Date().toISOString(),
    };
    // getNode may return config as [] (empty); coerce to an object so the documents key persists.
    let config: any = node.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    if (!Array.isArray(config.documents)) config.documents = [];
    config.documents.push(document);
    await this.graphRepository.updateNode(nodeId, {
      config,
      node_type: node.node_type,
      agent_id: node.agent_id,
      pos_x: node.pos_x,
      pos_y: node.pos_y,
    });
    return { status_code: 201, success: true, document, message: 'Document metadata saved' };
  }

  /** GET /api/v1/workflows/:id/nodes/:nodeId/documents */
  async listNodeDocuments(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = phpIntval(ctx.params.id);
    const nodeId = phpIntval(ctx.params.nodeId);
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };
    if (!workflowId || !nodeId) return { status_code: 400, success: false, error: 'Workflow ID and Node ID are required' };
    if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
      return { status_code: 404, success: false, error: 'Workflow not found or access denied' };
    }
    const node = await this.graphRepository.getNode(nodeId);
    if (!node || phpIntval(node.workflow_id) !== workflowId) return { status_code: 404, success: false, error: 'Node not found' };
    const documents = (node.config && node.config.documents) || [];
    return { success: true, documents, count: documents.length };
  }

  /** DELETE /api/v1/workflows/:id/nodes/:nodeId/documents/:docId */
  async deleteNodeDocument(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = phpIntval(ctx.params.id);
    const nodeId = phpIntval(ctx.params.nodeId);
    const docId = ctx.params.docId ?? '';
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };
    if (!workflowId || !nodeId || phpEmpty(docId)) {
      return { status_code: 400, success: false, error: 'Workflow ID, Node ID, and Document ID are required' };
    }
    if (!(await this.workflowRepository.isOwner(userId, workflowId))) {
      return { status_code: 404, success: false, error: 'Workflow not found or access denied' };
    }
    const node = await this.graphRepository.getNode(nodeId);
    if (!node || phpIntval(node.workflow_id) !== workflowId) return { status_code: 404, success: false, error: 'Node not found' };

    let config: any = node.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    const documents = Array.isArray(config.documents) ? config.documents : [];
    const updated = documents.filter((d: any) => d.id !== docId);
    if (updated.length === documents.length) return { status_code: 404, success: false, error: 'Document not found' };

    config.documents = updated;
    await this.graphRepository.updateNode(nodeId, {
      config,
      node_type: node.node_type,
      agent_id: node.agent_id,
      pos_x: node.pos_x,
      pos_y: node.pos_y,
    });
    return { success: true, message: 'Document deleted successfully' };
  }
}

// Silence unused-import warnings for the type used only structurally.
export type { Workflow };
