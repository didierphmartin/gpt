import fs from 'fs/promises';
import path from 'path';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/FileStorageController.php — browse and read files from the user's
 * storage (universalFS-backed cloud providers with a local-filesystem fallback).
 *
 * Notes on faithful divergence:
 *  - universalFS is a PHP composer library (vendor/autoload.php + PDO credential store + PHP
 *    adapters); there is no Node port, so getUniversalFSAdapter always resolves null and the
 *    PHP null-adapter fallbacks are the effective behavior: local listing/reading for 'local',
 *    the "Cloud storage is not yet configured" message for cloud providers.
 *  - PHP getProviders calls an undefined getUniversalFSClient() (latent bug); TS implements the
 *    documented client-unavailable fallback: the local-only provider list.
 *  - Runtime DDL (ensureStorageColumnsExist) is NOT replicated — the columns already exist
 *    (same convention as SettingsController).
 */
export class FileStorageController {
  private static readonly ROOT_FOLDER = 'synergyaichatroot';

  // Matches PHP's __DIR__ . '/../../../../storage' default (config['storage_path'] is never set):
  // htdocs/storage, from src/Controllers and dist/Controllers alike.
  private static readonly STORAGE_BASE = path.resolve(__dirname, '../../../../storage');

  /**
   * Build the full path including the root folder
   * Structure: synergyaichatroot/{user_folder}/{path}
   */
  private buildFullPath(userFolder: string, relPath = ''): string {
    const trim = (s: string) => s.replace(/^\/+|\/+$/g, '');
    const parts = [FileStorageController.ROOT_FOLDER];
    if (userFolder) parts.push(trim(userFolder));
    if (relPath) parts.push(trim(relPath));
    return parts.join('/');
  }

  /** Get user's storage configuration */
  private async getUserStorageConfig(userId: number): Promise<{ provider: string; folder: string }> {
    const user = (
      await sql<{ storage_provider: string | null; storage_folder: string | null }>`
        SELECT storage_provider, storage_folder FROM users WHERE id = ${userId}`.execute(db)
    ).rows[0];

    return {
      provider: user?.storage_provider ?? 'local',
      folder: user?.storage_folder ?? '',
    };
  }

  /** GET /api/v1/storage/providers — available storage providers for the user */
  async getProviders(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required' };
    }

