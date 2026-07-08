import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';
import { MCPToolsLoader } from './MCPToolsLoader';

/**
 * Composes a base executor (local ToolsManager) with an MCPToolsLoader — mirrors
 * src/Services/CombinedToolsExecutor.php. MCP tools are checked/routed first.
 */
export class CombinedToolsExecutor implements FunctionExecutor {
  constructor(private readonly base: FunctionExecutor, private readonly mcpLoader: MCPToolsLoader | null = null) {}

  async execute(name: string, params: any, context?: any): Promise<any> {
    if (this.mcpLoader && this.mcpLoader.isMCPTool(name)) {
      return this.mcpLoader.executeTool(name, params); // MCP ignores context/userId
    }
    return this.base.execute(name, params, context);
  }

  hasFunction(name: string): boolean {
    return (this.mcpLoader?.isMCPTool(name) ?? false) || this.base.hasFunction(name);
  }

  isMCPTool(name: string): boolean {
    return this.mcpLoader?.isMCPTool(name) ?? false;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.base.getToolDefinitions(), ...(this.mcpLoader?.getToolDefinitions() ?? [])];
  }
}
