import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LangGraphPackage } from '../AgentTeam/compiler/LangGraphPackage';
import { Edition, EditionConfig } from './Edition';
import { SkillClashException, SkillForbidden, SkillInUse, SkillNotFound, SkillPathInvalid, SkillRequiredBy } from './SkillErrors';

type Entry = { owner: number | string; visibility: string };
type Index = Record<string, Entry>;
type Files = Record<string, Buffer>;

export type SkillRow = {
  path: string;
  name: string;
  description: string;
  visibility: string;
  owner_id: number;
  mine: boolean;
  dependencies: string[];
  requires?: string[];
};

/** The robot's workflows binding a leaf name (RobotSkillPolicy.robotWorkflowsUsing). */
export type RobotWorkflowsUsing = (leaf: string) => Promise<Array<{ id: number; name: string }>>;

/**
 * Mirrors src/Services/SkillStore.php: the skills volume of the Docker app: <root>/public/<path>/ and
 * <root>/users/<uid>/<path>/, with <root>/index.json recording owner and visibility of every skill. A skill path is
 * "leaf" or "group/leaf"; the leaf name is unique across public skills and the caller's own area. The individual
 * edition has no public area. No database: the volume is the only state.
 *
 * File work is synchronous (as PHP's): a write runs to its end without yielding, so writes of this process never
 * interleave. PHP also takes flock(<root>/.lock) against other processes; Node has no flock, so the lock file is
 * created but not locked (one backend process serves a volume).
 */
export class SkillStore {
  constructor(private readonly root: string, private readonly edition: string, private readonly robotWorkflowsUsing: RobotWorkflowsUsing | null = null) {}

  static fromEnv(cfg: EditionConfig, robotWorkflowsUsing: RobotWorkflowsUsing | null = null): SkillStore | null {
    const dir = (process.env.SKILLS_DIR ?? '').trim();
    return dir === '' ? null : new SkillStore(dir.replace(/\/+$/, ''), Edition.current(cfg), robotWorkflowsUsing);
  }

  /** The first skill named leaf in some user's private area. */
  findPrivate(leaf: string): { path: string; owner_id: number } | null {
    for (const [key, e] of Object.entries(this.index())) {
      const [area, p] = this.splitKey(key);
      if (area !== 'public' && this.leaf(p) === leaf && isDir(this.dir(area, p))) return { path: p, owner_id: intval(e.owner) };
    }
    return null;
  }

  list(userId: number, asRobot = false, withRequires = false): SkillRow[] {
    const rows: SkillRow[] = [];
    const index = this.index();
    // Only when asked (reads each skill's scripts/): the names a row's requirements resolve against, built once.
    let mine: string[] | null = null;
    let pub: string[] | null = null;
    if (withRequires) {
      pub = Object.keys(this.viewOf(index, -1)); // no user -1: public skills only
      mine = asRobot && this.edition !== 'individual' ? pub : Object.keys(this.viewOf(index, userId));
    }
    for (const [key, e] of Object.entries(index)) {
      const [area, p] = this.splitKey(key);
      if (!this.visible(e, userId, asRobot) || !isDir(this.dir(area, p))) continue;
      const md = readText(this.dir(area, p) + '/SKILL.md');
      const fm = this.frontmatter(md);
      const row: SkillRow = {
        path: p,
        name: fm.name ?? this.leaf(p),
        description: fm.description ?? '',
        visibility: e.visibility,
        owner_id: intval(e.owner),
        mine: intval(e.owner) === userId,
        dependencies: LangGraphPackage.skillDependencies(md),
      };
      if (withRequires) {
        // Direct required skills (same rule as delete protection). My own: from my view (own, then public); another
        // user's public skill: against public skills only, as it resolves for its owner at run time.
        const names = intval(e.owner) === userId ? mine! : pub!;
        row.requires = LangGraphPackage.requiredSkills(p, this.requiresFiles(area, p, md), names).requires;
      }
      rows.push(row);
    }
    rows.sort((a, b) => strcmp(a.path, b.path));
    return rows;
  }

  /** rel => bytes; .wheels/native/ is never included. */
  files(userId: number, p: string, asRobot = false, withWheels = true): Files {
    this.checkPath(p);
    const r = this.resolve(userId, p, asRobot);
    if (r === null) throw new SkillNotFound('No such skill.');
    return this.readTree(this.dir(r[0], p), withWheels);
  }

