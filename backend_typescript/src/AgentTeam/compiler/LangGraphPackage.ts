import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  array_unique, basename, copy, entries, explode, has, implode, isEmptyArr, is_array, keysOf, mb_check_encoding_utf8,
  pathExtension, preg_replace, preg_split, sortStrings, strtolower, strtoupper, strval, trim, truthy, values, empty,
} from './php';
import { EnvVars, PackageDocs } from './PackageDocs';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import { PythonRequirements } from './PythonRequirements';
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

/**
 * The Docker app's skill store as a compile reads it (SkillStore.compileResolver): the folder of skill `dir` as the
 * workflow's owner sees it, null when they cannot; `from` is the skill that needs it (a store resolver prefers its group).
 */
export type SkillResolver = (dir: string, from?: string | null) => string | null;

/** A compile's skills: the skills folder, or the skill store's resolver. */
export type SkillsRoot = string | SkillResolver;

export type SkillFile = { dir: string; rel: string; bytes: Buffer; entry: PackageFile };

/** What every LangGraph program imports (the single file; a package's workflow, common and agents). */
const BASE_REQUIREMENTS = ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx',
  'pydantic', 'python-dotenv'];

/** A package's run server (api.py; an A2A agent server serves with uvicorn too). */
const SERVER_REQUIREMENTS = ['fastapi', 'uvicorn'];

/** The A2A package: its agents are A2A servers, its orchestrator their client. */
const A2A_REQUIREMENTS = ['a2a-sdk[http-server]'];

