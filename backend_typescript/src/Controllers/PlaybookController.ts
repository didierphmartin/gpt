import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { LoaderMcpExecutor } from '../Playbook/Adapters/LoaderMcpExecutor';
import { PlaybookAnalyzer } from '../Playbook/PlaybookAnalyzer';
import { InvalidPlaybookError, PlaybookDocument } from '../Playbook/PlaybookDocument';

/**
 * Registration-time playbook validation: parses the submitted playbook, resolves its action bindings
 * against the caller's MCP tools and agents, and reports blocking errors before any run is created.
 * Mirrors backend/src/Controllers/PlaybookController.php.
 */
export class PlaybookController {
  /** loaderFactory: test seam; production loads the user's MCP tools. */
  constructor(private readonly loaderFactory: ((userId: string) => Promise<MCPToolsLoader>) | null = null) {}

  /** POST /api/v1/playbooks/validate — body: { playbook: object|string } */
  async validate(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    if (userId === null || userId === undefined || (userId as any) === '') {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    const playbook = (ctx.body ?? {}).playbook ?? null;
    let doc: PlaybookDocument;
    try {
      if (typeof playbook === 'string') {
        doc = PlaybookDocument.fromConsoleText(playbook);
      } else if (playbook !== null && typeof playbook === 'object') {
        doc = PlaybookDocument.fromArray(playbook);
      } else {
        throw new InvalidPlaybookError('Field "playbook" (object or string) is required.');
      }
    } catch (e: any) {
      if (!(e instanceof InvalidPlaybookError)) throw e;
      return { valid: false, errors: [e.message], status_code: 422 };
    }

    const loader = await this.makeLoader(String(userId));
    const availableTools = Object.keys(new LoaderMcpExecutor(loader).availableTools());
    const availableAgents = await this.loadAgentNames(userId);

    const result = new PlaybookAnalyzer().analyze(doc, availableTools, availableAgents);
    const valid = result.errors.length === 0;
    return {
      valid,
      actions: result.actions,
      gates: result.gates,
      checklist: result.checklist,
      errors: result.errors,
      warnings: result.warnings,
      notices: result.notices ?? [],
      status_code: valid ? 200 : 422,
    };
  }

  private async makeLoader(userId: string): Promise<MCPToolsLoader> {
    if (this.loaderFactory !== null) return this.loaderFactory(userId);
    const loader = new MCPToolsLoader();
    await loader.loadToolsForUser(userId);
    return loader;
  }

  private async loadAgentNames(userId: number): Promise<string[]> {
    return (await sql<{ name: string }>`SELECT name FROM agents WHERE user_id = ${userId}`.execute(db)).rows.map((r) => r.name);
  }
}
