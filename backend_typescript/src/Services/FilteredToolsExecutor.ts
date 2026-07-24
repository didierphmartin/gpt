import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';

/**
 * Wraps a FunctionExecutor and restricts the tools OFFERED to the LLM to an
 * allowlist of names — the workflow node's MCP/tool selection. Mirrors
 * src/Services/FilteredToolsExecutor.php exactly:
 *   - Only getToolDefinitions() is filtered (what the model sees).
 *   - execute() / hasFunction() are NOT filtered — they delegate to the base,
 *     since the model can only call tools it was offered.
 *   - A null OR empty allowlist means "all tools" (no filtering), so a node that
 *     selects nothing keeps the default toolset rather than losing everything.
 */
export class FilteredToolsExecutor implements FunctionExecutor {
  constructor(
    private readonly base: FunctionExecutor,
    private readonly allowedTools: string[] | null = null,
  ) {}

  private isFiltering(): boolean {
    return this.allowedTools !== null && this.allowedTools.length > 0;
  }

  execute(name: string, params: any, context?: any): Promise<any> {
    return this.base.execute(name, params, context);
  }

  hasFunction(name: string): boolean {
    return this.base.hasFunction(name);
  }

  isMCPTool(name: string): boolean {
    return this.base.isMCPTool(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    const all = this.base.getToolDefinitions();
    if (!this.isFiltering()) return all;
    const allow = new Set(this.allowedTools as string[]);
    return all.filter((t) => allow.has(t.name));
  }
}