/** Providers whose LLM factory branch imports a package beyond the base ones. */
const PROVIDER_REQUIREMENTS: Record<string, string> = { gemini: 'langchain-google-genai', google: 'langchain-google-genai' };

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
  /** The TO RUN install line of a package's files: the package's requirements.txt holds the list. */
  static readonly PIP_REQUIREMENTS = 'pip install -r requirements.txt';

  /** TO RUN note: the document converter's packages are imported only for an attachment of that format. */
  static readonly OPTIONAL_FORMATS_NOTE = ['# optional, only for the attachment formats you use:',
    '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'];

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
  static files(facts: any, skillsRoot: SkillsRoot, documents: StartDocumentReader = null): PackageFile[] {
    const skills = LangGraphPackage.skillFiles(facts, skillsRoot);
    const out: PackageFile[] = LangGraphPackage.docFiles(facts, 'modular', skills,
      strval(facts['safeName']) + (has(facts, 'swarm') ? '_modular_swarm' : '_modular'), 'workflow.py');
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
   * Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc, .env*, dot-directories), sorted,
   * plus the skill's native wheels (.wheels/native/: the program installs its libraries from there, offline);
   * never the browser's (.wheels/pyodide/). Each used skill brings the skills it requires (requiredSkills(),
   * transitively): they are copied the same way, after the bound ones, at skills/<leaf>/ (a grouped one too).
   *
   * skillsRoot: the folder holding the skills, or (the Docker app's skill store) a resolver giving each skill's own
   * folder, null when the owner cannot see it. bytes is the file's content (Buffer).
   */
  static skillFiles(facts: any, skillsRoot: SkillsRoot): SkillFile[] {
    const out: SkillFile[] = [];
    const root: string | false | null = typeof skillsRoot === 'string' ? realpath(skillsRoot) : null;
    // [skill, who needs it, where it goes]: a bound skill at its own path; a required one at skills/<leaf>/, where
    // the scripts that need it look (SKILLS_ROOT/<leaf>/...).
    const queue: Array<[string, string | null, string]> = LangGraphPackage.skillDirs(facts).map((d) => [d, null, d]);
    const done = new Map<string, string>();
    let installed: string[] | null = null; // the skill paths a folder root holds (read once, when a skill needs it)
    while (queue.length > 0) {
      const [d, by, as] = queue.shift()!;
      if (done.has(as)) {
        if (done.get(as) !== d) { // two different skills would land in one folder
          throw new Error(`Skills "${done.get(as)}" and "${d}" both need to be available as '${as}'; rename one.`);
        }
        continue;
      }
      done.set(as, d);
      const base = LangGraphPackage.skillBase(d, skillsRoot, root, by);
      if (base === false) {
        throw new Error(by === null
          ? `Skill folder "${d}" is not available on this server, so it can't be packaged.`
          : `Skill "${by}" needs skill "${d}", which is not available on this server, so it can't be packaged.`);
      }
      const found = LangGraphPackage.folderFiles(base, base);
      const own: Record<string, Buffer> = {};
      for (const rel of found) {
        if (rel === 'SKILL.md' || rel.startsWith('scripts/')) own[rel] = fs.readFileSync(`${base}/${rel}`);
      }
      if (isDir(`${base}/.wheels/native`)) found.push(...LangGraphPackage.folderFiles(base, `${base}/.wheels/native`));
      sortStrings(found);
      for (const rel of found) {
        const bytes = fs.readFileSync(`${base}/${rel}`);
        out.push({ dir: as, rel, bytes, entry: LangGraphPackage.entry(`skills/${as}/${rel}`, bytes) });
      }
      let names: string[];
      if (root !== null) {
        installed ??= root === false ? [] : LangGraphPackage.installedSkills(root);
        names = installed;
      } else {
        names = LangGraphPackage.probedSkills(d, own, skillsRoot as SkillResolver);
      }
      const req = LangGraphPackage.requiredSkills(d, own, names);
      for (const m of req.missing) {
        throw new Error(`Skill "${d}" needs skill "${m}", which is not available on this server, so it can't be packaged.`);
      }
      for (const q of req.requires) queue.push([q, d, basename(q)]);
    }
    return out;
  }

  /** The real folder of skill d (inside the root, or from the store resolver), false when unsafe or absent. */
  private static skillBase(d: string, skillsRoot: SkillsRoot, root: string | false | null, from: string | null = null): string | false {
    // dir_name comes from the client-saved node config: plain segments ("GEO/geo-report" for a grouped
    // skill; none empty, "." or "..", none starting with "." (.git, .superpowers), no "\"), resolved
    // inside the root.
    const segments = StartDocumentStore.safeSegments(d);
    const safe = segments !== null && segments.filter((seg) => seg.startsWith('.')).length === 0;
    if (!safe) return false;
    let base: string | false;
    if (root === null) {
      const dir = (skillsRoot as SkillResolver)(d, from); // from: the skill that needs it (a store resolver prefers its group)
      base = dir === null ? false : realpath(dir);
    } else {
      base = root !== false ? realpath(root + path.sep + d) : false;
      base = base !== false && base.startsWith(root + path.sep) ? base : false;
    }
    return base !== false && isDir(base) ? base : false;
  }

  /** The skill paths under a skills root: folders (one or two levels, no dot-folder) holding a SKILL.md. */
  private static installedSkills(root: string): string[] {
    const out: string[] = [];
    const ls = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    };
    for (const a of ls(root)) {
      if (a.startsWith('.') || !isDir(`${root}/${a}`)) continue;
      if (isFile(`${root}/${a}/SKILL.md`)) {
        out.push(a);
        continue;
      }
      for (const b of ls(`${root}/${a}`)) {
        if (!b.startsWith('.') && isFile(`${root}/${a}/${b}/SKILL.md`)) out.push(`${a}/${b}`);
      }
    }
    sortStrings(out);
    return out;
  }

  /**
   * The store has no listing here, only the resolver: every name the skill could mean (its requires-skills, else each
   * exact quoted literal and each /segment/ of its scripts) that resolves to a skill the owner sees (the resolver
   * also finds a grouped skill by its leaf).
   */
  private static probedSkills(self: string, files: Record<string, Buffer | string>, resolve: SkillResolver): string[] {
    const md = text(files['SKILL.md'] ?? '');
    const cands: string[] = [...(LangGraphPackage.declaredSkillsOrNull(md) ?? [])];
    if (!LangGraphPackage.declaresSkills(md)) { // declared (even []) replaces scanning
      for (const lit of LangGraphPackage.quotedLiterals(files)) {
        cands.push(lit); // an exact literal
        const segs = lit.split('/');
        for (let i = 1; i < segs.length - 1; i++) cands.push(segs[i]); // a /segment/ with a slash on both sides
      }
    }
    const out: string[] = [];
    for (const c of [...new Set(cands)]) {
      if (c === self || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/.test(c)) continue;
      const dir = resolve(c, self);
      if (dir !== null && isFile(dir + '/SKILL.md')) out.push(c);
    }
    sortStrings(out);
    return out;
  }

  /** The quoted string literals ('…' / "…", one line) of a skill's scripts/** text files. */
  private static quotedLiterals(files: Record<string, Buffer | string>): string[] {
    const lits: string[] = [];
    for (const [rel, bytes] of Object.entries(files)) {
      const buf = toBuf(bytes);
      if (!rel.startsWith('scripts/') || rel.split('/').includes('__pycache__') || rel.endsWith('.pyc') || !mb_check_encoding_utf8(buf)) continue;
      for (const m of buf.toString('utf8').matchAll(/'([^'\n\\]*)'|"([^"\n\\]*)"/g)) {
        lits.push((m[2] ?? '') !== '' ? m[2] : (m[1] ?? ''));
      }
    }
    return lits;
  }

  /** `requires-skills:` of a SKILL.md frontmatter (list or single form, parsed as `dependencies:`); [] when absent. */
  static declaredSkills(skillMd: Buffer | string): string[] {
    return LangGraphPackage.frontmatterList(text(skillMd), 'requires-skills:');
  }

  /** Whether the frontmatter has a `requires-skills:` line: `requires-skills: []` says "none" and stops scanning. */
  static declaresSkills(skillMd: Buffer | string): boolean {
    return LangGraphPackage.declaredSkillsOrNull(text(skillMd)) !== null;
  }

  /** null when the frontmatter has no `requires-skills:` line. */
  private static declaredSkillsOrNull(skillMd: string): string[] | null {
    return LangGraphPackage.frontmatterListOrNull(skillMd, 'requires-skills:');
  }

  /** The installed skill a name means: the exact path, else by leaf (same group as from, then top level, then the first). */
  static resolveSkillName(name: string, installed: string[], from: string): string | null {
    if (installed.includes(name)) return name;
    const leaf = basename(name);
    const hits = installed.filter((p) => basename(p) === leaf);
    if (hits.length === 0) return null;
    const group = from.includes('/') ? from.split('/')[0] : '';
    for (const p of hits) if ((p.includes('/') ? p.split('/')[0] : '') === group) return p;
    for (const p of hits) if (!p.includes('/')) return p;
    sortStrings(hits);
    return hits[0];
  }

  /**
   * The skills skill path requires (one level; twin of SkillRequires.direct in frontend/assets/js/skill-requires.js):
   * its `requires-skills:` when declared (replaces scanning), else every OTHER installed skill whose leaf folder name
   * is an exact quoted string of its scripts/** text files or a /leaf/ segment (slash on both sides) inside one.
   * Unknown declared names are missing.
   */
  static requiredSkills(p: string, files: Record<string, Buffer | string>, installed: string[]): { requires: string[]; missing: string[] } {
    const list = installed.filter((x) => x !== p);
    const out = new Set<string>();
    const missing: string[] = [];
    const declared = LangGraphPackage.declaredSkillsOrNull(text(files['SKILL.md'] ?? ''));
    if (declared !== null) { // a declared list (even []) replaces scanning
      for (const name of declared) {
        const hit = LangGraphPackage.resolveSkillName(name, list, p);
        if (hit === null) missing.push(name);
        else out.add(hit);
      }
    } else {
      const lits = LangGraphPackage.quotedLiterals(files);
      const exact = new Set(lits);
      for (const leaf of [...new Set(list.map((x) => basename(x)))]) {
        const hit = exact.has(leaf) || lits.some((l) => l.includes(`/${leaf}/`));
        if (hit) out.add(LangGraphPackage.resolveSkillName(leaf, list, p) as string);
      }
    }
    const req = [...out];
    sortStrings(req);
    return { requires: req, missing };
  }

  /** The files under from (paths relative to the skill folder base), skipping junk, .env* and dot-directories. */
  private static folderFiles(base: string, from: string): string[] {
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
        if (isDir(full) && name.startsWith('.')) continue; // .git/, .pytest_cache/, .wheels/ ... (a link to one too)
        // RecursiveDirectoryIterator does not descend into a symlinked directory (a leaf, and not a file).
        if (isRealDir(full)) {
          walk(full);
          continue;
        }
        // A file is copied only if it really lives in the skill folder (a symlink may point elsewhere).
        const real = isFile(full) ? realpath(full) : false;
        if (real !== false && real.startsWith(base + path.sep)) found.push(full.slice(base.length + 1));
      }
    };
    walk(from);
    return found;
  }

  /**
   * The SKILL.md dependencies a package's requirements.txt lists: those of each skill without bundled wheels.
   * A skill that carries .wheels/native/*.whl installs its libraries from there, offline, at its first use.
   */
  static skillRequirementNames(skillFiles: Array<{ dir?: string; rel: string; bytes: Buffer | string }>): string[] {
    const bundled = new Set<string>();
    for (const f of skillFiles) {
      if (f.rel.startsWith('.wheels/native/') && f.rel.endsWith('.whl')) bundled.add(String(f.dir ?? ''));
    }
    const req: string[] = [];
    for (const f of skillFiles) {
      if (f.rel === 'SKILL.md' && !bundled.has(String(f.dir ?? ''))) req.push(...LangGraphPackage.skillDependencies(f.bytes));
    }
    return req;
  }

  /** `dependencies:` of a SKILL.md's frontmatter, parsed as SkillRuntime.ensure_deps parses it. */
  static skillDependencies(skillMd: Buffer | string): string[] {
    return LangGraphPackage.frontmatterList(text(skillMd), 'dependencies:');
  }

  /** A frontmatter list field (key with its colon): `key: a, b` or `key: [a, "b"]`; [] when absent. */
  private static frontmatterList(skillMd: string, key: string): string[] {
    return LangGraphPackage.frontmatterListOrNull(skillMd, key) ?? [];
  }

  /** frontmatterList, but null when the field is absent (or there is no frontmatter). */
  private static frontmatterListOrNull(skillMd: string, key: string): string[] | null {
    const lines = preg_split('/\\r\\n|\\r|\\n/', skillMd);
    if (!lines.length || trim(lines[0]) !== '---') return null;
    for (const line of lines.slice(1)) {
      const s = trim(line);
      if (s === '---') break;
      if (strtolower(s).startsWith(key)) return LangGraphPackage.listItems(explode(':', s, 2)[1]);
    }
    return null;
  }

  /**
   * Items of a frontmatter list value (`a, b` or `[a, 'b,c']`): split on commas outside single/double quotes,
   * then one matching quote pair is stripped ('' -> ' inside single quotes). An unterminated quote falls back
   * to splitting on every comma. Twin of SkillRequires.listItems (JS) and the emitted Python readers.
   */
  static listItems(raw: string): string[] {
    const val = trim(trim(raw), '[]');
    const items: string[] = [];
    let cur = '';
    let q: string | null = null;
    for (let i = 0; i < val.length; i++) {
      const c = val[i];
      if (q !== null) {
        cur += c;
        if (c === q) {
          if (q === "'" && (val[i + 1] ?? '') === "'") cur += val[++i];
          else q = null;
        }
      } else if ((c === '"' || c === "'") && trim(cur) === '') {
        q = c;
        cur += c;
      } else if (c === ',') {
        items.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    items.push(cur);
    const out: string[] = [];
    if (q !== null) {
      for (const d0 of val.split(',')) {
        const d = trim(trim(trim(d0), "'"), '"');
        if (d !== '') out.push(d);
      }
      return out;
    }
    for (const d0 of items) {
      let d = trim(d0);
      const k = d[0] ?? '';
      if (d.length >= 2 && (k === "'" || k === '"') && d[d.length - 1] === k) {
        d = d.slice(1, -1);
        if (k === "'") d = d.split("''").join("'");
      }
      if (d !== '') out.push(d);
    }
    return out;
  }

  private static providers(facts: any): string[] {
    const p = new Set<string>();
    for (const d of [...values(at(facts, 'agentData') ?? []), ...values(at(facts, 'playbookData') ?? [])]) {
      if ((at(d, 'provider') ?? '') !== '') p.add(strtolower(strval(d['provider'])));
    }
    return [...p];
  }

  /**
   * The packages a LangGraph program of layout ('single' | 'modular' | 'a2a') imports: the one list its
   * requirements.txt, its TO RUN install line and its README come from. skillFiles: the skills the package
   * carries (their SKILL.md dependencies); a program that reads its skills from the editor's folder installs
   * their dependencies at the first run instead.
   */
  static requirementNames(facts: any, layout: string, skillFiles: Array<{ dir?: string; rel: string; bytes: Buffer }> = []): string[] {
    const req: string[] = [...BASE_REQUIREMENTS];
    if (layout !== 'single') req.push(...SERVER_REQUIREMENTS);
    if (layout === 'a2a') req.push(...A2A_REQUIREMENTS);
    if (has(facts, 'swarm')) req.push(...SWARM_REQUIREMENTS);
    for (const p of LangGraphPackage.providers(facts)) {
      if (Object.hasOwn(PROVIDER_REQUIREMENTS, p)) req.push(PROVIDER_REQUIREMENTS[p]);
    }
    req.push(...LangGraphPackage.skillRequirementNames(skillFiles));
    req.push(...PythonRequirements.documentNames(at(facts, 'startDocuments') ?? []));
    return req;
  }

  /** The TO RUN install line of a layout program that has no requirements.txt beside it (the single file). */
  static pipInstall(facts: any, layout: string): string {
    return PythonRequirements.pipInstall(LangGraphPackage.requirementNames(facts, layout));
  }

  /**
   * The files a single-file export carries beside <name>_langgraph.py: requirements.txt, .env.example and
   * README.md (the script reads the .env next to it first).
   */
  static singleFiles(facts: any, filename: string): PackageFile[] {
    return LangGraphPackage.docFiles(facts, 'single', [], filename.replace(/\.py$/, ''), filename);
  }

  /** requirements.txt, .env.example and README.md of the A2A package (layout: a2aLayout()). */
  static a2aFiles(facts: any, layout: any): PackageFile[] {
    return LangGraphPackage.docFiles({ a2aAgents: layout['agents'], ...facts }, 'a2a', [], strval(layout['root']), 'orchestrator.py');
  }

  private static docFiles(facts: any, layout: string, skillFiles: Array<{ rel: string; bytes: Buffer }>, folder: string,
    entry: string): PackageFile[] {
    return [
      { path: 'requirements.txt', code: PythonRequirements.txt(LangGraphPackage.requirementNames(facts, layout, skillFiles)) },
      { path: '.env.example', code: PackageDocs.envExample(strval(facts['wfName']), LangGraphPackage.envVariables(facts),
        LangGraphPackage.optionalEnv(facts, layout)) },
      { path: 'README.md', code: LangGraphPackage.readme(facts, layout, folder, entry) },
    ];
  }

  /** The environment the program reads that .env must provide (PackageDocs' vars). */
  static envVariables(facts: any): EnvVars {
    const keys = new Map<string, string[]>();
    for (const p of LangGraphPackage.providers(facts)) {
      const k = PythonEmitHelpers.providerKeyEnv(p);
      if (k !== null) {
        if (!keys.has(k)) keys.set(k, []);
        keys.get(k)!.push(p);
      }
    }
    const decision = new Map<string, string>();
    for (const ad of values(at(facts, 'agentData') ?? [])) {
      for (const c of values(!empty(at(ad, 'dispatch')) ? (at(ad, 'decision') ?? []) : [])) {
        decision.set(strval(c['key_env']), strval(c['url_env']));
      }
    }
    // Every LangGraph program reads MODEL_NAME: its model factory is in the script, common.py or each agent server.
    return { keys, decision, mcp: at(facts, 'serverSlugs') ?? [], model: 'One model for every node, instead of each node\'s own' };
  }

  /** The optional variables a layout program reads, as .env.example lists them: [what it does, KEY=example]. */
  private static optionalEnv(facts: any, layout: string): Array<[string, string]> {
    const o: Array<[string, string]> = [];
    o.push(layout === 'single' ? ['Where saved outputs go (default: outputs/ next to the script)', 'SYNERGYAI_OUTPUT_ROOT=./outputs']
      : layout === 'a2a' ? ['Where saved outputs go (default: ~/Documents/synergyAI/outputs)', 'SYNERGYAI_OUTPUT_ROOT=/path/to/outputs']
        : ['Where saved outputs go (default: outputs/ in this folder)', 'SYNERGYAI_OUTPUT_ROOT=./outputs']);
    if (layout !== 'a2a' && !has(facts, 'swarm')) {   // a swarm and the A2A orchestrator write no run logs
      o.push([layout === 'single' ? 'Where run logs go (default: runs/ next to the script)' : 'Where run logs go (default: runs/ in this folder)',
        'RUNS_DIR=./runs']);
    }
    if (LangGraphPackage.skillDirs(facts).length) {
      o.push(layout === 'modular'
        ? ['Where the skills are read from (default: skills/ in this folder)', 'SYNERGYAI_SKILLS_DIR=./skills']
        : ['Where the skills are read from (default: ' + PackageDocs.EDITOR_SKILLS_DIR + ')', 'SYNERGYAI_SKILLS_DIR=/path/to/skills']);
    }
    if (layout === 'a2a') o.push(['First port of the agent servers, one per agent in order (default: 8701)', 'A2A_BASE_PORT=8701']);
    return o;
  }

  /** README.md: what the folder is, install, configure, the run modes, files written, run server, service, code nodes. */
  private static readme(facts: any, layout: string, folder: string, entry: string): string {
    const name = strval(facts['wfName']);
    const swarm = has(facts, 'swarm');
    const skills = LangGraphPackage.skillDirs(facts);
    const startMode = strval(at(facts, 'startMode') ?? 'prompt');
    const defaultCron: string | null = at(facts, 'defaultCron');
    const intro: string[] = layout === 'single'
      ? ['A LangGraph program compiled from the SynergyAI workflow editor, as one Python file: `' + entry + '`.',
        'It runs on its own: no database, no SynergyAI server.']
      : layout === 'a2a'
        ? ['A LangGraph program compiled from the SynergyAI workflow editor, as A2A agents: each agent node is an',
          'A2A server of its own (`agents/`), and `orchestrator.py` runs the workflow over them. It runs on its own:',
          'no database, no SynergyAI server.']
        : swarm
          ? ['A LangGraph swarm compiled from the SynergyAI workflow editor: its agents (`agents/`, one file each) hand',
            'the conversation to one another. It runs on its own: no database, no SynergyAI server. Everything it needs',
            'is in this folder.']
          : ['A LangGraph program compiled from the SynergyAI workflow editor, with each node in a file of its own',
            '(`agents/`). It runs on its own: no database, no SynergyAI server. Everything it needs is in this folder.'];
    if (layout !== 'modular') intro.push(...PackageDocs.editorSkillsNote(skills));
    const L = PackageDocs.head(name, intro, folder, LangGraphPackage.envVariables(facts));
    L.push('## Run');
    L.push('');
    L.push('Run these from the folder, with the environment active.');
    L.push('');
    if (layout === 'a2a') {
      L.push('```sh');
      L.push('python orchestrator.py "your prompt"   # one run on the text (no text: the Start node\'s prompt)');
      L.push('python orchestrator.py --cron [EXPR]   # a run on each tick of a 5-field cron schedule, until stopped');
      L.push('```');
      L.push('');
      L.push(defaultCron !== null ? `Without EXPR, \`--cron\` uses the Start node's schedule (\`${defaultCron}\`).`
        : '`--cron` needs EXPR: the Start node has no schedule.');
      L.push('Text goes before `--cron` (after it, it is read as the cron expression). Ctrl-C (or SIGTERM) stops the loop.');
      L.push('');
      L.push(...LangGraphPackage.a2aAgentLines(at(facts, 'a2aAgents') ?? []));
    } else {
      L.push(...PackageDocs.modes(entry, swarm ? 'prompt' : startMode, defaultCron, swarm ? null : at(facts, 'defaultWatch'), !swarm));
    }
    L.push('## Files written');
    L.push('');
    const here = layout === 'single' ? 'next to the script' : 'in this folder';
    L.push(layout === 'a2a'
      ? '- `~/Documents/synergyAI/outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).'
      : `- \`outputs/\` ${here} -- the saved results, when output storage is on (\`SYNERGYAI_OUTPUT_ROOT\` overrides).`);
    if (layout !== 'a2a' && !swarm) {
      L.push(`- \`runs/\` ${here} -- one \`<date>_<run id>.jsonl\` event log per run, and \`runs/current\` (\`RUNS_DIR\` overrides).`);
      L.push('  A run with nothing to do leaves no file.');
    }
    L.push('');
    if (layout === 'a2a') {
      L.push(...PackageDocs.runServer(false, ['The agent servers start with its first run and stop when it exits.']));
    } else if (layout === 'modular') {
      L.push(...PackageDocs.runServer(!swarm));
    }
    if (layout === 'a2a') {
      const cron = defaultCron !== null;
      L.push(...PackageDocs.service(name, 'LangGraph', folder, entry, cron ? '--cron' : '', cron ? 'cron' : 'prompt'));
    } else {
      L.push(...PackageDocs.service(name, 'LangGraph', folder, entry, '', swarm ? 'prompt' : startMode));
    }
    if (layout === 'modular' && !isEmptyArr(at(facts, 'codeData') ?? [])) {
      L.push('## Editing code nodes');
      L.push('');
      L.push('Each code node runs its file in `code/` (`code/start_<name>.py` is the Start option\'s code).');
      L.push('The file is read at each run: an edit takes effect on the next run, with no recompile. The code');
      L.push('runs under the same rules as in the editor (`code_harness.py`): standard library only, network');
      L.push('only through `call_tool`, one of the node\'s exits, its timeout.');
      L.push('');
    }
    return implode('\n', L).replace(/\n+$/, '') + '\n';
  }

  /** The A2A agent servers: what starts them, their files and default URLs. agents: a2aLayout()['agents']. */
  private static a2aAgentLines(agents: any): string[] {
    const L: string[] = [];
    L.push('### Agent servers');
    L.push('');
    L.push('The orchestrator starts every agent server at launch and stops them when it ends. `--keep-serving` leaves');
    L.push('them running; `--no-spawn` starts none and uses servers already running, each at its `A2A_AGENT_<id>_URL`');
    L.push('(default below; `A2A_BASE_PORT` moves the whole range).');
    L.push('');
    L.push('| Node | File | Default URL |');
    L.push('|---|---|---|');
    const all = entries(agents);
    for (const [nid, e] of all) L.push(`| ${strval(e['display'])} (${nid}) | \`${strval(e['file'])}\` | http://127.0.0.1:${strval(e['port'])}/ |`);
    L.push('');
    if (all.length) {
      const first = all[0][1];
      L.push(`To start one by hand: \`python ${strval(first['file'])} --port ${strval(first['port'])}\` (\`--host\` sets the interface).`);
      L.push('');
    }
    return L;
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

/** A file's text (bytes as UTF-8). */
function text(b: Buffer | string): string {
  return Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '');
}
