import * as posix from 'path/posix';

/**
 * Faithful TypeScript mirror of src/AgentTeam/Services/IngestionLoader.php.
 *
 * The interpreter's file-read step: recursive list_files -> read_file -> decode
 * -> text. Files are reached through the UniversalFS / langfs MCP server, but the
 * two MCP tools are INJECTED as callables (list_files / read_file) so this class
 * is decoupled from the live server.
 *
 *   listFiles(provider, path): {files:[{id,name,type}]}
 *   readFile(provider, fileId): string | {is_text, data}
 *
 * NOTE ON ASYNC: the PHP twin is synchronous (blocking curl). In this backend the
 * injected callables perform async MCP HTTP, so the callable-driven methods
 * (enumerateFiles / loadFile / loadDocuments / readRound) are async and `await`
 * the callables. The algorithm (enumeration, filtering, recursion) is identical.
 *
 * NOTE ON DECODE: text/csv are passthrough; word (.docx) is extracted dependency-
 * free via zlib; pdf and html have no bundled extractor (PHP uses Smalot\PdfParser
 * and League\HTMLToMarkdown) and throw an explicit "not ported" error — those are
 * only reached at run time by the deferred slice-2 loader endpoints.
 */

export type ListFilesFn = (provider: string, path: string) => Promise<any> | any;
export type ReadFileFn = (provider: string, fileId: string) => Promise<any> | any;

export interface LoaderDescriptor {
  provider: string;
  file_id: string;
  name: string;
  source: string;
  doc_type: string;
}

/** Extension -> document type. Drives both the type filter and decode. */
const EXT_MAP: Record<string, string> = {
  pdf: 'pdf',
  docx: 'word',
  doc: 'word',
  txt: 'text',
  csv: 'csv',
  html: 'html',
  htm: 'html',
};

/** PHP basename() over '/'-separated paths (file ids use forward slashes). */
function phpBasename(p: string): string {
  return posix.basename(p);
}

/** Code-point length (PHP mb_strlen). */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** PHP mb_substr($s, 0, $len) by code points. */
function cpSubstr(s: string, len: number): string {
  const arr = Array.from(s);
  return arr.slice(0, len).join('');
}