  /**
   * A skill's files as paths and sizes (stat, contents never read): SKILL.md first, then byte order.
   * Left out: `.wheels/`, `__pycache__/`, `*.pyc` and anything dot-named.
   */
  listing(userId: number, p: string, asRobot = false): Array<{ rel: string; size: number }> {
    this.checkPath(p);
    const r = this.resolve(userId, p, asRobot);
    if (r === null) throw new SkillNotFound('No such skill.');
    const dir = this.dir(r[0], p);
    const out: Array<{ rel: string; size: number }> = [];
    if (isDir(dir)) {
      for (const full of walkFiles(dir)) {
        const rel = full.slice(dir.length + 1);
        if (this.isPyCache(rel) || /(^|\/)\./.test(rel)) continue;
        out.push({ rel, size: fs.statSync(full).size });
      }
    }
    out.sort((a, b) => (a.rel !== 'SKILL.md' ? 1 : 0) - (b.rel !== 'SKILL.md' ? 1 : 0) || strcmp(a.rel, b.rel));
    return out;
  }

  readFile(userId: number, p: string, rel: string, asRobot = false): Buffer {
    this.checkPath(p);
    this.checkRel(rel);
    const r = this.resolve(userId, p, asRobot);
    if (r === null) throw new SkillNotFound('No such skill.');
    const file = this.dir(r[0], p) + '/' + rel;
    if (!isFile(file)) throw new SkillNotFound('No such file.');
    return fs.readFileSync(file);
  }

  writeFile(userId: number, p: string, rel: string, bytes: Buffer): void {
    this.checkPath(p);
    this.checkRel(rel);
    this.locked(() => {
      const [area] = this.owned(userId, p);
      const file = this.dir(area, p) + '/' + rel;
      this.mkdir(path.dirname(file));
      this.put(file, bytes);
    });
  }

  /**
   * dryRun: only say what the import would do: 'new' | 'identical', or the clash; nothing is written.
   * expectPublic (public): the required skills the user confirmed go public along; 409 when it differs.
   * A public import takes along the skills it requires that are still my own private ones (as setVisibility does),
   * all or nothing. batch: the other skills of the same import (one zip), installed public with it: a requirement
   * naming one of them resolves to it (after my own and the public skills) instead of being missing.
   */
  import(userId: number, p: string, files: Files, visibility = 'private', dryRun = false,
    expectPublic: string[] | null = null, batch: string[] = []): { status: string; made_public?: string[] } {
    this.checkPath(p);
    this.checkVisibility(visibility);
    for (const rel of Object.keys(files)) this.checkRel(rel);
    return this.locked(() => {
      const index = this.index();
      for (const area of [this.areaFor(userId, 'private'), 'public']) {
        const e = index[`${area}/${p}`];
        if (e !== undefined && intval(e.owner) === userId) {
          const same = sameFingerprint(this.fingerprint(this.readTree(this.dir(area, p), false)), this.fingerprint(withoutWheels(files)));
          if (same) return { status: 'identical' };
          throw new SkillClashException(`A different skill is already installed at '${p}'.`);
        }
      }
      const incoming = this.fingerprint(withoutWheels(files));
      for (const key of Object.keys(index)) {
        const [a, q] = this.splitKey(key);
        if ((a === 'public' || a === `users/${userId}`) && this.leaf(q) === this.leaf(p)
          && sameFingerprint(this.fingerprint(this.readTree(this.dir(a, q), false)), incoming)) {
          return { status: 'identical' };
        }
      }
      this.assertLeafFree(index, userId, p, true);
      const area = this.areaFor(userId, visibility);
      let along: string[] = [];
      if (visibility === 'public') {
        along = this.privateRequired(index, userId, p, this.requiresOnly(withoutWheels(files)), null,
          batch.map(String).filter((x) => x !== p));
        for (const q of along) this.assertLeafFree(index, userId, q, false);
        this.assertExpected(p, along, expectPublic);
      }
      if (dryRun) return { status: 'new', ...(visibility === 'public' ? { made_public: along } : {}) };
      const dir = this.dir(area, p);
      this.rmtree(dir); // a folder with no index entry has no owner: never merge into it
      this.mkdir(dir);
      for (const [rel, bytes] of Object.entries(files)) {
        const file = dir + '/' + rel;
        this.mkdir(path.dirname(file));
        this.put(file, bytes);
      }
      index[`${area}/${p}`] = { owner: userId, visibility };
      try {
        this.publishAll(index, userId, along);
      } catch (e) {
        this.rmtree(dir); // all or nothing: the skill goes with the skills it needs, or not at all
        this.pruneGroup(area, p);
        throw e;
      }
      this.saveIndex(index);
      return { status: 'installed', ...(visibility === 'public' ? { made_public: along } : {}) };
    });
  }

