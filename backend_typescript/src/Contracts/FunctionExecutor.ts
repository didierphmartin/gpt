/** Tool definition in Claude shape (also accepted by the other providers). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: any;
}

/**
 * Server-tool execution interface — mirrors src/Contracts/FunctionExecutorInterface.php.
 * (ToolsManager implements it; CombinedToolsExecutor/FilteredToolsExecutor/MCP come in Phase 3.)
 */
export interface FunctionExecutor {
  execute(name: string, params: any, context?: any): Promise<any>;
  hasFunction(name: string): boolean;
  getToolDefinitions(): ToolDefinition[];
  isMCPTool(name: string): boolean;
}
