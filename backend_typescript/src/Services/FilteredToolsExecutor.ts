import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';

/**
 * Wraps a FunctionExecutor and restricts the tools OFFERED to the LLM to an
 * allowlist of names — the workflow node's MCP/tool selection. Mirrors
 * src/Services/FilteredToolsExecutor.php exactly:
 *   - Only getToolDefinitions() is filtered (what the model sees).
 *   - execute() / hasFunction() are NOT filtered — they delegate to the base,
 *     since the model can only call tools it was offered.
 *   - null = no filtering (all tools). An EMPTY allowlist = NO tools: a workflow
 *     node that selected nothing must not be offered all 100+ tools.
 */
export class FilteredToolsExecutor implements FunctionExecutor {
  constructor(
    private readonly base: FunctionExecutor,
    private readonly allowedTools: string[] | null = null,
  ) {}

  private isFiltering(): boolean {
    return this.allowedTools !== null;
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
