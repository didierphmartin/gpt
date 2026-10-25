import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  array_unique, basename, copy, entries, explode, has, implode, isEmptyArr, is_array, keysOf, mb_check_encoding_utf8,
  pathExtension, preg_replace, preg_split, sortStrings, strtolower, strtoupper, strval, trim, truthy, values, empty,
} from './php';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import { StartDocumentStore } from './StartDocumentStore';

/**
 * The files that make a modular LangGraph package run on its own (spec 2026-10-15 §5): requirements.txt,
 * .env.example, README.md, the code-node harness, each used skill's folder and the Start's documents.
 * Ported from backend/src/AgentTeam/Services/LangGraphPackage.php.
 *
 * A file entry is {path, code}; a file that is not valid UTF-8 is {path, code (base64), encoding: "base64"}.
 * File contents are read as bytes (Buffer); a text entry's code is the UTF-8 string.
 */

/** What startDocuments() reads a document through (compiler/StartDocumentStore). */
export type StartDocumentReader = { read(doc: any): Buffer | string | null } | null;

export type PackageFile = { path: string; code: string; encoding?: string };

/** What every package imports (workflow, common, api), before provider, skill and document extras. */
const BASE_REQUIREMENTS = ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx',
  'pydantic', 'python-dotenv', 'fastapi', 'uvicorn'];

/** Providers whose LLM factory branch imports a package beyond the base ones. */
const PROVIDER_REQUIREMENTS: Record<string, string> = { gemini: 'langchain-google-genai', google: 'langchain-google-genai' };

/** The document converter's lazy imports, by attachment extension. */
const DOCUMENT_REQUIREMENTS: Record<string, string> = { pdf: 'pypdf', docx: 'mammoth', pptx: 'python-pptx', xlsx: 'openpyxl' };

const SKIP_NAMES = ['__pycache__', '.DS_Store'];

/** The swarm package's workflow.py builds its graph with create_swarm() (langgraph_swarm). */
const SWARM_REQUIREMENTS = ['langgraph-swarm'];

/** <repo>/frontend/assets/py/code_node_harness.py (this file is <repo>/backend_typescript/src/AgentTeam/compiler/). */
const HARNESS = path.resolve(__dirname, '../../../../frontend/assets/py/code_node_harness.py');

/** CodeNodeEmit::slug. */
function slug(s: string): string {
  return strtolower(preg_replace('/[^a-z0-9]+/i', '_', s));
}

function realpath(p: string): string | false {
  try {
    return fs.realpathSync(p);
  } catch {
    return false;
  }
}

/** PHP `$x['k'] ?? null`. */
function at(x: any, k: string): any {
  if (x === null || x === undefined || typeof x !== 'object') return null;
  const v = Array.isArray(x) ? x[Number(k)] : x[k];
  return v === undefined ? null : v;
}

function toBuf(b: Buffer | string): Buffer {
  return Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
}

export class LangGraphPackage {
  /** Where the editor keeps the skill folders: the default skills root of the generator. */
  static defaultSkillsRoot(): string {
    const home = process.env.HOME || (() => {
      try {
        return os.userInfo().homedir ?? '';
      } catch {
        return '';
      }
    })();
    return home + '/Documents/synergyAI/skills';
  }

  /** The package's own files (the code modules, agents and code/ files are the generator's). */
  static files(facts: any, skillsRoot: string, documents: StartDocumentReader = null): PackageFile[] {
    const skills = LangGraphPackage.skillFiles(facts, skillsRoot);
    const out: PackageFile[] = [
      { path: 'requirements.txt', code: LangGraphPackage.requirements(facts, skills) },
      { path: '.env.example', code: LangGraphPackage.envExample(facts) },
      { path: 'README.md', code: LangGraphPackage.readme(facts) },
    ];
    if (!isEmptyArr(at(facts, 'codeData') ?? [])) {
      let harness: string;
      try {
        harness = fs.readFileSync(HARNESS, 'utf8');
      } catch {
        throw new Error('code node harness not found (frontend/assets/py/code_node_harness.py)');
      }
      out.push({ path: 'code_harness.py', code: harness });
    }
    for (const f of skills) out.push(f.entry);
    for (const f of LangGraphPackage.startDocuments(at(facts, 'startDocuments') ?? [], documents).files) out.push(f);
    return out;
  }

