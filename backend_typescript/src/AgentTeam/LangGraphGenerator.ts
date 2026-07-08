import { sql } from 'kysely';
import { db } from '../db/pools';
import { WorkflowRepository, WorkflowGraphRepository, phpIntval } from './WorkflowRepository';
import { AgentRepository, agentToArray } from './AgentRepository';
import {
  mcpClientBlock,
  toolBuilderBlock,
  stateBlock,
  datetimeInjectorBlock,
  contextBuilderBlock,
  documentConverterBlock,
  parentsChildrenBlock,
  runHeaderBlock,
  runBodyBlock,
} from './pyBlocks';

/**
 * LangGraph Generator — faithful TypeScript mirror of
 * src/AgentTeam/Services/LangGraphGenerator.php.
 *
 * Generates a standalone Python LangGraph script from a saved workflow. The
 * output is intended to be BYTE-FOR-BYTE identical to the PHP generator's
 * output (the PHP itself mirrors langchain_runner/code_generator.py).
 *
 * Byte-fidelity notes:
 *  - The static Python code blocks live in pyBlocks.ts, extracted verbatim from
 *    the PHP nowdoc <<<'PY' heredocs (each ends in exactly one '\n').
 *  - Prompt wrapping is done in the BYTE domain (PHP strlen/wordwrap operate on
 *    bytes), so the result `code` is a Buffer.
 *  - json_encode is emulated to match PHP's JSON_UNESCAPED_SLASHES |
 *    JSON_UNESCAPED_UNICODE (plus PHP always escaping U+2028/U+2029).
 */

// ---------- byte / php helpers ----------

const NL = Buffer.from('\n');

/**
 * PHP-faithful float serialization. The LIVE server runs with serialize_precision = 100, so
 * json_encode of a (float) emits the FULL EXACT DECIMAL EXPANSION of the IEEE-754 double
 * (e.g. 0.7 -> "0.6999999999999999555910790149937383830547332763671875"), while integer-valued
 * floats print with no decimal (1.0 -> "1", 0.0 -> "0"). Reproduces that exactly via BigInt.
 */
function phpFloatExact(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return Object.is(x, -0) ? '-0' : String(x); // PHP: 1.0 -> "1", 0.0 -> "0"
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(x);
  const bits = buf.readBigUInt64LE();
  const sign = (bits >> 63n) & 1n;
  let exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn;
  if (exp === 0) {
    exp = 1;
  } else {
    mant |= 0x10000000000000n;
  }
  exp -= 1075;
  let num = mant;
  let den = 1n;
  if (exp >= 0) num = mant << BigInt(exp);
  else den = 1n << BigInt(-exp);
  const intPart = num / den;
  let rem = num % den;
  let s = intPart.toString();
  if (rem > 0n) {
    s += '.';
    let frac = '';
    while (rem > 0n) {
      rem *= 10n;
      frac += (rem / den).toString();
      rem %= den;
    }
    s += frac;
  }
  return (sign ? '-' : '') + s;
}

// Sentinel used to splice exact float decimals into a JSON.stringify result. Present only
// transiently inside phpJsonStringify (always fully replaced before return).
const FLOAT_SENTINEL = ' __PHP_FLOAT_SENTINEL_8b41f2__ ';

/**
 * PHP json_encode emulation that, like the LIVE server (serialize_precision = 100), prints the
 * exact decimal expansion for every genuine float while leaving integers as integers. Strings,
 * structure and (pretty) 4-space indentation come from JSON.stringify (which matches PHP's
 * JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE byte-for-byte); then U+2028/U+2029 are escaped
 * and float sentinels are swapped for phpFloatExact() expansions. A non-integer JS number is a
 * PHP float; an integer-valued JS number serializes identically whether PHP saw it as int or as
 * an integer-valued float (both print with no decimal), so only non-integers need the sentinel.
 */
function phpJsonStringify(value: any, pretty: boolean): string {
  const floats: string[] = [];
  const replacer = (_key: string, val: any): any => {
    if (typeof val === 'number' && Number.isFinite(val) && !Number.isInteger(val)) {
      const idx = floats.length;
      floats.push(phpFloatExact(val));
      return FLOAT_SENTINEL + idx + FLOAT_SENTINEL;
    }
    return val;
  };
  let s = pretty ? JSON.stringify(value, replacer, 4) : JSON.stringify(value, replacer);
  s = fixSep(s);
  if (floats.length > 0) {
    const enc = JSON.stringify(FLOAT_SENTINEL).slice(1, -1); // escaped form, no surrounding quotes
    for (let i = 0; i < floats.length; i++) {
      s = s.split('"' + enc + i + enc + '"').join(floats[i]);
    }
  }
  return s;
}

/** PHP json_encode(..., JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), compact. */
function jsonEncode(v: any): string {
  return phpJsonStringify(v, false);
}

