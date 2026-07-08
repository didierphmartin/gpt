import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Request, Response } from 'express';
import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Mirrors src/Controllers/ChatAttachmentController.php — POST /api/v1/chat/upload.
 * Stores an uploaded file to disk (storage/chat-uploads/<userId>/<uuid>.<ext>) and records it in
 * chat_attachments. MIME is detected from the bytes (magic sniffing) + extension refinement, NOT the
 * browser-supplied type, matching PHP's finfo-based detectMime. (Runtime DDL not replicated.)
 */
export class ChatAttachmentController {
  // mime → extension. Copied verbatim from the PHP ALLOWED_MIME map (the actual gate).
  private static readonly ALLOWED_MIME: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'application/json': 'json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-powerpoint': 'ppt',
  };

  private static readonly MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  private readonly storageRoot = path.resolve(__dirname, '../../storage/chat-uploads');

  /** POST /api/v1/chat/upload — multer puts the file on req.file (memory storage). */
  async upload(req: Request, res: Response): Promise<void> {
    const send = (status: number, body: Record<string, any>) => res.status(status).json(body);

    const userId = (req as any).user_id;
    if (userId === null || userId === undefined || !/^\d+$/.test(String(userId))) {
      send(401, { success: false, error: 'Authentication required' });
      return;
    }
    const userIdInt = Number(userId);

    const file = (req as any).file as { buffer: Buffer; originalname: string; size: number } | undefined;
    if (!file || !file.buffer) {
      send(400, { success: false, error: 'No file field' });
      return;
    }

    const size = file.size ?? file.buffer.length;
    if (size <= 0) {
      send(400, { success: false, error: 'Empty file' });
      return;
    }
    if (size > ChatAttachmentController.MAX_BYTES) {
      send(413, { success: false, error: 'File exceeds ' + ChatAttachmentController.MAX_BYTES / 1024 / 1024 + ' MB limit' });
      return;
    }

    const detectedMime = this.detectMime(file.buffer, file.originalname ?? '');
    if (!(detectedMime in ChatAttachmentController.ALLOWED_MIME)) {
      send(415, {
        success: false,
        error:
          `Unsupported file type: ${detectedMime}. ` +
          'Allowed: PDF, PNG/JPEG/WebP/GIF, plain text, Markdown, CSV, HTML, JSON. ' +
          '(Office documents will be supported in a later release.)',
      });
      return;
    }

    const userDir = path.join(this.storageRoot, String(userIdInt));
    try {
      fs.mkdirSync(userDir, { recursive: true });
    } catch {
      send(500, { success: false, error: 'Storage init failed' });
      return;
    }

    const uuid = this.uuidv4();
    const ext = ChatAttachmentController.ALLOWED_MIME[detectedMime];
    const storedName = `${uuid}.${ext}`;
    const storedPath = path.join(userDir, storedName);

    try {
      fs.writeFileSync(storedPath, file.buffer);
    } catch {
      send(500, { success: false, error: 'Failed to persist upload' });
      return;
    }

    // Sanitize display name — strip path separators, cap length (mirrors basename + 250 cap).
    let origName = path.basename(String(file.originalname ?? 'file'));
    if (origName.length > 250) origName = origName.slice(0, 250);

    let id: number;
    try {
      const r = await sql`
        INSERT INTO chat_attachments (user_id, original_name, stored_path, mime_type, size_bytes)
        VALUES (${userIdInt}, ${origName}, ${storedPath}, ${detectedMime}, ${size})`.execute(db);
      id = Number(r.insertId);
    } catch (e: any) {
      // Roll back the disk write so we don't leak orphan files.
      try {
        fs.unlinkSync(storedPath);
      } catch {
        /* ignore */
      }
      send(500, { success: false, error: 'Failed to record upload' });
      return;
    }

    send(200, { success: true, attachment: { id, name: origName, mime_type: detectedMime, size } });
  }

  /**
   * Byte-sniff the real MIME, then refine by extension — mirrors PHP detectMime (finfo + the
   * text/zip/ole extension-refinement branches). The browser-supplied type is intentionally ignored.
   */
  private detectMime(buf: Buffer, filename: string): string {
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    const sniff = this.sniffMagic(buf);

    // Unambiguous binary signatures.
    if (sniff === 'application/pdf' || sniff === 'image/png' || sniff === 'image/jpeg' || sniff === 'image/webp' || sniff === 'image/gif') {
      return sniff;
    }

    // ZIP container (OOXML Office are zips) — disambiguate by extension.
    if (sniff === 'application/zip') {
      switch (ext) {
        case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      }
    }

    // OLE compound (legacy Office) — extension is authoritative.
    if (sniff === 'application/x-ole-storage') {
      switch (ext) {
        case 'doc': return 'application/msword';
        case 'xls': return 'application/vnd.ms-excel';
        case 'ppt': return 'application/vnd.ms-powerpoint';
      }
    }

    // Text-like / unknown: finfo would say text/plain or octet-stream → refine by extension.
    switch (ext) {
      case 'md': return 'text/markdown';
      case 'csv': return 'text/csv';
      case 'html': return 'text/html';
      case 'json': return 'application/json';
      case 'txt': return 'text/plain';
    }
    // Fall back to whatever we sniffed, else text/plain (keeps behaviour bounded to the allowlist check).
    return sniff ?? 'text/plain';
  }

  /** Detect a base MIME from magic bytes (the subset finfo would recognise for our allowlist). */
  private sniffMagic(b: Buffer): string | null {
    if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'; // GIF8
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'application/zip'; // PK
    if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/x-ole-storage';
    return null;
  }

  private uuidv4(): string {
    return crypto.randomUUID();
  }
}
