import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { CodeNodeEmit, CodeNodeData } from './CodeNodeEmit';
import { CodeParent } from './CodeNodeStep';

/**
 * Runs one code node server-side: backend/scripts/code_node_run.py in a short-lived python3
 * process, the same harness the editor and compiled LangGraph use (frontend/assets/py). The node
 * reaches the user's MCP servers it checked, with their stored headers. Switched off with
 * CODE_NODES_SERVER_SIDE=0. Mirrors backend/src/AgentTeam/Services/CodeNodeExecutor.php.
 */
const RUNNER = path.resolve(__dirname, '../../../backend/scripts/code_node_run.py');
const HARNESS_DIR = path.resolve(__dirname, '../../../frontend/assets/py');
/** Extra seconds beyond the node's own timeout before the process is killed. */
const KILL_GRACE_S = 5;

export interface CodeNodeResult {
  ok: boolean;
  route?: string;
  output_text?: string;
  error?: string;
  stdout?: string;
  tool_calls?: Array<{ server: string; tool: string; ok: boolean; ms: number }>;
  [k: string]: any;
}

export class CodeNodeExecutor {
  constructor(private config: Record<string, any> = {}) {}

  /** PHP config code_nodes.server_side (ai_config: CODE_NODES_SERVER_SIDE, default on). */
  static enabled(config: Record<string, any> = {}): boolean {
    const set = config?.code_nodes?.server_side;
    if (set !== undefined && set !== null) return Boolean(set);
    return (process.env.CODE_NODES_SERVER_SIDE ?? '1') !== '0';
  }

  async run(
    node: any,
    edges: any[],
    nodeIds: Array<string | number>,
    userId: string,
    parents: CodeParent[],
    userPrompt: string
  ): Promise<{ data: CodeNodeData; result: CodeNodeResult }> {
    const servers = await this.servers(userId);
    const slugToUrl: Record<string, string> = {};
    for (const [slug, s] of Object.entries(servers)) slugToUrl[slug] = s.url;
    const data = CodeNodeEmit.nodeData(node, edges, slugToUrl, nodeIds);
    const cfgArgs = node?.config?.args;
    const picked: Record<string, any> = {};
    for (const slug of data.mcp_servers) if (Object.hasOwn(servers, slug)) picked[slug] = servers[slug];
    const request = {
      source: data.source, exits: data.exits, timeout_s: data.timeout_s,
      parents, user_prompt: userPrompt, name: data.display,
      // (object) in PHP: a list becomes {"0": ...}, an empty one {}.
      args: cfgArgs !== null && typeof cfgArgs === 'object' ? { ...cfgArgs } : {},
      servers: picked,
    };
    return { data, result: await this.spawn(request, data.timeout_s + KILL_GRACE_S) };
  }

  /** slug => {url, headers}: enabled global servers plus the user's own; the user's row wins a name clash. */
  async servers(userId: string): Promise<Record<string, { url: string; headers: Record<string, any> }>> {
    const rows = (
      await sql<any>`SELECT name, url, headers, user_id FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ${userId})`.execute(db)
    ).rows;
    // Globals first, own overwrite (a stable sort keeps the DB order within each group).
    const ordered = [...rows].sort((a, b) => Number(b.user_id === null) - Number(a.user_id === null));
    const out: Record<string, { url: string; headers: Record<string, any> }> = {};
    for (const r of ordered) {
      let headers: any = {};
      if (typeof r.headers === 'string') {
        try {
          headers = JSON.parse(r.headers) || {};
        } catch {
          headers = {};
        }
      } else if (r.headers !== null && typeof r.headers === 'object') {
        headers = r.headers; // mysql2 already decoded a JSON column
      }
      out[CodeNodeEmit.slug(String(r.name))] = { url: String(r.url), headers: { ...headers } };
    }
    return out;
  }

  private spawn(request: Record<string, any>, killAfterS: number): Promise<CodeNodeResult> {
    const python = String(this.config?.code_nodes?.python ?? process.env.CODE_NODE_PYTHON ?? 'python3');
    if (!fs.existsSync(RUNNER) || !fs.existsSync(HARNESS_DIR)) {
      throw new Error('code node runner files are missing (scripts/code_node_run.py, frontend/assets/py)');
    }
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;
      const done = (r: CodeNodeResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      let child;
      try {
        child = spawn(python, [RUNNER, HARNESS_DIR], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        done({ ok: false, error: `code node runner failed: could not start ${python} for the code node`, stdout: '', tool_calls: [] });
        return;
      }
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, killAfterS * 1000);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      // A child that died early closes the pipe: not an error here, the empty stdout reports it.
      child.stdin.on('error', () => {});
      child.on('error', (e: any) => {
        clearTimeout(timer);
        done({ ok: false, error: 'code node runner failed: ' + (e?.message ?? String(e)), stdout: '', tool_calls: [] });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (killed) {
          done({ ok: false, error: `code node timed out after ${killAfterS}s (process killed)`, stdout: '', tool_calls: [] });
          return;
        }
        let result: any = null;
        try {
          result = JSON.parse(stdout);
        } catch {
          result = null;
        }
        if (result === null || typeof result !== 'object') {
          done({
            ok: false,
            error: 'code node runner failed: ' + (stderr.trim() || stdout.trim() || `exit code ${code}`),
            stdout: '',
            tool_calls: [],
          });
          return;
        }
        done(result);
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
