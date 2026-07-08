import { Ctx, ControllerResult } from '../Support/Http';
import { phpIntval, phpBool, phpIsArray } from '../AgentTeam/WorkflowRepository';
import {
  WorkflowSchemaRepository,
  hydrateSchema,
  schemaToApiArray,
  validateSchema,
} from '../AgentTeam/WorkflowSchemaRepository';

/**
 * Mirrors src/AgentTeam/Controllers/WorkflowSchemaController.php — full CRUD:
 *   index, show, create, update, destroy.
 *
 * Note: the PHP error() helper puts only `error` + `status_code` in the body (no `status` field).
 */
export class WorkflowSchemaController {
  private repository = new WorkflowSchemaRepository();

  private error(message: string, status: number): ControllerResult {
    return { success: false, error: message, status_code: status };
  }

  /** GET /api/v1/workflow-schemas */
  async index(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntval(ctx.user_id ?? 0);
    if (!userId) {
      return this.error('Authentication required', 401);
    }

    try {
      const schemas = await this.repository.findByUser(userId);
      return {
        success: true,
        data: schemas.map((s) => schemaToApiArray(s)),
        count: schemas.length,
        status_code: 200,
      };
    } catch (e: any) {
      return this.error(e?.message ?? '', 500);
    }
  }

  /** GET /api/v1/workflow-schemas/{id} */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntval(ctx.user_id ?? 0);
    const id = phpIntval(ctx.params?.id ?? 0);

    if (!userId) {
      return this.error('Authentication required', 401);
    }

    try {
      const schema = await this.repository.findById(id);
      if (!schema || schema.userId !== userId) {
        return this.error('Schema not found', 404);
      }
      return { success: true, data: schemaToApiArray(schema), status_code: 200 };
    } catch (e: any) {
      return this.error(e?.message ?? '', 500);
    }
  }

  /** POST /api/v1/workflow-schemas */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntval(ctx.user_id ?? 0);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return this.error('Authentication required', 401);
    }

    try {
      const schema = hydrateSchema({});
      schema.userId = userId;
      schema.name = String(body.name ?? '');
      schema.description = String(body.description ?? '');
      schema.schemaJson = phpIsArray(body.schema_json ?? null) ? body.schema_json : [];
      schema.strict = phpBool(body.strict ?? true);

      const errors = validateSchema(schema);
      if (errors.length > 0) {
        return {
          success: false,
          error: 'Invalid schema',
          validation_errors: errors,
          status_code: 400,
        };
      }

      // Enforce unique name per user.
      const existing = await this.repository.findByName(userId, schema.name);
      if (existing) {
        return this.error(`A schema named '${schema.name}' already exists`, 409);
      }

      const created = await this.repository.create(schema);

      return {
        success: true,
        data: schemaToApiArray(created),
        message: 'Schema created',
        status_code: 201,
      };
    } catch (e: any) {
      return this.error(e?.message ?? '', 500);
    }
  }

  /** PUT /api/v1/workflow-schemas/{id} */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntval(ctx.user_id ?? 0);
    const id = phpIntval(ctx.params?.id ?? 0);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return this.error('Authentication required', 401);
    }

    try {
      const schema = await this.repository.findById(id);
      if (!schema || schema.userId !== userId) {
        return this.error('Schema not found', 404);
      }

      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      if (has('name')) schema.name = String(body.name);
      if (has('description')) schema.description = String(body.description);
      if (has('schema_json') && phpIsArray(body.schema_json)) {
        schema.schemaJson = body.schema_json;
      }
      if (has('strict')) schema.strict = phpBool(body.strict);

      const errors = validateSchema(schema);
      if (errors.length > 0) {
        return {
          success: false,
          error: 'Invalid schema',
          validation_errors: errors,
          status_code: 400,
        };
      }

      // If renamed, check uniqueness.
      const sameName = await this.repository.findByName(userId, schema.name);
      if (sameName && sameName.id !== schema.id) {
        return this.error(`A schema named '${schema.name}' already exists`, 409);
      }

      await this.repository.update(schema);

      return {
        success: true,
        data: schemaToApiArray(schema),
        message: 'Schema updated',
        status_code: 200,
      };
    } catch (e: any) {
      return this.error(e?.message ?? '', 500);
    }
  }

  /** DELETE /api/v1/workflow-schemas/{id} */
  async destroy(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntval(ctx.user_id ?? 0);
    const id = phpIntval(ctx.params?.id ?? 0);

    if (!userId) {
      return this.error('Authentication required', 401);
    }

    try {
      const schema = await this.repository.findById(id);
      if (!schema || schema.userId !== userId) {
        return this.error('Schema not found', 404);
      }
      await this.repository.delete(id, userId);
      return { success: true, message: 'Schema deleted', status_code: 200 };
    } catch (e: any) {
      return this.error(e?.message ?? '', 500);
    }
  }
}
