import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { WorkflowRepository, phpIntval, phpEmpty } from '../AgentTeam/WorkflowRepository';
import { IngestionCompiler } from '../AgentTeam/IngestionCompiler';
import { VectorMcpStore } from '../AgentTeam/VectorMcpStore';
import { IngestionLoader, LoaderDescriptor } from '../AgentTeam/IngestionLoader';
import { IngestionSplitter } from '../AgentTeam/IngestionSplitter';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';

/**
 * Shared parallel-run state. PHP persists this to /tmp files + a flock cursor
 * because each PHP request is a separate prefork process; the TS backend is a
 * SINGLE Node process, so the run record + claim cursor live in this
 * module-level Map (same call the SkillToolBridge/GraphWorkflowRunner port made).
 * `cursor++` is atomic across concurrent run-worker requests because Node is
 * single-threaded, so no lock is needed to mirror PHP's flock claim.
 */
interface RunState {
  config: Record<string, any>;
  descriptors: LoaderDescriptor[];
  cursor: number;
  /** ms creation stamp for the 2h TTL sweep (mirrors PHP filemtime housekeeping). */
  createdAt: number;
}
const ingestionRuns = new Map<string, RunState>();

/** PHP trim() charset. */
const PHP_WS = ' \t\n\r\0\x0B';
function phpTrim(v: any): string {
  const s = v === undefined || v === null ? '' : String(v);
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.indexOf(s[start]) !== -1) start++;
  while (end > start && PHP_WS.indexOf(s[end - 1]) !== -1) end--;
  return s.slice(start, end);
}

/** PHP (string) cast (bool true->'1', false->'', else String). */
function phpStrval(v: any): string {
  if (v === true) return '1';
  if (v === false) return '';
  if (v === null || v === undefined) return '';
  return String(v);
}