  /**
   * Make one of my skills public or private. Public takes along every skill it requires (closure) that is still my
   * own private skill, all or nothing (a leaf clash in public for any of them changes nothing); a required skill I
   * cannot make public refuses it. Private is refused while a public skill requires it. dryRun: only say what would
   * be made public.
   */
  async setVisibility(userId: number, p: string, visibility: string, dryRun = false, expectPublic: string[] | null = null): Promise<{ made_public: string[] }> {
    this.checkPath(p);
    this.checkVisibility(visibility);
    // The robot check reads the database: done first (PHP does it inside its lock), then the write runs locked.
    const pre = this.resolve(userId, p, false);
    if (visibility === 'private' && pre !== null && pre[0] === 'public' && intval(pre[1].owner) === userId && !dryRun) {
      await this.assertNotBoundByRobot(p);
    }
    return this.locked(() => {
      const [area] = this.owned(userId, p);
      const to = this.areaFor(userId, visibility);
      const index = this.index();
      if (visibility === 'public') {
        const along = this.privateRequired(index, userId, p, null, area);
        const moves = to === area ? along : [p, ...along];
        for (const q of moves) this.assertLeafFree(index, userId, q, false);
        this.assertExpected(p, along, expectPublic);
        if (!dryRun && moves.length > 0) {
          this.publishAll(index, userId, moves);
          this.saveIndex(index);
        }
        return { made_public: along };
      }
      if (to === area || dryRun) return { made_public: [] };
      if (area === 'public') {
        const publicDeps = this.dependents(index, userId, area, p, true);
        if (publicDeps.length > 0) {
          const list = publicDeps.join(', ');
          throw new SkillRequiredBy(`"${this.leaf(p)}" can't be made private: the public skill(s) ${list} need it to run.`, 'private', p, publicDeps);
        }
      }
      this.relocate(area, p, to, p);
      delete index[`${area}/${p}`];
      index[`${to}/${p}`] = { owner: userId, visibility };
      this.saveIndex(index);
      return { made_public: [] };
    });
  }

  /**
   * dryRun: only check (a group delete checks every skill first). withPaths: skills deleted together with this one
   * (the rest of the group): they do not count as skills that need it.
   */
  async delete(userId: number, p: string, dryRun = false, withPaths: string[] = []): Promise<void> {
    this.checkPath(p);
    const [area0] = this.owned(userId, p);
    if (area0 === 'public') await this.assertNotBoundByRobot(p);
    this.locked(() => {
      const [area] = this.owned(userId, p);
      // The rest of the group, as the skills of mine at those paths (area + path, never someone else's same path).
      const except: string[] = [];
      for (const w of withPaths) {
        const r = this.resolve(userId, String(w), false);
        if (r !== null && intval(r[1].owner) === userId) except.push(r[0] + '/' + w);
      }
      this.assertNotRequired(userId, area, p, 'delete', except);
      if (dryRun) return;
      this.rmtree(this.dir(area, p));
      this.pruneGroup(area, p);
      const index = this.index();
      delete index[`${area}/${p}`];
      this.saveIndex(index);
    });
  }

  async move(userId: number, from: string, to: string): Promise<void> {
    this.checkPath(from);
    this.checkPath(to);
    const [area0] = this.owned(userId, from);
    if (from !== to && area0 === 'public' && this.leaf(from) !== this.leaf(to)) await this.assertNotBoundByRobot(from);
    this.locked(() => {
      const [area, entry] = this.owned(userId, from);
      if (from === to) return;
      if (this.leaf(from) !== this.leaf(to)) { // regrouping keeps the leaf: the skills that need it still find it
        this.assertNotRequired(userId, area, from, 'rename');
      }
      const index = this.index();
      if (index[`${area}/${to}`] !== undefined) throw new SkillClashException(`A skill already exists at '${to}'.`);
      delete index[`${area}/${from}`];
      this.assertLeafFree(index, userId, to, true);
      this.relocate(area, from, area, to);
      index[`${area}/${to}`] = entry;
      this.saveIndex(index);
    });
  }

