import { Kysely, sql } from 'kysely';
import { db } from '../db/pools';
import { DB } from '../db/types';

/** A refused collection operation: kind (not_found, invalid_text, invalid_key, key_taken, in_use, replaces), its HTTP status,
 *  and optional data for the client. */
export class PlaybookStoreError extends Error {
  constructor(public readonly kind: string, message: string, public readonly status: number,
    public readonly data: Record<string, any> = {}) {
    super(message);
  }
}

const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY_MAX = 64;
const TITLE_MAX = 255;
/** Port of PlaybookDocument::SECTION_HEADER_RE. */
const SECTION_HEADER_RE = /^\s*(\d+[.)]|[-*•]|#{1,6})?\s*\**(Title|Trigger|Instructions|Tools used|Actions used|Domain)\**\s*:\**\s*(.*)$/i;
const LABELS: Record<string, string> = {
  'title': 'Title', 'trigger': 'Trigger', 'instructions': 'Instructions',
  'tools used': 'Tools used', 'actions used': 'Actions used', 'domain': 'Domain',
};

/** "Okta password reset" -> "okta-password-reset", "Ça va" -> "ca-va" (accents dropped; at most 64 characters;
 *  "playbook" when nothing is left). */
export function keyFromTitle(title: string): string {
  let key = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  key = key.slice(0, KEY_MAX).replace(/-+$/, '');
  return key === '' ? 'playbook' : key;
}

export function isValidKey(key: string): boolean {
  return key.length <= KEY_MAX && KEY_RE.test(key);
}

/** The Title of a Console-format playbook; throws invalid_text (422) with the parser's message when Title or Instructions is missing. */
export function parseTitle(text: string): string {
  const sections: Record<string, string> = {};
  for (const k of Object.keys(LABELS)) sections[k] = '';
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = SECTION_HEADER_RE.exec(line);
    if (m) {
      current = m[2].toLowerCase();
      const marker = m[1] !== undefined && /^\d/.test(m[1]) ? m[1] + ' ' : '';
      sections[current] = m[3] === '' ? '' : marker + m[3];
    } else if (current !== null) {
      sections[current] += '\n' + line;
    }
  }
  const missing: string[] = [];
  if (sections['title'].trim() === '') missing.push('Title');
  if (sections['instructions'].trim() === '') missing.push('Instructions');
  if (missing.length) {
    const found = Object.entries(LABELS).filter(([k]) => sections[k].trim() !== '').map(([, l]) => l);
    throw new PlaybookStoreError('invalid_text',
      `Missing "${missing.join(':" and "')}:" section. Recognized sections: ${found.length ? found.join(', ') : 'none'}. ` +
      `Each section must start on its own line as "${missing[0]}: …" (a list number, "##" or "**" before the keyword is fine).`, 422);
  }
  const title = sections['title'].trim();
  const len = [...title].length;
  if (len > TITLE_MAX) {
    throw new PlaybookStoreError('invalid_text', `The title is longer than 255 characters (${len}); shorten the "Title:" line.`, 422);
  }
  return title;
}

export type PlaybookRow = { id: number; pkey: string; title: string; text: string; updated_at: string };

const COLS = sql`id, pkey, title, text, updated_at`;

function norm(r: any): PlaybookRow {
  return { ...r, id: Number(r.id) };
}

/** First + last name, else the email; '' when the user is gone. */
export function personName(u: { email?: any; first_name?: any; last_name?: any } | null | undefined): string {
  if (!u) return '';
  const name = (String(u.first_name ?? '').trim() + ' ' + String(u.last_name ?? '').trim()).trim();
  return name !== '' ? name : String(u.email ?? '');
}

/**
 * Where a publish writes (PHP PlaybookStore::publish, before its transaction). `ownId` is the robot copy of this
 * source (found by source_id); `holder` is the robot row holding the source's key. Returns the row to save into
 * (null = a new row) and a row to delete first (another copy on the key ours moves to), or 'replaces' when the
 * key is held by another (or a deleted) source and the replacement was not confirmed.
 */
export function publishPlan(sourceId: number, ownId: number | null, holder: { id: number; source_id: number | null } | null,
  confirmReplace: boolean): { targetId: number | null; deleteId: number | null } | 'replaces' {
  if (holder === null || holder.id === ownId) return { targetId: ownId, deleteId: null }; // the key is free, or already ours
  const sameSource = ownId === null && holder.source_id !== null && Number(holder.source_id) === sourceId;
  if (sameSource) return { targetId: holder.id, deleteId: null };
  if (!confirmReplace) return 'replaces';
  if (ownId === null) return { targetId: holder.id, deleteId: null };
  return { targetId: ownId, deleteId: holder.id };
}

