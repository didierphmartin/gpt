import { Ctx, ControllerResult } from '../Support/Http';
import {
  AgentRepository,
  Agent,
  AgentFilters,
  hydrateAgent,
  agentToArray,
} from '../AgentTeam/AgentRepository';
import { AgentRunner } from '../AgentTeam/AgentRunner';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';

/**
 * Mirrors src/AgentTeam/Controllers/AgentMCPController.php — the MCP (Model Context Protocol)
 * JSON-RPC 2.0 endpoint that exposes agent management to external AI clients (Claude Desktop,
 * Cursor, VS Code, ...).
 *
 * Endpoint: POST /api/v1/mcp/agents
 *
 * Supported methods: initialize, agents/list, agents/get, agents/create, agents/update,
 * agents/delete, agents/run, tools/list, tools/call, ping.
 *
 * Error mapping is faithful to PHP: InvalidArgumentException → -32601 (including param-validation
 * failures — a PHP quirk we preserve), any other exception → -32603, missing `jsonrpc: "2.0"` →
 * -32600. All JSON-RPC responses (success AND error) go out as HTTP 200 through the normal
 * handle() wrapper — the envelope {jsonrpc, id, result|error} IS the body.
 *
 * tools/list + tools/call use the runner's ToolsManager/MCPToolsLoader in PHP. Here builtin
 * function tools are not ported, so the ToolsManager is empty — builtin discovery fails open to []
 * and tools/call always reports "Tool not found" (same fail-open as AgentController.listTools);
 * MCP tool discovery is real (DB-backed, per user).
 */

/** Mirrors PHP's \InvalidArgumentException → JSON-RPC -32601 mapping. */
class InvalidArgument extends Error {}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'AgentTeam';
const SERVER_VERSION = '1.0.0';

export class AgentMCPController {
  private repository = new AgentRepository();

  /**
   * Handle MCP JSON-RPC request
   *
   * POST /api/v1/mcp/agents
   */
  async handle(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const body: any = ctx.body ?? {};

    // Validate JSON-RPC structure
    if (body.jsonrpc !== '2.0') {
      return this.jsonRpcError(null, -32600, 'Invalid Request: missing jsonrpc 2.0');
    }

    const method: string = body.method ?? '';
    const params: any = body.params ?? {};
    const id = body.id ?? null;

    // Route to appropriate handler
    try {
      let result: Record<string, any>;
      switch (method) {
        case 'initialize':
          result = this.initialize(params);
          break;
        case 'agents/list':
          result = await this.listAgents(userId, params);
          break;
        case 'agents/get':
          result = await this.getAgent(userId, params);
          break;
        case 'agents/create':
          result = await this.createAgent(userId, params);
          break;
        case 'agents/update':
          result = await this.updateAgent(userId, params);
          break;
        case 'agents/delete':
          result = await this.deleteAgent(userId, params);
          break;
        case 'agents/run':
          result = await this.runAgent(userId, params);
          break;
        case 'tools/list':
          result = await this.listTools(userId);
          break;
        case 'tools/call':
          result = await this.callTool(userId, params);
          break;
        case 'ping':
          result = { pong: true };
          break;
        default:
          throw new InvalidArgument(`Method not found: ${method}`);
      }

      return this.jsonRpcSuccess(id, result);
    } catch (e: any) {
      if (e instanceof InvalidArgument) {
        return this.jsonRpcError(id, -32601, e.message);
      }
      return this.jsonRpcError(id, -32603, e?.message ?? 'Internal error');
    }
  }

