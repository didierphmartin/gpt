import { sql } from 'kysely';
import { db } from '../db/pools';
import { CodeNodeEmit } from '../AgentTeam/CodeNodeEmit';

/**
 * Mirrors src/Services/RobotMcpServers.php: a robot workflow's MCP calls go to the robot's servers, matched to the
 * caller's by slug (servers have no slug column: the name's).
 */
export class RobotMcpServers {
  /**
   * The caller's servers behind these requested tools (mcp_<tool>, as a node selects them) that the robot has
   * no enabled server for, by name. A null selection (every tool) names none.
   */
  static async missing(callerId: string, robotId: string, toolNames: any[] | null): Promise<string[]> {
    const tools = [...new Set((toolNames ?? []).map((t) => String(t)).filter((t) => t.startsWith('mcp_')).map((t) => t.slice(4)))];
    if (tools.length === 0) return [];
    const needed = (
      await sql<any>`SELECT DISTINCT s.name FROM mcp_server_tools t JOIN mcp_servers s ON s.id = t.server_id
        WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = ${callerId}) AND t.tool_name IN (${sql.join(tools)})
        ORDER BY s.name`.execute(db)
    ).rows.map((r) => String(r.name));
    const have = new Set(
      (await sql<any>`SELECT name FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ${robotId})`.execute(db)).rows.map((r) =>
        CodeNodeEmit.slug(String(r.name))
      )
    );
    return needed.filter((n) => !have.has(CodeNodeEmit.slug(n)));
  }

  /** The 422 body naming the first missing server. */
  static missingResponse(server: string): Record<string, any> {
    return {
      success: false,
      error_code: 'robot_server_missing',
      server,
      error: `The robot has no enabled "${server}" MCP server. Add it to the robot's connections.`,
      status_code: 422,
    };
  }
}