/** The playbook collection: the only code that touches the `playbooks` table. Owner-scoped throughout. */
export class PlaybookStore {
  /** `ex` is the pool, or the transaction a publish runs in. */
  constructor(private readonly ex: Kysely<DB> = db) {}

  async list(userId: number): Promise<any[]> {
    // automation_id: the automation that manages the playbook (null = none); save_playbook_agent checks it on a key clash.
    const rows = (await sql<any>`SELECT ${COLS}, automation_id FROM playbooks WHERE user_id = ${userId} ORDER BY title`.execute(this.ex)).rows.map(norm);
    const out: any[] = [];
    for (const r of rows) {
      const used = await this.usedBy(userId, r.id);
      const automationId = (r as any).automation_id;
      out.push({ ...r, automation_id: automationId === null || automationId === undefined ? null : Number(automationId), used_by: used.agents.length + used.nodes.length });
    }
    return out;
  }

  async get(userId: number, id: number): Promise<PlaybookRow | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM playbooks WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex)).rows[0];
    return r ? norm(r) : null;
  }

  async getByKey(userId: number, pkey: string): Promise<PlaybookRow | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM playbooks WHERE pkey = ${pkey} AND user_id = ${userId}`.execute(this.ex)).rows[0];
    return r ? norm(r) : null;
  }

  /** Create (id null) or update. The text must parse; the key defaults to the title's (create) or stays (update). */
  async save(userId: number, id: number | null, text: string, pkey: string | null): Promise<PlaybookRow> {
    const title = parseTitle(text);
    const current = id === null ? null : await this.get(userId, id);
    if (id !== null && current === null) throw new PlaybookStoreError('not_found', `Playbook #${id} not found`, 404);
    const key = pkey ?? current?.pkey ?? keyFromTitle(title);
    if (!isValidKey(key)) {
      throw new PlaybookStoreError('invalid_key',
        `Key "${key}": lowercase letters, digits and single dashes, at most 64 characters (e.g. okta-reset).`, 422);
    }
    const clash = await this.getByKey(userId, key);
    if (clash && clash.id !== id) {
      throw new PlaybookStoreError('key_taken', `Key "${key}" is already used by "${clash.title}".`, 409);
    }
    if (id === null) {
      const res = await sql`INSERT INTO playbooks (user_id, pkey, title, text, created_at, updated_at)
        VALUES (${userId}, ${key}, ${title}, ${text}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`.execute(this.ex);
      id = Number(res.insertId);
    } else {
      await sql`UPDATE playbooks SET pkey = ${key}, title = ${title}, text = ${text}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
    }
    return (await this.get(userId, id))!;
  }

  /**
   * Publish the user's playbook to the robot as a frozen copy (one version). A source has at most one robot copy:
   * republishing updates it (moving it to the source's current key). A key held by another (or a deleted) source
   * is refused with `replaces` unless confirmReplace, then that row goes and ours takes the key.
   */
  async publish(userId: number, id: number, robotId: number, confirmReplace: boolean): Promise<Record<string, any>> {
    const src = await this.get(userId, id);
    if (src === null) throw new PlaybookStoreError('not_found', `Playbook #${id} not found`, 404);
    const own = (await sql<any>`SELECT id FROM playbooks WHERE user_id = ${robotId} AND source_id = ${id} ORDER BY id LIMIT 1`.execute(this.ex)).rows[0];
    const ownId = own ? Number(own.id) : null;
    const byKey = await this.getByKey(robotId, src.pkey);
    let holder: { id: number; source_id: number | null } | null = null;
    let meta: any = null;
    if (byKey !== null && byKey.id !== ownId) {
      meta = (await sql<any>`SELECT source_id, published_by, published_at FROM playbooks WHERE id = ${byKey.id}`.execute(this.ex)).rows[0];
      holder = { id: byKey.id, source_id: meta?.source_id == null ? null : Number(meta.source_id) };
    }
    const plan = publishPlan(id, ownId, holder, confirmReplace);
    if (plan === 'replaces') {
      const by = await this.personNameOf(meta?.published_by ?? null);
      throw new PlaybookStoreError('replaces', `The robot already has "${src.pkey}", published by ${by}.`, 409,
        { published_by: by, published_at: meta?.published_at ?? null });
    }
    const write = async (store: PlaybookStore): Promise<number> => {
      if (plan.deleteId !== null) {
        // our copy moves onto a key another copy holds: that copy goes
        await sql`DELETE FROM playbooks WHERE id = ${plan.deleteId} AND user_id = ${robotId}`.execute(store.ex);
      }
      const row = await store.save(robotId, plan.targetId, src.text, src.pkey);
      await sql`UPDATE playbooks SET published_by = ${userId}, published_at = CURRENT_TIMESTAMP, source_id = ${id}
        WHERE id = ${row.id} AND user_id = ${robotId}`.execute(store.ex);
      return row.id;
    };
    const rowId = this.ex.isTransaction ? await write(this) : await this.ex.transaction().execute((trx) => write(new PlaybookStore(trx)));
    const out = (await sql<any>`SELECT id, pkey, title, text, updated_at, published_by, published_at, source_id
      FROM playbooks WHERE id = ${rowId}`.execute(this.ex)).rows[0];
    return { ...out, id: Number(out.id) };
  }

  /** The robot's collection with who published each and the title of its source (null when the source is gone). */
  async robotList(robotId: number): Promise<any[]> {
    const rows = (await sql<any>`SELECT p.id, p.pkey, p.title, p.text, p.updated_at, p.published_by, p.published_at, p.source_id,
        s.title AS source_title
      FROM playbooks p LEFT JOIN playbooks s ON s.id = p.source_id WHERE p.user_id = ${robotId} ORDER BY p.title`.execute(this.ex)).rows;
    const out: any[] = [];
    for (const r of rows) {
      out.push({ ...r, id: Number(r.id), published_by_name: r.published_by === null ? null : await this.personNameOf(r.published_by) });
    }
    return out;
  }

  async unpublish(robotId: number, robotPlaybookId: number): Promise<void> {
    if ((await this.get(robotId, robotPlaybookId)) === null) {
      throw new PlaybookStoreError('not_found', `Playbook #${robotPlaybookId} not found`, 404);
    }
    await sql`DELETE FROM playbooks WHERE id = ${robotPlaybookId} AND user_id = ${robotId}`.execute(this.ex);
  }

  /** source playbook id => 'published' (robot copy equals the source) | 'changed' (the source was edited since). */
  async publishStatus(userId: number, robotId: number): Promise<Record<number, 'published' | 'changed'>> {
    const rows = (await sql<any>`SELECT s.id, s.text AS source_text, r.text AS robot_text
      FROM playbooks r JOIN playbooks s ON s.id = r.source_id AND s.user_id = ${userId} WHERE r.user_id = ${robotId} ORDER BY r.id`.execute(this.ex)).rows;
    const map: Record<number, 'published' | 'changed'> = {};
    for (const r of rows) map[Number(r.id)] = r.source_text === r.robot_text ? 'published' : 'changed';
    return map;
  }

  private async personNameOf(userId: any): Promise<string> {
    if (userId === null || userId === undefined) return '';
    const u = (await sql<any>`SELECT email, first_name, last_name FROM users WHERE id = ${userId}`.execute(this.ex)).rows[0];
    return personName(u);
  }

  async delete(userId: number, id: number): Promise<void> {
    if ((await this.get(userId, id)) === null) throw new PlaybookStoreError('not_found', `Playbook #${id} not found`, 404);
    const used = await this.usedBy(userId, id);
    const names = [
      ...used.agents.map((a) => `agent "${a.name}"`),
      ...used.nodes.map((n) => `node "${n.node_name}" in workflow "${n.workflow_name}"`),
    ];
    if (names.length) throw new PlaybookStoreError('in_use', 'This playbook is used by ' + names.join(', ') + '.', 409);
    await sql`DELETE FROM playbooks WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
  }

  /** The agents and workflow nodes (the user's own) that link to the playbook. */
  async usedBy(userId: number, id: number): Promise<{
    agents: { id: number; name: string }[];
    nodes: { workflow_id: number; workflow_name: string; node_name: string }[];
  }> {
    const ag = (await sql<any>`SELECT id, name FROM agents WHERE user_id = ${userId} AND playbook_id = ${id} ORDER BY name`.execute(this.ex)).rows;
    const agents = ag.map((a) => ({ id: Number(a.id), name: String(a.name) }));
    // The node's link lives in its config JSON: decoded here, so the query stays portable.
    const rows = (await sql<any>`SELECT n.config, w.id AS workflow_id, w.name AS workflow_name
      FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
      WHERE w.user_id = ${String(userId)} AND n.node_type = 'playbook' ORDER BY w.name, n.id`.execute(this.ex)).rows;
    const nodes: { workflow_id: number; workflow_name: string; node_name: string }[] = [];
    for (const r of rows) {
      let cfg: any = null;
      try { cfg = typeof r.config === 'string' ? JSON.parse(r.config) : r.config; } catch { cfg = null; }
      if (cfg && typeof cfg === 'object' && Number(cfg.playbook_id ?? 0) === id) {
        nodes.push({ workflow_id: Number(r.workflow_id), workflow_name: String(r.workflow_name), node_name: String(cfg.name ?? 'Playbook') });
      }
    }
    return { agents, nodes };
  }
}