    // universalFS client not available in the TS backend — return the default provider list.
    return {
      success: true,
      providers: [{ id: 'local', name: 'Local Storage', icon: 'folder', connected: true }],
    };
  }

  /** GET /api/v1/storage/list — list files and folders at a given path */
  async listFiles(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required' };
    }

    // Get parameters from query string
    const relativePath = String(ctx.query.path ?? ''); // Path relative to user's folder

    // Get user's storage config
    const storageConfig = await this.getUserStorageConfig(userId);
    const provider = storageConfig.provider;
    const userFolder = storageConfig.folder;

    // Check if storage folder is configured
    if (!userFolder) {
      return {
        success: true,
        provider,
        userFolder: '',
        path: '',
        fullPath: '',
        items: [],
        message: 'No storage folder configured. Please configure your storage folder in Settings.',
      };
    }

    // Build full path: synergyaichatroot/{user_folder}/{relative_path}
    const fullPath = this.buildFullPath(userFolder, relativePath);

    try {
      // No universalFS adapter in the TS backend (PHP-only library).
      if (provider !== 'local') {
        return {
          success: true,
          provider,
          userFolder,
          path: relativePath,
          fullPath,
          items: [],
          message: 'Cloud storage is not yet configured. Please contact support or configure universalFS.',
        };
      }
      // Fallback to local storage
      return await this.listLocalFiles(userId, fullPath);
    } catch (e: any) {
      console.error('[FileStorageController] listFiles error: ' + (e?.message ?? e));
      return {
        success: false,
        error: 'Unable to connect to storage. Please check your settings.',
        items: [],
      };
    }
  }

  /** GET /api/v1/storage/read — read file content */
  async readFile(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required' };
    }

    // Get parameters from query string
    const fileId = String(ctx.query.fileId ?? ctx.query.file_id ?? '');

    if (!fileId) {
      return { success: false, error: 'File ID is required' };
    }

    try {
      // No universalFS adapter in the TS backend — read from local storage.
      return await this.readLocalFile(userId, fileId);
    } catch (e: any) {
      console.error('[FileStorageController] readFile error: ' + (e?.message ?? e));
      return { success: false, error: e?.message ?? 'Read failed' };
    }
  }

  /**
   * List local files (fallback)
   * Uses the same structure: storage/{ROOT_FOLDER}/{user_folder}/{path}
   */
  private async listLocalFiles(_userId: number, relPath: string): Promise<ControllerResult> {
    const basePath = FileStorageController.STORAGE_BASE;
    const fullPath = basePath + '/' + relPath.replace(/^\/+/, '');

    const dirStat = await fs.stat(fullPath).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      // Create the directory structure if it doesn't exist
      try {
        await fs.mkdir(fullPath, { recursive: true, mode: 0o755 });
        console.error('[FileStorageController] Created local folder: ' + fullPath);
      } catch {
        /* mkdir failed — still report the empty folder, matching PHP */
      }
      return {
        success: true,
        provider: 'local',
        path: relPath,
        fullPath,
        items: [],
        message: 'Folder is empty or was just created.',
      };
    }

    const items: Record<string, any>[] = [];
    for (const name of await fs.readdir(fullPath)) {
      const itemPath = fullPath + '/' + name;
      const relativePath = (relPath + '/' + name).replace(/^\/+|\/+$/g, '');
      const st = await fs.stat(itemPath).catch(() => null);
      if (!st) continue;

      items.push({
        id: relativePath,
        name,
        path: relativePath,
        type: st.isDirectory() ? 'folder' : 'file',
        size: st.isFile() ? st.size : 0,
        modified: this.formatMtime(st.mtime),
        mimeType: st.isFile() ? this.guessMimeType(name) : 'inode/directory',
      });
    }

    // Sort: folders first, then by name
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    return {
      success: true,
      provider: 'local',
      path: relPath,
      fullPath,
      items,
    };
  }

  /** Read local file (fallback) */
  private async readLocalFile(userId: number, filePath: string): Promise<ControllerResult> {
    const basePath = FileStorageController.STORAGE_BASE;
    const fullPath = basePath + '/user_' + userId + '/' + filePath.replace(/^\/+/, '');

    const st = await fs.stat(fullPath).catch(() => null);
    if (!st || !st.isFile()) {
      return { success: false, error: 'File not found' };
    }

    const content = await fs.readFile(fullPath);
    const mimeType = this.guessMimeType(path.basename(fullPath));
    const isBinary = this.isBinaryContent(content, mimeType);

    return {
      success: true,
      name: path.basename(fullPath),
      size: st.size,
      mimeType,
      isBinary,
      content: isBinary ? content.toString('base64') : content.toString('utf8'),
      encoding: isBinary ? 'base64' : 'utf-8',
    };
  }

  /** Format an mtime as 'YYYY-MM-DD HH:MM:SS' local time — matches PHP date('Y-m-d H:i:s'). */
  private formatMtime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Guess MIME type from filename */
  private guessMimeType(filename: string): string {
    const ext = path.extname(filename).slice(1).toLowerCase();

    const map: Record<string, string> = {
      txt: 'text/plain',
      html: 'text/html',
      htm: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
      xml: 'application/xml',
      pdf: 'application/pdf',
      zip: 'application/zip',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      md: 'text/markdown',
      csv: 'text/csv',
      php: 'application/x-php',
      py: 'text/x-python',
      java: 'text/x-java',
      c: 'text/x-c',
      cpp: 'text/x-c',
      h: 'text/x-c',
      sql: 'application/sql',
      yaml: 'text/yaml',
      yml: 'text/yaml',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  /** Check if content is binary */
  private isBinaryContent(content: Buffer, mimeType: string): boolean {
    // Check MIME type first
    const textTypes = ['text/', 'application/json', 'application/javascript',
                       'application/xml', 'application/sql', 'application/x-php'];

    for (const type of textTypes) {
      if (mimeType.startsWith(type)) return false;
    }

    // Check for binary content (null bytes or high percentage of non-printable chars)
    if (content.includes(0)) return true;

    // Sample first 1KB
    const sample = content.subarray(0, 1024);
    let nonPrintable = 0;
    for (const byte of sample) {
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) { // Allow tab, newline, carriage return
        nonPrintable++;
      }
    }

    return nonPrintable / Math.max(1, sample.length) > 0.1;
  }
}
