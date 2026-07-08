import fs from 'fs';
import path from 'path';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { phpBool, phpEmpty, phpIntval } from './WorkflowRepository';

/**
 * Faithful port of src/AgentTeam/Services/WorkflowOutputStorage.php.
 *
 * Handles saving workflow outputs to external storage "via universalFS" (PHP's in-process PHP
 * library at /Applications/XAMPP/xamppfiles/htdocs/universalfs — NOT an HTTP API). Supports local,
 * S3, Google Drive, and OneDrive providers in PHP by dispatching through a `UniversalFSClient`
 * instance obtained from `getUniversalFSClient()`, which does `require_once
 * .../universalfs/bootstrap.php` and calls the global `getUniversalFSClientWithApiKey()` helper.
 *
 * PORTING DECISION (recon, 2026-07-08): universalFS is a same-process PHP library, not a network
 * service — there is no HTTP endpoint for saveOutput/listOutputs/getOutput to call from Node. (The
 * `universalfs/mcp/server.php` is a separate MCP tool-call surface used by IngestionLoader/
 * IngestionController for a different purpose — read_file — and does not expose the generic
 * connect/write/ls/read primitives this class needs.) PHP's own `getUniversalFSClient()` already
 * returns null whenever the bootstrap file is missing or no API key is configured, in which case
 * PHP itself always falls back to `saveToLocalFallback`/`listFromLocalFallback`/
 * `readFromLocalFallback`. Every current deployment therefore already exercises the local-fallback
 * path exclusively (no `universalfs_api_key` column exists on `users`; `getUserUniversalFSApiKey()`
 * only reads `config['universalfs']['api_key']`, which is unset). This port implements the local
 * fallback FULLY and faithfully (same directory structure, same filename/sanitization logic) and
 * leaves `getUniversalFSClient()` as a documented stub returning null (see TODO on that method) so
 * the S3/gdrive/local dispatch is never silently skipped — it is simply never reached, exactly as in
 * the current PHP runtime configuration.
 */
export class WorkflowOutputStorage {
  private config: Record<string, any>;

  // Path to universalFS library (PHP-only; unreachable from Node — see class doc).
  private static readonly UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs';
  private static readonly ROOT_FOLDER = 'synergyaichatroot';

  constructor(config: Record<string, any> = {}) {
    this.config = config;
  }

  /**
   * Build the full path including the root folder.
   * Structure: synergyaichatroot/{user_folder}/{path}
   */
  private buildFullPath(userFolder: string, pathSuffix: string = ''): string {
    const parts = [WorkflowOutputStorage.ROOT_FOLDER];
    if (!phpEmpty(userFolder)) parts.push(trimSlashes(userFolder));
    if (!phpEmpty(pathSuffix)) parts.push(trimSlashes(pathSuffix));
    return parts.join('/');
  }

  /**
   * Save workflow output to storage.
   */
  async saveOutput(workflowId: number, userId: number, output: Record<string, any>): Promise<Record<string, any>> {
    try {
      const workflow = await this.getWorkflow(workflowId);
      if (!workflow) {
        return { success: false, error: 'Workflow not found' };
      }

      if (!workflow.output_storage_enabled) {
        return { success: false, error: 'Output storage not enabled for this workflow' };
      }

      const storageConfig = await this.getStorageConfig(userId, workflow);
      if (!storageConfig.provider || !storageConfig.folder) {
        return { success: false, error: 'Storage not configured' };
      }

      const filename = this.generateFilename(workflow.name);
      const fullPath = this.buildFullPath(storageConfig.folder, filename);

      // JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE: 4-space indent, unicode kept unescaped —
      // JSON.stringify(..., null, 4) matches both.
      const content = JSON.stringify(output, null, 4);

      const result = await this.saveToStorage(storageConfig.provider, fullPath, content, userId);

      if (result.success) {
        console.error(`[WorkflowOutputStorage] Saved output to ${storageConfig.provider}://${fullPath}`);
      }

      return {
        ...result,
        filename,
        path: fullPath,
        provider: storageConfig.provider,
      };
    } catch (e: any) {
      console.error('[WorkflowOutputStorage] Error: ' + (e?.message ?? String(e)));
      return { success: false, error: e?.message ?? String(e) };
    }
  }

