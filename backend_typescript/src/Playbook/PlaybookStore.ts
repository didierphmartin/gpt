import { sql } from 'kysely';
import { db } from '../db/pools';

/** A refused collection operation: kind (not_found, invalid_text, invalid_key, key_taken, in_use) and its HTTP status. */
export class PlaybookStoreError extends Error {
  constructor(public readonly kind: string, message: string, public readonly status: number) {
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

/** The playbook collection: the only code that touches the `playbooks` table. Owner-scoped throughout. */
export class PlaybookStore {
  async list(userId: number): Promise<any[]> {
    const rows = (await sql<any>`SELECT ${COLS} FROM playbooks WHERE user_id = ${userId} ORDER BY title`.execute(db)).rows.map(norm);
    const out: any[] = [];
    for (const r of rows) {
      const used = await this.usedBy(userId, r.id);
      out.push({ ...r, used_by: used.agents.length + used.nodes.length });
    }
    return out;
  }

  async get(userId: number, id: number): Promise<PlaybookRow | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM playbooks WHERE id = ${id} AND user_id = ${userId}`.execute(db)).rows[0];
    return r ? norm(r) : null;
  }

  async getByKey(userId: number, pkey: string): Promise<PlaybookRow | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM playbooks WHERE pkey = ${pkey} AND user_id = ${userId}`.execute(db)).rows[0];
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
        VALUES (${userId}, ${key}, ${title}, ${text}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`.execute(db);
      id = Number(res.insertId);
    } else {
      await sql`UPDATE playbooks SET pkey = ${key}, title = ${title}, text = ${text}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND user_id = ${userId}`.execute(db);
    }
    return (await this.get(userId, id))!;
  }

  async delete(userId: number, id: number): Promise<void> {
    if ((await this.get(userId, id)) === null) throw new PlaybookStoreError('not_found', `Playbook #${id} not found`, 404);
    const used = await this.usedBy(userId, id);
    const names = [
      ...used.agents.map((a) => `agent "${a.name}"`),
      ...used.nodes.map((n) => `node "${n.node_name}" in workflow "${n.workflow_name}"`),
    ];
    if (names.length) throw new PlaybookStoreError('in_use', 'This playbook is used by ' + names.join(', ') + '.', 409);
    await sql`DELETE FROM playbooks WHERE id = ${id} AND user_id = ${userId}`.execute(db);
  }

  /** The agents and workflow nodes (the user's own) that link to the playbook. */
  async usedBy(userId: number, id: number): Promise<{
    agents: { id: number; name: string }[];
    nodes: { workflow_id: number; workflow_name: string; node_name: string }[];
  }> {
    const ag = (await sql<any>`SELECT id, name FROM agents WHERE user_id = ${userId} AND playbook_id = ${id} ORDER BY name`.execute(db)).rows;
    const agents = ag.map((a) => ({ id: Number(a.id), name: String(a.name) }));
    // The node's link lives in its config JSON: decoded here, so the query stays portable.
    const rows = (await sql<any>`SELECT n.config, w.id AS workflow_id, w.name AS workflow_name
      FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
      WHERE w.user_id = ${String(userId)} AND n.node_type = 'playbook' ORDER BY w.name, n.id`.execute(db)).rows;
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