/** PHP always escapes U+2028 / U+2029 even with JSON_UNESCAPED_UNICODE; JS does not. */
function fixSep(s: string): string {
  return s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** PHP str_replace on ': true'/': false'/': null' (global, including inside strings — a quirk). */
function boolToPy(s: string): string {
  return s.split(': true').join(': True').split(': false').join(': False').split(': null').join(': None');
}

/**
 * jsonToPython: json_encode(value, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)
 * then ': true'->': True', ': false'->': False', ': null'->': None'. PHP's JSON_PRETTY_PRINT uses
 * 4-space indent and ': ' / ',\n' separators — JSON.stringify(_, null, 4) matches byte-for-byte.
 * forceObject casts an empty top-level array to {} (handled by the caller building objects/Maps).
 */
function jsonToPython(value: any): string {
  return boolToPy(phpJsonStringify(value, true));
}

/** Flat string->string dict, pretty-printed in INSERTION order (JSON.stringify reorders int keys). */
function pyDictFlat(entries: Array<[string, string]>): string {
  if (entries.length === 0) return '{}';
  const inner = entries.map(([k, v]) => `    ${jsonEncode(String(k))}: ${jsonEncode(v)}`).join(',\n');
  return boolToPy(`{\n${inner}\n}`);
}

/** Mirror json_decode($s,true) then json_encode: empty objects collapse to []. */
function phpAssocReencode(x: any): any {
  if (Array.isArray(x)) return x.map(phpAssocReencode);
  if (x !== null && typeof x === 'object') {
    const keys = Object.keys(x);
    if (keys.length === 0) return [];
    const o: any = {};
    for (const k of keys) o[k] = phpAssocReencode(x[k]);
    return o;
  }
  return x;
}

const PHP_WS = /[ \t\n\r\0\x0B]/;
function phpRtrim(s: string): string {
  let end = s.length;
  while (end > 0 && PHP_WS.test(s[end - 1])) end--;
  return s.slice(0, end);
}
function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.test(s[start])) start++;
  while (end > start && PHP_WS.test(s[end - 1])) end--;
  return s.slice(start, end);
}

/** PHP (float) cast: parse leading numeric, else 0. */
function phpFloatval(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const m = String(v).match(/^[ \t\n\r\v\f]*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/);
  return m ? parseFloat(m[0]) : 0;
}

/** PHP empty() for arrays/strings (used for the few empty() checks here). */
function isEmpty(v: any): boolean {
  if (v === undefined || v === null) return false ? false : true;
  if (v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ---------- byte-domain wordwrap (matches PHP byte-based wordwrap) ----------

function splitBuffer(buf: Buffer, delim: number): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === delim) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  parts.push(buf.subarray(start));
  return parts;
}

/** Faithful port of PHP wordwrap(text, width, "\n", cut=true) operating on bytes. */
function phpWordwrapBytes(buf: Buffer, width: number, cut: boolean): Buffer {
  const out: number[] = [];
  let laststart = 0;
  let lastspace = 0;
  const BRK = 0x0a;
  const SP = 0x20;
  for (let current = 0; current < buf.length; current++) {
    const ch = buf[current];
    if (ch === BRK) {
      out.push(BRK);
      laststart = lastspace = out.length;
    } else if (ch === SP) {
      if (out.length - laststart >= width) {
        out.push(BRK);
        laststart = lastspace = out.length;
      } else {
        out.push(SP);
        lastspace = out.length - 1;
      }
    } else if (out.length - laststart >= width && cut && laststart >= lastspace) {
      out.push(BRK);
      laststart = lastspace = out.length;
      out.push(ch);
    } else if (out.length - laststart >= width && laststart < lastspace) {
      out[lastspace] = BRK;
      laststart = lastspace + 1;
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  return Buffer.from(out);
}

/** Escape a prompt for a triple-quoted Python string: '\\'->'\\\\', '"""'->'\"\"\"'. */
function escapePrompt(s: string): string {
  return s.split('\\').join('\\\\').split('"""').join('\\"\\"\\"');
}

/** Mirror the per-line strlen<=80 ? line : wordwrap(line,80) logic, on bytes. Returns Buffers. */
function wrapPromptToBuffers(escaped: string): Buffer[] {
  const buf = Buffer.from(escaped, 'utf8');
  const segs = splitBuffer(buf, 0x0a);
  return segs.map((seg) => (seg.length <= 80 ? seg : phpWordwrapBytes(seg, 80, true)));
}

// ---------- node helpers ----------

function asObj(v: any): any {
  return v !== null && typeof v === 'object' ? v : {};
}

function nodeType(n: any): string {
  const cfg = asObj(n.config);
  return String(n.node_type ?? n.type ?? (cfg.type ?? '') ?? '');
}

function nodeId(n: any): string {
  return String(n.id ?? n.drawflow_node_id ?? (n._id ?? ''));
}

function edgeFrom(e: any): string {
  return String(e.from_node_id ?? e.from ?? (e.source ?? ''));
}

function edgeTo(e: any): string {
  return String(e.to_node_id ?? e.to ?? (e.target ?? ''));
}

function children(nid: string, edges: any[]): string[] {
  const out: string[] = [];
  const s = String(nid);
  for (const e of edges) {
    if (edgeFrom(e) === s) out.push(edgeTo(e));
  }
  return out;
}

function providerMaxTokensDefault(provider: string): number {
  switch (provider) {
    case 'claude':
    case 'anthropic':
      return 32000;
    case 'openai':
    case 'grok':
      return 16000;
    case 'gemini':
    case 'google':
    case 'kimi':
    case 'moonshot':
    case 'deepseek':
    default:
      return 8000;
  }
}

function displayName(node: any): string {
  const cfg = asObj(node.config);
  const name = cfg.agent_name ?? cfg.name ?? (node.name ?? null);
  if (name !== null && name !== undefined && name !== '') return String(name);
  return 'node_' + nodeId(node);
}

/**
 * PHP ctype_alnum() per-byte classification on the LIVE server (Apache) under the C locale:
 * ASCII-only. Every byte that is not ASCII [0-9A-Za-z] is non-alnum — so all UTF-8 high bytes
 * (e.g. 0xC3/0xE2 lead/continuation bytes of accented letters, em-dashes, middots) classify as
 * non-alnum and safeVar() maps each to '_'. (Earlier code kept Latin-1 lead bytes from a
 * C.UTF-8 CLI probe; the live Apache server uses the C locale, so that table was wrong.)
 */
function isPhpAlnumByte(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}

function safeVar(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  const out: number[] = [];
  for (const b of bytes) {
    out.push(isPhpAlnumByte(b) ? b : 0x5f); // 0x5f = '_'
  }
  // trim leading/trailing '_' (byte 0x5f)
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === 0x5f) start++;
  while (end > start && out[end - 1] === 0x5f) end--;
  const trimmed = Buffer.from(out.slice(start, end));
  // strtolower: ASCII A-Z only (PHP strtolower is byte-wise ASCII; high bytes unchanged).
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] >= 65 && trimmed[i] <= 90) trimmed[i] += 32;
  }
  return trimmed.toString('latin1');
}