/** PHP is_scalar(): int/float/string/bool. */
function isScalar(v: any): boolean {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/** PHP mb_strlen(..,'UTF-8'): code-point count. */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Mirrors src/AgentTeam/Controllers/IngestionController.php — slice 1: `compile` (already ported),
 * plus `nodeCode`, `saveScript`, `storeFind`, and the JSON-RPC MCP session client used by the
 * vector-store endpoints. The run-start/run-worker/run-stream + loader/splitter/store-chunks
 * endpoints and `buildLoaderClosures` are slice 2 and intentionally not present here.
 */
export class IngestionController {
  private workflowRepository = new WorkflowRepository();

  /** PHP `(array)($x ?? [])` for a json body field (object passes through, else {}). */
  private asArr(v: any): Record<string, any> {
    return v !== null && typeof v === 'object' ? v : {};
  }

  /** POST /api/v1/workflows/{id}/ingestion/compile */
  async compile(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const workflowId = phpIntval(ctx.params?.id ?? 0);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }
    if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
      return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
    }

    const body: any = ctx.body ?? {};
    const loader = this.asArr(body.loader ?? []);
    const splitter = this.asArr(body.splitter ?? []);
    const store = this.asArr(body.vectorstore ?? []);

    // Resolve runtime URLs: langfs (from the loader's storage MCP) and mcp_qrant (from store:"mcp:<id>").
    const context: Record<string, any> = {};
    if (!phpEmpty(loader.storage_mcp_url)) {
      context.langfs_url = String(loader.storage_mcp_url);
    }
    const m = String(store.store ?? '').match(/^mcp:(\d+)$/);
    if (m) {
      const row = (
        await sql<any>`SELECT url FROM mcp_servers WHERE id = ${phpIntval(m[1])} AND enabled = 1`.execute(db)
      ).rows[0];
      if (row) {
        context.mcpqrant_url = String(row.url);
      }
    }

    try {
      const r = IngestionCompiler.compileScript(loader, splitter, store, context);

      // gpt/langchain_runner (3 levels up from src/Controllers), matching PHP dirname(__DIR__,4)=gpt
      // and saveScript's repoRoot. Was ../../../.. (htdocs) — an off-by-one.
      const filePath = path.resolve(__dirname, '../../../langchain_runner', path.basename(r.filename));
      let written = true;
      try {
        fs.writeFileSync(filePath, r.code);
      } catch {
        written = false;
      }

      return {
        success: true,
        data: {
          filename: r.filename,
          path: written ? filePath : null,
          written,
          code: r.code,
        },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 400 };
    }
  }

  /**
   * POST /api/v1/workflows/{id}/ingestion/node-code
   * Compile the Python chunk for a SINGLE node (or the cumulative view of ordered
   * stages) from the config the frontend sends.
   */
  async nodeCode(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const workflowId = phpIntval(ctx.params?.id ?? 0);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }
    if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
      return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
    }

    const body: any = ctx.body ?? {};
    const stages = body.stages ?? null;

    try {
      let view: { input: string; generated: string; output: string };
      let nodeType: string;
      if (stages !== null && typeof stages === 'object' && !phpEmpty(stages)) {
        // Ordered pipeline stages (start … target) → cumulative view.
        const stagesArr: any[] = Array.isArray(stages) ? stages : Object.values(stages);
        view = IngestionCompiler.compileView(stagesArr);
        const last = stagesArr[stagesArr.length - 1] ?? {};
        nodeType = String(last?.node_type ?? last?.type ?? 'loader');
      } else {
        // Single node fallback.
        nodeType = String(body.node_type ?? 'loader');
        view = IngestionCompiler.compileNodeView(nodeType, this.asArr(body.config ?? []));
      }
      return {
        success: true,
        data: { node: nodeType, ...view },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 400 };
    }
  }

  /**
   * POST /api/v1/workflows/{id}/ingestion/save-script
   * Store an already-compiled ingestion script to a chosen location (default:
   * the langchain_runner/ Python env). Body: { code, dest?, filename? }.
   */
  async saveScript(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const workflowId = phpIntval(ctx.params?.id ?? 0);
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId || !(await this.workflowRepository.canUserAccess(userId, workflowId))) {
      return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
    }

    const body: any = ctx.body ?? {};
    const code = phpStrval(body.code ?? '');
    const dest = phpTrim(body.dest ?? '');
    let filename = path.posix.basename(phpTrim(body.filename ?? ''));
    if (code === '') {
      return { success: false, error: 'Nothing to save (empty script).', status_code: 400 };
    }
    if (filename === '') {
      filename = 'ingestion_pipeline.py';
    }
    if (!filename.endsWith('.py')) {
      filename += '.py';
    }

    // PHP dirname(__DIR__, 4) from src/AgentTeam/Controllers = the gpt repo root.
    // Here from src/Controllers the gpt repo root is three levels up.
    const repoRoot = path.resolve(__dirname, '../../..');
    const defaultDir = repoRoot + '/langchain_runner';

    // Resolve the destination directory.
    let dir: string;
    if (dest === '') {
      dir = defaultDir;
    } else if (dest.endsWith('.py')) {
      dir = path.posix.dirname(dest);
      filename = path.posix.basename(dest);
    } else if (dest[0] === '/' || dest[0] === '~') {
      dir = dest.startsWith('~') ? (process.env.HOME ?? '') + dest.substring(1) : dest;
    } else {
      dir = repoRoot + '/' + dest;
    }
    dir = dir.replace(/\/+$/, '');

    if (!this.isDir(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o775 });
      } catch {
        /* fall through to the re-check */
      }
      if (!this.isDir(dir)) {
        return { success: false, error: `Could not create directory: ${dir}`, status_code: 400 };
      }
    }
    const filePath = dir + '/' + filename;
    try {
      fs.writeFileSync(filePath, code);
    } catch {
      return { success: false, error: `Could not write to: ${filePath}`, status_code: 400 };
    }
    return { success: true, data: { path: filePath, default_dir: defaultDir }, status_code: 200 };
  }

  /** PHP is_dir(). */
  private isDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * POST /api/v1/workflows/{id}/ingestion/store-find
   * Retrieval test panel: run `find` against the store node's vector-DB MCP and
   * return the matched chunks. Body: { vectorstore: { store:"mcp:<id>",
   * collection?, provider?, connection?, embedding? }, query }.
   */
  async storeFind(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const workflowId = phpIntval(ctx.params?.id ?? 0);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }
    if (!(await this.workflowRepository.canUserAccess(userId, workflowId))) {
      return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
    }

    const body: any = ctx.body ?? {};
    const storeCfg = this.asArr(body.vectorstore ?? []);
    const query = phpTrim(body.query ?? '');
    const collection = phpTrim(storeCfg.collection ?? '');
    const provider = phpTrim(storeCfg.provider ?? '');
    const connection = this.asArr(storeCfg.connection ?? []);
    const embedding = phpTrim(storeCfg.embedding ?? '');

    if (query === '') {
      return { success: false, error: 'Enter a search query.', status_code: 400 };
    }
    const m = String(storeCfg.store ?? '').match(/^mcp:(\d+)$/);
    if (!m) {
      return { success: false, error: 'Pick a vector-DB MCP server in the store node.', status_code: 400 };
    }
    const serverId = phpIntval(m[1]);
    // headers is a MySQL json column; mysql2 auto-parses it, but mcpBaseHeaders wants the raw
    // json string (PHP json_decodes it), so CAST AS CHAR to get the original text.
    const srv = (
      await sql<any>`SELECT url, CAST(headers AS CHAR) AS headers FROM mcp_servers WHERE id = ${serverId} AND enabled = 1`.execute(
        db
      )
    ).rows[0];
    if (!srv) {
      return { success: false, error: `Vector MCP server #${serverId} not found or disabled.`, status_code: 400 };
    }
    if (collection === '') {
      return { success: false, error: 'Set a collection name in the store node.', status_code: 400 };
    }

    const vs = new VectorMcpStore((_sid: number, tool: string, args: any) =>
      this.callMcpServer(String(srv.url), srv.headers ?? null, tool, args)
    );
    let find: { results: Array<{ text: string; metadata: any; score: number | null }> };
    try {
      find = await vs.find(serverId, query, {
        provider,
        connection,
        collection,
        embedding: embedding !== '' ? embedding : null,
        limit: 5,
      });
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 400 };
    }
    // Map the MCP's {text,metadata,score} to the Search panel's {content,source,score}.
    const results = find.results.map((r) => ({
      content: r.text,
      source: r.metadata?.source ?? null,
      score: r.score,
    }));
    return {
      success: true,
      data: { query, results },
      status_code: 200,
    };
  }

  /**
   * POST /api/v1/workflows/{id}/ingestion/run-start
   * Parallel run, step 1: enumerate the source ONCE and create a shared run
   * record ({run_id, count}). The frontend then opens K concurrent run-worker
   * streams that pull files from the shared cursor. Body: { loader, splitter?,
   * vectorstore? }.
   */
  async runStart(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const workflowId = phpIntval(ctx.params?.id ?? 0);
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    if (!workflowId || !(await this.workflowRepository.canUserAccess(userId, workflowId))) {
      return { success: false, error: 'Workflow not found or access denied', status_code: 404 };
    }

    const body: any = ctx.body ?? {};
    const loaderCfg = this.asArr(body.loader ?? []);
    // PHP isset() — false when the key is absent OR the value is null.
    const hasSplitter = body.splitter !== undefined && body.splitter !== null;
    const hasStore = body.vectorstore !== undefined && body.vectorstore !== null;
    const splitterCfg = this.asArr(body.splitter ?? []);
    const storeCfg = this.asArr(body.vectorstore ?? []);

    // PHP `(string)(... ?? 'local') ?: 'local'` — `?:` treats '' AND '0' as falsy.
    const providerRaw = phpStrval(loaderCfg.provider ?? 'local');
    const provider = providerRaw === '' || providerRaw === '0' ? 'local' : providerRaw;
    const path = phpTrim(loaderCfg.path ?? '');
    const isDir = !phpEmpty(loaderCfg.is_dir);
    const types = (Array.isArray(loaderCfg.types) ? loaderCfg.types : Object.values(loaderCfg.types ?? {})).filter(
      (t: any) => typeof t === 'string'
    ) as string[];

    if (path === '') {
      return { success: false, error: 'The loader has no Source set.', status_code: 400 };
    }

    let serverId = 0;
    let srv: any = null;
    if (hasStore) {
      const m = String(storeCfg.store ?? '').match(/^mcp:(\d+)$/);
      if (!m) {
        return { success: false, error: 'The store node needs a vector-DB MCP server selected.', status_code: 400 };
      }
      serverId = phpIntval(m[1]);
      // headers is a MySQL json column; CAST AS CHAR to get the raw json string
      // (mcpBaseHeaders json-parses it, mirroring PHP), not the auto-parsed object.
      srv = (
        await sql<any>`SELECT url, CAST(headers AS CHAR) AS headers FROM mcp_servers WHERE id = ${serverId} AND enabled = 1`.execute(
          db
        )
      ).rows[0];
      if (!srv) {
        return { success: false, error: `Vector MCP server #${serverId} not found or disabled.`, status_code: 400 };
      }
      if (phpTrim(storeCfg.collection ?? '') === '') {
        return { success: false, error: 'Set a collection name in the store node.', status_code: 400 };
      }
    }

    const [listFiles] = this.buildLoaderClosures(userId, phpStrval(loaderCfg.storage_mcp_id ?? ''));
    let descriptors: LoaderDescriptor[];
    try {
      descriptors = await IngestionLoader.enumerateFiles(listFiles, provider, path, types, isDir);
    } catch (e: any) {
      return { success: false, error: 'Loader enumeration failed: ' + (e?.message ?? ''), status_code: 400 };
    }
    const count = descriptors.length;
    if (count === 0) {
      return { success: true, data: { run_id: null, count: 0 }, status_code: 200 };
    }

    const runId = crypto.randomBytes(8).toString('hex');
    const config: Record<string, any> = {
      user_id: Number(userId),
      has_splitter: hasSplitter,
      has_store: hasStore,
      chunk_size: Math.max(1, phpIntval(splitterCfg.chunk_size ?? 1000)),
      overlap: Math.max(0, phpIntval(splitterCfg.overlap ?? 150)),
      collection: phpTrim(storeCfg.collection ?? ''),
      provider: phpTrim(storeCfg.provider ?? ''),
      connection: this.asArr(storeCfg.connection ?? []),
      embedding: phpTrim(storeCfg.embedding ?? ''),
      server_id: serverId,
      server_url: srv?.url ?? null,
      server_headers: srv?.headers ?? null,
    };
    ingestionRuns.set(runId, { config, descriptors, cursor: 0, createdAt: Date.now() });
    this.cleanupOldRuns();

    return { success: true, data: { run_id: runId, count }, status_code: 200 };
  }

  /**
   * POST /api/v1/workflows/{id}/ingestion/run-worker  (SSE)
   * Parallel run, step 2 — ONE worker. Repeatedly CLAIMS the next file from the
   * shared in-memory cursor and processes it (read→decode→split→store),
   * streaming logs/progress. K of these run concurrently = work-stealing across
   * requests. Body: { run_id }. Streaming is owned by the raw route handler,
   * which writes each emitted event as `data: <json>\n\n` and terminates the
   * stream — mirroring PHP's `$sse(...)` / `$done()` sentinel.
   */
  async runWorker(ctx: Ctx, sse: (event: Record<string, any>) => void, isAborted: () => boolean): Promise<void> {
    const userId = Number(ctx.user_id ?? 0);
    if (!userId) {
      sse({ type: 'error', error: 'Authentication required' });
      return;
    }
    const runId = phpStrval((ctx.body ?? {}).run_id ?? '');
    if (!/^[a-f0-9]{16}$/.test(runId)) {
      sse({ type: 'error', error: 'Invalid run id' });
      return;
    }
    const run = ingestionRuns.get(runId);
    if (!run) {
      sse({ type: 'error', error: 'Run not found (it may have expired).' });
      return;
    }
    const config = run.config ?? {};
    const descriptors = run.descriptors ?? [];
    if (phpIntval(config.user_id ?? -1) !== Number(userId)) {
      sse({ type: 'error', error: 'Access denied' });
      return;
    }
    const count = descriptors.length;

    // NOTE (PHP quirk, faithfully mirrored): PHP reads $config['loader']['storage_mcp_id'],
    // but runStart never stores a 'loader' key in $config, so this is always '' — the loader
    // closures here are therefore never scoped to a storage server. Same here.
    const [, readFile] = this.buildLoaderClosures(userId, phpStrval((config.loader?.storage_mcp_id) ?? ''));

    let vs: VectorMcpStore | null = null;
    const serverId = phpIntval(config.server_id ?? 0);
    if (!phpEmpty(config.has_store)) {
      const url = phpStrval(config.server_url ?? '');
      const hdrs = (config.server_headers ?? null) as string | null;
      const sess = await this.openMcpSession(url, this.mcpBaseHeaders(hdrs));
      if (!phpEmpty(sess.error)) {
        sse({ type: 'error', error: 'Vector store connection failed: ' + (sess.message ?? 'session error') });
        return;
      }
      const sessHeaders = sess.headers!;
      vs = new VectorMcpStore((_sid: number, tool: string, args: any) => this.callMcpTool(url, sessHeaders, tool, args));
    }

    const chunkSize = phpIntval(config.chunk_size);
    const overlap = phpIntval(config.overlap);
    const collection = phpStrval(config.collection ?? '');
    const provider = phpStrval(config.provider ?? '');
    const connection = this.asArr(config.connection ?? []);
    const embedding = phpStrval(config.embedding ?? '');
    const hasSplitter = !phpEmpty(config.has_splitter);

    let files = 0;
    let chunks = 0;
    let stored = 0;
    let errors = 0;
    while (true) {
      if (isAborted()) {
        break;
      }
      const i = this.claimNextFile(runId, count);
      if (i === null) {
        break; // exhausted — every file claimed
      }
      const desc = descriptors[i];
      const src = phpStrval(desc.source ?? '?') || '?';
      let text: string;
      try {
        text = await IngestionLoader.loadFile(readFile, desc);
      } catch (e: any) {
        errors++;
        sse({ type: 'log', lines: [`[loader] ${src}: ERROR — ` + (e?.message ?? '')] });
        continue;
      }
      sse({
        type: 'log',
        lines: [`[loader] ${i + 1}/${count}: ${src} → ` + (desc.doc_type ?? '?') + ', ' + cpLen(text) + ' chars'],
      });
      const ch = IngestionSplitter.recursiveSplit(text, chunkSize, overlap);
      chunks += ch.length;
      if (hasSplitter) {
        sse({ type: 'log', lines: [`[splitter] ${src}: ${ch.length} chunk(s) (size=${chunkSize}, overlap=${overlap})`] });
      }
      if (vs !== null) {
        try {
          const r = await vs.store(serverId, ch, {
            provider,
            connection,
            collection: collection !== '' ? collection : null,
            embedding: embedding !== '' ? embedding : null,
            metadata: { source: src },
          });
          stored += r.stored;
          errors += r.errors;
          sse({
            type: 'log',
            lines: [
              `[store] ${src}: wrote ${r.stored} chunk(s)` +
                (r.errors ? ` (${r.errors} failed)` : '') +
                ` on mcp:${serverId}`,
            ],
          });
        } catch (e: any) {
          errors++;
          sse({ type: 'log', lines: [`[store] ${src}: ERROR — ` + (e?.message ?? '')] });
          continue;
        }
      }
      files++;
      sse({ type: 'progress', index: i, count, files, chunks, stored });
    }

    sse({ type: 'done', files, chunks, stored, errors, wrote: !phpEmpty(config.has_store) });
  }

  // ---- JSON-RPC MCP session client (vector-store / storage MCP) --------------

  /**
   * Call ONE specific MCP server (url + stored headers) for a tool: open a
   * session (initialize → capture Mcp-Session-Id → notifications/initialized),
   * then tools/call. Returns the JSON-RPC result, or {error:true,message}.
   */
  private async callMcpServer(
    url: string,
    headersJson: string | null,
    tool: string,
    args: any
  ): Promise<Record<string, any>> {
    const sess = await this.openMcpSession(url, this.mcpBaseHeaders(headersJson));
    if (!phpEmpty(sess.error)) {
      return sess as Record<string, any>;
    }
    return this.callMcpTool(url, sess.headers!, tool, args);
  }

  /** Build the base headers (content/accept + the server's stored auth headers). */
  private mcpBaseHeaders(headersJson: string | null): Record<string, string> {
    const base: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (headersJson && headersJson !== '0') {
      let h: any = null;
      try {
        h = JSON.parse(headersJson);
      } catch {
        h = null;
      }
      if (h !== null && typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) {
          if (typeof k === 'string' && k !== '' && isScalar(v)) {
            const key = k.replace(/[\r\n:]/g, '');
            const val = phpStrval(v).replace(/[\r\n]/g, '');
            base[key] = val;
          }
        }
      }
    }
    return base;
  }

  /**
   * Open a Streamable-HTTP session ONCE: initialize (capture the Mcp-Session-Id
   * response header) → notifications/initialized. Returns {headers} to reuse for
   * every subsequent tools/call.
   */
  private async openMcpSession(
    url: string,
    base: Record<string, string>
  ): Promise<{ headers?: Record<string, string>; error?: boolean; message?: string }> {
    const init = await this.mcpPost(url, base, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gpt-ingestion', version: '1' },
      },
    });
    if (!phpEmpty(init.body.error)) {
      return init.body;
    }
    const callHeaders = { ...base };
    if (init.session) {
      callHeaders['Mcp-Session-Id'] = init.session;
      await this.mcpPost(url, callHeaders, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    }
    return { headers: callHeaders };
  }

  /** One tools/call on an already-opened session. Returns the JSON-RPC result, or {error:true,...}. */
  private async callMcpTool(
    url: string,
    callHeaders: Record<string, string>,
    tool: string,
    args: any
  ): Promise<Record<string, any>> {
    const isEmptyArgs =
      (Array.isArray(args) && args.length === 0) ||
      (args !== null && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0);
    const res = await this.mcpPost(url, callHeaders, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: isEmptyArgs ? {} : args },
    });
    return this.interpretToolResult(res.body);
  }

  /**
   * One JSON-RPC POST to an MCP server. Captures the Mcp-Session-Id response
   * header, parses a JSON or SSE body, and normalizes a JSON-RPC error. A
   * bodyless notification ack (202) normalizes to {ok:true}.
   */
  private async mcpPost(
    url: string,
    headers: Record<string, string>,
    payload: any
  ): Promise<{ body: Record<string, any>; session: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    } catch (e: any) {
      clearTimeout(timer);
      return { body: { error: true, message: `MCP connection failed: ${e?.message ?? e}` }, session: null };
    }
    clearTimeout(timer);

    const sessionHeader = res.headers.get('mcp-session-id');
    const session = sessionHeader !== null ? sessionHeader.trim() : null;
    const code = res.status;
    if (code >= 400) {
      return { body: { error: true, message: `MCP server returned HTTP ${code}` }, session };
    }
    const resp = await res.text().catch(() => '');
    return { body: this.normalizeMcpBody(resp), session };
  }

  /** Decode a JSON or SSE MCP body into a JSON-RPC object, normalizing errors. */
  private normalizeMcpBody(resp: string | null): Record<string, any> {
    let parsed: any;
    try {
      parsed = JSON.parse(resp ?? '');
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      for (const rawLine of (resp ?? '').split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('data:')) {
          const d = line.substring(5).trim();
          if (d !== '') {
            let p: any = null;
            try {
              p = JSON.parse(d);
            } catch {
              p = null;
            }
            if (p !== null) {
              parsed = p;
              break;
            }
          }
        }
      }
    }
    if (!(parsed !== null && typeof parsed === 'object')) {
      return { ok: true }; // e.g. 202 Accepted for a notification
    }
    if (parsed.error !== undefined && parsed.error !== null) {
      return { error: true, message: phpStrval(parsed.error?.message ?? 'MCP error') };
    }
    return parsed;
  }

  /** From a parsed JSON-RPC response, return the tool result or an error (handles result.isError). */
  private interpretToolResult(res: Record<string, any>): Record<string, any> {
    if (!phpEmpty(res.error)) {
      return res;
    }
    const result = res.result ?? res;
    if (result !== null && typeof result === 'object' && !phpEmpty(result.isError)) {
      let msg = '';
      for (const c of result.content ?? []) {
        if (c && c.text !== undefined && c.text !== null) {
          msg += phpStrval(c.text);
        }
      }
      return { error: true, message: msg !== '' ? msg : 'MCP tool error' };
    }
    return result !== null && typeof result === 'object' ? result : { ok: true };
  }

  // ---- Parallel-run state (in-memory) + loader closures ----------------------

  /**
   * Atomically claim the next file index from the shared in-memory cursor.
   * Node is single-threaded so `cursor++` never races across concurrent
   * run-worker requests (mirrors PHP's flock claim, no lock needed). Returns the
   * claimed index, or null when the run is exhausted (cursor reached count).
   */
  private claimNextFile(runId: string, count: number): number | null {
    const st = ingestionRuns.get(runId);
    if (!st || st.cursor >= count) {
      return null;
    }
    return st.cursor++;
  }

  /** Drop run entries older than 2h (best-effort housekeeping; mirrors PHP's 7200s TTL). */
  private cleanupOldRuns(): void {
    const cutoff = Date.now() - 7200 * 1000;
    for (const [id, st] of ingestionRuns) {
      if (st.createdAt < cutoff) {
        ingestionRuns.delete(id);
      }
    }
  }

  /**
   * Build the two injected MCP callables the loader needs (list_files /
   * read_file against the registered UniversalFS/langfs storage). Scopes MCP
   * dispatch to the chosen storage server (by name) so the tools resolve to
   * langfs, not another server that also exposes them.
   */
  private buildLoaderClosures(
    userId: number | string,
    storageMcpId: string | null = null
  ): [(provider: string, folder: string) => Promise<any>, (provider: string, fileId: string) => Promise<any>] {
    const mcp = new MCPToolsLoader();
    let allowed: string[] | null = null;
    const loadReady: Promise<void> = (async () => {
      if (storageMcpId !== null && storageMcpId !== '') {
        const row = (await sql<any>`SELECT name FROM mcp_servers WHERE id = ${storageMcpId}`.execute(db)).rows[0];
        if (row && row.name !== undefined && row.name !== null) {
          allowed = [String(row.name)];
        }
      }
      await mcp.loadToolsForUser(String(userId), allowed);
    })();

    const listFiles = async (provider: string, folder: string): Promise<any> => {
      await loadReady;
      const args: Record<string, any> = { provider };
      if (folder !== '') {
        args.path = folder;
      }
      const res = await mcp.executeTool('list_files', args);
      if (!phpEmpty(res.error)) {
        throw new Error(phpStrval(res.message ?? 'list_files failed'));
      }
      let decoded: any = null;
      try {
        decoded = JSON.parse(phpStrval(res.result ?? ''));
      } catch {
        decoded = null;
      }
      return decoded !== null && typeof decoded === 'object' ? decoded : { files: [] };
    };

    // Read one file via langfs, which extracts text server-side:
    //  - langfs: {"content":"<text>"}              → {is_text:true}.
    //  - langfs error: {"error":true,"message":…}  → throw that message.
    // The legacy UniversalFS base64 raw-bytes path (is_text=false + local decode) was removed —
    // langfs is the only storage backend now, so a response without `content` is an error.
    const readFile = async (provider: string, fileId: string): Promise<any> => {
      await loadReady;
      const res = await mcp.executeTool('read_file', {
        provider,
        file_id: fileId,
        format: 'text', // langfs: extracted text
      });
      if (!phpEmpty(res.error)) {
        throw new Error(phpStrval(res.message ?? 'read_file failed'));
      }
      const raw = phpStrval(res.result ?? '');
      let decoded: any = null;
      try {
        decoded = JSON.parse(raw);
      } catch {
        decoded = null;
      }
      if (decoded !== null && typeof decoded === 'object') {
        if (!phpEmpty(decoded.error)) {
          throw new Error(phpStrval(decoded.message ?? 'read_file error'));
        }
        if (Object.prototype.hasOwnProperty.call(decoded, 'content')) {
          return { is_text: true, data: phpStrval(decoded.content) };
        }
      }
      throw new Error('read_file did not return {content} extracted text (langfs required).');
    };

    return [listFiles, readFile];
  }
}
