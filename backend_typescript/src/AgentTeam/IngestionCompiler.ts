import { phpIntval, phpEmpty } from './WorkflowRepository';
import { ingestionScriptTemplate } from './ingestionTemplate';

/**
 * Faithful TypeScript mirror of src/AgentTeam/Services/IngestionCompiler.php — the
 * compileScript() method (backs POST /workflows/{id}/ingestion/compile) plus slugify().
 *
 * Output is byte-for-byte identical to the PHP. The big runnable script template lives in
 * ingestionTemplate.ts (extracted verbatim from the PHP <<<PY heredoc); the placeholder
 * tokens are substituted here. json_encode is emulated with PHP's
 * JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE (plus U+2028/U+2029 escaping).
 */

function fixSep(s: string): string {
  return s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** json_encode(v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE). */
function js(v: any): string {
  return fixSep(JSON.stringify(v));
}

const PHP_WS = /[ \t\n\r\0\x0B]/;
function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.test(s[start])) start++;
  while (end > start && PHP_WS.test(s[end - 1])) end--;
  return s.slice(start, end);
}

/** PHP `(string)($x ?? 'default')` then `?: 'default'` (falls back on '' / '0'). */
function strOrDefault(v: any, def: string): string {
  const s = v === undefined || v === null ? def : String(v);
  return s === '' || s === '0' ? def : s;
}

/** json_encode(v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) — same as compileScript's `js`. */
function jsonLit(v: any): string {
  return js(v);
}

/** PHP ucfirst(): uppercase the first character. */
function ucfirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** PHP empty(). */
function phpEmptyLocal(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === 0) return true;
  if (v === '') return true;
  if (v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

/** PHP `(array)($x ?? [])` — object passes through, else []. */
function asArr(v: any): any {
  const x = v ?? [];
  return x !== null && typeof x === 'object' ? x : [];
}

/** array_values(array_filter((array)($x ?? []), 'is_string')). */
function stringTypes(v: any): string[] {
  const raw = v ?? [];
  const arr = raw !== null && typeof raw === 'object' ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];
  return arr.filter((x: any) => typeof x === 'string');
}

/** PHP (object)((array)$v): a list array becomes {"0":..}, an assoc/object stays, scalar/null -> {}. */
function phpArrayToStdClass(v: any): Record<string, any> {
  if (v === null || v === undefined) return {};
  if (Array.isArray(v)) {
    const o: Record<string, any> = {};
    v.forEach((val, i) => {
      o[String(i)] = val;
    });
    return o;
  }
  if (typeof v === 'object') return v;
  return { '0': v };
}

/** Splitter dispatch: strategy -> { import, body } where `body` sets `chunks`. */
function splitterDispatch(): Record<string, { import: string; body: string }> {
  return {
    recursive: {
      import: 'from langchain_text_splitters import RecursiveCharacterTextSplitter',
      body:
        'splitter = RecursiveCharacterTextSplitter(\n' +
        '    chunk_size=int(SPLITTER.get("chunk_size", 1000)),\n' +
        '    chunk_overlap=int(SPLITTER.get("overlap", 150)),\n' +
        ')\n' +
        'chunks = [c for c in splitter.split_text(text) if c.strip()]',
    },
  };
}

export interface CompileScriptResult {
  filename: string;
  code: string;
}

export class IngestionCompiler {
  /**
   * Compile the full, self-contained, runnable ingestion script from the three node configs.
   * Mirrors IngestionCompiler::compileScript().
   */
  static compileScript(
    loaderCfg: Record<string, any>,
    splitterCfg: Record<string, any>,
    storeCfg: Record<string, any>,
    ctx: Record<string, any> = {}
  ): CompileScriptResult {
    const langfsUrl = String(ctx.langfs_url ?? loaderCfg.storage_mcp_url ?? '');
    const mcpqUrl = String(ctx.mcpqrant_url ?? '');
    const provider = strOrDefault(loaderCfg.provider, 'local');
    const path = String(loaderCfg.path ?? '');
    const isDir = !phpEmpty(loaderCfg.is_dir) ? 'True' : 'False';

    let typesRaw: any = loaderCfg.types ?? [];
    const typesArr =
      typesRaw !== null && typeof typesRaw === 'object'
        ? Array.isArray(typesRaw)
          ? typesRaw
          : Object.values(typesRaw)
        : [];
    const types = typesArr.filter((x: any) => typeof x === 'string');

    const chunk = Math.max(1, phpIntval(splitterCfg.chunk_size ?? 1000));
    const overlap = Math.max(0, phpIntval(splitterCfg.overlap ?? 150));
    const vsProvider = strOrDefault(storeCfg.provider, 'qdrant');

    let connection: any = storeCfg.connection ?? [];
    if (connection === null || typeof connection !== 'object') connection = [];

    const collection = phpTrim(String(storeCfg.collection ?? ''));
    const embedding = phpTrim(String(storeCfg.embedding ?? ''));
    const workersInt = phpIntval(loaderCfg.workers ?? 0);

    const pyLangfs = js(langfsUrl);
    const pyMcpq = js(mcpqUrl);
    const pyProv = js(provider);
    const pyPath = js(path);
    const pyTypes = types.length === 0 ? '[]' : js(types);
    const pyVsProv = js(vsProvider);
    const pyConn = phpEmpty(connection) ? '{}' : js(connection);
    const pyColl = js(collection);
    const pyEmb = js(embedding);
    const pyWorkers = workersInt > 0 ? String(workersInt) : 'None';

    const subs: Array<[string, string]> = [
      ['{$pyLangfs}', pyLangfs],
      ['{$pyMcpq}', pyMcpq],
      ['{$pyProv}', pyProv],
      ['{$pyPath}', pyPath],
      ['{$isDir}', isDir],
      ['{$pyTypes}', pyTypes],
      ['{$chunk}', String(chunk)],
      ['{$overlap}', String(overlap)],
      ['{$pyVsProv}', pyVsProv],
      ['{$pyConn}', pyConn],
      ['{$pyColl}', pyColl],
      ['{$pyEmb}', pyEmb],
      ['{$pyWorkers}', pyWorkers],
    ];
    let code = ingestionScriptTemplate;
    for (const [token, value] of subs) {
      code = code.split(token).join(value);
    }

    const slug = IngestionCompiler.slugify(collection);
    const filename = 'ingestion_' + (slug !== '' ? slug : 'pipeline') + '.py';

    return { filename, code };
  }

