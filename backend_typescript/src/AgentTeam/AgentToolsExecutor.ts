import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';
import { AgentDelegationFunctions } from './AgentDelegationFunctions';
import type { AgentRunner } from './AgentRunner';

/**
 * Executor for manager agents — TS port of AgentToolsExecutor.php.
 * Routes delegation tool names to the delegation handlers (with the runner's
 * executionContext); everything else falls through to the base executor.
 */
export class AgentToolsExecutor implements FunctionExecutor {
  private readonly delegationNames: Set<string>;

  constructor(
    private readonly base: FunctionExecutor,
    private readonly delegation: AgentDelegationFunctions,
    private readonly runner: AgentRunner,
  ) {
    this.delegationNames = new Set(AgentDelegationFunctions.toolNames());
  }

  async execute(name: string, params: any, context?: any): Promise<any> {
    if (this.delegationNames.has(name)) {
      const fn = this.delegation.getAllFunctions()[name];
      return fn.handler(params, this.runner.getExecutionContext());
    }
    return this.base.execute(name, params, context);
  }

  hasFunction(name: string): boolean {
    return this.delegationNames.has(name) || this.base.hasFunction(name);
  }

  isMCPTool(name: string): boolean {
    return this.delegationNames.has(name) ? false : this.base.isMCPTool(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.base.getToolDefinitions();
  }
}
