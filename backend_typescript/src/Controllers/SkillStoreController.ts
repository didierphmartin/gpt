import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { EditionConfig } from '../Services/Edition';
import { RobotSkillPolicy } from '../Services/RobotSkillPolicy';
import { SkillClashException, SkillForbidden, SkillInUse, SkillNotFound, SkillPathInvalid, SkillRequiredBy } from '../Services/SkillErrors';
import { SkillStore } from '../Services/SkillStore';
import { SkillWheelError, SkillWheelFetcher } from '../Services/SkillWheelFetcher';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/SkillStoreController.php: /api/v1/skills — the Docker app's skills volume (SkillStore).
 * Without SKILLS_DIR (folder mode) every route but /store and /native-wheels answers 404. Paths travel as query/body
 * fields because they contain "/"; file bytes are base64 both ways. `as=robot` only narrows the view to what the
 * robot may see, so any signed-in user may ask for it.
 */
export class SkillStoreController {
  private readonly storeFactory: () => SkillStore | null;
  private readonly wheels: Pick<SkillWheelFetcher, 'fetch'>;

  constructor(
    private readonly cfg: EditionConfig = config,
    storeFactory: (() => SkillStore | null) | null = null,
    wheels: Pick<SkillWheelFetcher, 'fetch'> | null = null
  ) {
    this.wheels = wheels ?? new SkillWheelFetcher();
    this.storeFactory = storeFactory ?? (() => SkillStore.fromEnv(this.cfg, (leaf) => new RobotSkillPolicy(this.cfg, null).robotWorkflowsUsing(leaf)));
  }

  async store(_ctx: Ctx): Promise<ControllerResult> {
    const s = this.storeFactory();
    return { success: true, data: { mode: s === null ? 'folder' : 'volume', edition: String(this.cfg.edition ?? '') }, status_code: 200 };
  }

  list(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      const rows = s.list(uid(ctx), robot(ctx), q(ctx, 'requires') === '1');
      const names = await this.ownerNames(rows.filter((r) => !r.mine).map((r) => r.owner_id));
      return rows.map((r) => ({ ...r, owner_name: names.get(r.owner_id) ?? '' }));
    });
  }

  /** Display name (else email) per user id, one query; unknown ids absent. */
  private async ownerNames(ids0: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(ids0)];
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    try {
      const rows = (await sql<any>`SELECT id, email, first_name, last_name FROM users WHERE id IN (${sql.join(ids)})`.execute(db)).rows;
      for (const u of rows) {
        const name = `${String(u.first_name ?? '').trim()} ${String(u.last_name ?? '').trim()}`.trim();
        out.set(Number(u.id), name !== '' ? name : String(u.email ?? ''));
      }
      return out;
    } catch {
      return new Map();
    }
  }

  files(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      // wheels=0: leave .wheels/ out (the caller would only drop it).
      const files = s.files(uid(ctx), q(ctx, 'path'), robot(ctx), q(ctx, 'wheels') !== '0');
      return { files: Object.keys(files).length === 0 ? [] : base64All(files) };
    });
  }

  listing(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => ({ files: s.listing(uid(ctx), q(ctx, 'path'), robot(ctx)) }));
  }

  readFile(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => ({ content: s.readFile(uid(ctx), q(ctx, 'path'), q(ctx, 'rel'), robot(ctx)).toString('base64') }));
  }

  writeFile(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      const b = body(ctx);
      s.writeFile(uid(ctx), str(b.path), str(b.rel), decode(b.content ?? null));
      return [];
    });
  }

  import(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      const b = body(ctx);
      const input = b.files ?? null;
      if (input === null || typeof input !== 'object') throw new SkillPathInvalid('files must be an object of base64 contents.');
      const files: Record<string, Buffer> = {};
      for (const [rel, content] of Object.entries(input)) files[String(rel)] = decode(content);
      return s.import(uid(ctx), str(b.path), files, b.visibility === undefined || b.visibility === null ? 'private' : str(b.visibility),
        (b.dry_run ?? false) === true, Array.isArray(b.expect_public) ? b.expect_public.map(String) : null,
        Array.isArray(b.incoming) ? b.incoming.map(String) : []);
    });
  }

  visibility(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      const b = body(ctx);
      return s.setVisibility(uid(ctx), str(b.path), str(b.visibility), (b.dry_run ?? false) === true,
        Array.isArray(b.expect_public) ? b.expect_public.map(String) : null);
    });
  }

  move(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      const b = body(ctx);
      await s.move(uid(ctx), str(b.from), str(b.to));
      return { path: str(b.to) };
    });
  }

  delete(ctx: Ctx): Promise<ControllerResult> {
    return this.run(async (s) => {
      // dry_run=1: only check; with=a,b: skills deleted together with it (a group) do not count as needing it.
      const withPaths = q(ctx, 'with').split(',').filter((x) => x !== '');
      await s.delete(uid(ctx), q(ctx, 'path'), q(ctx, 'dry_run') === '1', withPaths);
      return [];
    });
  }

  /** Works in both modes (the export needs it everywhere), so it bypasses the "no skill store" guard. */
  async nativeWheels(ctx: Ctx): Promise<ControllerResult> {
    const deps = body(ctx).dependencies ?? null;
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
      return { success: false, data: { message: 'dependencies must be a list of strings.' }, error: 'dependencies must be a list of strings.', status_code: 400 };
    }
    try {
      return { success: true, data: { wheels: base64All(await this.wheels.fetch(deps)) }, status_code: 200 };
    } catch (e) {
      if (!(e instanceof SkillWheelError)) throw e;
      return { success: false, data: { message: e.message, ...e.data() }, error: e.message, status_code: e.statusCode() };
    }
  }

  private async run(fn: (s: SkillStore) => Promise<any>): Promise<ControllerResult> {
    const s = this.storeFactory();
    if (s === null) return { success: false, data: { message: 'no skill store' }, error: 'no skill store', status_code: 404 };
    try {
      return { success: true, data: await fn(s), status_code: 200 };
    } catch (e) {
      if (e instanceof SkillRequiredBy) return { success: false, data: e.data(), error: e.message, status_code: e.statusCode() };
      if (e instanceof SkillInUse) {
        return { success: false, data: { message: e.message, robot_workflows: e.workflows() }, error: e.message, status_code: e.statusCode() };
      }
      if (e instanceof SkillClashException) return { success: false, data: { clash: 'different', message: e.message }, error: 'clash', status_code: 409 };
      if (e instanceof SkillNotFound || e instanceof SkillForbidden || e instanceof SkillPathInvalid) {
        return { success: false, data: { message: e.message }, error: e.message, status_code: e.statusCode() };
      }
      throw e;
    }
  }
}

function uid(ctx: Ctx): number {
  return Math.trunc(Number(ctx.user_id ?? 0)) || 0;
}

function robot(ctx: Ctx): boolean {
  return (ctx.query?.as ?? '') === 'robot';
}

function q(ctx: Ctx, key: string): string {
  return str(ctx.query?.[key]);
}

function body(ctx: Ctx): Record<string, any> {
  return ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {};
}

function str(v: any): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** base64_decode($v, true): a string of the base64 alphabet only (whitespace ignored), else invalid. */
function decode(v: any): Buffer {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(v)) throw new SkillPathInvalid('Content must be valid base64.');
  return Buffer.from(v, 'base64');
}

/** rel => base64; an empty map is {} (PHP: (object) for wheels; files as array_map: [] when empty). */
function base64All(files: Record<string, Buffer>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, b] of Object.entries(files)) out[k] = b.toString('base64');
  return out;
}
