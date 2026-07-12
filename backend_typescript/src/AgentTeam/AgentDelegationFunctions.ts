import { Agent, AgentRepository, canDelegateToAgent } from './AgentRepository';
import type { AgentRunner } from './AgentRunner';
import { ToolDefinition } from '../Contracts/FunctionExecutor';

export interface DelegationContext {
  user_id?: number;
  current_agent_id?: number | null;
  execution_id?: number | null;
  parent_execution_id?: number | null;
  stream_context?: any;
}

type Handler = (params: any, context: DelegationContext) => Promise<any>;

/**
 * Manager delegation tools — TS port of AgentDelegationFunctions.php.
 * Ported tools: delegate_to_agent, list_available_agents, complete_task.
 * (run_agents_parallel is intentionally NOT ported — unwired in PHP.)
 * complete_task is a plain signal tool (no marker-switch): with tool_choice='auto'
 * the provider loop lets the manager answer once it stops delegating.
 */
export class AgentDelegationFunctions {
  constructor(private repository: AgentRepository, private runner: AgentRunner) {}

  static toolNames(): string[] {
    return ['delegate_to_agent', 'list_available_agents', 'complete_task'];
  }

  getAllFunctions(): Record<string, { schema: { description: string; input_schema: any }; handler: Handler }> {
    return {
      delegate_to_agent: {
        schema: {
          description:
            'Delegate a task to a specialized sub-agent. The sub-agent will execute the task and return results. Use this to break down complex tasks and assign them to specialists. You can specify the agent by ID or name.',
          input_schema: {
            type: 'object',
            properties: {
              agent_id: { type: 'integer', description: 'ID of the agent to delegate to (use either agent_id or agent_name)' },
              agent_name: { type: 'string', description: 'Name of the agent to delegate to (use either agent_id or agent_name)' },
              task: { type: 'string', description: 'The task description to send to the sub-agent. Be specific and clear about what you need.' },
              context: { type: 'string', description: 'Optional additional context from previous agent outputs or research to help the sub-agent.' },
            },
            required: ['task'],
          },
        },
        handler: (p, c) => this.delegateToAgent(p, c),
      },
      list_available_agents: {
        schema: {
          description:
            'List all agents that this manager can delegate tasks to. Returns agent names, descriptions, and capabilities. Use this to understand your team before delegating.',
          input_schema: {
            type: 'object',
            properties: {
              agent_type: { type: 'string', description: 'Optional filter by agent type: worker, standard, or all', enum: ['worker', 'standard', 'all'] },
            },
            required: [],
          },
        },
        handler: (p, c) => this.listAvailableAgents(p, c),
      },
      complete_task: {
        schema: {
          description:
            'Signal that the workflow is complete and you are ready to provide your final response to the user. Call this ONLY when you have gathered all necessary information from your agents and are ready to synthesize the final answer. After calling this, respond directly to the user with your findings.',
          input_schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'Brief explanation of why the workflow is complete' },
              summary: { type: 'string', description: 'Optional brief summary of what was accomplished during the workflow' },
            },
            required: ['reason'],
          },
        },
        handler: (p, c) => this.completeTask(p, c),
      },
    };
  }

  toolDefinitions(): ToolDefinition[] {
    return Object.entries(this.getAllFunctions()).map(([name, f]) => ({
      name,
      description: f.schema.description,
      input_schema: f.schema.input_schema,
    }));
  }

  async delegateToAgent(params: any, context: DelegationContext): Promise<any> {
    const userId = Number(context.user_id ?? 0);
    const currentAgentId = context.current_agent_id ?? null;
    const parentExecutionId = context.execution_id ?? null;

    const task = String(params.task ?? '').trim();
    if (!task) return { success: false, error: 'Task description is required' };

    const agentId = params.agent_id ?? null;
    const agentName = params.agent_name ?? null;
    if (!agentId && !agentName) return { success: false, error: 'Either agent_id or agent_name is required' };

    let agent: Agent | null;
    try {
      agent = agentId
        ? await this.repository.findById(Number(agentId))
        : await this.repository.findByName(String(agentName), userId);
    } catch (e: any) {
      return { success: false, error: 'Error finding agent: ' + (e?.message ?? e) };
    }

    if (!agent) {
      let available: string[] = [];
      if (currentAgentId) available = (await this.repository.findWorkerAgents(Number(currentAgentId))).map((w) => w.name);
      let msg = `Agent not found: ${agentName ?? `ID ${agentId}`}`;
      if (available.length) msg += `. Available agents you can delegate to: ${available.map((n) => `"${n}"`).join(', ')}`;
      return { success: false, error: msg, available_agents: available };
    }

    if (!agent.enabled) return { success: false, error: `Agent '${agent.name}' is disabled` };

    if (currentAgentId) {
      const manager = await this.repository.findById(Number(currentAgentId));
      if (manager && !canDelegateToAgent(manager, agent.id as number)) {
        return { success: false, error: `Manager cannot delegate to agent '${agent.name}'` };
      }
    }

    let input = task;
    const additional = String(params.context ?? '').trim();
    if (additional) input = `## Context from Previous Analysis\n${additional}\n\n## Your Task\n${task}`;

    if (context.stream_context) {
      const manager = currentAgentId ? await this.repository.findById(Number(currentAgentId)) : null;
      context.stream_context.emitAgentDelegate(Number(currentAgentId ?? 0), manager?.name ?? 'Unknown', agent.id, agent.name, task);
    }

    try {
      const result = await this.runner.run(agent, input, [], userId, {
        parent_execution_id: parentExecutionId,
        parent_agent_id: currentAgentId,
      });
      if (result.success) {
        return {
          success: true,
          delegated_to: agent.name,
          agent_id: agent.id,
          agent_type: agent.agentType,
          status: 'completed',
          result: result.text ?? '',
          tools_used: result.tools_used ?? [],
          execution_id: result.execution_id ?? null,
        };
      }
      return { success: false, agent_name: agent.name, error: result.error ?? 'Unknown error' };
    } catch (e: any) {
      return { success: false, agent_name: agent.name, error: 'Delegation failed: ' + (e?.message ?? e) };
    }
  }

  async listAvailableAgents(params: any, context: DelegationContext): Promise<any> {
    const userId = Number(context.user_id ?? 0);
    const currentAgentId = context.current_agent_id ?? null;
    const typeFilter = params.agent_type ?? 'all';

    const info = (a: Agent) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      type: a.agentType,
      provider: a.provider,
      tools: a.tools,
    });

    const agents: any[] = [];
    if (currentAgentId) {
      const workers = await this.repository.findWorkerAgents(Number(currentAgentId));
      for (const a of workers) if (typeFilter === 'all' || a.agentType === typeFilter) agents.push(info(a));
    } else {
      const filters: any = {};
      if (typeFilter !== 'all') filters.agent_type = typeFilter;
      const accessible = await this.repository.findAccessibleByUser(userId, filters);
      for (const a of accessible) if (a.agentType !== 'manager') agents.push(info(a));
    }

    return {
      success: true,
      count: agents.length,
      agents,
      message: agents.length > 0 ? `Found ${agents.length} agents available for delegation` : 'No agents available for delegation',
    };
  }

  async completeTask(params: any, _context: DelegationContext): Promise<any> {
    const reason = params.reason ?? 'Workflow complete';
    const summary = params.summary ?? '';
    return {
      success: true,
      status: 'workflow_complete',
      reason,
      summary,
      instruction: 'You may now synthesize all results and respond to the user with your final answer.',
    };
  }
}
