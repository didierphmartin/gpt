import { promises as fs } from 'fs';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { NativeAttachment } from '../Contracts/types';

export interface AttachmentPrefixResult {
  prefix: string;
  image_attachments: NativeAttachment[];
  pdf_attachments: NativeAttachment[];
  notes: string[];
}

/**
 * Attachment Dispatcher — TypeScript port of `Services/AttachmentDispatcher.php`.
 *
 * Loads chat_attachments rows by id (with ownership check), reads bytes from
 * disk, and turns them into a chunk of text suitable for prepending to a
 * chat message — plus routes images and (for some providers) PDFs to native
 * provider dispatch.
 *
 * The frontend attachment-converter (Pyodide-based) is the primary path for
 * binary docs (.docx/.pptx/.xlsx/.pdf): it converts them to Markdown in the
 * browser and strips their IDs from `attachment_ids`. Under normal operation
 * this dispatcher only sees:
 *   - image attachments → native per-provider dispatch (image_attachments)
 *   - PDFs on native-PDF providers → native dispatch (pdf_attachments)
 *   - text-native files (txt/md/csv/json/html) → read verbatim
 *
 * DIVERGENCE from PHP: the smalot/pdfparser + phpoffice/* server-side
 * extraction safety net (legacy / non-converter-aware clients only) has no
 * Node counterpart here — those files are skipped with a note instead.
 */
export class AttachmentDispatcher {
  /** Cap each attachment's extracted text to keep request budgets sane. */
  private static readonly MAX_TEXT_PER_FILE = 100_000; // characters

  /**
   * Providers that can ingest PDFs natively (preserving charts/figures)
   * via inline base64 in the message body.
   */
  private static readonly NATIVE_PDF_PROVIDERS = ['claude', 'gemini', 'openai'];

  /** MIME families the PHP fallback extractor handled via libraries — skipped here. */
  private static readonly LIBRARY_EXTRACTED_MIMES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
  ];

  /** Build the per-request attachment payload. Mirrors PHP buildPrefix(). */
  async buildPrefix(
    attachmentIds: any[],
    userId: number,
    provider: string | null = null,
    skillModeActive = false,
  ): Promise<AttachmentPrefixResult> {
    const ids = attachmentIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
    console.log(
      `[AttachmentDispatcher] buildPrefix called — attachment_count: ${ids.length}, provider: ` +
        `${provider ?? 'null'}, skillModeActive: ${skillModeActive ? 'true (will elide)' : 'false (will inline)'}`,
    );
    const empty: AttachmentPrefixResult = { prefix: '', image_attachments: [], pdf_attachments: [], notes: [] };
    if (!ids.length) return empty;

    const result = await sql<{
      id: number;
      original_name: string;
      stored_path: string;
      mime_type: string;
      size_bytes: number;
    }>`SELECT id, original_name, stored_path, mime_type, size_bytes
       FROM chat_attachments
       WHERE user_id = ${userId} AND deleted_at IS NULL AND id IN (${sql.join(ids)})`.execute(db);
    const rows = result.rows;
    if (!rows.length) return empty;

    const supportsNativePdf =
      provider !== null && AttachmentDispatcher.NATIVE_PDF_PROVIDERS.includes(provider.toLowerCase());

    const blocks: string[] = [];
    const images: NativeAttachment[] = [];
    const pdfs: NativeAttachment[] = [];
    const notes: string[] = [];

    for (const row of rows) {
      const name = String(row.original_name);
      const mime = String(row.mime_type);
      const path = String(row.stored_path);

      // Images: read bytes, base64-encode, hand off for per-provider native dispatch.
      if (mime.startsWith('image/')) {
        try {
          const bytes = await fs.readFile(path);
          images.push({ mime_type: mime, data: bytes.toString('base64'), name });
        } catch {
          notes.push(`Image '${name}' could not be read; skipped.`);
        }
        continue;
      }

      // PDFs: if the active provider supports native PDF, hand the bytes off so
      // charts/figures/diagrams survive.
      if (mime === 'application/pdf' && supportsNativePdf) {
        try {
          const bytes = await fs.readFile(path);
          pdfs.push({ mime_type: mime, data: bytes.toString('base64'), name });
        } catch {
          notes.push(`PDF '${name}' could not be read; skipped.`);
        }
        continue;
      }

      // Skill-mode short-reference: the file is pre-staged at /scratch/<name> for
      // the skill script; inlining the full text would waste tokens and tempt the
      // model to answer inline instead of calling the skill.
      if (skillModeActive) {
        const sizeBytes = Number(row.size_bytes ?? 0);
        blocks.push(
          `### ${name} (${sizeBytes} bytes, mime: ${mime})\n` +
            `[Pre-staged at /scratch/${name} for skill-script access. ` +
            `Pass this path to run_skill_script via argv (e.g. -i /scratch/${name}). ` +
            `Full content NOT inlined here to save tokens.]`,
        );
        continue;
      }

      // PHP falls back to library-based extraction (pdfparser / phpoffice) here;
      // no Node counterpart — these normally never reach the backend because the
      // frontend converter inlines them client-side.
      if (AttachmentDispatcher.LIBRARY_EXTRACTED_MIMES.includes(mime)) {
        notes.push(`Could not read '${name}' (server-side extraction not available on this backend); skipped.`);
        continue;
      }

      // Plain-text family — read verbatim as UTF-8 (BOM stripped).
      let text: string;
      try {
        let bytes = await fs.readFile(path);
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
        text = bytes.toString('utf8');
      } catch {
        notes.push(`Could not read '${name}'; skipped.`);
        continue;
      }

      text = this.truncate(text);
      if (text === '') {
        notes.push(`Attachment '${name}' contained no readable text; skipped.`);
        continue;
      }

      blocks.push(`### ${name}\n${text}`);
    }

    let prefix = '';
    if (blocks.length) {
      const header = skillModeActive
        ? '[The user attached the following document(s). They are pre-staged on the script filesystem under /scratch/ — call run_skill_script with the appropriate path in argv to process them.]\n\n'
        : '[The user attached the following document(s); use them as authoritative context for the message that follows.]\n\n';
      prefix = header + blocks.join('\n\n---\n\n') + '\n\n---\n\n';
    }

    return { prefix, image_attachments: images, pdf_attachments: pdfs, notes };
  }

  private truncate(text: string): string {
    if (text.length <= AttachmentDispatcher.MAX_TEXT_PER_FILE) return text;
    return (
      text.slice(0, AttachmentDispatcher.MAX_TEXT_PER_FILE) +
      `\n\n[…document truncated at ${AttachmentDispatcher.MAX_TEXT_PER_FILE} characters…]`
    );
  }
}