  /**
   * What a compile reads skills through (LangGraphPackage.skillFiles): (dir, from) => the folder of the skill the
   * owner sees at dir, else (a required skill named by its leaf) one with that leaf: in the group of from (the skill
   * that needs it), then the owner's own, then public; null otherwise.
   */
  compileResolver(ownerId: number, asRobot: boolean): (dir: string, from?: string | null) => string | null {
    return (dir: string, from: string | null = null): string | null => {
      try {
        const p = this.absolutePath(ownerId, dir, asRobot);
        if (p === null && !dir.includes('/')) {
          // By leaf: in the group of the skill that needs it, then the owner's own skill, then a public one.
          const hits = this.list(ownerId, asRobot).filter((r) => this.leaf(r.path) === dir);
          const group = from !== null && from !== undefined && from.includes('/') ? from.split('/')[0] : null;
          const rank = (r: SkillRow): [number, number, string] =>
            [group !== null && r.path.startsWith(`${group}/`) ? 0 : 1, r.mine ? 0 : 1, r.path];
          hits.sort((a, b) => cmpTuple(rank(a), rank(b)));
          return hits.length === 0 ? null : this.absolutePath(ownerId, hits[0].path, asRobot);
        }
        return p;
      } catch (e) {
        if (e instanceof SkillPathInvalid) return null; // reported as any skill the owner cannot see
        throw e;
      }
    };
  }

  absolutePath(ownerId: number, p: string, asRobot = false): string | null {
    this.checkPath(p);
    const r = this.resolve(ownerId, p, asRobot);
    return r === null ? null : this.dir(r[0], p);
  }

  // ---- required skills (LangGraphPackage.requiredSkills) ----------------------------------------------