  /**
   * Compile the Python chunk for a SINGLE node, from that node's own config.
   * Mirrors IngestionCompiler::compileNodeChunk().
   * @throws Error on unknown kind / strategy
   */
  static compileNodeChunk(kind: string, config: Record<string, any> = {}): string {
    // A disabled node is a passthrough — it forwards its input unchanged.
    if (kind !== 'start' && !phpEmptyLocal(config.disabled)) {
      const label = ucfirst(kind);
      return (
        `# ${label} — DISABLED (skipped for debugging)\n` +
        '# This stage is a passthrough; its input is forwarded unchanged.'
      );
    }

    switch (kind) {
      case 'start':
        return 'import json, os\n# (common header — shared by the stages below)';

      case 'loader': {
        const provider = strOrDefault(config.provider, 'local');
        const isDir = !phpEmptyLocal(config.is_dir);
        const types = stringTypes(config.types);
        const json = jsonLit({
          provider,
          path: config.path ?? '',
          is_dir: isDir,
          types,
        });
        return (
          `# Loader — langfs (provider: ${provider}${isDir ? ', recursive folder' : ''})\n` +
          '# langfs enumerates + EXTRACTS text; no local decoders here.\n' +
          `LOADER = ${json}\n` +
          '# files  = list_files(provider, path, types)        -> [source, ...]\n' +
          "# text   = read_file(provider, file_id, format='text')  -> extracted text\n" +
          '# (text per file) -> handed to the Splitter'
        );
      }

      case 'splitter': {
        const strategy = String(config.strategy ?? 'recursive');
        const table = splitterDispatch();
        if (!Object.prototype.hasOwnProperty.call(table, strategy)) {
          throw new Error(
            `IngestionCompiler: no fragment for splitter strategy '${strategy}' yet — add it to the splitter dispatch table.`
          );
        }
        const S = table[strategy];
        const json = jsonLit({
          strategy,
          chunk_size: config.chunk_size ?? 1000,
          overlap: config.overlap ?? 150,
        });
        return (
          `# Splitter — strategy: ${strategy}\n` +
          `${S.import}\n\n` +
          `SPLITTER = ${json}\n` +
          `${S.body}\n` +
          '# chunks : list[str]  -> handed to the Vector store'
        );
      }

      case 'vectorstore': {
        const vsProvider = strOrDefault(config.provider, 'qdrant');
        const json = jsonLit({
          provider: vsProvider,
          connection: phpArrayToStdClass(asArr(config.connection ?? [])),
          collection: String(config.collection ?? ''),
          embedding: String(config.embedding ?? ''),
        });
        return (
          `# Vector store — mcp_qrant "store" (provider: ${vsProvider})\n` +
          '# mcp_qrant EMBEDS + upserts; no embeddings/vector-store libs here.\n' +
          `STORE = ${json}\n` +
          '# "store"(provider, connection, collection,\n' +
          '#          items=[{"text": c, "metadata": {"source": src}} for c in chunks],\n' +
          '#          embedding) -> {"stored": int, "errors": int}'
        );
      }

      default:
        throw new Error(
          `IngestionCompiler: unknown node kind '${kind}' (expected start, loader, splitter, vectorstore).`
        );
    }
  }

  /**
   * Compile the three-panel "node view" (input/generated/output) for a single
   * node. Mirrors IngestionCompiler::compileNodeView().
   */
  static compileNodeView(kind: string, config: Record<string, any>): { input: string; generated: string; output: string } {
    const generated = IngestionCompiler.compileNodeChunk(kind, config);

    let input: string;
    let output: string;
    if (kind === 'loader') {
      input = IngestionCompiler.compileNodeChunk('start');
      output = input + '\n\n' + generated;
    } else {
      input = '';
      output = generated;
    }

    return { input, generated, output };
  }

  /**
   * Compile the input/generated/output view for the ORDERED pipeline stages from
   * start through the target node. Mirrors IngestionCompiler::compileView().
   */
  static compileView(stages: any[]): { input: string; generated: string; output: string } {
    if (phpEmptyLocal(stages)) {
      return { input: '', generated: '', output: '' };
    }
    const chunks: string[] = [];
    for (const s of stages) {
      const kind = String(s?.node_type ?? s?.type ?? '');
      const cfg = asArr(s?.config ?? []);
      chunks.push(IngestionCompiler.compileNodeChunk(kind, cfg));
    }
    const generated = String(chunks.pop() ?? '');
    const input = chunks.join('\n\n');
    const output = input === '' ? generated : input + '\n\n' + generated;
    return { input, generated, output };
  }

  /** Mirrors slugify(): lowercase, non-alnum runs -> '_', trim '_'. */
  static slugify(name: string): string {
    let slug = phpTrim(name).toLowerCase();
    slug = slug.replace(/[^a-z0-9]+/g, '_');
    return slug.replace(/^_+/, '').replace(/_+$/, '');
  }
}
