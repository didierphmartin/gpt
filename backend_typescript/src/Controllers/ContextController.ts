import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/** Mirrors src/Controllers/ContextController.php — conversation_contexts CRUD, scoped by user_id. */
export class ContextController {
  /** GET /api/v1/contexts */
  async list(ctx: Ctx): Promise<ControllerResult> {
    const uid = ctx.user_id as number;
    const rows = await db
      .selectFrom('conversation_contexts')
      .select(['id', 'title', 'provider', 'message_count', 'created_at', 'updated_at'])
      .where('user_id', '=', uid)
      .orderBy('updated_at', 'desc')
      .execute();
    return { success: true, data: rows };
  }

  /** GET /api/v1/contexts/:id */
  async get(ctx: Ctx): Promise<ControllerResult> {
    const id = parseInt(ctx.params.id, 10);
    const uid = ctx.user_id as number;
    const row = await db
      .selectFrom('conversation_contexts')
      .select(['id', 'title', 'context_data', 'provider', 'message_count', 'created_at', 'updated_at'])
      .where('id', '=', id)
      .where('user_id', '=', uid)
      .executeTakeFirst();

    if (!row) return { status_code: 404, success: false, message: 'Context not found' };

    let contextData: any = null;
    try {
      contextData = JSON.parse(row.context_data);
    } catch {
      contextData = null;
    }
    return { success: true, data: { ...row, context_data: contextData } };
  }

  /** POST /api/v1/contexts — create or (when body.id present) update. */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const uid = ctx.user_id as number;
    const input = ctx.body;

    if (!input.messages || !Array.isArray(input.messages) || input.messages.length === 0) {
      return { status_code: 400, success: false, message: 'Messages array is required' };
    }

    const contextId = input.id ?? null;
    const messages = input.messages;
    const metadata = input.metadata ?? [];

    let title = '';
    for (const msg of messages) {
      if (msg?.role === 'user') {
        title = String(msg.content ?? '').slice(0, 100);
        break;
      }
    }
    if (!title) title = 'Untitled Conversation';

    let provider = 'unknown';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant' && messages[i]?.provider) {
        provider = messages[i].provider;
        break;
      }
    }

    const messageCount = messages.length;
    const contextData = JSON.stringify({ messages, metadata });

    if (contextId) {
      await db
        .updateTable('conversation_contexts')
        .set({ title, context_data: contextData, provider, message_count: messageCount, updated_at: sql`CURRENT_TIMESTAMP` })
        .where('id', '=', contextId)
        .where('user_id', '=', uid)
        .execute();
      return { success: true, message: 'Context updated successfully', data: { id: contextId } };
    }

    const res = await db
      .insertInto('conversation_contexts')
      .values({ user_id: uid, title, context_data: contextData, provider, message_count: messageCount } as any)
      .executeTakeFirst();
    return { success: true, message: 'Context created successfully', data: { id: Number(res.insertId) } };
  }

  /** PUT /api/v1/contexts/:id — rename. */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const id = parseInt(ctx.params.id, 10);
    const uid = ctx.user_id as number;
    const input = ctx.body;

    if (input.title === undefined || String(input.title).trim() === '') {
      return { status_code: 400, success: false, message: 'Title is required' };
    }
    const newTitle = String(input.title).trim();

    const res = await db.updateTable('conversation_contexts').set({ title: newTitle }).where('id', '=', id).where('user_id', '=', uid).executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return { status_code: 404, success: false, message: 'Context not found' };
    return { success: true, message: 'Context updated successfully' };
  }

  /** DELETE /api/v1/contexts/:id */
  async delete(ctx: Ctx): Promise<ControllerResult> {
    const id = parseInt(ctx.params.id, 10);
    const uid = ctx.user_id as number;
    const res = await db.deleteFrom('conversation_contexts').where('id', '=', id).where('user_id', '=', uid).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return { status_code: 404, success: false, message: 'Context not found' };
    return { success: true, message: 'Context deleted successfully' };
  }
}
