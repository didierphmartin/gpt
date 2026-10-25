import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { AutomationMcp, CallRawAnswer } from './AutomationMcp';

/**
 * Production AutomationMcp: describe through the loader (like CodeNodeController), install by one JSON-RPC POST.
 * Mirrors backend/src/Automation/LiveAutomationMcp.php.
 */
export class LiveAutomationMcp implements AutomationMcp {
  async describe(userId: number, serverName: string, key: string): Promise<CallRawAnswer> {
    const loader = new MCPToolsLoader();
    await loader.loadToolsForUser(String(userId));
    const slug = serverName.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    // LoaderMcpExecutor::callRaw(slug, 'describe_item', {key})
    let entry: { original_name: string } | null = null;
    for (const meta of loader.getTools().values()) {
      if (String(meta.server_name).replace(/[^a-z0-9]+/gi, '_').toLowerCase() === slug && meta.original_name === 'describe_item') {
        entry = meta;
        break;
      }
    }
    if (entry === null) return { ok: false, error: `MCP tool '${slug}.describe_item' not found` };
    const r = await loader.executeToolRaw('mcp_' + entry.original_name, { key });
    if (r.error) return { ok: false, error: String(r.message ?? 'MCP tool execution failed') };
    return { ok: true, result: r.raw };
  }

  async install(url: string, headerLines: string[], args: Record<string, any>, timeoutSeconds: number): Promise<CallRawAnswer> {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: Math.floor(Date.now() / 1000), method: 'tools/call',
      params: { name: 'install_app', arguments: args },
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const line of headerLines) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    let resp: string;
    let http: number;
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
      http = r.status;
      resp = await r.text();
    } catch {
      return { ok: false, error: 'unreachable' };
    }
    if (http >= 400) {
      return { ok: false, error: 'http_' + http };
    }
    const data = [...resp.matchAll(/^data:\s?(.*)$/gm)];
    if (data.length > 0) {
      resp = data[data.length - 1][1];
    }
    let rpc: any;
    try {
      rpc = JSON.parse(resp);
    } catch {
      rpc = null;
    }
    if (rpc === null || typeof rpc !== 'object') {
      return { ok: false, error: 'bad_answer' };
    }
    if (rpc.error !== undefined && rpc.error !== null) {
      return { ok: false, error: typeof rpc.error === 'object' ? String(rpc.error.message ?? 'rpc_error') : 'rpc_error' };
    }
    return { ok: true, result: rpc.result ?? [] };
  }
}
