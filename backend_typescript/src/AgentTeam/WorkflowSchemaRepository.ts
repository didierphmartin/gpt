import { sql } from 'kysely';
import { db } from '../db/pools';
import { phpIntval, phpBool, decodeJson } from './WorkflowRepository';

/**
 * Faithful mirror of:
 *  - src/AgentTeam/Models/WorkflowSchema.php          (hydrate / toArray / toApiArray / validate)
 *  - src/AgentTeam/Services/WorkflowSchemaRepository.php (CRUD on the workflow_schemas table)
 *
 * Reusable JSON Schemas attached to agent nodes for constrained decoding. Table: workflow_schemas
 * (contexts DB pool). The WorkflowSchema "model" is a mutable plain object.
 */

export interface WorkflowSchema {
  id: number | null;
  userId: number;
  name: string;
  description: string;
  schemaJson: any; // array (or object) decoded from JSON
  strict: any; // bool after hydrate
  createdAt: string | null;
  updatedAt: string | null;
}

/** Mirrors WorkflowSchema::hydrate(). */
export function hydrateSchema(data: any): WorkflowSchema {
  return {
    id: data.id !== undefined && data.id !== null ? phpIntval(data.id) : null,
    userId: data.user_id !== undefined && data.user_id !== null ? phpIntval(data.user_id) : 0,
    name: data.name ?? '',
    description: data.description ?? '',
    schemaJson: decodeJson(data.schema_json ?? []),
    strict: phpBool(data.strict ?? true),
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
  };
}

/** Mirrors WorkflowSchema::toArray(). */
export function schemaToArray(s: WorkflowSchema): Record<string, any> {
  return {
    id: s.id,
    user_id: s.userId,
    name: s.name,
    description: s.description,
    schema_json: s.schemaJson,
    strict: s.strict,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** Mirrors WorkflowSchema::toApiArray(). */
export function schemaToApiArray(s: WorkflowSchema): Record<string, any> {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    schema_json: s.schemaJson,
    strict: s.strict,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** Mirrors WorkflowSchema::validate(). Returns array of error strings (empty = valid). */
export function validateSchema(s: WorkflowSchema): string[] {
  const errors: string[] = [];

  if (s.name === '') {
    errors.push('Schema name is required');
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(s.name)) {
    errors.push('Schema name must contain only letters, numbers, dashes and underscores');
  }
  // PHP empty(): empty array / empty object / falsy → "required".
  const sj = s.schemaJson;
  const schemaEmpty =
    sj === undefined ||
    sj === null ||
    (Array.isArray(sj) && sj.length === 0) ||
    (typeof sj === 'object' && !Array.isArray(sj) && Object.keys(sj).length === 0) ||
    sj === '' ||
    sj === 0 ||
    sj === false;

  if (schemaEmpty) {
    errors.push('schema_json is required');
  } else {
    const type = sj.type ?? null;
    if (type !== 'object') {
      errors.push('Top-level schema type must be "object"');
    }
    // PHP: !isset($schema['properties']) || !is_array($properties)
    const props = sj.properties;
    const propsIsArray = props !== undefined && props !== null && typeof props === 'object';
    if (props === undefined || props === null || !propsIsArray) {
      errors.push('Schema must have a "properties" object');
    }
  }

  return errors;
}

export class WorkflowSchemaRepository {
  async findByUser(userId: number): Promise<WorkflowSchema[]> {
    const rows = (
      await sql<any>`SELECT * FROM workflow_schemas WHERE user_id = ${userId} ORDER BY name ASC`.execute(db)
    ).rows;
    return rows.map(hydrateSchema);
  }

  async findById(id: number): Promise<WorkflowSchema | null> {
    const row = (await sql<any>`SELECT * FROM workflow_schemas WHERE id = ${id}`.execute(db)).rows[0];
    return row ? hydrateSchema(row) : null;
  }

  async findByName(userId: number, name: string): Promise<WorkflowSchema | null> {
    const row = (
      await sql<any>`SELECT * FROM workflow_schemas WHERE user_id = ${userId} AND name = ${name} LIMIT 1`.execute(
        db
      )
    ).rows[0];
    return row ? hydrateSchema(row) : null;
  }

  async create(schema: WorkflowSchema): Promise<WorkflowSchema> {
    const res = await sql`
      INSERT INTO workflow_schemas (user_id, name, description, schema_json, strict)
      VALUES (${schema.userId}, ${schema.name}, ${schema.description}, ${JSON.stringify(schema.schemaJson)}, ${
      schema.strict ? 1 : 0
    })`.execute(db);

    schema.id = Number(res.insertId);
    return schema;
  }

  async update(schema: WorkflowSchema): Promise<WorkflowSchema> {
    if (!schema.id) {
      throw new Error('Cannot update schema without an ID');
    }

    await sql`
      UPDATE workflow_schemas
      SET name = ${schema.name}, description = ${schema.description}, schema_json = ${JSON.stringify(
      schema.schemaJson
    )}, strict = ${schema.strict ? 1 : 0}
      WHERE id = ${schema.id} AND user_id = ${schema.userId}`.execute(db);

    return schema;
  }

  async delete(id: number, userId: number): Promise<boolean> {
    const res = await sql`DELETE FROM workflow_schemas WHERE id = ${id} AND user_id = ${userId}`.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }
}
