import { readFileSync } from 'fs';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';

/** Mirrors src/Controllers/ModelCatalogController.php. Public; reads the static catalog file. */
export class ModelCatalogController {
  get(_ctx: Ctx): ControllerResult {
    let raw: string;
    try {
      raw = readFileSync(config.modelCatalogPath, 'utf8');
    } catch {
      return { status_code: 500, success: false, error: 'Model catalog file not found' };
    }

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return { status_code: 500, success: false, error: 'Failed to read model catalog' };
    }

    if (!data || typeof data.providers !== 'object' || data.providers === null || Array.isArray(data.providers)) {
      return { status_code: 500, success: false, error: 'Model catalog is malformed' };
    }

    return { success: true, providers: data.providers, updated: data._updated ?? null };
  }
}