/** PHP empty() for the shapes we deal with. */
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === 0) return true;
  if (v === '') return true;
  if (v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

/** PHP is_array() over a json_decode(..,true) value. */
function phpIsArray(v: any): boolean {
  return v !== null && typeof v === 'object';
}

/** Coerce injected raw bytes to a byte-preserving string (mirrors PHP binary string). */
function toByteString(v: any): string {
  if (Buffer.isBuffer(v)) return v.toString('latin1');
  return v === undefined || v === null ? '' : String(v);
}

export class IngestionLoader {
  /** Map a filename / path to a document type, or null if unsupported. */
  static detectType(name: string): string | null {
    const dot = name.lastIndexOf('.');
    if (dot === -1) {
      return null;
    }
    const ext = name.substring(dot + 1).toLowerCase();
    return EXT_MAP[ext] ?? null;
  }

  /**
   * Enumerate the files the loader will process. `allowedTypes` is the loader
   * form's checkbox filter; [] = no restriction (every supported type kept).
   */
  static async enumerateFiles(
    listFiles: ListFilesFn,
    provider: string,
    path: string,
    allowedTypes: string[] = [],
    isDir = false,
    maxDepth = 64
  ): Promise<LoaderDescriptor[]> {
    const resolve = (name: string): string | null => {
      const dt = IngestionLoader.detectType(name);
      if (dt === null) {
        return null;
      }
      if (allowedTypes.length !== 0 && !allowedTypes.includes(dt)) {
        return null;
      }
      return dt;
    };

    if (!isDir) {
      const dt = resolve(phpBasename(path));
      if (dt === null) {
        return [];
      }
      return [IngestionLoader.descriptor(provider, path, phpBasename(path), dt)];
    }

    const out: LoaderDescriptor[] = [];
    const visited: Record<string, boolean> = {};

    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > maxDepth || visited[folder]) {
        return;
      }
      visited[folder] = true;
      const result = await listFiles(provider, folder);
      const files = (result && result.files) ?? [];
      for (const item of files) {
        const itemId = item?.id ?? null;
        const name = item?.name ?? (itemId !== null ? phpBasename(itemId) : '');
        if ((item?.type ?? '') === 'folder') {
          if (itemId !== null) {
            await walk(itemId, depth + 1);
          }
        } else {
          const dt = resolve(name);
          if (dt !== null && itemId !== null) {
            out.push(IngestionLoader.descriptor(provider, itemId, name, dt));
          }
        }
      }
    };

    await walk(path, 0);
    return out;
  }

  private static descriptor(provider: string, fileId: string, name: string, docType: string): LoaderDescriptor {
    return {
      provider,
      file_id: fileId,
      name,
      source: fileId, // full path = provenance for the store metadata
      doc_type: docType,
    };
  }

  /**
   * Read one enumerated file via the injected readFile. langfs extracts text
   * server-side ({is_text:true, data}) — pass it straight through. The legacy
   * UniversalFS raw-bytes path (is_text=false + local decode) was removed; a
   * non-text response throws instead of being decoded here.
   */
  static async loadFile(readFile: ReadFileFn, descriptor: LoaderDescriptor): Promise<string> {
    const r = await readFile(descriptor.provider, descriptor.file_id);
    if (phpIsArray(r) && !phpEmpty(r.is_text)) {
      return toByteString(r.data ?? '');
    }
    throw new Error(
      `read_file did not return extracted text for '${descriptor.name}' — ` +
        'the legacy raw-bytes decode path was removed; use a langfs storage server (format=text).'
    );
  }

  /**
   * The loader's iterator: yield {text, source} per file, reading + decoding
   * lazily so the store can clock the loop one file at a time.
   */
  static async *loadDocuments(
    listFiles: ListFilesFn,
    readFile: ReadFileFn,
    provider: string,
    path: string,
    allowedTypes: string[] = [],
    isDir = false
  ): AsyncGenerator<{ text: string; source: string }> {
    for (const desc of await IngestionLoader.enumerateFiles(listFiles, provider, path, allowedTypes, isDir)) {
      yield { text: await IngestionLoader.loadFile(readFile, desc), source: desc.source };
    }
  }

  /**
   * Run ONE round of the loader: enumerate the source, then read + decode just
   * the file at `cursor`. Returns the ordered `sources` and the `current` file's
   * text (clipped to `maxChars` code points). Out-of-range cursor → current null.
   */
  static async readRound(
    listFiles: ListFilesFn,
    readFile: ReadFileFn,
    provider: string,
    path: string,
    allowedTypes: string[] = [],
    isDir = false,
    cursor = 0,
    maxChars = 20000
  ): Promise<{ count: number; cursor: number; sources: string[]; current: Record<string, any> | null }> {
    const descs = await IngestionLoader.enumerateFiles(listFiles, provider, path, allowedTypes, isDir);
    const count = descs.length;
    const sources = descs.map((d) => d.source);

    if (count === 0 || cursor < 0 || cursor >= count) {
      return { count, cursor, sources, current: null };
    }

    const desc = descs[cursor];
    let current: Record<string, any>;
    try {
      const text = await IngestionLoader.loadFile(readFile, desc);
      const chars = cpLen(text);
      const clipped = chars > maxChars;
      current = {
        source: desc.source,
        type: desc.doc_type,
        chars,
        text: clipped ? cpSubstr(text, maxChars) : text,
        clipped,
      };
    } catch (e: any) {
      current = { source: desc.source, type: desc.doc_type, error: e?.message ?? String(e) };
    }

    return { count, cursor, sources, current };
  }
}