/** Kahn's algorithm restricted to nodes reachable from start. Maps preserve PHP insertion order. */
function topoOrder(startId: string, edges: any[]): string[] {
  const reachable = new Map<string, boolean>();
  const stack: string[] = [startId];
  while (stack.length > 0) {
    const nid = String(stack.pop());
    if (reachable.has(nid)) continue;
    reachable.set(nid, true);
    for (const child of children(nid, edges)) stack.push(String(child));
  }

  const inDeg = new Map<string, number>();
  for (const nid of reachable.keys()) inDeg.set(String(nid), 0);
  for (const e of edges) {
    const f = edgeFrom(e);
    const t = edgeTo(e);
    if (reachable.has(f) && reachable.has(t)) inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }

  const order: string[] = [];
  const queue: string[] = [];
  for (const [nid, d] of inDeg) {
    if (d === 0) queue.push(String(nid));
  }
  while (queue.length > 0) {
    const nid = String(queue.shift());
    order.push(nid);
    for (const child0 of children(nid, edges)) {
      const child = String(child0);
      if (!inDeg.has(child)) continue;
      const nd = (inDeg.get(child) as number) - 1;
      inDeg.set(child, nd);
      if (nd === 0) queue.push(child);
    }
  }
  return order;
}

function pythonListRepr(items: string[]): string {
  const parts = items.map((s) => "'" + String(s).split('\\').join('\\\\').split("'").join("\\'") + "'");
  return '[' + parts.join(', ') + ']';
}

function extractToolNames(raw: any[]): string[] {
  const out: string[] = [];
  for (const tool of raw) {
    let tname: any = null;
    if (typeof tool === 'string') tname = tool;
    else if (tool !== null && typeof tool === 'object') tname = tool.name ?? tool.tool_name ?? null;
    if (tname) {
      if (String(tname).indexOf('mcp_') === 0) tname = String(tname).substring(4);
      out.push(tname);
    }
  }
  return out;
}

interface AgentDatum {
  display: string;
  system_prompt: string;
  tool_names: string[];
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
}

export interface GenerateResult {
  filename: string;
  code: Buffer;
}

export class LangGraphGenerator {
  protected workflowRepo: WorkflowRepository;
  protected graphRepo: WorkflowGraphRepository;
  protected agentRepo: AgentRepository;

  constructor(workflowRepo: WorkflowRepository, graphRepo: WorkflowGraphRepository, agentRepo: AgentRepository) {
    this.workflowRepo = workflowRepo;
    this.graphRepo = graphRepo;
    this.agentRepo = agentRepo;
  }

