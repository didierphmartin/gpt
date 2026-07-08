import { sql } from 'kysely';
import { db } from '../db/pools';
import { Workflow, validateSteps } from './WorkflowRepository';
import { AgentRepository } from './AgentRepository';
import { AgentRunner } from './AgentRunner';

/**
 * Faithful port of src/AgentTeam/Services/WorkflowRunner.php — run() and its helpers.
 *
 * Executes legacy STEP-based (non-graph) workflows: the fallback path the controllers take when a
 * workflow has no graph nodes. Graph workflows go through GraphWorkflowRunner instead.
 *
 * Provider invocation reuses the already-ported AgentRunner (its run() mirrors PHP's). The workflow's
 * AgentRunner has NO StreamContext set, so per-agent agent_start/agent_complete frames are suppressed
 * (this path is non-streaming anyway).
 */
export class WorkflowRunner {
  private agentRepository = new AgentRepository();
  private agentRunner = new AgentRunner();

  private stepOutputs: Record<string, any> = {};
  private executionId: number | null = null;

  async run(workflow: Workflow, userId: number, inputVariables: Record<string, any> = {}): Promise<Record<string, any>> {
    this.stepOutputs = {};

    // Merge input variables with workflow variables (workflow vars first, input overrides).
    const variables: Record<string, any> = { ...toObject(workflow.variables), ...inputVariables };

    this.executionId = await this.createExecution(workflow, userId, inputVariables);

    const startTime = Date.now();

    try {
      const errors = validateSteps(workflow.steps);
      if (errors.length > 0) {
        throw new Error('Invalid workflow: ' + errors.join(', '));
      }

      const entrySteps = getEntrySteps(workflow);
      if (entrySteps.length === 0) {
        throw new Error('Workflow has no entry steps');
      }

      const completedSteps: any[] = [];
      // PHP keeps $pendingSteps as the steps array and unset()s by index. Reproduce with a list
      // of {index, step} preserving original indices for the dependency-loop semantics.
      let pendingSteps: { index: number; step: any }[] = asStepList(workflow.steps).map((step, index) => ({
        index,
        step,
      }));

      while (pendingSteps.length > 0) {
        let executed = false;
        const stillPending: { index: number; step: any }[] = [];

        for (const entry of pendingSteps) {
          const step = entry.step;
          const dependsOn: any[] = Array.isArray(step?.depends_on) ? step.depends_on : [];

          const canExecute =
            dependsOn.length === 0 ||
            dependsOn.filter((d) => completedSteps.includes(d)).length === dependsOn.length;

          if (canExecute) {
            const output = await this.executeStep(step, workflow, userId, variables);

            const outputKey = step.output_key ?? step.id;
            this.stepOutputs[outputKey] = output;
            variables[outputKey] = output;

            completedSteps.push(step.id);
            executed = true;
          } else {
            stillPending.push(entry);
          }
        }

        if (!executed && stillPending.length > 0) {
          throw new Error('Workflow has unresolvable dependencies');
        }

        pendingSteps = stillPending;
      }

      const responseTime = Date.now() - startTime;

      await this.completeExecution(this.executionId, this.stepOutputs, responseTime);

      return {
        success: true,
        execution_id: this.executionId,
        workflow: { id: workflow.id, name: workflow.name },
        outputs: this.stepOutputs,
        steps_completed: completedSteps,
        response_time_ms: round2(responseTime),
      };
    } catch (e: any) {
      const msg = e?.message ?? 'Unknown error';
      await this.failExecution(this.executionId, msg);

      return {
        success: false,
        error: msg,
        execution_id: this.executionId,
        workflow: { id: workflow.id, name: workflow.name },
        partial_outputs: this.stepOutputs,
      };
    }
  }

  private async executeStep(step: any, workflow: Workflow, userId: number, variables: Record<string, any>): Promise<any> {
    const stepType = step.type ?? 'agent';
    switch (stepType) {
      case 'agent':
        return this.executeAgentStep(step, workflow, userId, variables);
      case 'condition':
        return this.executeConditionStep(step, workflow, userId, variables);
      case 'transform':
        return this.executeTransformStep(step, variables);
      default:
        throw new Error(`Unknown step type: ${stepType}`);
    }
  }

  private async executeAgentStep(
    step: any,
    workflow: Workflow,
    userId: number,
    variables: Record<string, any>
  ): Promise<any> {
    const agentName = step.agent ?? null;
    const agentId = step.agent_id ?? null;
    const taskTemplate = step.task_template ?? step.task ?? '';

    let agent = null;
    if (agentId) {
      agent = await this.agentRepository.findById(agentId);
    } else if (agentName) {
      agent = await this.agentRepository.findByName(agentName, userId);
    }

    if (!agent) {
      throw new Error('Agent not found: ' + (agentName ?? agentId));
    }

    const task = interpolateVariables(workflow, taskTemplate, variables);

    const result = await this.agentRunner.run(agent, task, [], userId, {
      workflow_execution_id: this.executionId,
      step_id: step.id,
    });

    return {
      agent: agent.name,
      agent_id: agent.id,
      task,
      result: result.text ?? result.output ?? '',
      success: result.success ?? true,
      usage: result.usage ?? null,
    };
  }