  /** One code node's code as a package file: code/start_<slug>.py for the Start option's trigger, else code/<nid>_<slug>.py. */
  static codeFile(nid: string, cd: any, isTrigger: boolean): { path: string; code: string } {
    let s = slug(strval(at(cd, 'display') ?? 'code'));
    s = trim(s, '_') !== '' ? trim(s, '_') : 'code';
    return { path: 'code/' + (isTrigger ? 'start' : nid) + `_${s}.py`, code: strval(at(cd, 'source')) };
  }

  /**
   * The Start's documents as package files, and the START_DOCUMENTS entries pointing at them
   * (start_documents/<basename>). Only a document the store can read is copied; any other entry is left as it is.
   */
  static startDocuments(docs: any, documents: StartDocumentReader = null): { files: PackageFile[]; docs: any[] } {
    const files: PackageFile[] = [];
    const out: any[] = [];
    const taken = new Set<string>();
    for (const [i, doc0] of entries(docs)) {
      const bytes = is_array(doc0) && documents !== null ? documents.read(doc0) : null;
      if (bytes === null || bytes === undefined) {
        out.push(doc0);
        continue;
      }
      let name = basename(strval(at(doc0, 'path')));
      if (taken.has(name)) name = `${i}_${name}`;
      taken.add(name);
      files.push(LangGraphPackage.entry(`start_documents/${name}`, toBuf(bytes)));
      const doc = copy(doc0);
      delete doc['fullPath'];
      delete doc['localUri'];
      doc['path'] = `start_documents/${name}`;
      out.push(doc);
    }
    return { files, docs: out };
  }

  /** {path, code} for text (valid UTF-8), {path, code: base64, encoding: base64} otherwise. */
  private static entry(p: string, bytes: Buffer): PackageFile {
    return mb_check_encoding_utf8(bytes)
      ? { path: p, code: bytes.toString('utf8') }
      : { path: p, code: bytes.toString('base64'), encoding: 'base64' };
  }

  /** The skill folders the agents bind ({'dir': d}), in first-use order. */
  static skillDirs(facts: any): string[] {
    const dirs = new Set<string>();
    for (const ad of values(at(facts, 'agentData') ?? [])) {
      for (const s of values(at(ad, 'skills') ?? [])) {
        if (has(s, 'dir') && strval(s['dir']) !== '') dirs.add(strval(s['dir']));
      }
    }
    return [...dirs];
  }