  /** Provider default models from system_llm_settings (lowercased provider_key -> model). */
  protected async loadProviderDefaults(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const rows = (
        await sql<any>`SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1`.execute(db)
      ).rows;
      for (const row of rows) {
        map.set(String(row.provider_key ?? '').toLowerCase(), String(row.model ?? ''));
      }
    } catch (_e) {
      // table missing/unreadable — fall through with empty map (matches PHP catch).
    }
    return map;
  }

  /** Fetch MCP tools with server info (url, name), matching list_mcp_tools_with_servers(). */
  protected async loadMcpToolsWithServers(): Promise<any[]> {
    const rows = (
      await sql<any>`
        SELECT t.*, s.name AS server_name, s.url AS server_url
        FROM mcp_server_tools t
        JOIN mcp_servers s ON t.server_id = s.id
        WHERE s.enabled = 1 AND s.user_id IS NULL`.execute(db)
    ).rows;

    const out: any[] = [];
    for (const row of rows) {
      const schemaRaw = row.input_schema ?? null;
      let schema: any = null;
      if (typeof schemaRaw === 'string') {
        if (schemaRaw !== '') {
          try {
            schema = JSON.parse(schemaRaw);
          } catch {
            schema = null;
          }
        }
      } else if (schemaRaw !== null && schemaRaw !== undefined) {
        schema = schemaRaw; // mysql2 already parsed the json column
      }
      row.input_schema = schema;
      out.push(row);
    }
    return out;
  }

  async generate(workflowId: number, _userId: string | null = null): Promise<GenerateResult> {
    const workflow = await this.workflowRepo.findById(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found.`);
    }
    const rawName = workflow.name;
    const wfName = rawName === '' || rawName === '0' || rawName == null ? 'workflow_' + workflowId : rawName;
    let safeName = safeVar(wfName);
    if (safeName === '') {
      safeName = 'workflow_' + workflowId;
    }

    const graph = await this.graphRepo.getGraph(workflowId);
    const nodes: any[] = graph.nodes ?? [];
    const edges: any[] = graph.edges ?? [];

    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(nodeId(n), n);

    const startNodes = nodes.filter((n) => nodeType(n) === 'start');
    if (startNodes.length === 0) {
      throw new Error('No start node found.');
    }
    const startNode = startNodes[0];
    const startId = nodeId(startNode);
    const startCfg = asObj(startNode.config ?? startNode.data ?? {});
    const startPrompt = startCfg.prompt === undefined || startCfg.prompt === null ? '' : String(startCfg.prompt);
    let startDocuments: any = startCfg.documents ?? [];
    if (startDocuments === null || typeof startDocuments !== 'object') startDocuments = [];

    const order = topoOrder(startId, edges);

    const providerDefaults = await this.loadProviderDefaults();
    const mcpTools = await this.loadMcpToolsWithServers();

    // server registry + tool catalog (insertion order preserved by plain objects; keys are non-numeric).
    const serverRegistry: Record<string, any> = {};
    const toolCatalog: Record<string, any> = {};
    for (const t of mcpTools) {
      const surl = String(t.server_url ?? '');
      const sname = String(t.server_name ?? '');
      const tname = String(t.tool_name ?? t.name ?? '');
      if (surl === '' || tname === '') continue;
      if (!Object.prototype.hasOwnProperty.call(serverRegistry, surl)) {
        serverRegistry[surl] = { name: sname };
      }
      let desc = t.tool_description ?? t.description ?? '';
      if (desc === null || desc === undefined) desc = '';
      let schema = t.input_schema ?? null;
      if (schema === null || schema === undefined) schema = {};
      toolCatalog[tname] = { server_url: surl, description: desc, input_schema: schema };
    }

    // resolve agent data per agent node
    const agentData = new Map<string, AgentDatum>();
    const allNeededTools = new Map<string, boolean>();
    for (const nid of order) {
      const node = byId.get(nid);
      const ntype = nodeType(node);
      if (ntype !== 'agent' && ntype !== 'agent-template') continue;
      const cfg = asObj(node.config);
      const agentId = node.agent_id ?? cfg.agent_id ?? null;
      let systemPrompt = String(cfg.systemPrompt ?? cfg.instructions ?? '');

      let rawTools: any = cfg.selectedTools ?? cfg.tools ?? [];
      if (rawTools === null || typeof rawTools !== 'object') rawTools = [];
      const rawToolsArr = Array.isArray(rawTools) ? rawTools : Object.values(rawTools);
      let toolNames = extractToolNames(rawToolsArr);

      let agentProvider = '';
      let agentModel = '';
      if (agentId !== null && agentId !== '') {
        try {
          const agent = await this.agentRepo.findById(phpIntval(agentId));
          if (agent !== null) {
            const agentArr = agentToArray(agent);
            if (systemPrompt === '') {
              systemPrompt = String(
                agentArr.instructions ?? (agentArr as any).system_prompt ?? (agentArr as any).prompt ?? ''
              );
            }
            agentProvider = String(agentArr.provider ?? '');
            agentModel = String(agentArr.model ?? '');
            const agentTools = agentArr.tools ?? null;
            if (toolNames.length === 0 && agentTools !== null && typeof agentTools === 'object') {
              const toolsIter = Array.isArray(agentTools) ? agentTools : Object.values(agentTools);
              toolNames = toolNames.concat(extractToolNames(toolsIter));
            }
          }
        } catch (_e) {
          // swallow (matches PHP broad except).
        }
      }

      const nodeProvider = String(cfg.llm_provider ?? cfg.provider ?? cfg.agent_provider ?? '');
      const nodeModel = String(cfg.model ?? '');
      if (nodeProvider !== '') agentProvider = nodeProvider;
      if (nodeModel !== '') agentModel = nodeModel;
      if (agentProvider === '') agentProvider = 'claude';
      if (agentModel === '') agentModel = providerDefaults.get(agentProvider.toLowerCase()) ?? '';

      const skillContent = phpTrim(String(cfg.skill_content ?? ''));
      if (skillContent !== '') {
        systemPrompt = phpRtrim(systemPrompt) + '\n\n## Skill\n' + skillContent;
      }

      const pl = systemPrompt.toLowerCase();
      const wantsHtml =
        pl.indexOf('output only the html') !== -1 ||
        pl.indexOf('production-quality html') !== -1 ||
        pl.indexOf('<!doctype') !== -1 ||
        (pl.indexOf('self-contained') !== -1 && pl.indexOf('<style') !== -1);
      if (wantsHtml) {
        systemPrompt =
          phpRtrim(systemPrompt) +
          '\n\n## Output format (CRITICAL — read carefully)\n' +
          'Your FINAL message MUST be the complete, self-contained HTML ' +
          'document itself: start with `<!DOCTYPE html>` and end with ' +
          '`</html>`. Output ONLY the raw HTML — no Markdown, no triple-backtick ' +
          'code fences, no preamble, and no commentary before or after. Do NOT ' +
          'narrate what you are about to do; produce the HTML directly as your ' +
          'answer. The runtime saves your final message verbatim to an .html ' +
          'file, so anything that is not HTML breaks the deliverable.';
      }

      const cfgSettings = asObj(cfg.settings);
      const agentTemperature = phpFloatval(cfgSettings.temperature ?? 0.7);
      const explicitMaxTokens = phpIntval(cfgSettings.max_tokens ?? 0);
      const agentMaxTokens =
        explicitMaxTokens > 4096 ? explicitMaxTokens : providerMaxTokensDefault(agentProvider.toLowerCase());

      if (systemPrompt.indexOf('run_skill_script') !== -1 && !toolNames.includes('run_skill_script')) {
        toolNames.push('run_skill_script');
      }

      for (const tn of toolNames) allNeededTools.set(tn, true);
      agentData.set(nid, {
        display: displayName(node),
        system_prompt: systemPrompt,
        tool_names: toolNames,
        provider: agentProvider.toLowerCase(),
        model: agentModel,
        temperature: agentTemperature,
        max_tokens: agentMaxTokens,
      });
    }

    // filter catalog/servers to what's actually used
    const usedCatalog: Record<string, any> = {};
    for (const k of Object.keys(toolCatalog)) {
      if (allNeededTools.has(k)) usedCatalog[k] = toolCatalog[k];
    }
    const usedServers: Record<string, any> = {};
    for (const entry of Object.values(usedCatalog)) {
      const surl = entry.server_url ?? '';
      if (surl !== '' && Object.prototype.hasOwnProperty.call(serverRegistry, surl)) {
        usedServers[surl] = serverRegistry[surl];
      }
    }
    const missing: string[] = [];
    for (const tn of allNeededTools.keys()) {
      if (tn === 'run_skill_script') continue;
      if (!Object.prototype.hasOwnProperty.call(toolCatalog, tn)) missing.push(tn);
    }
    missing.sort(); // SORT_STRING (ASCII tool names — byte order == UTF-16 order)

    const edgeList: string[][] = [];
    for (const e of edges) edgeList.push([edgeFrom(e), edgeTo(e)]);

    // ---- emit ----
    const lines: Array<string | Buffer> = [];
    const push = (s: string | Buffer) => lines.push(s);

    const nodeDescs: string[] = [];
    for (const nid of order) {
      const node = byId.get(nid);
      const ntype = nodeType(node);
      const name = displayName(node);
      const ad = agentData.get(nid);
      if (ad) {
        const tc = ad.tool_names.length;
        nodeDescs.push(`  ${nid} (${ntype}): ${name} -- ${tc} tool(s)`);
      } else {
        nodeDescs.push(`  ${nid} (${ntype}): ${name}`);
      }
    }
    const edgeDescs: string[] = [];
    for (const e of edges) edgeDescs.push('  ' + edgeFrom(e) + ' -> ' + edgeTo(e));

    const sep = '# ' + '='.repeat(62);

    push('"""Standalone LangGraph workflow: ' + wfName);
    push('');
    push('Auto-generated -- backend-independent.');
    push('Connects directly to MCP servers via JSON-RPC 2.0 over HTTP.');
    push('');
    push('ARCHITECTURE');
    push('============');
    push('This script was generated from a visual workflow editor. It embeds:');
    push('  - Agent system prompts and tool assignments (AGENTS dict)');
    push('  - MCP server URLs and tool schemas (MCP_SERVERS, TOOL_CATALOG)');
    push('  - Graph structure as edges + topological order (EDGES, ORDER)');
    push('');
    push('At runtime it builds a LangGraph StateGraph where each workflow');
    push("node becomes a graph node. Agents use LangChain's ReAct pattern");
    push('(create_react_agent) which lets the LLM decide when to call tools.');
    push('');
    push('DATA FLOW');
    push('=========');
    push('1. Start node stores the user prompt in shared state');
    push('2. Each agent node receives labeled context from its direct');
    push('   upstream predecessors (not all prior nodes -- only edge parents)');
    push('3. The context message includes the original user prompt plus');
    push("   each predecessor's output under a ### header with source name");
    push("4. Output node collects its parents' outputs as final result");
    push('');
    push('GRAPH NODES');
    push('===========');
    for (const nd of nodeDescs) push(nd);
    push('');
    push('GRAPH EDGES');
    push('===========');
    for (const ed of edgeDescs) push(ed);
    push('');
    push('TOOL EXECUTION');
    push('==============');
    push('Tools are called via the MCP protocol (Model Context Protocol).');
    push('Each tool invocation:');
    push('  1. Opens a JSON-RPC 2.0 session with the MCP server (initialize)');
    push('  2. Sends a tools/call request with tool name + arguments');
    push('  3. Parses the response (JSON or SSE format)');
    push('  4. Returns the text content to the LLM agent');
    push('Server URLs and tool schemas are baked in at generation time.');
    push('');
    push('REQUIREMENTS');
    push('============');
    push('  pip install langchain langchain-anthropic langgraph httpx pydantic');
    push('  export ANTHROPIC_API_KEY=sk-ant-...');
    push('');
    push('  # Optional, install only formats you actually attach:');
    push('  pip install mammoth        # for .docx attachments');
    push('  pip install python-pptx    # for .pptx attachments');
    push('  pip install openpyxl       # for .xlsx attachments');
    push('  pip install pypdf          # for .pdf attachments');
    push('');
    // safeName may carry raw (latin1) high bytes from a non-ASCII workflow name — push as a Buffer
    // so the join's utf8 encoding doesn't re-encode them (PHP keeps the raw bytes).
    push(
      Buffer.concat([
        Buffer.from('Usage: python ', 'utf8'),
        Buffer.from(safeName, 'latin1'),
        Buffer.from(".py 'your prompt here'", 'utf8'),
      ])
    );
    if (missing.length > 0) {
      push('');
      push('WARNING: These tools are NOT available as MCP servers');
      push('and will be missing at runtime: ' + pythonListRepr(missing));
      push('Convert them to MCP servers to enable full functionality.');
    }
    push('"""');
    push('from __future__ import annotations');
    push('');
    push('import asyncio, json, os, subprocess, sys, threading, time');
    push('from typing import Annotated, Any, TypedDict');
    push('');
    push('import httpx');
    push('# Provider-aware LLM wiring — each agent uses the LLM (provider/model)');
    push('# configured for it in the workflow editor. Imports are lazy inside');
    push('# _make_llm so a missing optional package only breaks the agents that');
    push('# actually use that provider, not the whole script.');
    push('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage');
    push('from langchain_core.tools import StructuredTool');
    push('from langgraph.graph import END, START, StateGraph');
    push('try:');
    push('    from langchain.agents import create_agent as create_react_agent');
    push('except ImportError:');
    push('    from langgraph.prebuilt import create_react_agent');
    push('from pydantic import BaseModel, Field, create_model');
    push('');
    push('# Optional global override: setting MODEL_NAME in the env forces every');
    push('# agent to use that model regardless of its per-agent setting. Useful for');
    push("# quick experiments. Leave unset to honour each agent's configured model.");
    push("MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()");
    push('');
    push('');
    push('def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096):');
    push('    """Build a LangChain chat model for the given provider/model.');
    push('');
    push('    The (provider, model) pair was resolved by the generator: the');
    push("    agent's explicit model overrides the provider's default from");
    push('    system_llm_settings, and that result is what reaches this');
    push('    function. No hardcoded model fallbacks here — every value comes');
    push('    from the database, so changing a model in the editor propagates');
    push('    via the next Generate Python.');
    push('');
    push('    Recognised providers (case-insensitive):');
    push('      claude     → langchain_anthropic.ChatAnthropic');
    push('      openai     → langchain_openai.ChatOpenAI');
    push('      gemini     → langchain_google_genai.ChatGoogleGenerativeAI');
    push('      grok       → ChatOpenAI on https://api.x.ai/v1');
    push('      deepseek   → ChatOpenAI on https://api.deepseek.com');
    push('      kimi       → ChatOpenAI on https://api.moonshot.ai/v1');
    push('');
    push('    Reads API keys from the environment (loaded from .env at startup).');
    push('    """');
    push('    p = (provider or "claude").lower()');
    push('    if MODEL_NAME_OVERRIDE:');
    push('        model = MODEL_NAME_OVERRIDE');
    push('    if not model:');
    push('        raise RuntimeError(');
    push('            f"No model specified for provider {p!r}. "');
    push('            "Set a model name on the agent in the workflow editor, "');
    push('            "or set MODEL_NAME in .env."');
    push('        )');
    push('    if p == "claude":');
    push('        from langchain_anthropic import ChatAnthropic');
    push('        return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)');
    push('    if p == "openai":');
    push('        from langchain_openai import ChatOpenAI');
    push('        return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)');
    push('    if p == "gemini":');
    push('        from langchain_google_genai import ChatGoogleGenerativeAI');
    push('        return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)');
    push('    if p == "grok":');
    push('        from langchain_openai import ChatOpenAI');
    push('        return ChatOpenAI(');
    push('            model=model,');
    push('            base_url="https://api.x.ai/v1",');
    push('            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),');
    push('            temperature=temperature,');
    push('            max_tokens=max_tokens,');
    push('        )');
    push('    if p == "deepseek":');
    push('        from langchain_openai import ChatOpenAI');
    push('        return ChatOpenAI(');
    push('            model=model,');
    push('            base_url="https://api.deepseek.com",');
    push('            api_key=os.environ.get("DEEPSEEK_API_KEY"),');
    push('            temperature=temperature,');
    push('            max_tokens=max_tokens,');
    push('        )');
    push('    if p == "kimi":');
    push('        from langchain_openai import ChatOpenAI');
    push('        # K2 models enforce non-thinking sampling values; mirror the');
    push('        # PHP KimiProvider so the API accepts the request. The');
    push("        # editor's temperature is overridden here (API requirement);");
    push('        # max_tokens is still honoured.');
    push('        kwargs = dict(');
    push('            model=model,');
    push('            base_url="https://api.moonshot.ai/v1",');
    push('            api_key=os.environ.get("KIMI_API_KEY"),');
    push('            max_tokens=max_tokens,');
    push('        )');
    push('        if model.startswith("kimi-k2"):');
    push('            kwargs["temperature"] = 0.6');
    push('            kwargs["top_p"] = 0.95');
    push('            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}');
    push('        else:');
    push('            kwargs["temperature"] = temperature');
    push('        return ChatOpenAI(**kwargs)');
    push('    raise RuntimeError(');
    push('        f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi."');
    push('    )');
    push('');

    // ---- MCP server registry ----
    push(sep);
    push('# MCP SERVER REGISTRY');
    push("# Baked at generation time from the workflow editor's config.");
    push('# Maps server URL -> metadata. If a server moves, update the URL here.');
    push(sep);
    push('');
    push('MCP_SERVERS = ' + jsonToPython(usedServers));
    push('');

    // ---- tool catalog ----
    push(sep);
    push('# TOOL CATALOG');
    push('# Each entry maps a tool name to its MCP server URL and');
    push('# JSON Schema for input validation. Only tools actually used');
    push('# by agents in this workflow are included.');
    push('# To add a tool: add an entry here AND reference it in the');
    push("# agent's tool_names list in the AGENTS dict below.");
    push(sep);
    push('');
    push('TOOL_CATALOG = ' + jsonToPython(usedCatalog));
    push('');

    // ---- MCP client ----
    push(sep);
    push('# MCP CLIENT -- JSON-RPC 2.0 over HTTP');
    push('#');
    push('# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.');
    push('# Each tool call requires:');
    push('#   1. URL normalization -- append /mcp if not present');
    push("#   2. Session initialization -- send 'initialize' + notification");
    push("#   3. Tool invocation -- send 'tools/call' with name + arguments");
    push('#   4. Response parsing -- handle plain JSON or SSE-wrapped JSON');
    push('#');
    push('# Some MCP servers return Server-Sent Events (SSE) instead of');
    push('# plain JSON. The parser handles both formats transparently.');
    push(sep);
    push('');
    push(mcpClientBlock);

    // ---- tool builder ----
    push('');
    push(sep);
    push('# TOOL BUILDER');
    push('# Converts the baked TOOL_CATALOG into LangChain StructuredTool');
    push('# objects. Each tool gets a dynamically-built Pydantic model for');
    push('# input validation (from the JSON Schema), and a callable that');
    push('# invokes the MCP server. The LLM agent calls these like any');
    push("# other LangChain tool -- it doesn't know about MCP internals.");
    push(sep);
    push('');
    push(toolBuilderBlock);

    // ---- state ----
    push('');
    push(sep);
    push('# LANGGRAPH STATE');
    push('#');
    push('# WFState is the shared state that flows through the graph.');
    push('# - user_prompt: the original user input (immutable after start)');
    push('# - node_outputs: dict of node_id -> {source, text} -- each node');
    push('#   writes its output here. Uses a merge reducer so parallel');
    push('#   branches can both contribute without conflicts.');
    push('# - final_output: set by the output node as the workflow result');
    push(sep);
    push('');
    push(stateBlock);

    // ---- datetime injector ----
    push('');
    push(sep);
    push('# DATETIME INJECTOR');
    push('#');
    push("# LLMs have knowledge cutoffs and don't know the current date.");
    push("# inject_datetime() prepends a short context block to each agent's");
    push("# system prompt so the agent reasons with today's actual date.");
    push('# Also resolves any [date]/[weekday]/[year]/[time] placeholders');
    push('# that may exist inside the prompt text (legacy templating).');
    push(sep);
    push('');
    push(datetimeInjectorBlock);

    // ---- context builder ----
    push('');
    push(sep);
    push('# CONTEXT BUILDER');
    push('#');
    push('# Each agent receives a structured message containing:');
    push('#   1. The original user request (for reference)');
    push('#   2. Labeled outputs from direct upstream agents only');
    push("# This matches the PHP backend's 'labeled' merge strategy.");
    push("# The agent's system prompt tells it what to DO with this input.");
    push(sep);
    push('');
    push(contextBuilderBlock);

    // ---- document converter ----
    push('');
    push(sep);
    push('# DOCUMENT CONVERTER');
    push('#');
    push('# Reads a file at `path` and returns Markdown the LLM can read.');
    push('# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through');
    push('# verbatim. Binary office formats and PDFs are routed to their');
    push('# matching pure-Python library (mammoth / python-pptx / openpyxl /');
    push('# pypdf). Imports are lazy so the helper only pulls in heavy deps');
    push('# when a document of that format is actually attached.');
    push('#');
    push("# This mirrors the editor's frontend converter (Pyodide) so the");
    push('# generated script behaves the same way the workflow did at design');
    push('# time. Paths come from the doc.path field stored in the workflow');
    push('# config — make sure the file is reachable from wherever you run');
    push('# this script (absolute paths recommended).');
    push(sep);
    push('');
    push(documentConverterBlock);

    // ---- start node config ----
    push('');
    push(sep);
    push('# START NODE');
    push('#');
    push('# The start node feeds the prompt into the workflow.');
    push("# DEFAULT_PROMPT is baked from the workflow's start node config.");
    push('# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.');
    push('# If the workflow has documents attached to the start node,');
    push("# they're read from doc.path, converted to Markdown via");
    push('# _convert_doc_to_markdown(), and prepended to the prompt.');
    push(sep);
    push('');
    const promptEscaped = escapePrompt(startPrompt);
    push('DEFAULT_PROMPT = """');
    for (const seg of wrapPromptToBuffers(promptEscaped)) push(seg);
    push('""".strip()');
    push('');
    if (!isEmpty(startDocuments)) {
      push('START_DOCUMENTS = ' + jsonToPython(phpAssocReencode(startDocuments)));
    } else {
      push('START_DOCUMENTS = []');
    }
    push('');

    // ---- agent definitions ----
    push(sep);
    push('# AGENT DEFINITIONS');
    push('#');
    push('# Each agent is identified by its workflow node ID.');
    push('#   display:       Human-readable name (for logs and context labels)');
    push("#   system_prompt: The agent's persona/instructions (sent as SystemMessage)");
    push('#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)');
    push('#');
    push('# To modify an agent: edit its system_prompt or tool_names here.');
    push('# To add a new agent: add an entry, create edges in EDGES, and');
    push('# include the node ID in ORDER at the right topological position.');
    push(sep);
    push('');
    push('AGENTS = {');
    for (const [nid, ad] of agentData) {
      let toolsList = jsonEncode(ad.tool_names);
      if (toolsList === '[]') toolsList = '[]';
      const promptText = escapePrompt(ad.system_prompt);
      const wrappedSegs = wrapPromptToBuffers(promptText);
      const displayJson = jsonEncode(ad.display);
      const providerJson = jsonEncode(String(ad.provider ?? 'claude'));
      const modelJson = jsonEncode(String(ad.model ?? ''));
      const temperatureLit = jsonEncode(phpFloatval(ad.temperature ?? 0.7));
      const maxTokensLit = String(phpIntval(ad.max_tokens ?? 4096));
      push('    "' + nid + '": {');
      push('        "display": ' + displayJson + ',');
      push('        "provider": ' + providerJson + ',');
      push('        "model": ' + modelJson + ',');
      push('        "temperature": ' + temperatureLit + ',');
      push('        "max_tokens": ' + maxTokensLit + ',');
      push('        "system_prompt": """');
      for (const seg of wrappedSegs) push(seg);
      push('""",');
      push('        "tool_names": ' + toolsList + ',');
      push('    },');
    }
    push('}');
    push('');

    // ---- edge data ----
    push(sep);
    push('# GRAPH STRUCTURE');
    push('#');
    push('# EDGES: directed connections as (from_node_id, to_node_id) tuples.');
    push("# ORDER: topological execution order (Kahn's algorithm).");
    push('#        Guarantees every node runs after all its predecessors.');
    push("# NODE_TYPES: maps node_id -> type ('start', 'agent', 'output').");
    push(sep);
    push('');
    push('EDGES = ' + jsonToPython(edgeList));
    push('ORDER = ' + jsonToPython(order));
    push('');
    push(parentsChildrenBlock);

    const typeEntries: Array<[string, string]> = [];
    for (const nid of order) typeEntries.push([nid, nodeType(byId.get(nid))]);
    push('NODE_TYPES = ' + pyDictFlat(typeEntries));
    push('');

    // ---- main ----
    push(sep);
    push('# MAIN EXECUTION');
    push('#');
    push('# run() builds the LangGraph, wires edges, and executes it.');
    push('# Each node type has a factory function (make_start, make_agent,');
    push('# make_output) that returns a callable for LangGraph to invoke.');
    push('#');
    push("# Agent nodes use LangChain's ReAct pattern: the LLM receives");
    push('# the system prompt + upstream context, and can call tools in a');
    push('# loop until it produces a final answer.');
    push(sep);
    push('');
    push(runHeaderBlock);

    if (missing.length > 0) {
      push('    print("[warn] Missing tools (not MCP): ' + pythonListRepr(missing) + '")');
      push('');
    }

    push(runBodyBlock);

    // join (implode("\n", lines)) in the byte domain
    const bufs: Buffer[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) bufs.push(NL);
      const p = lines[i];
      bufs.push(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
    }
    const code = Buffer.concat(bufs);
    const filename = `${safeName}.py`;
    return { filename, code };
  }
}