  private async executeConditionStep(
    step: any,
    workflow: Workflow,
    userId: number,
    variables: Record<string, any>
  ): Promise<any> {
    const condition = step.condition ?? '';
    const thenStep = step.then ?? null;
    const elseStep = step.else ?? null;

    const conditionMet = evaluateCondition(condition, variables);

    if (conditionMet && thenStep) {
      return {
        condition,
        result: true,
        branch: 'then',
        output: await this.executeStep(thenStep, workflow, userId, variables),
      };
    } else if (!conditionMet && elseStep) {
      return {
        condition,
        result: false,
        branch: 'else',
        output: await this.executeStep(elseStep, workflow, userId, variables),
      };
    }

    return { condition, result: conditionMet, branch: 'none', output: null };
  }

  private executeTransformStep(step: any, variables: Record<string, any>): any {
    const transform = step.transform ?? '';
    const input = step.input ?? null;
    const inputData = input ? variables[input] ?? null : variables;

    let output: any;
    switch (transform) {
      case 'json_encode':
        output = JSON.stringify(inputData);
        break;
      case 'json_decode':
        output = typeof inputData === 'string' ? safeJsonDecode(inputData) : inputData;
        break;
      case 'combine':
        output = combineOutputs(step.inputs ?? [], variables);
        break;
      case 'extract':
        output = extractField(inputData, step.field ?? '');
        break;
      case 'summarize':
        output = summarizeOutputs(step.inputs ?? [], variables);
        break;
      default:
        output = inputData;
    }

    return { transform, output };
  }

  // ---- execution records (agent_workflow_executions) ----

  private async createExecution(workflow: Workflow, userId: number, inputVariables: Record<string, any>): Promise<number> {
    const res = await sql`
      INSERT INTO agent_workflow_executions (workflow_id, user_id, input_variables, status, started_at)
      VALUES (${workflow.id}, ${userId}, ${JSON.stringify(inputVariables)}, 'running', NOW())
    `.execute(db);
    return Number((res as any).insertId ?? 0);
  }

  private async completeExecution(executionId: number | null, outputs: Record<string, any>, responseTime: number): Promise<void> {
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

// =========================================================================
// Workflow model helpers (mirror the PHP Workflow methods this runner uses)
// =========================================================================

/** Mirrors Workflow::getEntrySteps(): steps with no depends_on. */
function getEntrySteps(workflow: Workflow): any[] {
  return asStepList(workflow.steps).filter((s) => phpEmptyVal(s?.depends_on));
}

/** Mirrors Workflow::interpolateVariables(): replace {{key}} with vars (workflow vars + context). */
function interpolateVariables(workflow: Workflow, template: string, context: Record<string, any>): string {
  const allVars = { ...toObject(workflow.variables), ...context };
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
    const v = allVars[key];
    return v !== undefined && v !== null ? String(v) : m;
  });
}

function evaluateCondition(conditionRaw: string, variables: Record<string, any>): boolean {
  const condition = String(conditionRaw).trim();

  if (condition.startsWith('!')) {
    const varName = condition.slice(1);
    return phpEmptyVal(variables[varName]);
  }

  if (condition.includes('==')) {
    const [l, r] = condition.split('==', 2).map((s) => s.trim());
    const leftValue = variables[l] ?? l;
    const rightValue = variables[r] ?? r;
    // eslint-disable-next-line eqeqeq
    return leftValue == rightValue;
  }

  if (condition.includes('!=')) {
    const [l, r] = condition.split('!=', 2).map((s) => s.trim());
    const leftValue = variables[l] ?? l;
    const rightValue = variables[r] ?? r;
    // eslint-disable-next-line eqeqeq
    return leftValue != rightValue;
  }

  return !phpEmptyVal(variables[condition]);
}

function combineOutputs(inputKeys: any[], variables: Record<string, any>): Record<string, any> {
  const combined: Record<string, any> = {};
  for (const key of inputKeys) {
    if (variables[key] !== undefined) combined[key] = variables[key];
  }
  return combined;
}

function extractField(data: any, field: string): any {
  if (data === null || typeof data !== 'object') return null;
  const parts = String(field).split('.');
  let current: any = data;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || current[part] === undefined) return null;
    current = current[part];
  }
  return current;
}

function summarizeOutputs(inputKeys: any[], variables: Record<string, any>): string {
  const summaries: string[] = [];
  for (const key of inputKeys) {
    if (variables[key] !== undefined) {
      const value = variables[key];
      if (value !== null && typeof value === 'object') {
        summaries.push(`${key}: ` + (value.result ?? JSON.stringify(value)));
      } else {
        summaries.push(`${key}: ${value}`);
      }
    }
  }
  return summaries.join('\n\n');
}

function safeJsonDecode(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** PHP empty() for the value kinds the steps path deals with. */
function phpEmptyVal(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && Object.keys(v).length === 0) return true;
  return false;
}

/** Steps decode to a list (PHP array). Normalize object-shaped decode to its values. */
function asStepList(steps: any): any[] {
  if (Array.isArray(steps)) return steps;
  if (steps && typeof steps === 'object') return Object.values(steps);
  return [];
}

function toObject(vars: any): Record<string, any> {
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) return vars;
  return {};
}

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}
