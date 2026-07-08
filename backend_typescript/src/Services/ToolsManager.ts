import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';

interface Registered {
  handler: (params: any, context?: any) => Promise<any> | any;
  schema: { description?: string; input_schema?: any };
}

/**
 * In-process tool registry + executor — mirrors src/Services/ToolsManager.php.
 * Functions/* classes register into it (Phase 3 adds the real ~21 tools; Phase 2 ships one stub).
 */
export class ToolsManager implements FunctionExecutor {
  private fns = new Map<string, Registered>();

  registerFunction(name: string, handler: Registered['handler'], schema: Registered['schema']): this {
    this.fns.set(name, { handler, schema });
    return this;
  }

  hasFunction(name: string): boolean {
    return this.fns.has(name);
  }

  getRegisteredFunctions(): string[] {
    return [...this.fns.keys()];
  }

  isMCPTool(_name: string): boolean {
    return false; // MCP routing is Phase 3 (CombinedToolsExecutor).
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.fns.entries()].map(([name, r]) => ({
      name,
      description: r.schema.description ?? `Execute ${name}`,
      input_schema: r.schema.input_schema ?? { type: 'object', properties: {}, required: [] },
    }));
  }

  async execute(name: string, params: any, context?: any): Promise<any> {
    const r = this.fns.get(name);
    if (!r) throw new Error(`Function not found: ${name}`);
    const result = await r.handler(params, context);
    return result ?? {};
  }
}