  /**
   * Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc, .env*, dot-directories), sorted.
   * bytes is the file's content (Buffer).
   */
  static skillFiles(facts: any, skillsRoot: string): Array<{ dir: string; rel: string; bytes: Buffer; entry: PackageFile }> {
    const out: Array<{ dir: string; rel: string; bytes: Buffer; entry: PackageFile }> = [];
    const root = realpath(skillsRoot);
    for (const d of LangGraphPackage.skillDirs(facts)) {
      const segments = StartDocumentStore.safeSegments(d);
      const safe = segments !== null && segments.filter((seg) => seg.startsWith('.')).length === 0;
      const base = safe && root !== false ? realpath(root + path.sep + d) : false;
      if (base === false || root === false || !base.startsWith(root + path.sep) || !isDir(base)) {
        throw new Error(`Skill folder "${d}" is not available on this server, so it can't be packaged.`);
      }
      const found: string[] = [];
      const walk = (dir: string): void => {
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          const full = dir + '/' + name;
          if (SKIP_NAMES.includes(name) || name.endsWith('.pyc') || name.startsWith('.env')) continue;
          if (isDir(full) && name.startsWith('.')) continue;   // .git/, .pytest_cache/, ... (a link to one too)
          // RecursiveDirectoryIterator does not descend into a symlinked directory (a leaf, and not a file).
          if (isRealDir(full)) {
            walk(full);
            continue;
          }
          const real = isFile(full) ? realpath(full) : false;
          if (real !== false && real.startsWith(base + path.sep)) found.push(full.slice(base.length + 1));
        }
      };
      walk(base);
      sortStrings(found);
      for (const rel of found) {
        const bytes = fs.readFileSync(`${base}/${rel}`);
        out.push({ dir: d, rel, bytes, entry: LangGraphPackage.entry(`skills/${d}/${rel}`, bytes) });
      }
    }
    return out;
  }

  /** `dependencies:` of a SKILL.md's frontmatter, parsed as SkillRuntime.ensure_deps parses it. */
  static skillDependencies(skillMd: Buffer | string): string[] {
    const text = Buffer.isBuffer(skillMd) ? skillMd.toString('utf8') : skillMd;
    const lines = preg_split('/\\r\\n|\\r|\\n/', text);
    if (!lines.length || trim(lines[0]) !== '---') return [];
    for (const line of lines.slice(1)) {
      const s = trim(line);
      if (s === '---') break;
      if (strtolower(s).startsWith('dependencies:')) {
        const val = trim(trim(explode(':', s, 2)[1]), '[]');
        const deps: string[] = [];
        for (const d0 of explode(',', val)) {
          const d = trim(trim(trim(d0), "'"), '"');
          if (d !== '') deps.push(d);
        }
        return deps;
      }
    }
    return [];
  }

  private static providers(facts: any): string[] {
    const p = new Set<string>();
    for (const d of [...values(at(facts, 'agentData') ?? []), ...values(at(facts, 'playbookData') ?? [])]) {
      if ((at(d, 'provider') ?? '') !== '') p.add(strtolower(strval(d['provider'])));
    }
    return [...p];
  }

  /** requirements.txt: one per line, sorted, unique. */
  private static requirements(facts: any, skillFiles: Array<{ rel: string; bytes: Buffer }>): string {
    let req: string[] = has(facts, 'swarm') ? [...BASE_REQUIREMENTS, ...SWARM_REQUIREMENTS] : [...BASE_REQUIREMENTS];
    for (const p of LangGraphPackage.providers(facts)) {
      if (Object.hasOwn(PROVIDER_REQUIREMENTS, p)) req.push(PROVIDER_REQUIREMENTS[p]);
    }
    for (const f of skillFiles) {
      if (f.rel === 'SKILL.md') req.push(...LangGraphPackage.skillDependencies(f.bytes));
    }
    for (const doc of values(at(facts, 'startDocuments') ?? [])) {
      const ext = strtolower(pathExtension(strval(is_array(doc) ? (at(doc, 'path') ?? at(doc, 'name') ?? '') : '')));
      if (Object.hasOwn(DOCUMENT_REQUIREMENTS, ext)) req.push(DOCUMENT_REQUIREMENTS[ext]);
    }
    req = values(array_unique(req));
    sortStrings(req);
    return implode('\n', req) + '\n';
  }

  /** .env.example: every variable the program reads, commented. */
  private static envExample(facts: any): string {
    const swarm = has(facts, 'swarm');
    const L: string[] = [];
    L.push('# Environment of the workflow "' + strval(facts['wfName']) + '" -- copy this file to .env and fill it in.');
    L.push('# The program reads .env from its own folder first, then from the folder two levels up');
    L.push('# (a local runner\'s .env). A variable already set in the environment is never overridden.');
    L.push('');
    const keys = new Map<string, string[]>();
    for (const p of LangGraphPackage.providers(facts)) {
      const k = PythonEmitHelpers.providerKeyEnv(p);
      if (k !== null) {
        if (!keys.has(k)) keys.set(k, []);
        keys.get(k)!.push(p);
      }
    }
    if (keys.size) {
      L.push('# API keys of the LLM providers this workflow uses');
      for (const [k, provs] of keys) {
        L.push('# ' + implode(', ', array_unique(provs)));
        L.push(`# ${k}=`);
      }
    } else {
      L.push('# No LLM provider is used by a node of this workflow.');
    }
    L.push('');
    const decision = new Map<string, string>();
    for (const ad of values(at(facts, 'agentData') ?? [])) {
      for (const c of values(!empty(at(ad, 'dispatch')) ? (at(ad, 'decision') ?? []) : [])) {
        decision.set(strval(c['key_env']), strval(c['url_env']));
      }
    }
    if (decision.size) {
      L.push('# Decision models the dispatchers may route with (each URL variable is optional: a gateway)');
      for (const [key, url] of decision) {
        L.push(`# ${key}=`);
        L.push(`# ${url}=`);
      }
      L.push('');
    }
    const slugs = at(facts, 'serverSlugs') ?? [];
    if (truthy(slugs)) {
      L.push('# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)');
      for (const [url, s] of entries(slugs)) {
        const up = strtoupper(strval(s));
        L.push(`MCP_URL_${up}=${url}`);
        L.push('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}');
        L.push(`# MCP_HEADERS_${up}=`);
      }
      L.push('');
    }
    L.push('# Optional');
    L.push('# One model for every node, instead of each node\'s own');
    L.push('# MODEL_NAME=');
    L.push('# Where saved outputs go (default: outputs/ in this folder)');
    L.push('# SYNERGYAI_OUTPUT_ROOT=./outputs');
    if (!swarm) {
      L.push('# Where run logs go (default: runs/ in this folder)');
      L.push('# RUNS_DIR=./runs');
    }
    if (LangGraphPackage.skillDirs(facts).length) {
      L.push('# Where the skills are read from (default: skills/ in this folder)');
      L.push('# SYNERGYAI_SKILLS_DIR=./skills');
    }
    return implode('\n', L) + '\n';
  }

  /** README.md: install, configure, modes, files written, run server, service units, code nodes. */
  private static readme(facts: any): string {
    const name = strval(facts['wfName']);
    const root = strval(facts['safeName']) + (has(facts, 'swarm') ? '_modular_swarm' : '_modular');
    const sl = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', name), '-'));
    const slugName = truthy(sl) ? sl : 'workflow';
    const swarm = has(facts, 'swarm');
    const mode = swarm ? 'prompt' : strval(at(facts, 'startMode') ?? 'prompt');
    const def = (m: string) => (m === mode ? ' **(default)**' : '');
    const L: string[] = [];
    L.push(`# ${name}`);
    L.push('');
    L.push('A LangGraph program compiled from the SynergyAI workflow editor. It runs on its own: no database,');
    L.push('no SynergyAI server. Everything it needs is in this folder.');
    L.push('');
    L.push('## Install');
    L.push('');
    L.push('```sh');
    L.push('python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt');
    L.push('cp .env.example .env   # then fill in the API keys and MCP headers');
    L.push('```');
    L.push('');
    L.push('## Modes');
    L.push('');
    L.push('One mode per launch. With no flag the program runs in the mode its Start node set.');
    L.push('');
    L.push('| Command | Mode |');
    L.push('|---|---|');
    L.push('| `python workflow.py ["text"]` | one run on the text, or on the Start\'s prompt' + def('prompt') + ' |');
    L.push('| `python workflow.py --cron [EXPR]` | a run on each tick of the schedule, until stopped' + def('cron') + ' |');
    if (!swarm) {
      L.push('| `python workflow.py --watch [server.tool {json}]` | a run for each event the trigger reports, until stopped' + def('watch') + ' |');
      L.push('| `python workflow.py --once "text"` | exactly one run, whatever the default mode |');
    }
    L.push('');
    if (!swarm) {
      L.push('`--quiet` prints only the done / failed line of each run; `--verbose` adds the progress lines.');
    }
    L.push('Ctrl-C (or SIGTERM) stops a loop after the current run.');
    L.push('');
    L.push('## Files written');
    L.push('');
    L.push('- `outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).');
    if (!swarm) {
      L.push('- `runs/` -- one `<date>_<run id>.jsonl` event log per run, and `runs/current` (`RUNS_DIR` overrides).');
      L.push('  A run with nothing to do leaves no file.');
    }
    L.push('');
    L.push('## Run server');
    L.push('');
    L.push('```sh');
    L.push('python api.py            # HTTP run server: POST /runs, an SSE event stream per run');
    if (!swarm) {
      L.push('python api.py --listen   # the same, plus the default mode running in the background');
    }
    L.push('```');
    L.push('');
    L.push('## Running as a service');
    L.push('');
    L.push(`Replace \`/path/to/${root}\` with this folder's absolute path.`);
    if (mode === 'prompt') {
      L.push('This workflow\'s default is one run, and a service is restarted when it exits: add `--cron EXPR`'
        + (swarm ? '' : ' (or `--watch`)') + ' after `workflow.py` so it keeps running.');
    }
    L.push('');
    L.push(`macOS (launchd): save as \`~/Library/LaunchAgents/ai.synergy.${slugName}.plist\`, then`);
    L.push(`\`launchctl load ~/Library/LaunchAgents/ai.synergy.${slugName}.plist\`.`);
    L.push('');
    L.push('```xml');
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
    L.push('<plist version="1.0">');
    L.push('<dict>');
    L.push('  <key>Label</key>');
    L.push(`  <string>ai.synergy.${slugName}</string>`);
    L.push('  <key>ProgramArguments</key>');
    L.push('  <array>');
    L.push(`    <string>/path/to/${root}/.venv/bin/python</string>`);
    L.push(`    <string>/path/to/${root}/workflow.py</string>`);
    L.push('  </array>');
    L.push('  <key>WorkingDirectory</key>');
    L.push(`  <string>/path/to/${root}</string>`);
    L.push('  <key>KeepAlive</key>');
    L.push('  <true/>');
    L.push('  <key>StandardOutPath</key>');
    L.push(`  <string>/path/to/${root}/service.log</string>`);
    L.push('  <key>StandardErrorPath</key>');
    L.push(`  <string>/path/to/${root}/service.log</string>`);
    L.push('</dict>');
    L.push('</plist>');
    L.push('```');
    L.push('');
    L.push(`Linux (systemd): save as \`/etc/systemd/system/${slugName}.service\`, then \`systemctl enable --now ${slugName}\`.`);
    L.push('');
    L.push('```ini');
    L.push('[Unit]');
    L.push(`Description=${name} (LangGraph)`);
    L.push('After=network-online.target');
    L.push('');
    L.push('[Service]');
    L.push(`ExecStart=/path/to/${root}/.venv/bin/python /path/to/${root}/workflow.py`);
    L.push(`WorkingDirectory=/path/to/${root}`);
    L.push('Restart=always');
    L.push('');
    L.push('[Install]');
    L.push('WantedBy=multi-user.target');
    L.push('```');
    if (!isEmptyArr(at(facts, 'codeData') ?? [])) {
      L.push('');
      L.push('## Editing code nodes');
      L.push('');
      L.push('Each code node runs its file in `code/` (`code/start_<name>.py` is the Start option\'s code).');
      L.push('The file is read at each run: an edit takes effect on the next run, with no recompile. The code');
      L.push('runs under the same rules as in the editor (`code_harness.py`): standard library only, network');
      L.push('only through `call_tool`, one of the node\'s exits, its timeout.');
    }
    return implode('\n', L) + '\n';
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

void keysOf;