  /**
   * List outputs for a workflow.
   */
  async listOutputs(workflowId: number, userId: number): Promise<Record<string, any>> {
    try {
      const workflow = await this.getWorkflow(workflowId);
      if (!workflow) {
        return { success: false, error: 'Workflow not found' };
      }

      const storageConfig = await this.getStorageConfig(userId, workflow);
      if (!storageConfig.provider || !storageConfig.folder) {
        return { success: true, files: [], message: 'Storage not configured' };
      }

      const sanitizedName = this.sanitizeFilename(workflow.name);
      const pattern = sanitizedName + '_';

      const fullPath = this.buildFullPath(storageConfig.folder);

      const files = await this.listFromStorage(storageConfig.provider, fullPath, pattern, userId);

      return {
        success: true,
        files,
        provider: storageConfig.provider,
        folder: storageConfig.folder,
      };
    } catch (e: any) {
      console.error('[WorkflowOutputStorage] List error: ' + (e?.message ?? String(e)));
      return { success: false, error: e?.message ?? String(e) };
    }
  }

  /**
   * Get a specific output file's content.
   */
  async getOutput(workflowId: number, userId: number, filename: string): Promise<Record<string, any>> {
    try {
      const workflow = await this.getWorkflow(workflowId);
      if (!workflow) {
        return { success: false, error: 'Workflow not found' };
      }

      const storageConfig = await this.getStorageConfig(userId, workflow);
      if (!storageConfig.provider || !storageConfig.folder) {
        return { success: false, error: 'Storage not configured' };
      }

      const fullPath = this.buildFullPath(storageConfig.folder, filename);

      const content = await this.readFromStorage(storageConfig.provider, fullPath, userId);

      return {
        success: true,
        content,
        filename,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  }

  /**
   * Get workflow details. `agent_workflows` is not in the Kysely `DB` typed interface (raw `sql`,
   * matching WorkflowRepository.ts's own pattern for this table).
   */
  private async getWorkflow(
    workflowId: number
  ): Promise<{ id: number; name: string; user_id: number; output_storage_enabled: boolean; output_folder: string | null } | null> {
    const row = (
      await sql<any>`SELECT id, name, user_id, output_storage_enabled, output_folder FROM agent_workflows WHERE id = ${workflowId}`.execute(
        db
      )
    ).rows[0];
    if (!row) return null;
    return {
      id: phpIntval(row.id),
      name: row.name,
      user_id: phpIntval(row.user_id),
      output_storage_enabled: phpBool(row.output_storage_enabled),
      output_folder: row.output_folder ?? null,
    };
  }

  /**
   * Get storage configuration for user/workflow. Workflow-specific folder overrides user's global
   * folder.
   */
  private async getStorageConfig(
    userId: number,
    workflow: { output_folder: string | null }
  ): Promise<{ provider: string; folder: string }> {
    const user = (
      await sql<{ storage_provider: string | null; storage_folder: string | null }>`SELECT storage_provider, storage_folder FROM users WHERE id = ${userId}`.execute(
        db
      )
    ).rows[0];

    const provider = user?.storage_provider ?? 'local';
    let folder = user?.storage_folder ?? '';

    if (!phpEmpty(workflow.output_folder)) {
      folder = workflow.output_folder as string;
    }

    return { provider, folder };
  }

  /**
   * Generate filename from workflow name + timestamp.
   * Format: Workflow_Name_2026-03-31_19-45-30.json
   */
  private generateFilename(workflowName: string): string {
    const sanitized = this.sanitizeFilename(workflowName);
    const timestamp = formatTimestamp(new Date());
    return `${sanitized}_${timestamp}.json`;
  }

  /**
   * Sanitize workflow name for use as filename.
   * - Replace spaces with underscores
   * - Remove special characters except - and _
   * - Collapse consecutive underscores, trim from ends
   */
  private sanitizeFilename(name: string): string {
    let n = name.replace(/ /g, '_');
    n = n.replace(/[^a-zA-Z0-9_\-]/g, '');
    n = n.replace(/_+/g, '_');
    n = n.replace(/^_+|_+$/g, '');
    return n || 'workflow';
  }

  /**
   * Save content to storage via universalFS (unreachable — see class doc); falls back to local FS.
   */
  private async saveToStorage(provider: string, pathStr: string, content: string, userId: number): Promise<Record<string, any>> {
    const client = this.getUniversalFSClient(userId);

    if (!client) {
      return this.saveToLocalFallback(pathStr, content, userId);
    }

    // TODO(universalfs): once a Node-reachable UniversalFS client exists (see getUniversalFSClient),
    // mirror PHP: client.connect(provider); client.write(`${provider}://${pathStr}`, content);
    return { success: false, error: 'universalFS client not implemented' };
  }

  /**
   * List files from storage via universalFS (unreachable — see class doc); falls back to local FS.
   */
  private async listFromStorage(provider: string, folder: string, pattern: string, userId: number): Promise<Array<Record<string, any>>> {
    const client = this.getUniversalFSClient(userId);

    if (!client) {
      return this.listFromLocalFallback(folder, pattern, userId);
    }

    // TODO(universalfs): mirror PHP: client.connect(provider); client.ls(`${provider}://${folder}`);
    // filter items where type==='file' && name.startsWith(pattern), sort by modified desc.
    return [];
  }

  /**
   * Read file from storage via universalFS (unreachable — see class doc); falls back to local FS.
   */
  private async readFromStorage(provider: string, pathStr: string, userId: number): Promise<string> {
    const client = this.getUniversalFSClient(userId);

    if (!client) {
      return this.readFromLocalFallback(pathStr, userId);
    }

    // TODO(universalfs): mirror PHP: client.connect(provider); return client.read(`${provider}://${pathStr}`);
    throw new Error('universalFS client not implemented');
  }

  /**
   * Get universalFS client instance.
   *
   * TODO(universalfs): PHP reaches universalFS via `require_once
   * '/Applications/XAMPP/xamppfiles/htdocs/universalfs/bootstrap.php'` (a same-process PHP include,
   * not a network call) and then `getUniversalFSClientWithApiKey($apiKey)`. There is no HTTP surface
   * for the generic connect/write/ls/read primitives this class needs — the only network-reachable
   * piece of universalfs/ is its MCP server (`universalfs/mcp/server.php`, default
   * http://localhost:8080/mcp/server.php), which speaks the MCP tool-call protocol for a narrower
   * `read_file`-style surface (already consumed elsewhere, see IngestionLoader.ts), not this
   * class's write/ls/read-by-provider API. To complete this from Node, one of:
   *   (a) add a small PHP HTTP shim in universalfs/ exposing connect/write/ls/read as REST endpoints
   *       the Node process can `fetch()`, or
   *   (b) port UniversalFSClient.php + the S3/gdrive/local adapters to a Node package.
   * Additionally, PHP's own `getUserUniversalFSApiKey()` only ever reads
   * `config['universalfs']['api_key']` (no DB column), which is unset in every known deployment —
   * so PHP itself always falls through to the local fallback today. Returning null here reproduces
   * that same effective behavior without inventing a fake client.
   */
  private getUniversalFSClient(_userId: number): null {
    return null;
  }

  // =========================================
  // Local Fallback Methods
  // =========================================

  private getBasePath(): string {
    return this.config.workflow_outputs_path ?? path.resolve(__dirname, '../../storage/workflow_outputs');
  }

  /**
   * Fallback: Save to local filesystem.
   */
  private saveToLocalFallback(pathStr: string, content: string, userId: number): Record<string, any> {
    const basePath = this.getBasePath();
    const fullPath = `${basePath}/${userId}/${pathStr}`;
    const dir = path.dirname(fullPath);

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
      fs.writeFileSync(fullPath, content);
      return { success: true };
    } catch {
      return { success: false, error: 'Failed to write file' };
    }
  }

  /**
   * Fallback: List from local filesystem.
   */
  private listFromLocalFallback(folder: string, pattern: string, userId: number): Array<Record<string, any>> {
    const basePath = this.getBasePath();
    const fullPath = `${basePath}/${userId}/${folder}`;

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
      return [];
    }

    const files: Array<Record<string, any>> = [];
    for (const file of fs.readdirSync(fullPath)) {
      if (!file.startsWith(pattern)) continue;

      const filePath = `${fullPath}/${file}`;
      const stat = fs.statSync(filePath);
      files.push({
        name: file,
        size: stat.size,
        modified: formatDateTime(stat.mtime),
        path: `${folder}/${file}`,
      });
    }

    files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));

    return files;
  }

  /**
   * Fallback: Read from local filesystem.
   */
  private readFromLocalFallback(pathStr: string, userId: number): string {
    const basePath = this.getBasePath();
    const fullPath = `${basePath}/${userId}/${pathStr}`;

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${pathStr}`);
    }

    return fs.readFileSync(fullPath, 'utf8');
  }
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

/** Mirrors PHP date('Y-m-d_H-i-s') using local server time (matches PHP's default TZ behavior). */
function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Mirrors PHP date('Y-m-d H:i:s') using local server time. */
function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
