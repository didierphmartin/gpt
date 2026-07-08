import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/** Mirrors src/Controllers/PromptLibraryController.php. Protected; scoped by JWT user_id. */
const COLUMNS = ['id', 'parent_id', 'type', 'name', 'content', 'sort_order', 'created_at', 'updated_at'] as const;

interface PromptNode {
  id: number;
  parent_id: number | null;
  type: 'folder' | 'prompt';
  name: string;
  content: string | null;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
  children?: PromptNode[];
}

export class PromptLibraryController {
  /** Recursive tree build (root = parent_id == null; orphans dropped) — matches PHP buildTree. */
  private buildTree(items: PromptNode[], parentId: number | null): PromptNode[] {
    const branch: PromptNode[] = [];
    for (const item of items) {
      const matches =
        parentId === null ? item.parent_id === null : item.parent_id !== null && Number(item.parent_id) === Number(parentId);
      if (matches) {
        const children = this.buildTree(items, item.id);
        const node: PromptNode = { ...item };
        if (children.length) node.children = children;
        branch.push(node);
      }
    }
    return branch;
  }

  async getTree(ctx: Ctx): Promise<ControllerResult> {
    const uid = ctx.user_id as number;
    const rows = (await db
      .selectFrom('prompt_library')
      .select(COLUMNS)
      .where('user_id', '=', uid)
      .orderBy('parent_id')
      .orderBy('sort_order')
      .orderBy('name')
      .execute()) as unknown as PromptNode[];

    return { success: true, data: this.buildTree(rows, null) };
  }

  async get(ctx: Ctx): Promise<ControllerResult> {
    const id = parseInt(ctx.params.id, 10);
    const uid = ctx.user_id as number;
    const row = await db
      .selectFrom('prompt_library')
      .select(COLUMNS)
      .where('id', '=', id)
      .where('user_id', '=', uid)
      .executeTakeFirst();

    if (!row) return { status_code: 404, success: false, message: 'Item not found' };
    return { success: true, data: row };
  }

  async create(ctx: Ctx): Promise<ControllerResult> {
    const b = ctx.body;
    const type = b.type;
    if (type !== 'folder' && type !== 'prompt') {
      return { status_code: 400, success: false, message: 'Valid type (folder or prompt) is required' };
    }
    if (!b.name) {
      return { status_code: 400, success: false, message: 'Name is required' };
    }

    const uid = ctx.user_id as number;
    const content = type === 'prompt' && b.content != null ? b.content : null;
    const sort_order = b.sort_order ?? 0;
    const parent_id = b.parent_id ?? null;

    if (parent_id != null) {
      const parent = await db
        .selectFrom('prompt_library')
        .select('id')
        .where('id', '=', parent_id)
        .where('user_id', '=', uid)
        .executeTakeFirst();
      if (!parent) {
        return { status_code: 400, success: false, message: 'Parent folder not found' };
      }
    }

    const res = await db
      .insertInto('prompt_library')
      .values({ user_id: uid, parent_id, type, name: b.name, content, sort_order })
      .executeTakeFirst();

    return {
      success: true,
      message: `${type === 'folder' ? 'Folder' : 'Prompt'} created successfully`,
      data: { id: String(res.insertId), type, name: b.name, parent_id, content },
    };
  }

  async update(ctx: Ctx): Promise<ControllerResult> {
    const id = parseInt(ctx.params.id, 10);
    const uid = ctx.user_id as number;

    const existing = await db
      .selectFrom('prompt_library')
      .select(['id', 'type'])
      .where('id', '=', id)
      .where('user_id', '=', uid)
      .executeTakeFirst();
    if (!existing) return { status_code: 404, success: false, message: 'Item not found' };

    const b = ctx.body;
    const updates: Record<string, unknown> = {};
    if (b.name !== undefined && String(b.name).trim() !== '') updates.name = b.name;
    if (b.content !== undefined) updates.content = b.content;
    if (b.parent_id !== undefined) updates.parent_id = b.parent_id;
    if (b.sort_order !== undefined) updates.sort_order = b.sort_order;

    if (Object.keys(updates).length === 0) {
      return { status_code: 400, success: false, message: 'No fields to update' };
    }

    await db.updateTable('prompt_library').set(updates as any).where('id', '=', id).where('user_id', '=', uid).execute();

    const label = existing.type === 'folder' ? 'Folder' : 'Prompt';
    return { success: true, message: `${label} updated successfully`, data: { id } };
  }

  async delete(ctx: Ctx): Promise<ControllerResult> {
    const id = parseInt(ctx.params.id, 10);
    const uid = ctx.user_id as number;

    const existing = await db
      .selectFrom('prompt_library')
      .select(['id', 'type'])
      .where('id', '=', id)
      .where('user_id', '=', uid)
      .executeTakeFirst();
    if (!existing) return { status_code: 404, success: false, message: 'Item not found' };

    await db.deleteFrom('prompt_library').where('id', '=', id).where('user_id', '=', uid).execute();

    const label = existing.type === 'folder' ? 'Folder' : 'Prompt';
    return { success: true, message: `${label} deleted successfully` };
  }
}
