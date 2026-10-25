import { Kysely, sql } from 'kysely';
import { DB } from '../db/types';
import { WorkflowGraphAnalyzer } from './WorkflowGraphAnalyzer';
import { CodeNodeEmit } from './CodeNodeEmit';

/**
 * The Start's mode as a compiled program bakes it (spec 2026-10-15 §2): the Start option's trigger node
 * (the hidden code node StartOptionGraph adds), its event trigger, the workflow's schedule. Read at compile
 * time only; the program never reads the database. Mirrors backend/src/AgentTeam/Services/StartTriggerFacts.php.
 */
export interface StartFacts {
  startMode: 'watch' | 'cron' | 'prompt';
  defaultCron: string | null;
  defaultWatch: { server: string; tool: string; args: Record<string, any> } | null;
  triggerNodeId: string | null;
}

function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object';
}

/** PHP: $v !== null && $v !== '' && $v !== [] (a decoded {} is [] in PHP too). */
function isFilled(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

function phpTrim(v: unknown): string {
  const s = v === undefined || v === null ? '' : typeof v === 'object' ? 'Array' : String(v);
  return s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

export const StartTriggerFacts = {
  /**
   * orderedNodes: nodes in topological order (each with config); serverSlugs: url => slug of the servers this
   * workflow uses. db null: no schedule defaults.
   */
  async of(db: Kysely<DB> | null, workflowId: number, orderedNodes: any[], serverSlugs: Record<string, string>): Promise<StartFacts> {
    let triggerNodeId: string | null = null;
    let startTrigger: Record<string, any> | null = null;
    let startArgs: Record<string, any> = {};
    for (const node of orderedNodes) {
      const st = (node?.config ?? {}).start_trigger ?? null;
      if (WorkflowGraphAnalyzer.typeOf(node) === 'code' && isObj(st)) {
        triggerNodeId = String(node.id);
        startTrigger = st;
        const a = node.config.args ?? null;
        startArgs = isObj(a) ? a : {}; // the Start's start_args
        break;
      }
    }
    const defaultCron = await StartTriggerFacts.defaultCron(db, workflowId);
    const slugs = Object.values(serverSlugs);
    return {
      startMode: startTrigger !== null ? 'watch' : defaultCron !== null ? 'cron' : 'prompt',
      defaultCron,
      defaultWatch: startTrigger !== null
        ? StartTriggerFacts.optionWatch(startTrigger, startArgs, slugs)
        : await StartTriggerFacts.defaultWatch(db, workflowId, slugs),
      triggerNodeId,
    };
  },

  /**
   * The watch's args with the Start's values merged in at top level (spec 2026-10-22 §6.1): its tag (a non-empty
   * string) and each start arg the option names in pass_args (when non-empty). The Start's values win; its other
   * args stay the code's ARGS only. Used by the event worker's schedule rows and the compiled DEFAULT_WATCH alike.
   */
  watchArgs(watchArgs: Record<string, any>, startArgs: Record<string, any>, passArgs: any[]): Record<string, any> {
    const out: Record<string, any> = { ...watchArgs };
    const tag = startArgs?.tag ?? null;
    if (typeof tag === 'string' && tag !== '') {
      out.tag = tag;
    }
    for (const name of passArgs) {
      const v = typeof name === 'string' ? (startArgs?.[name] ?? null) : null;
      if (isFilled(v)) {
        out[name] = v;
      }
    }
    return out;
  },

  /** A Start option's DEFAULT_WATCH: its trigger's watch with the Start's args merged in (watchArgs). */
  optionWatch(startTrigger: Record<string, any>, startArgs: Record<string, any>, slugs: string[]): StartFacts['defaultWatch'] {
    const w = StartTriggerFacts.watchFromTrigger(isObj(startTrigger.watch) ? startTrigger.watch : {}, slugs);
    if (w !== null) {
      const pass = startTrigger.pass_args ?? [];
      w.args = StartTriggerFacts.watchArgs(w.args, startArgs, Array.isArray(pass) ? pass : []);
    }
    return w;
  },

  async defaultCron(db: Kysely<DB> | null, workflowId: number): Promise<string | null> {
    if (db === null) return null;
    try {
      const r = (await sql<any>`SELECT cron FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND repeat_type = 'cron' AND status <> 'paused' ORDER BY id DESC LIMIT 1`.execute(db)).rows[0];
      const c = r?.cron;
      return typeof c === 'string' && c !== '' ? c : null;
    } catch {
      return null; // no schedules table, or one without the cron column: no default
    }
  },

  async defaultWatch(db: Kysely<DB> | null, workflowId: number, slugs: string[]): Promise<StartFacts['defaultWatch']> {
    if (db === null) return null;
    let raw: unknown;
    try {
      raw = (await sql<any>`SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND repeat_type = 'event' AND status <> 'paused' ORDER BY id DESC LIMIT 1`.execute(db)).rows[0]?.event_trigger;
    } catch {
      return null; // no schedules table, or one without the event_trigger column: no default
    }
    let t: unknown = null;
    if (typeof raw === 'string') {
      try {
        t = JSON.parse(raw);
      } catch {
        t = null;
      }
    }
    return isObj(t) && !Array.isArray(t) ? StartTriggerFacts.watchFromTrigger(t, slugs) : null;
  },

  /** {server (a name), tool, args} as DEFAULT_WATCH with the server slugged; a server the workflow does not use is an error. */
  watchFromTrigger(t: Record<string, any>, slugs: string[]): StartFacts['defaultWatch'] {
    if (phpTrim(t.server) === '' || phpTrim(t.tool) === '') {
      return null;
    }
    const slug = CodeNodeEmit.slug(String(t.server));
    if (!slugs.includes(slug)) {
      throw new Error('The event trigger waits on MCP server "' + t.server + '", which no node of this'
        + ' workflow uses; check it on the node that polls it (e.g. the code node calling poll_new_mail).');
    }
    return { server: slug, tool: String(t.tool), args: isObj(t.args) ? t.args : {} };
  },
};