  /** [area, path] of every skill userId sees (own + public), existing folders. */
  private visibleEntries(index: Index, userId: number): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [key, e] of Object.entries(index)) {
      const [area, p] = this.splitKey(key);
      if (this.visible(e, userId, false) && isDir(this.dir(area, p))) out.push([area, p]);
    }
    return out;
  }

  /** path => area a user resolves a skill path to: their own skill first, then a public one (never another's private). */
  private viewOf(index: Index, userId: number, incoming: string[] = []): Record<string, string> {
    const own: Record<string, string> = {};
    const pub: Record<string, string> = {};
    for (const key of Object.keys(index)) {
      const [area, p] = this.splitKey(key);
      if (!isDir(this.dir(area, p))) continue;
      if (area === `users/${userId}`) own[p] = area;
      else if (area === 'public') pub[p] = area;
    }
    // The rest of the same import (to be installed public with it): only where nothing of mine or public is.
    const out: Record<string, string> = { ...own };
    for (const [p, a] of Object.entries(pub)) if (!(p in out)) out[p] = a;
    for (const p of incoming) if (!(p in out)) out[p] = 'incoming';
    return out;
  }

  /** Only what the requires rule reads: SKILL.md and scripts/**. */
  private requiresOnly(files: Files): Files {
    return Object.fromEntries(Object.entries(files).filter(([rel]) => rel === 'SKILL.md' || rel.startsWith('scripts/')));
  }

  /** SKILL.md and scripts/** of a skill, read from disk (nothing else of the tree). */
  private requiresFiles(area: string, p: string, md: string | null = null): Record<string, Buffer | string> {
    const dir = this.dir(area, p);
    const out: Record<string, Buffer | string> = md !== null ? { 'SKILL.md': md } : isFile(`${dir}/SKILL.md`) ? { 'SKILL.md': fs.readFileSync(`${dir}/SKILL.md`) } : {};
    for (const [rel, b] of Object.entries(this.readTree(`${dir}/scripts`, false))) out[`scripts/${rel}`] = b;
    return out;
  }

  /**
   * What skill p (in area, owned by owner) requires, resolved from its owner's viewpoint: [[area, path]], plus the
   * declared names that resolve to nothing.
   */
  private requirementsOf(index: Index, owner: number, area: string, p: string, files: Record<string, Buffer | string> | null = null,
    incoming: string[] = []): { resolved: Array<[string, string]>; missing: string[] } {
    const view = this.viewOf(index, owner, incoming);
    const req = LangGraphPackage.requiredSkills(p, files ?? this.requiresFiles(area, p), Object.keys(view));
    return { resolved: req.requires.map((q) => [view[q], q] as [string, string]), missing: req.missing };
  }

  /**
   * The skills userId sees (only public ones when publicOnly; except: "area/path" keys left out) whose requirement,
   * resolved from their owner's viewpoint, is the skill at area/path. Sorted paths.
   */
  private dependents(index: Index, userId: number, area: string, p: string, publicOnly = false, except: string[] = []): string[] {
    const out: string[] = [];
    for (const [a, q] of this.visibleEntries(index, userId)) {
      if ((a === area && q === p) || (publicOnly && a !== 'public') || except.includes(`${a}/${q}`)) continue;
      const owner = intval(index[`${a}/${q}`]?.owner ?? 0);
      for (const [qa, qq] of this.requirementsOf(index, owner, a, q).resolved) {
        if (qa === area && qq === p) {
          out.push(q);
          break;
        }
      }
    }
    out.sort(strcmp);
    return out;
  }

  private assertNotRequired(userId: number, area: string, p: string, reason: string, except: string[] = []): void {
    const deps = this.dependents(this.index(), userId, area, p, false, except);
    if (deps.length === 0) return;
    const name = this.leaf(p);
    const list = deps.join(', ');
    throw new SkillRequiredBy(reason === 'delete'
      ? `"${name}" can't be deleted: ${list} need(s) it to run (listed in its required skills). Delete ${list} first, or remove "${name}" from its required skills.`
      : `"${name}" can't be renamed: ${list} need(s) it to run (listed in its required skills).`, reason, p, deps);
  }

  /**
   * The skills p requires, transitively, that are still userId's own private skills (what making it public takes
   * along), in discovery order. A required skill that is neither mine nor public refuses it. files: the skill's files
   * when it is not stored yet (an import).
   */
  private privateRequired(index: Index, userId: number, p: string, files: Files | null = null, startArea: string | null = null,
    incoming: string[] = []): string[] {
    const own = this.areaFor(userId, 'private');
    const along: string[] = [];
    const seen = new Set<string>([p]);
    const queue: Array<[string, string, Files | null]> = [[startArea ?? own, p, files]];
    while (queue.length > 0) {
      const [a, q, f] = queue.shift()!;
      const req = this.requirementsOf(index, userId, a, q, f, incoming);
      for (const m of req.missing) {
        throw new SkillRequiredBy(`"${this.leaf(q)}" needs "${m}", which you can't make public.`, 'public', q, [], m);
      }
      for (const [qa, qq] of req.resolved) {
        if (seen.has(qq)) continue;
        seen.add(qq);
        if (qa === own) {
          along.push(qq);
          queue.push([qa, qq, null]);
        }
      }
    }
    return along;
  }

  /** The user confirmed which skills go public along: refuse when the closure is no longer that. */
  private assertExpected(p: string, along: string[], expect: string[] | null): void {
    if (expect === null) return;
    const a = [...along].sort(strcmp);
    const b = expect.map(String).sort(strcmp);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new SkillRequiredBy(`The skills that go public with "${this.leaf(p)}" changed: ` + (along.join(', ') || '-') + '. Try again.',
        'changed', p, along);
    }
  }

  /** Move my private skills paths to public, all or nothing (moves already done are undone on a failure). */
  private publishAll(index: Index, userId: number, paths: string[]): void {
    const own = this.areaFor(userId, 'private');
    const done: string[] = [];
    try {
      for (const p of paths) {
        this.relocate(own, p, 'public', p);
        done.push(p);
      }
    } catch (e) {
      for (const p of [...done].reverse()) {
        try {
          this.relocate('public', p, own, p);
        } catch {
          // best effort: the index below is left unchanged either way
        }
      }
      throw e;
    }
    for (const p of paths) {
      delete index[`${own}/${p}`];
      index[`public/${p}`] = { owner: userId, visibility: 'public' };
    }
  }

  // ---- internals -------------------------------------------------------------------------------

  private areaFor(userId: number, visibility: string): string {
    if (visibility === 'public') {
      if (this.edition === 'individual') throw new SkillForbidden('Skills cannot be made public in this edition.');
      return 'public';
    }
    return `users/${userId}`;
  }

  private checkVisibility(v: string): void {
    if (v !== 'public' && v !== 'private') throw new SkillPathInvalid('Visibility must be public or private.');
  }

  private visible(e: Entry, userId: number, asRobot: boolean): boolean {
    if (asRobot) return e.visibility === 'public' || this.edition === 'individual';
    return intval(e.owner) === userId || e.visibility === 'public';
  }

  /** [area, entry] of the skill userId sees at path: own, then public, then (robot) any. */
  private resolve(userId: number, p: string, asRobot: boolean): [string, Entry] | null {
    const index = this.index();
    let candidates = [`users/${userId}/${p}`, `public/${p}`];
    if (asRobot && this.edition !== 'individual') candidates = [`public/${p}`]; // a corporate robot sees public skills only
    if (asRobot && this.edition === 'individual') {
      for (const key of Object.keys(index)) {
        if (key.startsWith('users/') && this.splitKey(key)[1] === p) candidates.push(key);
      }
    }
    for (const key of candidates) {
      const [a, q] = this.splitKey(key);
      if (index[key] !== undefined && isDir(this.dir(a, q))) return [a, index[key]];
    }
    return null;
  }

  /** The caller's own skill at path, else NotFound (invisible) or Forbidden (visible, not theirs). */
  private owned(userId: number, p: string): [string, Entry] {
    const r = this.resolve(userId, p, false);
    if (r === null) throw new SkillNotFound('No such skill.');
    if (intval(r[1].owner) !== userId) throw new SkillForbidden('Only the owner can change this skill.');
    return r;
  }

  /** A public skill a robot workflow binds keeps its public name: the robot could no longer find it otherwise. */
  private async assertNotBoundByRobot(p: string): Promise<void> {
    if (this.edition === 'corporate' && this.robotWorkflowsUsing !== null) {
      const workflows = await this.robotWorkflowsUsing(this.leaf(p));
      if (workflows.length > 0) throw new SkillInUse(workflows);
    }
  }

  /** Leaf unique across public + the caller's area (or public only when withOwn is false), ignoring the skill's own path. */
  private assertLeafFree(index: Index, userId: number, p: string, withOwn: boolean): void {
    const leaf = this.leaf(p);
    for (const [key, e] of Object.entries(index)) {
      const [area, q] = this.splitKey(key);
      const relevant = area === 'public' || (withOwn && area === `users/${userId}`);
      if (!relevant || this.leaf(q) !== leaf || (q === p && intval(e.owner) === userId)) continue;
      throw new SkillClashException(area === 'public' ? `A public skill named '${leaf}' already exists.` : `You already have a skill named '${leaf}'.`);
    }
  }

  private checkPath(p: string): void {
    if (p === '' || p.includes('\\') || p.startsWith('/') || p.includes('//')) throw new SkillPathInvalid('Invalid skill path.');
    const segs = p.split('/');
    if (segs.length > 2) throw new SkillPathInvalid('A skill path has at most one group level.');
    for (const s of segs) {
      if (s === '' || s[0] === '.' || /[\x00-\x1f]/.test(s)) throw new SkillPathInvalid('Invalid skill path.');
    }
  }

  /** A file path inside a skill: dot-prefixed segments are allowed (.wheels), traversal is not. */
  private checkRel(rel: string): void {
    if (rel === '' || rel.includes('\\') || rel.startsWith('/') || rel.includes('//') || /[\x00-\x1f]/.test(rel)) {
      throw new SkillPathInvalid('Invalid file path.');
    }
    for (const s of rel.split('/')) {
      if (s === '' || s === '.' || s === '..') throw new SkillPathInvalid('Invalid file path.');
    }
  }

  private leaf(p: string): string {
    return path.posix.basename(p);
  }

  private dir(area: string, p: string): string {
    return `${this.root}/${area}/${p}`;
  }

  private splitKey(key: string): [string, string] {
    if (key.startsWith('public/')) return ['public', key.slice(7)];
    const parts = key.split('/');
    return [`${parts[0]}/${parts[1]}`, parts.slice(2).join('/')];
  }

  private mkdir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o775 });
    } catch {
      if (!isDir(dir)) throw new Error(`Cannot create ${dir}`);
    }
  }

  private relocate(fromArea: string, from: string, toArea: string, to: string): void {
    const dest = this.dir(toArea, to);
    this.mkdir(path.dirname(dest));
    try {
      fs.renameSync(this.dir(fromArea, from), dest);
    } catch {
      throw new Error('Cannot move the skill folder.');
    }
    this.pruneGroup(fromArea, from);
  }

  private pruneGroup(area: string, p: string): void {
    if (p.includes('/')) {
      try {
        fs.rmdirSync(`${this.root}/${area}/${path.posix.dirname(p)}`);
      } catch {
        // not empty, or gone: as PHP's @rmdir
      }
    }
  }

  private rmtree(dir: string): void {
    if (!isDir(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private readTree(dir: string, withWheels: boolean): Files {
    const out: Files = {};
    if (!isDir(dir)) return out;
    for (const full of walkFiles(dir)) {
      const rel = full.slice(dir.length + 1);
      if (rel.startsWith('.wheels/native/') || (!withWheels && rel.startsWith('.wheels/')) || this.isPyCache(rel)) continue;
      out[rel] = fs.readFileSync(full);
    }
    return out;
  }

  /** Python's bytecode cache (`__pycache__/`, `*.pyc`): never part of a skill's content. */
  private isPyCache(rel: string): boolean {
    return rel.split('/').includes('__pycache__') || rel.endsWith('.pyc');
  }

  private fingerprint(files: Files): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of Object.keys(files).sort(strcmp)) {
      if (this.isPyCache(rel)) continue;
      out[rel] = crypto.createHash('sha256').update(files[rel]).digest('hex');
    }
    return out;
  }

  private frontmatter(md: string): { name?: string; description?: string } {
    const lines = md.split(/\r\n|\r|\n/);
    const out: Record<string, string> = {};
    if ((lines[0] ?? '').trim() !== '---') return out;
    for (const line of lines.slice(1)) {
      if (line.trim() === '---') break;
      const m = /^(name|description):\s*(.*)$/.exec(line);
      if (m) {
        let v = m[2].trim();
        // one matching outer quote pair only: `say "hi"` stays as written
        if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
        out[m[1]] = v;
      }
    }
    return out;
  }

  private index(): Index {
    let raw: string;
    try {
      raw = fs.readFileSync(this.root + '/index.json', 'utf8');
    } catch {
      return {};
    }
    try {
      const data = JSON.parse(raw);
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  private saveIndex(index: Index): void {
    const tmp = `${this.root}/index.json.${crypto.randomBytes(4).toString('hex')}.tmp`;
    // PHP json_encode of an empty array is "[]"
    this.put(tmp, Buffer.from(Object.keys(index).length === 0 ? '[]' : JSON.stringify(index, null, 4)));
    try {
      fs.renameSync(tmp, this.root + '/index.json');
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // gone already
      }
      throw new Error('Cannot update the skills index.');
    }
  }

  private put(file: string, bytes: Buffer): void {
    try {
      fs.writeFileSync(file, bytes);
    } catch {
      throw new Error(`Cannot write ${file}`);
    }
  }

  private locked<T>(fn: () => T): T {
    this.mkdir(this.root);
    try {
      fs.closeSync(fs.openSync(this.root + '/.lock', 'a'));
    } catch {
      throw new Error('Cannot lock the skills folder.');
    }
    return fn();
  }
}

function intval(v: any): number {
  const n = parseInt(String(v ?? 0), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP strcmp order (bytes). */
function strcmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function cmpTuple(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || strcmp(a[2], b[2]);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
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

function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Every file under dir, as RecursiveDirectoryIterator walks it: a linked directory is not entered, a linked file counts. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const full = `${d}/${n.name}`;
      if (n.isDirectory()) walk(full);
      else if (isFile(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function withoutWheels(files: Files): Files {
  return Object.fromEntries(Object.entries(files).filter(([k]) => !k.startsWith('.wheels/')));
}

function sameFingerprint(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