  /**
   * Initialize - MCP handshake
   */
  private initialize(_params: any): Record<string, any> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          subscribe: true,
          listChanged: true,
        },
        prompts: {
          listChanged: true,
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    };
  }

  /**
   * List agents accessible to user
   */
  private async listAgents(userId: number, params: any): Promise<Record<string, any>> {
    const filters: AgentFilters = {
      agent_type: params.type ?? null,
      provider: params.provider ?? null,
      limit: params.limit ?? 100,
    };

    // Remove null filters (mirrors array_filter($filters, fn($v) => $v !== null)).
    for (const k of Object.keys(filters) as (keyof AgentFilters)[]) {
      if (filters[k] === null) delete filters[k];
    }

    const agents = await this.repository.findAccessibleByUser(userId, filters);

    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        type: a.agentType,
        provider: a.provider,
        model: a.model,
        visibility: a.visibility,
        tools: a.tools,
      })),
      count: agents.length,
    };
  }

  /**
   * Get agent by ID
   */
  private async getAgent(userId: number, params: any): Promise<Record<string, any>> {
    const agentId = params.id ?? params.agent_id ?? null;

    if (!agentId) {
      throw new InvalidArgument('agent_id is required');
    }

    if (!(await this.repository.canUserAccess(userId, Number(agentId)))) {
      throw new InvalidArgument('Agent not found');
    }

    const agent = (await this.repository.findById(Number(agentId)))!;

    return {
      agent: agentToArray(agent),
    };
  }

  /**
   * Create a new agent
   */
  private async createAgent(userId: number, params: any): Promise<Record<string, any>> {
    if (this.phpEmpty(params.name)) {
      throw new InvalidArgument('name is required');
    }

    const agent = hydrateAgent({
      user_id: userId,
      name: params.name,
      description: params.description ?? '',
      agent_type: params.agent_type ?? 'standard',
      provider: params.provider ?? 'claude',
      model: params.model ?? null,
      instructions: params.instructions ?? '',
      tools: params.tools ?? [],
      can_delegate_to: params.can_delegate_to ?? [],
      visibility: params.visibility ?? 'personal',
      settings: params.settings ?? [],
    });

    const created = await this.repository.create(agent);

    return {
      agent: agentToArray(created),
      message: 'Agent created successfully',
    };
  }

  /**
   * Update an existing agent
   */
  private async updateAgent(userId: number, params: any): Promise<Record<string, any>> {
    const agentId = params.id ?? params.agent_id ?? null;

    if (!agentId) {
      throw new InvalidArgument('agent_id is required');
    }

    if (!(await this.repository.isOwner(userId, Number(agentId)))) {
      throw new InvalidArgument('Agent not found or access denied');
    }

    const agent = (await this.repository.findById(Number(agentId)))!;

    // Update fields (isset() semantics: key present AND not null)
    const isset = (k: string) => Object.prototype.hasOwnProperty.call(params, k) && params[k] !== null;

    if (isset('name')) agent.name = params.name;
    if (isset('description')) agent.description = params.description;
    if (isset('agent_type')) this.setAgentType(agent, params.agent_type);
    if (isset('provider')) agent.provider = params.provider;
    if (isset('model')) agent.model = params.model;
    if (isset('instructions')) agent.instructions = params.instructions;
    if (isset('tools')) agent.tools = params.tools;
    if (isset('can_delegate_to')) agent.canDelegateTo = this.intvalArray(params.can_delegate_to);
    if (isset('visibility')) this.setVisibility(agent, params.visibility);
    if (isset('enabled')) agent.enabled = Boolean(params.enabled);
    if (isset('settings')) agent.settings = params.settings;

    const updated = await this.repository.update(agent);

    return {
      agent: agentToArray(updated),
      message: 'Agent updated successfully',
    };
  }

  /**
   * Delete an agent
   */
  private async deleteAgent(userId: number, params: any): Promise<Record<string, any>> {
    const agentId = params.id ?? params.agent_id ?? null;

    if (!agentId) {
      throw new InvalidArgument('agent_id is required');
    }

    if (!(await this.repository.isOwner(userId, Number(agentId)))) {
      throw new InvalidArgument('Agent not found or access denied');
    }

    await this.repository.delete(Number(agentId));

    return {
      deleted: true,
      message: 'Agent deleted successfully',
    };
  }

  /**
   * Run an agent
   */
  private async runAgent(userId: number, params: any): Promise<Record<string, any>> {
    const agentId = params.agent_id ?? params.id ?? null;
    const input = String(params.input ?? params.message ?? '');

    if (!agentId) {
      throw new InvalidArgument('agent_id is required');
    }

    if (this.phpEmptyString(input.trim())) {
      throw new InvalidArgument('input is required');
    }

    if (!(await this.repository.canUserAccess(userId, Number(agentId)))) {
      throw new InvalidArgument('Agent not found');
    }

    const agent = (await this.repository.findById(Number(agentId)))!;

    if (!agent.enabled) {
      throw new InvalidArgument('Agent is disabled');
    }

    const conversationHistory: any[] = params.conversation_history ?? [];

    const runner = new AgentRunner();
    const result = await runner.run(agent, input, conversationHistory, userId);

    return {
      response: {
        text: result.text ?? '',
        success: result.success ?? false,
        error: result.error ?? null,
        usage: result.usage ?? {},
        tools_used: result.tools_used ?? [],
        execution_id: result.execution_id ?? null,
      },
      agent: {
        id: agent.id,
        name: agent.name,
      },
    };
  }

  /**
   * List available tools
   */
  private async listTools(userId: number): Promise<Record<string, any>> {
    // Built-in tools — ToolsManager is empty in TS (builtins not ported, fail-open).
    const toolsManager = new ToolsManager();
    const mcpLoader = new MCPToolsLoader();
    await mcpLoader.loadToolsForUser(userId); // fails soft internally

    const tools: any[] = [];

    // Built-in tools
    for (const tool of toolsManager.getToolDefinitions()) {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.input_schema ?? {},
        type: 'builtin',
      });
    }

    // MCP tools
    for (const tool of mcpLoader.getToolDefinitions()) {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.input_schema ?? {},
        type: 'mcp',
      });
    }

    // Delegation tools
    const delegationTools = [
      {
        name: 'delegate_to_agent',
        description: 'Delegate a task to a specialized sub-agent',
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string' },
            task: { type: 'string' },
            context: { type: 'string' },
          },
          required: ['task'],
        },
        type: 'delegation',
      },
      {
        name: 'list_available_agents',
        description: 'List agents available for delegation',
        inputSchema: { type: 'object', properties: {} },
        type: 'delegation',
      },
      {
        name: 'run_agents_parallel',
        description: 'Run multiple agents in parallel',
        inputSchema: {
          type: 'object',
          properties: {
            delegations: { type: 'array' },
          },
          required: ['delegations'],
        },
        type: 'delegation',
      },
    ];

    tools.push(...delegationTools);

    return {
      tools,
      count: tools.length,
    };
  }

  /**
   * Call a tool directly. PHP routes through the runner's ToolsManager (builtins only — MCP tools
   * are NOT callable here); the TS ToolsManager registers no builtins, so this faithfully reports
   * "Tool not found" for every name until Functions/* are ported.
   */
  private async callTool(userId: number, params: any): Promise<Record<string, any>> {
    const toolName = String(params.name ?? '');
    const args = params.arguments ?? {};

    if (this.phpEmptyString(toolName)) {
      throw new InvalidArgument('Tool name is required');
    }

    const toolsManager = new ToolsManager();

    if (!toolsManager.hasFunction(toolName)) {
      throw new InvalidArgument(`Tool not found: ${toolName}`);
    }

    const result = await toolsManager.execute(toolName, args, userId);

    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'object' && result !== null ? JSON.stringify(result, null, 4) : String(result),
        },
      ],
      isError: typeof result === 'object' && result !== null && 'error' in result,
    };
  }

  // ---- JSON-RPC envelope helpers ----

  /**
   * Create JSON-RPC success response
   */
  private jsonRpcSuccess(id: any, result: Record<string, any>): ControllerResult {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  /**
   * Create JSON-RPC error response
   */
  private jsonRpcError(id: any, code: number, message: string, data: any = null): ControllerResult {
    const error: Record<string, any> = {
      code,
      message,
    };

    if (data !== null) {
      error.data = data;
    }

    return {
      jsonrpc: '2.0',
      id,
      error,
    };
  }

  // ---- PHP-semantics helpers (mirror AgentController) ----

  // PHP's Agent model setters throw \InvalidArgumentException, which handle() maps to -32601.
  private setAgentType(agent: Agent, agentType: string): void {
    if (!['standard', 'manager', 'worker'].includes(agentType)) {
      throw new InvalidArgument(`Invalid agent type: ${agentType}`);
    }
    agent.agentType = agentType;
  }

  private setVisibility(agent: Agent, visibility: string): void {
    if (!['personal', 'workspace', 'public'].includes(visibility)) {
      throw new InvalidArgument(`Invalid visibility: ${visibility}`);
    }
    agent.visibility = visibility;
  }

  private intvalArray(arr: any): number[] {
    if (!Array.isArray(arr)) return [];
    return arr.map((v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? 0 : n;
    });
  }

  /** Mirrors PHP empty() for a string (also true for '0'). */
  private phpEmptyString(v: string): boolean {
    return v === '' || v === '0';
  }

  private phpEmpty(v: any): boolean {
    if (v === undefined || v === null) return true;
    if (v === false) return true;
    if (v === 0) return true;
    if (v === '') return true;
    if (v === '0') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }
}
