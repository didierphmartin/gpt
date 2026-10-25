import { PlaybookAnalyzer } from '../Playbook/PlaybookAnalyzer';
import { PlaybookDocument } from '../Playbook/PlaybookDocument';
import { LoaderMcpExecutor } from '../Playbook/Adapters/LoaderMcpExecutor';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';

/**
 * A playbook agent's `tools` selection = the MCP tools its #Actions bind to, named as the runtime and
 * the agent form name them (mcp_<tool>). Native verbs and unbound actions contribute nothing.
 * Mirrors backend/src/AgentTeam/Services/PlaybookAgentTools.php.
 */
export const PlaybookAgentTools = {
  /** availableTools: "server.tool" ids. Returns mcp_<tool> names, unique, in prose order. */
  fromPlaybookText(text: string, availableTools: string[]): string[] {
    let doc: PlaybookDocument;
    try {
      doc = PlaybookDocument.fromConsoleText(text);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const a of new PlaybookAnalyzer().analyze(doc, availableTools, []).actions) {
      if (a.kind !== 'bound') continue;
      const target = String(a.target ?? '');
      const dot = target.indexOf('.');
      if (dot === -1) continue; // agent.* bindings have no MCP tool
      const name = 'mcp_' + target.slice(dot + 1);
      if (!out.includes(name)) out.push(name);
    }
    return out;
  },

  /** Same, against the user's live MCP registry. Never throws (returns [] on any failure). */
  async forUser(userId: string, text: string): Promise<string[]> {
    try {
      const loader = new MCPToolsLoader();
      await loader.loadToolsForUser(userId);
      return PlaybookAgentTools.fromPlaybookText(text, Object.keys(new LoaderMcpExecutor(loader).availableTools()));
    } catch (e: any) {
      console.error('[PlaybookAgentTools] registry unavailable: ' + (e?.message ?? e));
      return [];
    }
  },
};
